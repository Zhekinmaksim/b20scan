// db.js - SQLite store. Single file, zero infra, WAL mode for concurrent reads
// while the indexer writes.
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(process.env.DB_PATH || path.join(__dirname, "b20scan.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  variant INTEGER NOT NULL,          -- 0 asset, 1 stablecoin
  name TEXT, symbol TEXT, decimals INTEGER,
  currency TEXT,                      -- stablecoin only
  creator TEXT,
  block INTEGER, tx TEXT, ts INTEGER,
  total_supply TEXT DEFAULT '0',
  transfer_count INTEGER DEFAULT 0,
  holder_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tokens_block ON tokens(block DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_variant ON tokens(variant);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  kind TEXT NOT NULL,
  block INTEGER, tx TEXT, log_index INTEGER, ts INTEGER,
  args TEXT,
  UNIQUE(tx, log_index)               -- dedup across backfill/live overlap
);
CREATE INDEX IF NOT EXISTS idx_events_token ON events(token, block DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, block DESC);

CREATE TABLE IF NOT EXISTS holders (
  token TEXT NOT NULL,
  account TEXT NOT NULL,
  balance TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (token, account)
);
`);

const eventCols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
if (!eventCols.includes("applied")) {
  db.exec("ALTER TABLE events ADD COLUMN applied INTEGER NOT NULL DEFAULT 1");
}

const stmts = {
  getMeta: db.prepare("SELECT value FROM meta WHERE key=?"),
  setMeta: db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  getCursor: db.prepare("SELECT value FROM meta WHERE key='cursor'"),
  setCursor: db.prepare("INSERT INTO meta(key,value) VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  insertToken: db.prepare(`INSERT OR IGNORE INTO tokens(address,variant,name,symbol,decimals,currency,creator,block,tx,ts)
    VALUES(@address,@variant,@name,@symbol,@decimals,@currency,@creator,@block,@tx,@ts)`),
  insertEvent: db.prepare(`INSERT OR IGNORE INTO events(token,kind,block,tx,log_index,ts,args,applied)
    VALUES(@token,@kind,@block,@tx,@log_index,@ts,@args,@applied)`),
  getEventApply: db.prepare("SELECT applied FROM events WHERE tx=? AND log_index=?"),
  markEventApplied: db.prepare("UPDATE events SET applied=1 WHERE tx=? AND log_index=?"),
  getHolder: db.prepare("SELECT balance FROM holders WHERE token=? AND account=?"),
  setHolder: db.prepare(`INSERT INTO holders(token,account,balance) VALUES(?,?,?)
    ON CONFLICT(token,account) DO UPDATE SET balance=excluded.balance`),
  delHolder: db.prepare("DELETE FROM holders WHERE token=? AND account=?"),
  bumpTransfers: db.prepare("UPDATE tokens SET transfer_count=transfer_count+1 WHERE address=?"),
  setSupplyHolders: db.prepare("UPDATE tokens SET total_supply=?, holder_count=? WHERE address=?"),
  tokenAddrs: db.prepare("SELECT address FROM tokens"),
};

const ZERO = "0x0000000000000000000000000000000000000000";

// Applies a Transfer to the holders table and total supply, in BigInt math.
function applyTransfer(token, from, to, amount) {
  const amt = BigInt(amount);
  if (from === to) {
    stmts.bumpTransfers.run(token);
    return;
  }

  const current = db.prepare("SELECT total_supply, holder_count FROM tokens WHERE address=?").get(token);
  let supply = BigInt(current?.total_supply || "0");
  let holderCount = Number(current?.holder_count || 0);

  if (from !== ZERO) {
    const cur = BigInt(stmts.getHolder.get(token, from)?.balance || "0");
    const next = cur - amt;
    if (next <= 0n) {
      if (cur > 0n) holderCount--;
      stmts.delHolder.run(token, from);
    }
    else stmts.setHolder.run(token, from, next.toString());
  } else {
    supply += amt;
  }

  if (to !== ZERO) {
    const cur = BigInt(stmts.getHolder.get(token, to)?.balance || "0");
    if (cur === 0n) holderCount++;
    stmts.setHolder.run(token, to, (cur + amt).toString());
  } else {
    supply -= amt;
  }
  stmts.bumpTransfers.run(token);
  // BigInt stays in Node: SQLite's int64 cannot hold 18-decimal token values.
  stmts.setSupplyHolders.run(supply.toString(), Math.max(0, holderCount), token);
}

module.exports = { db, stmts, applyTransfer };
