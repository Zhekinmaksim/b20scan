// Repair just the participants of confirmed cached-but-unapplied Transfers.
// Uses balanceOf/totalSupply at the frozen cursor, verifies the complete holder
// sum, saves rollback data, and changes no raw events. Stop the follower first.
require('dotenv').config();
const Database = require('better-sqlite3');
const { ethers } = require('ethers');
const { createRpcProvider } = require('./rpc.js');
const fs = require('node:fs');
const path = require('node:path');
const abi = new ethers.Interface(['function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)']);
const ZERO = ethers.ZeroAddress;

async function repairChain(dbPath, fromBlock, provider) {
  const db = new Database(dbPath);
  db.pragma('busy_timeout=5000');
  try {
    const cursor = Number(db.prepare('SELECT value FROM meta WHERE key=?').get('token_cursor').value);
    const pending = db.prepare(`SELECT token,block,log_index,args FROM events INDEXED BY idx_events_block_log
      WHERE block BETWEEN ? AND ? AND kind='Transfer' AND applied=0`).all(fromBlock, cursor);
    const groups = new Map();
    for (const row of pending) {
      const group = groups.get(row.token) || { count: 0, supplyDelta: 0n, accounts: new Set() };
      const args = JSON.parse(row.args), amount = BigInt(args.amount);
      group.count++;
      for (const account of [args.from,args.to]) if (account.toLowerCase() !== ZERO) group.accounts.add(ethers.getAddress(account));
      if (args.from.toLowerCase() !== args.to.toLowerCase()) {
        if (args.from.toLowerCase() === ZERO) group.supplyDelta += amount;
        if (args.to.toLowerCase() === ZERO) group.supplyDelta -= amount;
      }
      groups.set(row.token,group);
    }
    const plans = [];
    let accountCount = 0;
    for (const [address,group] of groups) {
      const original = db.prepare('SELECT total_supply,transfer_count,holder_count FROM tokens WHERE address=?').get(address);
      const holders = db.prepare('SELECT account,balance FROM holders WHERE token=?').all(address);
      const byAccount = new Map(holders.map(row=>[row.account.toLowerCase(),row]));
      const read = async (name,args) => BigInt(abi.decodeFunctionResult(name, await provider.call({
        to:address,data:abi.encodeFunctionData(name,args),blockTag:cursor }))[0]);
      const supply = await read('totalSupply',[]);
      if (supply !== BigInt(original.total_supply) + group.supplyDelta) throw new Error(`Supply drift for ${address}`);
      const changes = await Promise.all([...group.accounts].map(async account=>({ account,
        old:byAccount.get(account.toLowerCase()) || null, balance:(await read('balanceOf',[account])).toString() })));
      let sum = holders.reduce((n,row)=>n+BigInt(row.balance),0n), count=holders.filter(row=>BigInt(row.balance)>0n).length;
      for (const change of changes) {
        const balance = BigInt(change.balance);
        sum += balance - BigInt(change.old?.balance || '0');
        const hadBalance=change.old && BigInt(change.old.balance)>0n;
        if (hadBalance && !balance) count--;
        if (!hadBalance && balance) count++;
      }
      if (sum !== supply) throw new Error(`Repaired holder sum does not match chain supply for ${address}`);
      plans.push({address,original,changes,supply:supply.toString(),transfers:original.transfer_count+group.count,holders:count});
      accountCount += changes.length;
    }
    if (!plans.length) return {pending:0,tokens:0,cursor};
    const dir=path.join(path.dirname(dbPath),'backups');
    fs.mkdirSync(dir,{recursive:true});
    const backupPath=path.join(dir,`chain-balance-repair-${Date.now()}-${require('node:crypto').randomUUID().slice(0,8)}.json`);
    fs.writeFileSync(backupPath,JSON.stringify({cursor,pending,plans},null,2),{mode:0o600});
    db.transaction(()=>{
      if (Number(db.prepare('SELECT value FROM meta WHERE key=?').get('token_cursor').value)!==cursor) throw new Error('Source cursor changed; stop the follower');
      const remove=db.prepare('DELETE FROM holders WHERE token=? AND account=?');
      const upsert=db.prepare(`INSERT INTO holders(token,account,balance) VALUES(?,?,?)
        ON CONFLICT(token,account) DO UPDATE SET balance=excluded.balance`);
      const update=db.prepare('UPDATE tokens SET total_supply=?,transfer_count=?,holder_count=? WHERE address=?');
      const mark=db.prepare(`UPDATE events INDEXED BY idx_events_block_log SET applied=1
        WHERE token=? AND kind='Transfer' AND applied=0 AND block=? AND log_index=?`);
      for (const plan of plans) {
        const current=db.prepare('SELECT total_supply,transfer_count,holder_count FROM tokens WHERE address=?').get(plan.address);
        if (JSON.stringify(current)!==JSON.stringify(plan.original)) throw new Error('Source state changed during preparation');
        for (const change of plan.changes) {
          const account=change.old?.account || change.account;
          if (BigInt(change.balance)) upsert.run(plan.address,account,change.balance);
          else remove.run(plan.address,account);
        }
        update.run(plan.supply,plan.transfers,plan.holders,plan.address);
      }
      for (const row of pending) mark.run(row.token,row.block,row.log_index);
    })();
    return {pending:pending.length,tokens:plans.length,accounts:accountCount,cursor,backupPath};
  } finally {db.close();}
}

