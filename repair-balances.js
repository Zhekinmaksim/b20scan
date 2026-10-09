// Rebuild only tokens with confirmed, cached-but-unapplied Transfers.
// Stop the follower first. Raw events stay intact; old/new materialized state
// is saved in a separate SQLite backup before one atomic source transaction.
require('dotenv').config();
const Database = require('better-sqlite3');
const { ethers } = require('ethers');
const fs = require('node:fs');
const path = require('node:path');
const ZERO = ethers.ZeroAddress;

function tokenLedger(db, address, cursor) {
  const balances = new Map();
  let supply = 0n, count = 0;
  for (const row of db.prepare(`SELECT args FROM events INDEXED BY idx_events_token
    WHERE token=? AND kind='Transfer' AND block<=? ORDER BY block,log_index`).iterate(address, cursor)) {
    const args = JSON.parse(row.args), amount = BigInt(args.amount);
    const from = args.from.toLowerCase(), to = args.to.toLowerCase();
    count++;
    if (from === to) continue;
    if (from === ZERO) supply += amount;
    else balances.set(from, (balances.get(from) || 0n) - amount);
    if (to === ZERO) supply -= amount;
    else balances.set(to, (balances.get(to) || 0n) + amount);
  }
  for (const [account, balance] of balances) {
    if (balance < 0n) throw new Error(`Incomplete ledger for ${address}: negative balance at ${account}`);
    if (balance === 0n) balances.delete(account);
  }
  if (supply < 0n) throw new Error(`Negative supply for ${address}`);
  return { balances, supply: supply.toString(), count };
}

function applyPrepared(dbPath, backupPath, cursor) {
  const db = new Database(dbPath), backup = new Database(backupPath, { readonly: true });
  db.pragma('busy_timeout=5000');
  try {
    if (Number(db.prepare('SELECT value FROM meta WHERE key=?').get('token_cursor').value) !== cursor) {
      throw new Error('Source cursor changed after preparation; stop the follower and prepare again');
    }
    db.transaction(() => {
      for (const original of backup.prepare('SELECT * FROM old_tokens').iterate()) {
        const current = db.prepare('SELECT total_supply,transfer_count,holder_count FROM tokens WHERE address=?').get(original.address);
        if (current.total_supply !== original.supply || current.transfer_count !== original.transfers || current.holder_count !== original.holders) {
          throw new Error(`Source state changed after preparation for ${original.address}`);
        }
      }
      const remove = db.prepare('DELETE FROM holders WHERE token=?');
      const insert = db.prepare('INSERT INTO holders(token,account,balance) VALUES(?,?,?)');
      const update = db.prepare('UPDATE tokens SET total_supply=?,transfer_count=?,holder_count=? WHERE address=?');
      const mark = db.prepare(`UPDATE events INDEXED BY idx_events_token SET applied=1
        WHERE token=? AND kind='Transfer' AND applied=0 AND block<=?`);
      for (const token of backup.prepare('SELECT * FROM new_tokens').iterate()) {
        remove.run(token.address);
        for (const holder of backup.prepare('SELECT account,balance FROM new_holders WHERE token=?').iterate(token.address)) {
          insert.run(token.address, holder.account, holder.balance);
        }
        update.run(token.supply, token.transfers, token.holders, token.address);
        mark.run(token.address, cursor);
      }
    })();
    return { applied: true, cursor, tokens: backup.prepare('SELECT count(*) n FROM new_tokens').get().n,
      pending: backup.prepare('SELECT count(*) n FROM pending_transfers').get().n, backupPath };
  } finally { backup.close(); db.close(); }
}

