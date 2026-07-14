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
  holder_count INTEGER DEFAULT 0,
  has_non_mint_transfer INTEGER DEFAULT 0,
  last_activity_block INTEGER,
  admin_active INTEGER DEFAULT 0,
  admin_eoa INTEGER DEFAULT 0,
  admin_smart_eoa INTEGER DEFAULT 0,
  admin_contract INTEGER DEFAULT 0
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
CREATE TABLE IF NOT EXISTS account_types (
  account TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

const eventCols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
if (!eventCols.includes("applied")) {
  db.exec("ALTER TABLE events ADD COLUMN applied INTEGER NOT NULL DEFAULT 1");
}
const tokenCols = db.prepare("PRAGMA table_info(tokens)").all().map((c) => c.name);
if (!tokenCols.includes("has_non_mint_transfer")) {
  db.exec("ALTER TABLE tokens ADD COLUMN has_non_mint_transfer INTEGER NOT NULL DEFAULT 0");
}
if (!tokenCols.includes("last_activity_block")) {
  db.exec("ALTER TABLE tokens ADD COLUMN last_activity_block INTEGER");
}
if (!tokenCols.includes("admin_active")) {
  db.exec("ALTER TABLE tokens ADD COLUMN admin_active INTEGER NOT NULL DEFAULT 0");
}
if (!tokenCols.includes("admin_eoa")) {
  db.exec("ALTER TABLE tokens ADD COLUMN admin_eoa INTEGER NOT NULL DEFAULT 0");
}
if (!tokenCols.includes("admin_smart_eoa")) {
  db.exec("ALTER TABLE tokens ADD COLUMN admin_smart_eoa INTEGER NOT NULL DEFAULT 0");
}
if (!tokenCols.includes("admin_contract")) {
  db.exec("ALTER TABLE tokens ADD COLUMN admin_contract INTEGER NOT NULL DEFAULT 0");
}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_tokens_holders ON tokens(holder_count DESC, block DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_transfers ON tokens(transfer_count DESC, block DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_activity ON tokens(last_activity_block DESC, block DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_non_mint ON tokens(has_non_mint_transfer, block DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_admin_active ON tokens(admin_active, block DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_admin_eoa ON tokens(admin_eoa, block DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_admin_smart_eoa ON tokens(admin_smart_eoa, block DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_admin_contract ON tokens(admin_contract, block DESC);
`);

const stmts = {
  getMeta: db.prepare("SELECT value FROM meta WHERE key=?"),
  setMeta: db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  getCursor: db.prepare("SELECT value FROM meta WHERE key='cursor'"),
  setCursor: db.prepare("INSERT INTO meta(key,value) VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  insertToken: db.prepare(`INSERT OR IGNORE INTO tokens(address,variant,name,symbol,decimals,currency,creator,block,tx,ts)
    VALUES(@address,@variant,@name,@symbol,@decimals,@currency,@creator,@block,@tx,@ts)`),
  setTokenCreator: db.prepare("UPDATE tokens SET creator=? WHERE address=? COLLATE NOCASE AND (creator IS NULL OR creator='')"),
  tokensMissingCreator: db.prepare("SELECT address,tx FROM tokens WHERE (creator IS NULL OR creator='') AND tx IS NOT NULL ORDER BY block DESC LIMIT ?"),
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
  setNonMintTransfer: db.prepare("UPDATE tokens SET has_non_mint_transfer=1 WHERE address=?"),
  touchTokenActivity: db.prepare(`UPDATE tokens
    SET last_activity_block=MAX(COALESCE(last_activity_block, block, 0), ?)
    WHERE address=?`),
  setAdminActive: db.prepare("UPDATE tokens SET admin_active=? WHERE address=?"),
  currentAdminActive: db.prepare(`
    SELECT 1 active
    FROM events ae
    WHERE ae.token=? COLLATE NOCASE
      AND ae.kind='RoleGranted'
      AND lower(json_extract(ae.args,'$.role')) IN (
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        '0x1effbbff9c66c5e59634f24fe842750c60d18891155c32dd155fc2d661a4c86d'
      )
      AND NOT EXISTS (
        SELECT 1 FROM events re
        WHERE re.token=ae.token COLLATE NOCASE
          AND re.kind='RoleRevoked'
          AND lower(json_extract(re.args,'$.role'))=lower(json_extract(ae.args,'$.role'))
          AND lower(json_extract(re.args,'$.account'))=lower(json_extract(ae.args,'$.account'))
          AND (re.block > ae.block OR (re.block=ae.block AND re.log_index > ae.log_index))
      )
    LIMIT 1`),
  tokenAddrs: db.prepare("SELECT address FROM tokens"),
};

const ZERO = "0x0000000000000000000000000000000000000000";
const ADMIN_ROLES = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0x1effbbff9c66c5e59634f24fe842750c60d18891155c32dd155fc2d661a4c86d",
]);

function isAdminRole(role) {
  return ADMIN_ROLES.has(String(role || "").toLowerCase());
}

function markTokenEvent(event, args) {
  if (event.block != null) stmts.touchTokenActivity.run(Number(event.block), event.token);
  if (event.kind === "Transfer" && args?.from && String(args.from).toLowerCase() !== ZERO) {
    stmts.setNonMintTransfer.run(event.token);
  }
  if ((event.kind === "RoleGranted" || event.kind === "RoleRevoked") && isAdminRole(args?.role)) {
    stmts.setAdminActive.run(stmts.currentAdminActive.get(event.token) ? 1 : 0, event.token);
  }
}

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

const insertTransferEventAndApply = db.transaction((event, args) => {
  const inserted = stmts.insertEvent.run({ ...event, applied: 0 });
  const state = stmts.getEventApply.get(event.tx, event.log_index);
  if (inserted.changes) markTokenEvent(event, args);
  if (state && !state.applied) {
    applyTransfer(event.token, args.from, args.to, args.amount);
    stmts.markEventApplied.run(event.tx, event.log_index);
  }
  return inserted.changes;
});

function insertEventAndMaybeApply(event, args, applyState) {
  if (applyState && event.kind === "Transfer") return insertTransferEventAndApply(event, args);
  const applied = event.kind === "Transfer" ? 0 : 1;
  const changes = stmts.insertEvent.run({ ...event, applied }).changes;
  if (changes) markTokenEvent(event, args);
  return changes;
}

module.exports = { db, stmts, applyTransfer, insertEventAndMaybeApply };
