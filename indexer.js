// indexer.js - backfill + live follower for the B20 factory and its tokens.
//
//   node indexer.js               # backfill from START_BLOCK, then follow head
//   node indexer.js --once        # backfill only, exit (good for cron)
//
// Env: RPC_URL, CHAIN_ID, START_BLOCK (activation block), CHUNK (default 2000),
//      TOKEN_TOPIC_CHUNK (default 100),
//      CONFIRMATIONS (default 12), POLL_MS (default 4000),
//      LIVE_CHUNK (default 25), LIVE_LOOKBACK (default 300)
//
// Reorg strategy: only blocks at depth >= CONFIRMATIONS are indexed, so no
// unwind logic is needed. The cursor in `meta` makes restarts resume in place.
// UNIQUE(tx, log_index) makes overlapping ranges idempotent.
require("dotenv").config();
const { ethers } = require("ethers");
const { FACTORY, POLICY_REGISTRY, TOPIC_CREATED, TOKEN_TOPICS, REGISTRY_TOPICS, tokenIface, decodeCreated, decodeTokenLog, decodeRegistryLog } = require("./chain.js");
const { db, stmts, insertEventAndMaybeApply, insertRegistryEvent } = require("./db.js");

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);
// First Base block at/after the B20 activation time, 2026-07-08 18:00 UTC.
// Keeping this non-zero protects a fresh mainnet install from scanning the
// entire pre-B20 chain when .env has not been configured yet.
const START_BLOCK = Number(process.env.START_BLOCK || 48372133);
const CHUNK = Number(process.env.CHUNK || 2000);
const TOKEN_TOPIC_CHUNK = Number(process.env.TOKEN_TOPIC_CHUNK || 100);
const TOKEN_ADDRESS_CHUNK = Number(process.env.TOKEN_ADDRESS_CHUNK || 25);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 12);
const POLL_MS = Number(process.env.POLL_MS || 4000);
const LIVE_CHUNK = Number(process.env.LIVE_CHUNK || 25);
const LIVE_LOOKBACK = Number(process.env.LIVE_LOOKBACK || 300);
const ONCE = process.argv.includes("--once");
const FILL_CREATORS = process.argv.includes("--fill-creators");
const COBALT_BACKFILL = process.argv.includes("--cobalt-backfill");
const REGISTRY_CHUNK = Number(process.env.REGISTRY_CHUNK || 1000);
const SEIZE_CHUNK = Number(process.env.SEIZE_CHUNK || 1000);
// Base mainnet activation: September 30, 2026, 18:00 UTC. Overrides support
// other networks and deterministic tests without changing existing cursors.
const COBALT_TIMESTAMP = Number(process.env.COBALT_TIMESTAMP || 1790791200);
const SEIZED_TOPIC = tokenIface.getEvent("Seized").topicHash;
const advanceCursorStmt = db.prepare(`INSERT INTO meta(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
  WHERE CAST(excluded.value AS INTEGER) > CAST(meta.value AS INTEGER)`);

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {
  staticNetwork: ethers.Network.from(CHAIN_ID),
  // Base's public endpoint has an unusually strict batch limit. Disabling
  // batching avoids a single rejected batch taking down the whole indexer.
  batchMaxCount: 1,
  batchStallTime: 0,
});
const tsCache = new Map();
const txFromCache = new Map();
const B20_ADDRESS_PREFIX = "0xb200";
let tokenAddressCache = { count: -1, rows: [], set: new Set() };

async function blockTs(bn) {
  if (!tsCache.has(bn)) {
    const b = await provider.getBlock(bn);
    tsCache.set(bn, b.timestamp);
    if (tsCache.size > 4096) tsCache.delete(tsCache.keys().next().value);
  }
  return tsCache.get(bn);
}

function cursor(key, fallback) {
  return Number(stmts.getMeta.get(key)?.value ?? fallback);
}

function setCursor(key, value) {
  stmts.setMeta.run(key, String(value));
}

async function txFrom(hash) {
  if (!hash) return null;
  if (!txFromCache.has(hash)) {
    try {
      txFromCache.set(hash, (await provider.getTransaction(hash))?.from || null);
    } catch {
      txFromCache.set(hash, null);
    }
    if (txFromCache.size > 4096) txFromCache.delete(txFromCache.keys().next().value);
  }
  return txFromCache.get(hash);
}

async function fillMissingCreators(limit = 50) {
  const rows = stmts.tokensMissingCreator.all(limit);
  let n = 0;
  for (const row of rows) {
    const creator = await txFrom(row.tx);
    if (!creator) continue;
    stmts.setTokenCreator.run(creator, row.address);
    n++;
  }
  if (n) console.log(`  creators -> +${n}`);
  return n;
}