function repair(dbPath, fromBlock, { dryRun = false } = {}) {
  const db = new Database(dbPath);
  db.pragma('busy_timeout=5000');
  const cursor = Number(db.prepare('SELECT value FROM meta WHERE key=?').get('token_cursor').value);
  const pending = db.prepare(`SELECT token,args FROM events INDEXED BY idx_events_block_log
    WHERE block BETWEEN ? AND ? AND kind='Transfer' AND applied=0`).all(fromBlock, cursor);
  const groups = new Map();
  for (const row of pending) {
    const group = groups.get(row.token) || { count: 0, supply: 0n };
    const args = JSON.parse(row.args), amount = BigInt(args.amount);
    group.count++;
    if (args.from.toLowerCase() !== args.to.toLowerCase()) {
      if (args.from.toLowerCase() === ZERO) group.supply += amount;
      if (args.to.toLowerCase() === ZERO) group.supply -= amount;
    }
    groups.set(row.token, group);
  }
  if (!pending.length) { db.close(); return { pending: 0, tokens: 0, cursor }; }
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = path.join(dir, `balance-repair-${new Date().toISOString().replace(/[:.]/g, '-')}-${require('node:crypto').randomUUID().slice(0,8)}.db`);
  const backup = new Database(backupPath);
  backup.exec(`CREATE TABLE old_tokens(address TEXT PRIMARY KEY,supply TEXT,transfers INTEGER,holders INTEGER);
    CREATE TABLE old_holders(token TEXT,account TEXT,balance TEXT,PRIMARY KEY(token,account));
    CREATE TABLE pending_transfers(token TEXT,args TEXT);
    CREATE TABLE new_tokens(address TEXT PRIMARY KEY,supply TEXT,transfers INTEGER,holders INTEGER);
    CREATE TABLE new_holders(token TEXT,account TEXT,balance TEXT,PRIMARY KEY(token,account));`);
  const oldToken = backup.prepare('INSERT INTO old_tokens VALUES(?,?,?,?)');
  const oldHolder = backup.prepare('INSERT INTO old_holders VALUES(?,?,?)');
  const newToken = backup.prepare('INSERT INTO new_tokens VALUES(?,?,?,?)');
  const newHolder = backup.prepare('INSERT INTO new_holders VALUES(?,?,?)');
  try {
    backup.transaction(() => {
      const savePending = backup.prepare('INSERT INTO pending_transfers VALUES(?,?)');
      for (const row of pending) savePending.run(row.token, row.args);
      for (const [address, delta] of groups) {
        const original = db.prepare('SELECT total_supply,transfer_count,holder_count FROM tokens WHERE address=?').get(address);
        const ledger = tokenLedger(db, address, cursor);
        if (ledger.count !== original.transfer_count + delta.count
            || BigInt(ledger.supply) !== BigInt(original.total_supply) + delta.supply) {
          throw new Error(`Cache drift beyond the pending transfers for ${address}; source left unchanged`);
        }
        oldToken.run(address, original.total_supply, original.transfer_count, original.holder_count);
        for (const holder of db.prepare('SELECT account,balance FROM holders WHERE token=?').iterate(address)) {
          oldHolder.run(address, holder.account, holder.balance);
        }
        newToken.run(address, ledger.supply, ledger.count, ledger.balances.size);
        for (const [account, balance] of ledger.balances) newHolder.run(address, ethers.getAddress(account), balance.toString());
      }
    })();
    if (!dryRun) db.transaction(() => {
      const remove = db.prepare('DELETE FROM holders WHERE token=?');
      const insert = db.prepare('INSERT INTO holders(token,account,balance) VALUES(?,?,?)');
      const update = db.prepare('UPDATE tokens SET total_supply=?,transfer_count=?,holder_count=? WHERE address=?');
      const mark = db.prepare(`UPDATE events INDEXED BY idx_events_token SET applied=1
        WHERE token=? AND kind='Transfer' AND applied=0 AND block<=?`);
      for (const token of backup.prepare('SELECT * FROM new_tokens').iterate()) {
        remove.run(token.address);
        for (const holder of backup.prepare('SELECT account,balance FROM new_holders WHERE token=?').iterate(token.address)) {
          insert.run(token.address, holder.account, holder.balance);
        }
        update.run(token.supply, token.transfers, token.holders, token.address);
        mark.run(token.address, cursor);
      }
    })();
    return { pending: pending.length, tokens: groups.size, cursor, dryRun, backupPath };
  } finally { backup.close(); db.close(); }
}

if (require.main === module) {
  const from = process.argv.find(arg => arg.startsWith('--from-block='));
  const prepared = process.argv.find(arg => arg.startsWith('--prepared='));
  const cursor = process.argv.find(arg => arg.startsWith('--cursor='));
  if (process.env.DB_PATH && prepared && cursor && Number.isSafeInteger(Number(cursor.split('=')[1]))) {
    try { console.log(JSON.stringify(applyPrepared(process.env.DB_PATH, prepared.slice(11), Number(cursor.split('=')[1])))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  } else if (!process.env.DB_PATH || !from || !Number.isSafeInteger(Number(from.split('=')[1]))) {
    console.error('Set DB_PATH and pass --from-block=N; stop the indexer before applying. --dry-run is available.');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(repair(process.env.DB_PATH, Number(from.split('=')[1]), { dryRun: process.argv.includes('--dry-run') }))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
module.exports = { tokenLedger, repair, applyPrepared };
