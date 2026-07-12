// server.js - REST API + static frontend.
//   node server.js    (PORT env, default 3020)
require("dotenv").config();
const express = require("express");
const path = require("path");
const { ethers } = require("ethers");
const { db } = require("./db.js");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Cache-Control", "public, max-age=5");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://mainnet.base.org", 8453, {
  staticNetwork: ethers.Network.from(8453),
  batchMaxCount: 1,
  batchStallTime: 0,
});
const token = new ethers.Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function supplyCap() view returns (uint256)",
  "function contractURI() view returns (string)",
  "function currency() view returns (string)",
  "function multiplier() view returns (uint256)",
]);
const liveCache = new Map();
const LIVE_CACHE_MS = 15_000;
const LIVE_READ_TIMEOUT_MS = 2_500;
const seriesCache = { at: 0, value: null };
const DEPLOY_SERIES_CACHE_MS = 30_000;
const ZERO_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ROLE_NAMES = new Map([
  [ZERO_ROLE, "ADMIN"],
  [ethers.id("MINTER_ROLE").toLowerCase(), "MINT"],
  [ethers.id("MINT_ROLE").toLowerCase(), "MINT"],
  [ethers.id("PAUSER_ROLE").toLowerCase(), "PAUSE"],
  [ethers.id("PAUSE_ROLE").toLowerCase(), "PAUSE"],
  [ethers.id("METADATA_ROLE").toLowerCase(), "META"],
  [ethers.id("META_ROLE").toLowerCase(), "META"],
]);
const PAUSE_FEATURES = ["transfers", "mint", "burn", "memo", "metadata"];

function roleName(role) {
  return ROLE_NAMES.get(String(role).toLowerCase()) || `${String(role).slice(0, 10)}...`;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("live read timeout")), ms)),
  ]);
}

async function liveToken(address) {
  const cached = liveCache.get(address);
  if (cached && Date.now() - cached.at < LIVE_CACHE_MS) return cached.value;

  const read = async (method) => {
    const result = await provider.call({ to: address, data: token.encodeFunctionData(method) });
    return token.decodeFunctionResult(method, result)[0];
  };
  const [name, symbol, decimals, totalSupply, supplyCap, contractURI, currency, multiplier] = await Promise.allSettled([
    withTimeout(read("name"), LIVE_READ_TIMEOUT_MS),
    withTimeout(read("symbol"), LIVE_READ_TIMEOUT_MS),
    withTimeout(read("decimals"), LIVE_READ_TIMEOUT_MS),
    withTimeout(read("totalSupply"), LIVE_READ_TIMEOUT_MS),
    withTimeout(read("supplyCap"), LIVE_READ_TIMEOUT_MS),
    withTimeout(read("contractURI"), LIVE_READ_TIMEOUT_MS),
    withTimeout(read("currency"), LIVE_READ_TIMEOUT_MS),
    withTimeout(read("multiplier"), LIVE_READ_TIMEOUT_MS),
  ]);
  const value = {
    name: name.status === "fulfilled" ? name.value : null,
    symbol: symbol.status === "fulfilled" ? symbol.value : null,
    decimals: decimals.status === "fulfilled" ? Number(decimals.value) : null,
    total_supply: totalSupply.status === "fulfilled" ? totalSupply.value.toString() : null,
    supply_cap: supplyCap.status === "fulfilled" ? supplyCap.value.toString() : null,
    contract_uri: contractURI.status === "fulfilled" ? contractURI.value : null,
    currency: currency.status === "fulfilled" ? currency.value : null,
    multiplier: multiplier.status === "fulfilled" ? multiplier.value.toString() : null,
    fetched_at: Math.floor(Date.now() / 1000),
  };
  liveCache.set(address, { at: Date.now(), value });
  if (liveCache.size > 512) liveCache.delete(liveCache.keys().next().value);
  return value;
}