function knownTokenAddresses() {
  const count = Number(stmts.tokenCount.get()?.n || 0);
  if (count !== tokenAddressCache.count) {
    const rows = stmts.tokenAddrs.all().map((r) => r.address);
    tokenAddressCache = {
      count,
      rows,
      set: new Set(rows.map((a) => a.toLowerCase())),
    };
  }
  return tokenAddressCache;
}

function isKnownB20Emitter(address, addrSet) {
  const key = String(address || "").toLowerCase();
  return key.startsWith(B20_ADDRESS_PREFIX) && addrSet.has(key);
}

function isResponseTooLarge(e) {
  const text = [
    e?.shortMessage,
    e?.message,
    e?.info?.responseBody,
    e?.info?.responseStatus,
  ].filter(Boolean).join(" ");
  return /response too large|payload too large|\b413\b|block range.*(?:too large|exceed)/i.test(text);
}

// --- factory: new tokens ---
async function indexFactoryRange(from, to) {
  const logs = await provider.getLogs({ address: FACTORY, topics: [TOPIC_CREATED], fromBlock: from, toBlock: to });
  // A public RPC cannot sustain one `getBlock` plus one transaction lookup for
  // every deployment. Two boundary blocks give accurate-enough display times
  // within a CHUNK and keep the factory sweep responsive as B20 volume grows.
  const [fromTs, toTs] = await Promise.all([blockTs(from), blockTs(to)]);
  const span = Math.max(1, to - from);
  const timestampFor = (block) => Math.round(fromTs + ((block - from) / span) * (toTs - fromTs));

  for (const log of logs) {
    const t = decodeCreated(log);
    const creator = await txFrom(log.transactionHash);
    stmts.insertToken.run({
      address: t.token, variant: t.variant, name: t.name, symbol: t.symbol,
      decimals: t.decimals, currency: t.currency, creator,
      block: log.blockNumber, tx: log.transactionHash, ts: timestampFor(log.blockNumber),
    });
    if (creator) stmts.setTokenCreator.run(creator, t.token);
    console.log(`+ token ${t.symbol} (${t.variant === 0 ? "ASSET" : "STABLE"}) ${t.token} @${log.blockNumber}`);
  }
  return logs.length;
}

// --- tokens: transfers, memos, admin events ---
async function insertDecodedTokenLog(log, timestamp, applyState) {
  const d = decodeTokenLog(log);
  if (!d) return 0;
  return insertEventAndMaybeApply({
    token: log.address, kind: d.kind, block: log.blockNumber, tx: log.transactionHash,
    log_index: log.index, ts: timestamp, args: JSON.stringify(d.args),
  }, d.args, Boolean(applyState));
}

async function getAddressScopedLogs(addresses, topics, from, to) {
  try {
    return await provider.getLogs({ address: addresses, topics, fromBlock: from, toBlock: to });
  } catch (e) {
    if (!isResponseTooLarge(e)) throw e;
    if (from < to) {
      const mid = Math.floor((from + to) / 2);
      const [left, right] = await Promise.all([
        getAddressScopedLogs(addresses, topics, from, mid),
        getAddressScopedLogs(addresses, topics, mid + 1, to),
      ]);
      return left.concat(right);
    }
    if (Array.isArray(addresses) && addresses.length > 1) {
      const mid = Math.floor(addresses.length / 2);
      const [left, right] = await Promise.all([
        getAddressScopedLogs(addresses.slice(0, mid), topics, from, to),
        getAddressScopedLogs(addresses.slice(mid), topics, from, to),
      ]);
      return left.concat(right);
    }
    throw e;
  }
}

async function getTopicScopedLogs(topics, from, to) {
  try {
    return await provider.getLogs({ topics, fromBlock: from, toBlock: to });
  } catch (e) {
    if (!isResponseTooLarge(e) || from >= to) throw e;
    const mid = Math.floor((from + to) / 2);
    const [left, right] = await Promise.all([
      getTopicScopedLogs(topics, from, mid),
      getTopicScopedLogs(topics, mid + 1, to),
    ]);
    return left.concat(right);
  }
}

