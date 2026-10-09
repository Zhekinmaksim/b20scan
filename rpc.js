// Shared read-only RPC transport. A throttled public node must not stall the
// indexer for ethers' default five-minute retry window.
const { ethers } = require('ethers');

function matchesLogFilter(log, filter) {
  const addresses = filter.address == null ? null : [filter.address].flat().map(a => a.toLowerCase());
  if (addresses && !addresses.includes(String(log.address).toLowerCase())) return false;
  const block = Number(log.blockNumber), from = Number(filter.fromBlock), to = Number(filter.toBlock);
  if ((Number.isFinite(from) && block < from) || (Number.isFinite(to) && block > to) || log.removed) return false;
  return (filter.topics || []).every((topic, i) => topic == null || [topic].flat()
    .some(value => value == null || value.toLowerCase() === String(log.topics?.[i]).toLowerCase()));
}

function isLogRangeError(error) {
  const text = [error?.message, error?.shortMessage, error?.error?.message,
    error?.info?.error?.message, error?.info?.responseBody].filter(Boolean).join(' ');
  return /response too large|payload too large|\b413\b|too many results|result count exceeds|query (?:exceeds|returned more than).*results|response size.*(?:exceed|limit)|block range.*(?:too large|exceed)|up to (?:a )?\d+ block range|ranges over \d+ blocks|maximum allowed is \d+ blocks|limited to.*blocks range/i.test(text);
}

function createRpcProvider({ url = process.env.RPC_URL || 'https://mainnet.base.org',
  fallbacks = (process.env.RPC_FALLBACK_URLS || '').split(','), chainId = 8453,
  timeout = Number(process.env.RPC_TIMEOUT_MS || 8000),
  cooldown = Number(process.env.RPC_COOLDOWN_MS || 60000),
  concurrency = Number(process.env.RPC_CONCURRENCY || 4), logAddressPrefix = null, warn = console.warn } = {}) {
  const endpoints = [...new Set([url, ...fallbacks].map(x => x.trim()).filter(Boolean))]
    .map(url => ({ url, failedUntil: new Map(), chainChecked: false }));
  const preferred = new Map();
  let active = 0;
  const queue = [];
  async function acquire() {
    if (active >= Math.max(1, concurrency)) await new Promise(resolve => queue.push(resolve));
    else active++;
  }
  function release() {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
  function fail(endpoint, method, reason) {
    endpoint.failedUntil.set(method, Date.now() + cooldown);
    warn(`RPC ${new URL(endpoint.url).hostname} ${method}: ${reason}; trying backup`);
  }
  async function request(endpoint, payload, signal) {
    const controller = new AbortController();
    signal?.addListener(() => controller.abort());
    signal?.checkSignal();
    const response = await fetch(endpoint.url, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let json;
    try { json = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch {}
    return { response, bytes, json };
  }
  const fetchRequest = new ethers.FetchRequest(url);
  fetchRequest.timeout = timeout * endpoints.length + 1000;
  // Failover is bounded and handled below, not by exponential HTTP 429 retries.
  fetchRequest.retryFunc = async () => false;
  fetchRequest.getUrlFunc = async (req, signal) => {
    const payload = JSON.parse(Buffer.from(req.body).toString('utf8'));
    const method = payload.method;
    await acquire();
    try {
      const first = preferred.get(method);
      const ordered = first ? [first, ...endpoints.filter(e => e !== first)] : endpoints;
      const available = ordered.filter(e => (e.failedUntil.get(method) || 0) <= Date.now());
      if (!available.length) throw new Error(`All RPC endpoints are cooling down for ${method}`);
      for (const endpoint of available) {
        try {
          if (!endpoint.chainChecked) {
            const check = await request(endpoint, { jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] }, signal);
            if (!check.response.ok || Number(check.json?.result) !== chainId) {
              fail(endpoint, method, 'chain check failed');
              continue;
            }
            endpoint.chainChecked = true;
          }
          const result = await request(endpoint, payload, signal);
          const error = result.json?.error;
          const text = error?.message || '';
          const rangeMessage = text || (typeof error === 'string' ? error : '')
            || (result.response.status === 413 ? 'payload too large' : '');
          if (method === 'eth_getLogs' && isLogRangeError({ message: rangeMessage })) {
            // This is a request-size limit, not an outage. Split immediately
            // instead of spending every backup's free quota on the same range.
            return { statusCode: 200, statusMessage: 'OK', headers: {},
              body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
                error: { code: error?.code || -32005, message: rangeMessage } })) };
          }
          const transient = [401, 403, 408, 429].includes(result.response.status)
            || result.response.status >= 500 || !result.json
            || /rate limit|request limit|too many requests|temporarily unavailable|timeout|cu limit|archive requests require|historical state is not available|missing trie node|header not found|unknown block|block not found/i.test(text)
            || (method === 'eth_getBlockByNumber' && result.json?.result === null)
            || (method === 'eth_getLogs' && !payload.params?.[0]?.address
              && /missing required field.*address|address.*required|must.*address/i.test(text));
          if (transient) {
            fail(endpoint, method, `HTTP ${result.response.status}${error ? ' / ' + error.code : ''}`);
            continue;
          }
          if (!result.response.ok) {
            fail(endpoint, method, `HTTP ${result.response.status}`);
            continue;
          }
          if (method === 'eth_getLogs' && Array.isArray(result.json?.result)) {
            const filter = payload.params?.[0] || {};
            if (result.json.result.some(log => !matchesLogFilter(log, filter))) {
              fail(endpoint, method, 'response violates log filter');
              continue;
            }
            if (result.json.result.length >= 10000 && Number(filter.toBlock) > Number(filter.fromBlock)) {
              return { statusCode: 200, statusMessage: 'OK', headers: {},
                body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
                  error: { code: -32005, message: 'log response size exceeds safe result limit; split the range' } })) };
            }
          }
          // Reverts and invalid arguments are real RPC results, not outages.
          preferred.set(method, endpoint);
          let bytes = result.bytes;
          if (method === 'eth_getLogs' && logAddressPrefix && !payload.params?.[0]?.address
              && Array.isArray(result.json?.result)) {
            // Topic-scoped Transfer queries include all ERC-20s on Base. Drop
            // irrelevant emitters before ethers checksum/formats every log.
            // Address-scoped registry queries are never filtered.
            const prefix = logAddressPrefix.toLowerCase();
            bytes = Buffer.from(JSON.stringify({ ...result.json, result: result.json.result
              .filter(log => String(log.address).toLowerCase().startsWith(prefix)) }));
          }
          return { statusCode: result.response.status, statusMessage: result.response.statusText,
            headers: Object.fromEntries(result.response.headers), body: bytes };
        } catch (error) {
          signal?.checkSignal();
          fail(endpoint, method, error.name || 'network error');
        }
      }
      throw new Error(`All RPC endpoints failed for ${method}`);
    } finally { release(); }
  };
  return new ethers.JsonRpcProvider(fetchRequest, chainId, {
    staticNetwork: ethers.Network.from(chainId), batchMaxCount: 1, batchStallTime: 0,
  });
}

module.exports = { createRpcProvider, isLogRangeError, matchesLogFilter };