const q = {
  stats: db.prepare(`SELECT
    (SELECT COUNT(*) FROM tokens) tokens,
    (SELECT COUNT(*) FROM tokens WHERE variant=0) assets,
    (SELECT COUNT(*) FROM tokens WHERE variant=1) stables,
    (SELECT COUNT(*) FROM events WHERE kind='Transfer') transfers,
    (SELECT COUNT(*) FROM events WHERE kind='Memo') memos,
    (SELECT value FROM meta WHERE key='cursor') cursor,
    (SELECT value FROM meta WHERE key='token_cursor') event_cursor`),
  tokens: (variant, search) => {
    let sql = "SELECT * FROM tokens";
    const cond = [], params = [];
    if (variant !== null) { cond.push("variant=?"); params.push(variant); }
    if (search) { cond.push("(symbol LIKE ? OR name LIKE ? OR address LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (cond.length) sql += " WHERE " + cond.join(" AND ");
    sql += " ORDER BY block DESC LIMIT ? OFFSET ?";
    return { sql, params };
  },
  token: db.prepare("SELECT * FROM tokens WHERE address=? COLLATE NOCASE"),
  tokenEvents: db.prepare("SELECT kind,block,tx,ts,args FROM events WHERE token=? COLLATE NOCASE ORDER BY block DESC, log_index DESC LIMIT 50"),
  tokenControlEvents: db.prepare("SELECT kind,args,block,log_index FROM events WHERE token=? COLLATE NOCASE AND kind IN ('RoleGranted','RoleRevoked','Paused','Unpaused','PolicyUpdated','SupplyCapUpdated','Memo') ORDER BY block ASC, log_index ASC"),
  tokenHolders: db.prepare("SELECT account,balance FROM holders WHERE token=? COLLATE NOCASE ORDER BY LENGTH(balance) DESC, balance DESC LIMIT 20"),
  deployTimes: db.prepare("SELECT ts FROM tokens WHERE ts IS NOT NULL ORDER BY ts ASC"),
  feed: db.prepare(`SELECT kind,block,tx,ts,args,token,symbol FROM (
    SELECT e.kind,e.block,e.tx,e.ts,e.args,e.token,t.symbol FROM events e JOIN tokens t ON t.address=e.token
    UNION ALL
    SELECT 'Created',t.block,t.tx,t.ts,'{}',t.address,t.symbol FROM tokens t
  ) ORDER BY block DESC LIMIT 30`),
};

function deploySeries() {
  if (seriesCache.value && Date.now() - seriesCache.at < DEPLOY_SERIES_CACHE_MS) return seriesCache.value;
  const rows = q.deployTimes.all();
  if (!rows.length) return { from: null, to: null, buckets: [] };
  const from = rows[0].ts;
  const to = rows[rows.length - 1].ts;
  const count = 48;
  const step = Math.max(1, Math.ceil((to - from + 1) / count));
  const buckets = Array.from({ length: count }, (_, i) => ({
    from: from + i * step,
    to: Math.min(to, from + (i + 1) * step - 1),
    count: 0,
  }));
  for (const row of rows) {
    const idx = Math.min(count - 1, Math.max(0, Math.floor((row.ts - from) / step)));
    buckets[idx].count++;
  }
  const value = { from, to, buckets };
  seriesCache.at = Date.now();
  seriesCache.value = value;
  return value;
}

function controlsFor(address, tokenRow) {
  const rows = q.tokenControlEvents.all(address);
  const roles = {};
  const paused = new Set();
  const policy = {};
  let supplyCap = null;
  let latestMemo = null;

  for (const row of rows) {
    const a = JSON.parse(row.args);
    if (row.kind === "RoleGranted" || row.kind === "RoleRevoked") {
      const label = roleName(a.role);
      roles[label] ||= new Set();
      if (row.kind === "RoleGranted") roles[label].add(a.account);
      else roles[label].delete(a.account);
    } else if (row.kind === "Paused" || row.kind === "Unpaused") {
      const features = Array.isArray(a.features) ? a.features : [];
      for (const f of features) {
        const label = PAUSE_FEATURES[Number(f)] || `feature #${f}`;
        if (row.kind === "Paused") paused.add(label);
        else paused.delete(label);
      }
    } else if (row.kind === "PolicyUpdated") {
      policy[a.policyScope] = a.newPolicyId;
    } else if (row.kind === "SupplyCapUpdated") {
      supplyCap = a.newSupplyCap;
    } else if (row.kind === "Memo") {
      latestMemo = a.memo;
    }
  }

  return {
    roles: Object.fromEntries(
      Object.entries(roles)
        .map(([label, accounts]) => [label, [...accounts]])
        .filter(([, accounts]) => accounts.length)
    ),
    paused: [...paused],
    policy,
    memo: latestMemo,
    supply_cap: supplyCap,
  };
}

app.get("/api/stats", (_, res) => res.json(q.stats.get()));

app.get("/api/deploys", (_, res) => res.json(deploySeries()));

app.get("/api/tokens", (req, res) => {
  const variant = req.query.variant === "asset" ? 0 : req.query.variant === "stablecoin" ? 1 : null;
  const search = (req.query.q || "").slice(0, 64) || null;
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Number(req.query.offset || 0);
  const { sql, params } = q.tokens(variant, search);
  res.json(db.prepare(sql).all(...params, limit, offset));
});

app.get("/api/tokens/:address/live", async (req, res) => {
  const t = q.token.get(req.params.address);
  if (!t) return res.status(404).json({ error: "token not found" });
  try {
    res.json(await liveToken(t.address));
  } catch (e) {
    console.warn(`live token read failed for ${t.address}: ${e.shortMessage || e.message}`);
    res.status(504).json({ error: "live read timed out" });
  }
});

app.get("/api/tokens/:address", (req, res) => {
  const t = q.token.get(req.params.address);
  if (!t) return res.status(404).json({ error: "token not found" });
  res.json({
    ...t,
    live: liveCache.get(t.address)?.value || null,
    events: q.tokenEvents.all(t.address).map((e) => ({ ...e, args: JSON.parse(e.args) })),
    holders: q.tokenHolders.all(t.address),
    controls: controlsFor(t.address, t),
  });
});

app.get("/api/feed", (_, res) =>
  res.json(q.feed.all().map((e) => ({ ...e, args: JSON.parse(e.args) })))
);

const PORT = Number(process.env.PORT || 3020);
app.listen(PORT, () => console.log(`b20scan api+web on :${PORT}`));
