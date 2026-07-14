// server.js - REST API + static frontend.
//   node server.js    (PORT env, default 3020)
require("dotenv").config();
const express = require("express");
const path = require("path");
const { ethers } = require("ethers");
const { db, stmts } = require("./db.js");

const app = express();
app.disable("x-powered-by");
app.use((_, res, next) => {
  res.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "upgrade-insecure-requests",
  ].join("; "));
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-write=()");
  next();
});
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
const nameCache = new Map();
const accountTypeCache = new Map();
const NAME_CACHE_MS = 3_600_000;
const NAME_READ_TIMEOUT_MS = 1_500;
const NAME_API_TIMEOUT_MS = 1_200;
const ACCOUNT_TYPE_CACHE_MS = 3_600_000;
const ACCOUNT_TYPE_UNKNOWN_CACHE_MS = 10_000;
const ACCOUNT_TYPE_TIMEOUT_MS = 2_500;
const ENS_REGISTRY_ADDRESS = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ensRegistry = new ethers.Contract(
  ENS_REGISTRY_ADDRESS,
  ["function resolver(bytes32 node) view returns (address)"],
  provider
);
const ensResolverAbi = [
  "function name(bytes32 node) view returns (string)",
];
const seriesCache = { at: 0, value: null };
const DEPLOY_SERIES_CACHE_MS = 30_000;
const ZERO_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ROLE_NAMES = new Map([
  [ZERO_ROLE, "ADMIN"],
  [ethers.id("DEFAULT_ADMIN_ROLE").toLowerCase(), "ADMIN"],
  [ethers.id("MINTER_ROLE").toLowerCase(), "MINT"],
  [ethers.id("MINT_ROLE").toLowerCase(), "MINT"],
  [ethers.id("BURN_ROLE").toLowerCase(), "BURN"],
  [ethers.id("BURN_BLOCKED_ROLE").toLowerCase(), "BURN BLOCKED"],
  [ethers.id("PAUSER_ROLE").toLowerCase(), "PAUSE"],
  [ethers.id("PAUSE_ROLE").toLowerCase(), "PAUSE"],
  [ethers.id("UNPAUSE_ROLE").toLowerCase(), "UNPAUSE"],
  [ethers.id("METADATA_ROLE").toLowerCase(), "META"],
  [ethers.id("META_ROLE").toLowerCase(), "META"],
  [ethers.id("OPERATOR_ROLE").toLowerCase(), "OPERATOR"],
]);
const PAUSE_FEATURES = ["TRANSFER", "MINT", "BURN"];
const ADMIN_ROLE_VALUES_SQL = [ZERO_ROLE, ethers.id("DEFAULT_ADMIN_ROLE").toLowerCase()]
  .map((role) => `'${role}'`)
  .join(",");
const ACCOUNT_TYPE_VALUES = new Map([
  ["eoa", "EOA"],
  ["smart_eoa", "SMART_EOA"],
  ["contract", "CONTRACT"],
]);
const ACCOUNT_TYPE_COLUMNS = new Map([
  ["EOA", "t.admin_eoa"],
  ["SMART_EOA", "t.admin_smart_eoa"],
  ["CONTRACT", "t.admin_contract"],
]);
const SORTS = new Map([
  ["created", "t.block DESC"],
  ["holders", "t.holder_count DESC, t.block DESC"],
  ["transfers", "t.transfer_count DESC, t.block DESC"],
  ["activity", "COALESCE(t.last_activity_block, t.block) DESC, t.block DESC"],
]);
const accountTypeStore = {
  get: db.prepare("SELECT type,updated_at FROM account_types WHERE account=?"),
  set: db.prepare(`INSERT INTO account_types(account,type,updated_at) VALUES(?,?,?)
    ON CONFLICT(account) DO UPDATE SET type=excluded.type, updated_at=excluded.updated_at`),
};

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

async function basenameFor(address) {
  const key = address.toLowerCase();
  const cached = nameCache.get(key);
  if (cached && Date.now() - cached.at < NAME_CACHE_MS) return cached.value;
  let value = null;
  const reverseNode = ethers.namehash(`${key.slice(2)}.addr.reverse`);
  try {
    const resolverAddress = await withTimeout(ensRegistry.resolver(reverseNode), NAME_READ_TIMEOUT_MS);
    if (resolverAddress && resolverAddress !== ZERO_ADDRESS) {
      const resolver = new ethers.Contract(resolverAddress, ensResolverAbi, provider);
      const name = await withTimeout(resolver.name(reverseNode), NAME_READ_TIMEOUT_MS);
      if (name && /\.base\.eth$/i.test(name)) value = name;
    }
  } catch {
    value = null;
  }
  if (!value) {
    try {
      value = await withTimeout(provider.lookupAddress(address), NAME_READ_TIMEOUT_MS);
    } catch {
      value = null;
    }
    if (value && !/\.base\.eth$/i.test(value)) value = null;
  }
  if (!value) value = await basenameFromProfile(address);
  nameCache.set(key, { at: Date.now(), value });
  if (nameCache.size > 4096) nameCache.delete(nameCache.keys().next().value);
  return value;
}