async function indexTokenRange(from, to, opts = {}) {
  const tokens = knownTokenAddresses();
  const addrs = tokens.rows;
  if (addrs.length === 0) return 0;
  const applyState = opts.applyState !== false;
  // Do not issue one getBlock RPC for every event. A busy B20 range may
  // contain tens of thousands of transfers; interpolated block time has the
  // same display precision as the factory feed and keeps backfill moving.
  const [fromTs, toTs] = await Promise.all([blockTs(from), blockTs(to)]);
  const span = Math.max(1, to - from);
  const timestampFor = (block) => Math.round(fromTs + ((block - from) / span) * (toTs - fromTs));
  let n = 0;
  if (opts.topicFirst !== false) {
    try {
      const logs = await getTopicScopedLogs([TOKEN_TOPICS], from, to);
      for (const log of logs) {
        if (!isKnownB20Emitter(log.address, tokens.set)) continue;
        n += await insertDecodedTokenLog(log, timestampFor(log.blockNumber), applyState);
      }
      return n;
    } catch (e) {
      if (opts.fallback === false) throw e;
      console.warn(`  topic-first events failed ${from}-${to}, falling back to address scan: ${e.shortMessage || e.message}`);
    }
  }

  // Fallback path: getLogs accepts an address array; split hot ranges further
  // when Base's public RPC rejects a response as too large.
  for (let i = 0; i < addrs.length; i += TOKEN_ADDRESS_CHUNK) {
    const batch = addrs.slice(i, i + TOKEN_ADDRESS_CHUNK);
    const logs = await getAddressScopedLogs(batch, [TOKEN_TOPICS], from, to);
    for (const log of logs) {
      n += await insertDecodedTokenLog(log, timestampFor(log.blockNumber), applyState);
    }
  }
  return n;
}

async function cobaltStartBlock(head) {
  if (process.env.COBALT_START_BLOCK) return Number(process.env.COBALT_START_BLOCK);
  const saved = stmts.getMeta.get("cobalt_start_block");
  if (saved) return Number(saved.value);
  if ((await blockTs(head)) < COBALT_TIMESTAMP) return null;
  let low = START_BLOCK, high = head;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await blockTs(mid)) < COBALT_TIMESTAMP) low = mid + 1;
    else high = mid;
  }
  setCursor("cobalt_start_block", low);
  return low;
}

async function indexRegistryRange(from, to) {
  const logs = await getAddressScopedLogs(POLICY_REGISTRY, [REGISTRY_TOPICS], from, to);
  let count = 0;
  for (const log of logs) {
    const decoded = decodeRegistryLog(log);
    if (!decoded) continue;
    count += insertRegistryEvent({ kind: decoded.kind, block: log.blockNumber,
      tx: log.transactionHash, log_index: log.index, ts: await blockTs(log.blockNumber),
      args: JSON.stringify(decoded.args) }, decoded.args);
  }
  return count;
}

async function indexSeizeRange(from, to) {
  const logs = await getTopicScopedLogs([SEIZED_TOPIC], from, to);
  const tokens = knownTokenAddresses();
  let count = 0;
  for (const log of logs) {
    if (!isKnownB20Emitter(log.address, tokens.set)) continue;
    // Transfer already updates balances. Seized is evidence of the operation,
    // never a second balance change or a supply burn.
    count += await insertDecodedTokenLog(log, await blockTs(log.blockNumber), false);
  }
  return count;
}

async function drainNewStream(key, start, safeHead, chunk, indexRange, maxRanges) {
  let progress = cursor(key, start - 1);
  let processed = 0;
  while (progress < safeHead && processed < maxRanges) {
    // A manual backfill may run alongside the follower; cursors only advance.
    progress = Math.max(progress, cursor(key, start - 1));
    if (progress >= safeHead) break;
    const concurrency = maxRanges === Infinity ? 4 : 1;
    const ranges = Array.from({ length: Math.min(concurrency, Math.ceil((safeHead - progress) / chunk)) }, (_, i) => ({
      from: progress + i * chunk + 1, to: Math.min(progress + (i + 1) * chunk, safeHead),
    }));
    const counts = await Promise.all(ranges.map((range) => indexRange(range.from, range.to)));
    const to = ranges.at(-1).to;
    const count = counts.reduce((sum, n) => sum + n, 0);
    advanceCursorStmt.run(key, String(to));
    progress = to;
    processed += ranges.length;
    if (count || COBALT_BACKFILL) console.log(`  ${key} -> ${to} (+${count}, ${safeHead - to} behind)`);
  }
}

async function followCobalt(safeHead, maxRanges = 1) {
  await drainNewStream("registry_cursor", START_BLOCK, safeHead, REGISTRY_CHUNK, indexRegistryRange, maxRanges);
  const start = await cobaltStartBlock(safeHead);
  if (start != null) await drainNewStream("seize_cursor", start, safeHead, SEIZE_CHUNK, indexSeizeRange, maxRanges);
}

async function processFactoryRange(from, to) {
  await indexFactoryRange(from, to);
  setCursor("factory_cursor", to);
  // `cursor` is the public deployment cursor. It never waits on the slower
  // address-array event scan, so newly-created tokens reach the UI promptly.
  stmts.setCursor.run(String(to));
}