if (require.main===module) {
  const arg=process.argv.find(x=>x.startsWith('--from-block='));
  if (!process.env.DB_PATH || !arg || !Number.isSafeInteger(Number(arg.split('=')[1]))) {
    console.error('Set DB_PATH and pass --from-block=N; stop the follower first.');process.exitCode=1;
  } else {
    const provider=createRpcProvider();
    repairChain(process.env.DB_PATH,Number(arg.split('=')[1]),provider).then(result=>console.log(JSON.stringify(result)))
      .catch(error=>{console.error(error.message);process.exitCode=1}).finally(()=>provider.destroy());
  }
}
function applyChainSnapshot(dbPath, backupPath) {
  const snapshot=JSON.parse(fs.readFileSync(backupPath,'utf8'));
  const db=new Database(dbPath);
  db.pragma('busy_timeout=5000');
  try {
    db.transaction(()=>{
      if (Number(db.prepare('SELECT value FROM meta WHERE key=?').get('token_cursor').value)!==snapshot.cursor) throw new Error('Snapshot cursor no longer matches source');
      for (const plan of snapshot.plans) {
        const current=db.prepare('SELECT total_supply,transfer_count,holder_count FROM tokens WHERE address=?').get(plan.address);
        if (JSON.stringify(current)!==JSON.stringify(plan.original)) throw new Error('Snapshot source state changed');
      }
      const remove=db.prepare('DELETE FROM holders WHERE token=? AND account=?');
      const upsert=db.prepare(`INSERT INTO holders(token,account,balance) VALUES(?,?,?) ON CONFLICT(token,account) DO UPDATE SET balance=excluded.balance`);
      const update=db.prepare('UPDATE tokens SET total_supply=?,transfer_count=?,holder_count=? WHERE address=?');
      const mark=db.prepare(`UPDATE events INDEXED BY idx_events_block_log SET applied=1 WHERE token=? AND kind='Transfer' AND applied=0 AND block=? AND log_index=?`);
      for (const plan of snapshot.plans) {
        for (const change of plan.changes) {
          const account=change.old?.account||change.account;
          if (BigInt(change.balance)) upsert.run(plan.address,account,change.balance);
          else remove.run(plan.address,account);
        }
        update.run(plan.supply,plan.transfers,plan.holders,plan.address);
      }
      for (const row of snapshot.pending) mark.run(row.token,row.block,row.log_index);
    })();
    return {pending:snapshot.pending.length,tokens:snapshot.plans.length,cursor:snapshot.cursor,backupPath};
  } finally {db.close();}
}
module.exports={repairChain,applyChainSnapshot};