async function basenameFromProfile(address) {
  try {
    const res = await withTimeout(fetch(`https://api.web3.bio/profile/${address}`), NAME_API_TIMEOUT_MS);
    if (!res.ok) return null;
    const profiles = await withTimeout(res.json(), NAME_API_TIMEOUT_MS);
    if (!Array.isArray(profiles)) return null;
    const lower = address.toLowerCase();
    const exact = profiles.find((p) =>
      String(p.address || "").toLowerCase() === lower &&
      String(p.platform || "").toLowerCase() === "basenames" &&
      /\.base\.eth$/i.test(String(p.identity || p.displayName || ""))
    );
    return exact ? String(exact.identity || exact.displayName) : null;
  } catch {
    return null;
  }
}

async function accountTypeFor(address) {
  const key = address.toLowerCase();
  const cached = accountTypeCache.get(key);
  if (cached) {
    const ttl = cached.value === "UNKNOWN" ? ACCOUNT_TYPE_UNKNOWN_CACHE_MS : ACCOUNT_TYPE_CACHE_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
  }
  const dbCached = accountTypeStore.get.get(key);
  if (dbCached && Date.now() - dbCached.updated_at < ACCOUNT_TYPE_CACHE_MS) {
    accountTypeCache.set(key, { at: Date.now(), value: dbCached.type });
    return dbCached.type;
  }
  let value = "EOA";
  try {
    const code = await withTimeout(provider.getCode(address), ACCOUNT_TYPE_TIMEOUT_MS);
    if (code && code !== "0x") {
      value = /^0xef0100[0-9a-fA-F]{40}$/.test(code) ? "SMART_EOA" : "CONTRACT";
    }
  } catch {
    value = "UNKNOWN";
  }
  accountTypeCache.set(key, { at: Date.now(), value });
  if (value !== "UNKNOWN") {
    accountTypeStore.set.run(key, value, Date.now());
    refreshAdminTypeFlagsForAccount(key);
  }
  if (accountTypeCache.size > 4096) accountTypeCache.delete(accountTypeCache.keys().next().value);
  return value;
}

