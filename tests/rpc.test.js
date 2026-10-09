const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRpcProvider, isLogRangeError } = require('../rpc.js');

async function fixture(t, handler, chain = '0x2105') {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    const reply = (result, error, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, ...(error ? { error } : { result }) }));
    };
    if (payload.method === 'eth_chainId') reply(chain);
    else await handler(payload, reply);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
function provider(t, url, fallbacks, options = {}) {
  const p = createRpcProvider({ url, fallbacks, warn: () => {}, timeout: 1000, ...options });
  t.after(() => p.destroy());
  return p;
}

test('HTTP 429 switches immediately and sticks to a healthy backup', async t => {
  let primaryCalls = 0, backupCalls = 0;
  const primary = await fixture(t, (_, reply) => { primaryCalls++; reply(null, { code: -32011, message: 'request limit reached' }, 429); });
  const backup = await fixture(t, (_, reply) => { backupCalls++; reply('0x1234'); });
  const p = provider(t, primary, [backup]);
  assert.equal(await p.send('eth_blockNumber', []), '0x1234');
  assert.equal(await p.send('eth_blockNumber', []), '0x1234');
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 2);
});

test('hung upstream times out and wrong chain never supplies data', async t => {
  let wrongCalls = 0;
  const hung = await fixture(t, () => {});
  const wrong = await fixture(t, (_, reply) => { wrongCalls++; reply('0x999'); }, '0x1');
  const healthy = await fixture(t, (_, reply) => reply('0x1234'));
  const p = provider(t, hung, [wrong, healthy], { timeout: 100 });
  assert.equal(await p.send('eth_blockNumber', []), '0x1234');
  assert.equal(wrongCalls, 0);
});

test('rate limits in HTTP 200 JSON-RPC errors also fail over', async t => {
  const primary = await fixture(t, (_, reply) => reply(null, { code: -32005, message: 'rate limit exceeded' }));
  const backup = await fixture(t, (_, reply) => reply('0x1234'));
  assert.equal(await provider(t, primary, [backup]).send('eth_blockNumber', []), '0x1234');
});

test('pruned historical state switches to an archive-capable backup', async t => {
  const primary = await fixture(t, (_, reply) => reply(null, { code: -32000, message: 'historical state is not available' }));
  const backup = await fixture(t, (_, reply) => reply([]));
  assert.deepEqual(await provider(t, primary, [backup]).getLogs({ fromBlock: 1, toBlock: 10 }), []);
});

test('an RPC requiring explicit addresses is skipped for topic-only log queries', async t => {
  const primary = await fixture(t, (_, reply) => reply(null,
    { code: -32602, message: "invalid argument 0: missing required field 'address' for log filter" }));
  const backup = await fixture(t, (_, reply) => reply([]));
  assert.deepEqual(await provider(t, primary, [backup]).getLogs({ fromBlock: 1, toBlock: 10 }), []);
});

test('health does not hide unfinished event or policy backfill behind fresh deployments', () => {
  const { healthLag } = require('../health.js');
  const cursors = { factoryCursor: 1000, eventCursor: 200, liveCursor: 1000, registryCursor: 990, seizeCursor: 900 };
  assert.equal(healthLag(1012, cursors).lagBlocks, 812);
  assert.equal(healthLag(1012, cursors).status, 'lagging');
  cursors.eventCursor = cursors.seizeCursor = 1000;
  assert.equal(healthLag(1012, cursors).status, 'synced');
});

test('range limits survive failover and smaller requests remain usable', async t => {
  const endpoint = await fixture(t, (payload, reply) => {
    const filter = payload.params[0];
    if (Number(filter.toBlock) - Number(filter.fromBlock) > 9) reply(null,
      { code: -32600, message: 'You can make eth_getLogs requests with up to a 10 block range.' }, 400);
    else reply([]);
  });
  const p = provider(t, endpoint, []);
  await assert.rejects(p.getLogs({ fromBlock: 1, toBlock: 100 }), isLogRangeError);
  assert.deepEqual(await p.getLogs({ fromBlock: 1, toBlock: 10 }), []);
});

test('a result-count cap is recognized as a splittable range, not an outage', async t => {
  const endpoint = await fixture(t, (_, reply) => reply(null,
    { code: -32602, message: 'query exceeds max results 20000, retry with the range 10-50' }));
  await assert.rejects(provider(t, endpoint, []).getLogs({ fromBlock: 10, toBlock: 100 }), isLogRangeError);
});

test('raw log prefix filtering preserves B20 logs and leaves address-scoped registry queries alone', async t => {
  const zeroHash = '0x' + '00'.repeat(32);
  const logs = ['0xb200000000000000000000000000000000000001', '0x8453000000000000000000000000000000000002']
    .map((address, i) => ({ address, blockHash: zeroHash, blockNumber: '0xa',
      transactionHash: zeroHash, transactionIndex: '0x0', logIndex: '0x' + i,
      removed: false, topics: [], data: '0x' }));
  const endpoint = await fixture(t, (payload, reply) => reply(payload.params?.[0]?.address
    ? logs.filter(log => log.address === payload.params[0].address) : logs));
  const p = provider(t, endpoint, [], { logAddressPrefix: '0xb200' });
  const tokenLogs = await p.getLogs({ fromBlock: 10, toBlock: 10 });
  assert.equal(tokenLogs.length, 1);
  assert.equal(tokenLogs[0].address.toLowerCase(), logs[0].address);
  assert.equal((await p.getLogs({ address: logs[1].address, fromBlock: 10, toBlock: 10 }))[0].address.toLowerCase(), logs[1].address);
});

test('log responses must match emitter, topic and block range', () => {
  const { matchesLogFilter } = require('../rpc.js');
  const log = { address: '0xabc', blockNumber: '0xa', topics: ['0x11'], removed: false };
  assert.equal(matchesLogFilter(log, { address: '0xABC', fromBlock: '0x9', toBlock: '0xb', topics: [['0x11','0x22']] }), true);
  assert.equal(matchesLogFilter(log, { topics: ['0x22'] }), false);
  assert.equal(matchesLogFilter(log, { fromBlock: '0xb' }), false);
  assert.equal(matchesLogFilter(log, { address: '0xdef' }), false);
});

test('contract reverts are not treated as an upstream outage', async t => {
  let backupCalls = 0;
  const primary = await fixture(t, (_, reply) => reply(null, { code: 3, message: 'execution reverted', data: '0x' }));
  const backup = await fixture(t, (_, reply) => { backupCalls++; reply('0x'); });
  await assert.rejects(provider(t, primary, [backup]).send('eth_call', []));
  assert.equal(backupCalls, 0);
});

test('parallel range splits cannot exceed the configured transport concurrency', async t => {
  let active = 0, maximum = 0;
  const endpoint = await fixture(t, async (_, reply) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    reply('0x1234');
  });
  const p = provider(t, endpoint, [], { concurrency: 2 });
  await Promise.all(Array.from({ length: 8 }, () => p.send('eth_blockNumber', [])));
  assert.equal(maximum, 2);
});

test('all unavailable RPCs fail cleanly without leaking endpoint credentials', async t => {
  const endpoint = await fixture(t, (_, reply) => reply(null, { code: -32011, message: 'request limit reached' }, 429));
  const p = provider(t, endpoint, []);
  await assert.rejects(p.send('eth_blockNumber', []), error => /All RPC endpoints failed/.test(error.message));
  await assert.rejects(p.send('eth_blockNumber', []), error => /cooling down/.test(error.message));
});
