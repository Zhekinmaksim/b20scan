// indexer.js - backfill + live follower for the B20 factory and its tokens.
//
//   node indexer.js               # backfill from START_BLOCK, then follow head
//   node indexer.js --once        # backfill only, exit (good for cron)
//
// Env: RPC_URL, CHAIN_ID, START_BLOCK (activation block), CHUNK (default 2000),
//      CONFIRMATIONS (default 12), POLL_MS (default 4000),
//      LIVE_CHUNK (default 25), LIVE_LOOKBACK (default 300)
//
// Reorg strategy: only blocks at depth >= CONFIRMATIONS are indexed, so no
// unwind logic is needed. The cursor in `meta` makes restarts resume in place.
// UNIQUE(tx, log_index) makes overlapping ranges idempotent.
require("dotenv").config();
const { ethers } = require("ethers");
const { FACTORY, TOPIC_CREATED, TOKEN_TOPICS, decodeCreated, decodeTokenLog } = require("./chain.js");
const { db, stmts, applyTransfer } = require("./db.js");

const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);
// First Base block at/after the B20 activation time, 2026-07-08 18:00 UTC.
// Keeping this non-zero protects a fresh mainnet install from scanning the
// entire pre-B20 chain when .env has not been configured yet.
const START_BLOCK = Number(process.env.START_BLOCK || 48372133);
const CHUNK = Number(process.env.CHUNK || 2000);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 12);
const POLL_MS = Number(process.env.POLL_MS || 4000);
const LIVE_CHUNK = Number(process.env.LIVE_CHUNK || 25);
const LIVE_LOOKBACK = Number(process.env.LIVE_LOOKBACK || 300);
const ONCE = process.argv.includes("--once");

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, {
  staticNetwork: ethers.Network.from(CHAIN_ID),
  // Base's public endpoint has an unusually strict batch limit. Disabling
  // batching avoids a single rejected batch taking down the whole indexer.
  batchMaxCount: 1,
  batchStallTime: 0,
});
const tsCache = new Map();

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
    stmts.insertToken.run({
      address: t.token, variant: t.variant, name: t.name, symbol: t.symbol,
      decimals: t.decimals, currency: t.currency, creator: null,
      block: log.blockNumber, tx: log.transactionHash, ts: timestampFor(log.blockNumber),
    });
    console.log(`+ token ${t.symbol} (${t.variant === 0 ? "ASSET" : "STABLE"}) ${t.token} @${log.blockNumber}`);
  }
  return logs.length;
}

// --- tokens: transfers, memos, admin events ---
// getLogs accepts an address array; chunk it to stay under RPC limits.
async function insertDecodedTokenLog(log, timestamp, applyState) {
  const d = decodeTokenLog(log);
  if (!d) return 0;
  const inserted = stmts.insertEvent.run({
    token: log.address, kind: d.kind, block: log.blockNumber, tx: log.transactionHash,
    log_index: log.index, ts: timestamp, args: JSON.stringify(d.args),
    applied: applyState ? 1 : 0,
  });

  if (applyState && d.kind === "Transfer") {
    const state = stmts.getEventApply.get(log.transactionHash, log.index);
    if (state && !state.applied) {
      applyTransfer(log.address, d.args.from, d.args.to, d.args.amount);
      stmts.markEventApplied.run(log.transactionHash, log.index);
    }
    else if (inserted.changes) {
      applyTransfer(log.address, d.args.from, d.args.to, d.args.amount);
      stmts.markEventApplied.run(log.transactionHash, log.index);
    }
  }

  return inserted.changes;
}

async function indexTokenRange(from, to, opts = {}) {
  const addrs = stmts.tokenAddrs.all().map((r) => r.address);
  if (addrs.length === 0) return 0;
  const addrSet = opts.topicFirst ? new Set(addrs.map((a) => a.toLowerCase())) : null;
  // Do not issue one getBlock RPC for every event. A busy B20 range may
  // contain tens of thousands of transfers; interpolated block time has the
  // same display precision as the factory feed and keeps backfill moving.
  const [fromTs, toTs] = await Promise.all([blockTs(from), blockTs(to)]);
  const span = Math.max(1, to - from);
  const timestampFor = (block) => Math.round(fromTs + ((block - from) / span) * (toTs - fromTs));
  let n = 0;
  if (opts.topicFirst) {
    const logs = await provider.getLogs({ topics: [TOKEN_TOPICS], fromBlock: from, toBlock: to });
    for (const log of logs) {
      if (!addrSet.has(log.address.toLowerCase())) continue;
      n += await insertDecodedTokenLog(log, timestampFor(log.blockNumber), Boolean(opts.applyState));
    }
    return n;
  }

  for (let i = 0; i < addrs.length; i += 100) {
    const batch = addrs.slice(i, i + 100);
    const logs = await provider.getLogs({ address: batch, topics: [TOKEN_TOPICS], fromBlock: from, toBlock: to });
    for (const log of logs) {
      n += await insertDecodedTokenLog(log, timestampFor(log.blockNumber), true);
    }
  }
  return n;
}

async function processFactoryRange(from, to) {
  await indexFactoryRange(from, to);
  setCursor("factory_cursor", to);
  // `cursor` is the public deployment cursor. It never waits on the slower
  // address-array event scan, so newly-created tokens reach the UI promptly.
  stmts.setCursor.run(String(to));
}

async function processTokenRange(from, to) {
  await indexTokenRange(from, to);
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
    const to = Math.min(from + CHUNK - 1, factoryCursor);
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

  // Factory first: deployments are the explorer's primary live surface. Token
  // event backfill follows on its own cursor, so a growing address array can
  // never make the deployment list look days old.
  factoryCursor = await drainFactory(factoryCursor, safeHead);
  console.log("factory backfill complete");
  if (!ONCE) liveTokenCursor = await drainLiveTokens(liveTokenCursor, safeHead);
  tokenCursor = await drainTokens(tokenCursor, factoryCursor, ONCE ? Infinity : 1);
  if (tokenCursor >= factoryCursor) console.log("event backfill complete");
  if (ONCE) return;

  // live follow
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const h = (await provider.getBlockNumber()) - CONFIRMATIONS;
      factoryCursor = await drainFactory(factoryCursor, h);
      liveTokenCursor = await drainLiveTokens(liveTokenCursor, h);
      tokenCursor = await drainTokens(tokenCursor, factoryCursor, 1);
    } catch (e) {
      console.error("live tick failed:", e.shortMessage || e.message);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
