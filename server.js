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
  tokenHolders: db.prepare("SELECT account,balance FROM holders WHERE token=? COLLATE NOCASE ORDER BY LENGTH(balance) DESC, balance DESC LIMIT 20"),
  feed: db.prepare(`SELECT kind,block,tx,ts,args,token,symbol FROM (
    SELECT e.kind,e.block,e.tx,e.ts,e.args,e.token,t.symbol FROM events e JOIN tokens t ON t.address=e.token
    UNION ALL
    SELECT 'Created',t.block,t.tx,t.ts,'{}',t.address,t.symbol FROM tokens t
  ) ORDER BY block DESC LIMIT 30`),
};

app.get("/api/stats", (_, res) => res.json(q.stats.get()));

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
  });
});

app.get("/api/feed", (_, res) =>
  res.json(q.feed.all().map((e) => ({ ...e, args: JSON.parse(e.args) })))
);

const PORT = Number(process.env.PORT || 3020);
app.listen(PORT, () => console.log(`b20scan api+web on :${PORT}`));