function tokenFilter(options) {
  const { variant, search, minHolders, nonMint, admin, adminType } = options;
  const cond = [], params = [];
  if (variant !== null) { cond.push("t.variant=?"); params.push(variant); }
  if (search) { cond.push("(t.symbol LIKE ? OR t.name LIKE ? OR t.address LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (minHolders) { cond.push("t.holder_count>=?"); params.push(minHolders); }
  if (nonMint) cond.push("t.has_non_mint_transfer=1");
  if (admin === "renounced") cond.push("t.admin_active=0");
  else if (admin === "active") cond.push("t.admin_active=1");
  if (adminType) {
    const col = ACCOUNT_TYPE_COLUMNS.get(adminType);
    if (col) cond.push(`t.admin_active=1 AND ${col}=1`);
  }
  return { where: cond.length ? " WHERE " + cond.join(" AND ") : "", params };
}

function tokenQueryOptions(req) {
  const variant = req.query.variant === "asset" ? 0 : req.query.variant === "stablecoin" ? 1 : null;
  const admin = req.query.admin === "renounced" ? "renounced" : req.query.admin === "active" ? "active" : null;
  const adminType = ACCOUNT_TYPE_VALUES.get(String(req.query.admin_type || "").toLowerCase()) || null;
  const sort = SORTS.has(String(req.query.sort || "")) ? String(req.query.sort) : "created";
  return {
    variant,
    search: (req.query.q || "").slice(0, 64) || null,
    minHolders: req.query.min_holders === "2" ? 2 : null,
    nonMint: req.query.non_mint === "1",
    admin,
    adminType,
    sort,
  };
}

const q = {
  stats: db.prepare(`SELECT
    (SELECT COUNT(*) FROM tokens) tokens,
    (SELECT COUNT(*) FROM tokens WHERE variant=0) assets,
    (SELECT COUNT(*) FROM tokens WHERE variant=1) stables,
    (SELECT COUNT(*) FROM events WHERE kind='Transfer') transfers,
    (SELECT COUNT(DISTINCT account) FROM holders) holders,
    (SELECT COUNT(*) FROM events WHERE kind='Memo') memos,
    (SELECT value FROM meta WHERE key='cursor') cursor,
    (SELECT value FROM meta WHERE key='token_cursor') event_cursor`),
  tokens: (options) => {
    const { where, params } = tokenFilter(options);
    const order = SORTS.get(options.sort) || SORTS.get("created");
    let sql = "SELECT t.* FROM tokens t" + where;
    sql += ` ORDER BY ${order} LIMIT ? OFFSET ?`;
    return { sql, params };
  },
  tokenCount: (options) => {
    const { where, params } = tokenFilter(options);
    return { sql: "SELECT COUNT(*) total FROM tokens t" + where, params };
  },
  token: db.prepare("SELECT * FROM tokens WHERE address=? COLLATE NOCASE"),
  tokenEvents: db.prepare("SELECT kind,block,tx,log_index,ts,args FROM events WHERE token=? COLLATE NOCASE ORDER BY block DESC, log_index DESC"),
  tokenControlEvents: db.prepare("SELECT kind,args,block,log_index FROM events WHERE token=? COLLATE NOCASE AND kind IN ('RoleGranted','RoleRevoked','Paused','Unpaused','PolicyUpdated','SupplyCapUpdated','Memo') ORDER BY block ASC, log_index ASC"),
  tokenHolders: db.prepare("SELECT account,balance FROM holders WHERE token=? COLLATE NOCASE ORDER BY LENGTH(balance) DESC, balance DESC LIMIT 20"),
  deployTimes: db.prepare("SELECT ts FROM tokens WHERE ts IS NOT NULL ORDER BY ts ASC"),
  lastEvent: db.prepare("SELECT MAX(ts) ts, MAX(block) block FROM events"),
  feed: db.prepare(`SELECT kind,block,tx,log_index,ts,args,token,symbol FROM (
    SELECT e.kind,e.block,e.tx,e.log_index,e.ts,e.args,e.token,t.symbol FROM events e JOIN tokens t ON t.address=e.token
    UNION ALL
    SELECT 'Created',t.block,t.tx,NULL,t.ts,'{}',t.address,t.symbol FROM tokens t
  ) ORDER BY block DESC LIMIT 30`),
  adminAccountsNeedingTypes: db.prepare(`
    SELECT DISTINCT lower(json_extract(ae.args,'$.account')) account
    FROM events ae
    LEFT JOIN account_types aty ON aty.account=lower(json_extract(ae.args,'$.account'))
    WHERE ae.kind='RoleGranted'
      AND lower(json_extract(ae.args,'$.role')) IN (${ADMIN_ROLE_VALUES_SQL})
      AND json_extract(ae.args,'$.account') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM events re
        WHERE re.token=ae.token COLLATE NOCASE
          AND re.kind='RoleRevoked'
          AND lower(json_extract(re.args,'$.role'))=lower(json_extract(ae.args,'$.role'))
          AND lower(json_extract(re.args,'$.account'))=lower(json_extract(ae.args,'$.account'))
          AND (re.block > ae.block OR (re.block=ae.block AND re.log_index > ae.log_index))
      )
      AND (aty.account IS NULL OR aty.updated_at < ?)
    LIMIT ?`),
};

const adminTokensForAccount = db.prepare(`
  SELECT DISTINCT ae.token
  FROM events ae
  WHERE ae.kind='RoleGranted'
    AND lower(json_extract(ae.args,'$.role')) IN (${ADMIN_ROLE_VALUES_SQL})
    AND lower(json_extract(ae.args,'$.account'))=?
    AND NOT EXISTS (
      SELECT 1 FROM events re
      WHERE re.token=ae.token COLLATE NOCASE
        AND re.kind='RoleRevoked'
        AND lower(json_extract(re.args,'$.role'))=lower(json_extract(ae.args,'$.role'))
        AND lower(json_extract(re.args,'$.account'))=lower(json_extract(ae.args,'$.account'))
        AND (re.block > ae.block OR (re.block=ae.block AND re.log_index > ae.log_index))
    )`);
const adminTypesForToken = db.prepare(`
  SELECT DISTINCT aty.type
  FROM events ae
  JOIN account_types aty ON aty.account=lower(json_extract(ae.args,'$.account'))
  WHERE ae.token=? COLLATE NOCASE
    AND ae.kind='RoleGranted'
    AND lower(json_extract(ae.args,'$.role')) IN (${ADMIN_ROLE_VALUES_SQL})
    AND NOT EXISTS (
      SELECT 1 FROM events re
      WHERE re.token=ae.token COLLATE NOCASE
        AND re.kind='RoleRevoked'
        AND lower(json_extract(re.args,'$.role'))=lower(json_extract(ae.args,'$.role'))
        AND lower(json_extract(re.args,'$.account'))=lower(json_extract(ae.args,'$.account'))
        AND (re.block > ae.block OR (re.block=ae.block AND re.log_index > ae.log_index))
    )`);
const setTokenAdminTypeFlags = db.prepare(`
  UPDATE tokens
  SET admin_eoa=?, admin_smart_eoa=?, admin_contract=?
  WHERE address=? COLLATE NOCASE`);

function refreshAdminTypeFlagsForToken(tokenAddress) {
  const types = new Set(adminTypesForToken.all(tokenAddress).map((row) => row.type));
  setTokenAdminTypeFlags.run(
    types.has("EOA") ? 1 : 0,
    types.has("SMART_EOA") ? 1 : 0,
    types.has("CONTRACT") ? 1 : 0,
    tokenAddress
  );
}

function refreshAdminTypeFlagsForAccount(account) {
  for (const row of adminTokensForAccount.all(String(account).toLowerCase())) {
    refreshAdminTypeFlagsForToken(row.token);
  }
}

let adminTypeWarmRunning = false;
async function warmAdminAccountTypes(limit = 75) {
  if (adminTypeWarmRunning) return;
  adminTypeWarmRunning = true;
  try {
    const staleBefore = Date.now() - ACCOUNT_TYPE_CACHE_MS;
    const rows = q.adminAccountsNeedingTypes.all(staleBefore, limit);
    const concurrency = 8;
    for (let i = 0; i < rows.length; i += concurrency) {
      await Promise.all(rows.slice(i, i + concurrency).map((row) => accountTypeFor(row.account)));
    }
  } catch (e) {
    console.warn("admin account type warmup failed:", e.shortMessage || e.message);
  } finally {
    adminTypeWarmRunning = false;
  }
}

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
        const label = PAUSE_FEATURES[Number(f)] || `UNKNOWN FEATURE #${f}`;
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

app.get("/api/health", async (_, res) => {
  try {
    const chainHead = await withTimeout(provider.getBlockNumber(), 2_000);
    const factoryCursor = Number(stmts.getMeta.get("factory_cursor")?.value || stmts.getMeta.get("cursor")?.value || 0);
    const eventCursor = Number(stmts.getMeta.get("token_cursor")?.value || 0);
    const liveCursor = Number(stmts.getMeta.get("live_token_cursor")?.value || 0);
    const cursor = Math.max(factoryCursor, eventCursor, liveCursor);
    const lagBlocks = Math.max(0, chainHead - cursor);
    const lastEvent = q.lastEvent.get();
    res.json({
      status: lagBlocks <= 60 ? "synced" : lagBlocks <= 600 ? "catching_up" : "lagging",
      chainHead,
      factoryCursor,
      eventCursor,
      liveCursor,
      cursor,
      lagBlocks,
      lastEventTs: lastEvent?.ts || null,
      lastEventBlock: lastEvent?.block || null,
      database: "ok",
      checkedAt: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    res.status(503).json({
      status: "unavailable",
      database: "ok",
      error: e.shortMessage || e.message,
      checkedAt: Math.floor(Date.now() / 1000),
    });
  }
});

app.get("/api/tokens", (req, res) => {
  const options = tokenQueryOptions(req);
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const offset = Number(req.query.offset || 0);
  const { sql, params } = q.tokens(options);
  res.json(db.prepare(sql).all(...params, limit, offset));
});

app.get("/api/tokens/count", (req, res) => {
  const options = tokenQueryOptions(req);
  const { sql, params } = q.tokenCount(options);
  res.json(db.prepare(sql).get(...params));
});

app.get("/api/names", async (req, res) => {
  const raw = String(req.query.addresses || "");
  const addresses = [...new Set(raw.split(",").map((a) => a.trim()).filter(Boolean))].slice(0, 50);
  const out = {};
  await Promise.all(addresses.map(async (addr) => {
    try {
      const checked = ethers.getAddress(addr);
      const name = await basenameFor(checked);
      if (name) out[checked.toLowerCase()] = name;
    } catch { /* skip invalid address */ }
  }));
  res.json(out);
});

app.get("/api/account-types", async (req, res) => {
  const raw = String(req.query.addresses || "");
  const addresses = [...new Set(raw.split(",").map((a) => a.trim()).filter(Boolean))].slice(0, 50);
  const out = {};
  await Promise.all(addresses.map(async (addr) => {
    try {
      const checked = ethers.getAddress(addr);
      out[checked.toLowerCase()] = await accountTypeFor(checked);
    } catch { /* skip invalid address */ }
  }));
  res.json(out);
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

app.get("/token/:address", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = Number(process.env.PORT || 3020);
app.listen(PORT, () => {
  console.log(`b20scan api+web on :${PORT}`);
  setTimeout(() => warmAdminAccountTypes(500), 1_000);
  setInterval(() => warmAdminAccountTypes(300), 60_000);
});