async function processTokenRange(from, to) {
  await indexTokenRange(from, to, { topicFirst: true, applyState: true });
  setCursor("token_cursor", to);
}

async function drainFactory(factoryCursor, safeHead) {
  while (factoryCursor < safeHead) {
    const from = factoryCursor + 1;
    const to = Math.min(from + CHUNK - 1, safeHead);
    await processFactoryRange(from, to);
    factoryCursor = to;
    console.log(`  factory -> ${to} (${safeHead - to} behind)`);
  }
  return factoryCursor;
}

async function drainTokens(tokenCursor, factoryCursor, maxRanges = Infinity) {
  let ranges = 0;
  while (tokenCursor < factoryCursor && ranges < maxRanges) {
    const from = tokenCursor + 1;
    const to = Math.min(from + TOKEN_TOPIC_CHUNK - 1, factoryCursor);
    await processTokenRange(from, to);
    tokenCursor = to;
    ranges++;
    console.log(`  events  -> ${to} (${factoryCursor - to} behind)`);
  }
  return tokenCursor;
}

async function drainLiveTokens(liveCursor, safeHead) {
  const minCursor = Math.max(START_BLOCK - 1, safeHead - LIVE_LOOKBACK);
  if (liveCursor < minCursor) liveCursor = minCursor;
  while (liveCursor < safeHead) {
    const from = liveCursor + 1;
    const to = Math.min(from + LIVE_CHUNK - 1, safeHead);
    const n = await indexTokenRange(from, to, { topicFirst: true, applyState: false });
    setCursor("live_token_cursor", to);
    liveCursor = to;
    if (n) console.log(`  live events -> ${to} (+${n})`);
  }
  return liveCursor;
}

async function main() {
  if (FILL_CREATORS) {
    while (await fillMissingCreators(100)) {}
    return;
  }
  const head = await provider.getBlockNumber();
  const safeHead = head - CONFIRMATIONS;
  const legacyCursor = Number(stmts.getCursor.get()?.value ?? START_BLOCK - 1);
  let factoryCursor = cursor("factory_cursor", legacyCursor);
  // The public deployment cursor may race far ahead of event indexing. On an
  // old database that has no dedicated event cursor yet, begin at activation
  // rather than accidentally treating the deployment cursor as complete.
  let tokenCursor = cursor("token_cursor", START_BLOCK - 1);
  let liveTokenCursor = cursor("live_token_cursor", Math.max(START_BLOCK - 1, safeHead - LIVE_LOOKBACK));

  console.log(`b20scan indexer | chain ${CHAIN_ID} | head ${head} | safe ${safeHead} | factory ${factoryCursor} | events ${tokenCursor} | live ${liveTokenCursor}`);

  if (COBALT_BACKFILL) {
    // Use only already discovered tokens. Do not race the main follower's
    // factory cursor or apply Transfer balances during this additive backfill.
    await followCobalt(Math.min(factoryCursor, safeHead), Infinity);
    console.log("Cobalt and PolicyRegistry backfill complete");
    provider.destroy();
    db.close();
    return;
  }

  // Factory first: deployments are the explorer's primary live surface. Token
  // event backfill follows on its own cursor, so a growing address array can
  // never make the deployment list look days old.
  factoryCursor = await drainFactory(factoryCursor, safeHead);
  console.log("factory backfill complete");
  await fillMissingCreators(ONCE ? 1000 : 50);
  if (!ONCE) liveTokenCursor = await drainLiveTokens(liveTokenCursor, safeHead);
  try {
    tokenCursor = await drainTokens(tokenCursor, factoryCursor, ONCE ? Infinity : 1);
    if (tokenCursor >= factoryCursor) console.log("event backfill complete");
  } catch (e) {
    console.error("event backfill failed:", e.shortMessage || e.message);
    if (ONCE) throw e;
  }
  try {
    await followCobalt(safeHead, ONCE ? Infinity : 1);
  } catch (e) {
    console.error("Cobalt backfill failed:", e.shortMessage || e.message);
    if (ONCE) throw e;
  }
  if (ONCE) return;

  // live follow
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const h = (await provider.getBlockNumber()) - CONFIRMATIONS;
      factoryCursor = await drainFactory(factoryCursor, h);
      await fillMissingCreators(25);
      liveTokenCursor = await drainLiveTokens(liveTokenCursor, h);
      tokenCursor = await drainTokens(tokenCursor, factoryCursor, 1);
      try {
        await followCobalt(h);
      } catch (e) {
        console.error("Cobalt tick failed:", e.shortMessage || e.message);
      }
    } catch (e) {
      console.error("live tick failed:", e.shortMessage || e.message);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
