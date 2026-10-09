const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtemp, rm, readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const express = require("express");
const Database = require("better-sqlite3");
const { ethers } = require("ethers");

process.env.DB_PATH = ":memory:";
const { db, stmts, insertEventAndMaybeApply, insertRegistryEvent } = require("../db.js");
const { tokenIface, registryIface, FACTORY, POLICY_REGISTRY, decodeTokenLog, decodeRegistryLog } = require("../chain.js");
const { mountHistory, seizureCapability } = require("../history.js");

const token = "0xb200000000000000000000000000000000000013";
const other = "0xb200000000000000000000000000000000000014";
const caller = "0x00000000000000000000000000000000000000a1";
const holder = "0x00000000000000000000000000000000000000b2";
const treasury = "0x00000000000000000000000000000000000000c3";
const zero = ethers.ZeroAddress;
const allow = ((1n << 56n) | 10n).toString();
const block = "11";
const block2 = "12";
const composite = ((3n << 56n) | 20n).toString();
let sequence = 0;

function encoded(iface, name, values, emitter, bn, index) {
  const raw = iface.encodeEventLog(iface.getEvent(name), values);
  return { ...raw, address: emitter, blockNumber: bn, index,
    transactionHash: ethers.zeroPadValue(ethers.toBeHex(++sequence), 32) };
}
function add(kind, values, bn, index = 0, emitter = token) {
  const raw = encoded(tokenIface, kind, values, emitter, bn, index);
  const decoded = decodeTokenLog(raw);
  const record = { token: emitter, kind, block: bn, tx: raw.transactionHash,
    log_index: index, ts: 1700000000 + bn, args: JSON.stringify(decoded.args) };
  insertEventAndMaybeApply(record, decoded.args, true);
  return { raw, decoded, record };
}
function registry(kind, values, bn, index = 0) {
  const raw = encoded(registryIface, kind, values, POLICY_REGISTRY, bn, index);
  const decoded = decodeRegistryLog(raw);
  const record = { kind, block: bn, tx: raw.transactionHash, log_index: index,
    ts: 1700000000 + bn, args: JSON.stringify(decoded.args) };
  return { changes: insertRegistryEvent(record, decoded.args), record, decoded, raw };
}

let api;
let apiUrl;
test.before(async () => {
  for (const address of [token, other]) stmts.insertToken.run({ address, variant: 0, name: "Cobalt <test>", symbol: "TEST", decimals: 6, currency: null, creator: caller, block: 1, tx: null, ts: 1700000001 });
  registry("PolicyCreated", [allow, caller, 1], 50);
  registry("PolicyCreated", [block, caller, 0], 51);
  registry("PolicyCreated", [block2, caller, 0], 52);
  // Live update first, historical creation/backfill later.
  registry("CompositePolicyUpdated", [composite, caller, [allow, block2]], 600);
  registry("CompositePolicyUpdated", [composite, caller, [allow, block]], 100);
  registry("PolicyCreated", [composite, caller, 3], 100, 1);
  add("RoleGranted", [ethers.id("SEIZE_ROLE"), caller, caller], 200);
  add("PolicyUpdated", [ethers.id("SEIZE_EXEMPT_POLICY"), 0, composite], 300);
  add("PolicyUpdated", [ethers.id("SEIZE_RECEIVER_POLICY"), 0, allow], 301);
  add("PolicyUpdated", [ethers.id("TRANSFER_SENDER_POLICY"), 0, composite], 302);
  add("PolicyUpdated", [ethers.id("TRANSFER_SENDER_POLICY"), 0, composite], 302, 0, other);
  add("Transfer", [zero, holder, 10000000n], 350);
  add("Transfer", [holder, zero, 1500000n], 400);
  add("BurnedBlocked", [caller, holder, 1500000n], 400, 1);
  add("Transfer", [holder, treasury, 1250001n], 401);
  add("Seized", [caller, holder, treasury, 1250001n], 401, 2);
  const app = express();
  mountHistory(app, db);
  api = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => api.once("listening", resolve));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
});
test.after(async () => { await new Promise((resolve) => api.close(resolve)); db.close(); });
async function get(url) { const response = await fetch(apiUrl + url); assert.equal(response.status, 200); return response.json(); }

test("canonical event topics and ABI decoding preserve uint256/uint64 precision", () => {
  assert.equal(tokenIface.getEvent("Seized").topicHash, "0xa9aec5d8b86e2fa2fd6ac3af62f2622e3dfdab1967d4cbbb56a5df7d74cb887c");
  assert.equal(registryIface.getEvent("PolicyCreated").topicHash, "0x718d87917f0c4cfd1263707ef0e77c656ed8d8bfaca06152bdb0b8094142ec27");
  assert.equal(registryIface.getEvent("CompositePolicyUpdated").topicHash, "0x4ff6adaab31b0df87aa7b8b7320c52b8b3b5eede3bf28a6baaaa8b8b7e1d6363");
  const amount = 2n ** 200n;
  const log = encoded(tokenIface, "Seized", [caller, holder, treasury, amount], token, 1, 0);
  assert.equal(decodeTokenLog(log).args.amount, amount.toString());
  assert.equal(decodeTokenLog(log).args.to.toLowerCase(), treasury);
  assert.equal(decodeRegistryLog(log), null);
});

test("seize and legacy burns merge, paginate and retain fractional amounts", async () => {
  const first = await get(`/api/token/${token}/seizures?limit=1`);
  assert.equal(first.status, "enforced");
  assert.equal(first.total_seizures, 2);
  assert.equal(first.currently_armed, true);
  assert.equal(first.items[0].method, "seize");
  assert.equal(first.items[0].to.toLowerCase(), treasury);
  assert.equal(first.items[0].amount_display, "1.250001");
  assert.equal(first.nextCursor, "401:2");
  const second = await get(`/api/token/${token}/seizures?limit=1&cursor=${first.nextCursor}`);
  assert.equal(second.items[0].method, "burnBlocked");
  assert.equal(second.items[0].to, null);
  assert.equal(second.items[0].amount_display, "1.5");
  assert.equal(second.nextCursor, null);
  const state = db.prepare("SELECT total_supply,transfer_count FROM tokens WHERE address=?").get(token);
  assert.equal(state.total_supply, "8500000");
  assert.equal(state.transfer_count, 3); // dedicated Seized never applies again
  assert.equal(db.prepare("SELECT balance FROM holders WHERE token=? AND account=?").get(token, ethers.getAddress(treasury)).balance, "1250001");
  const supply = await get(`/api/token/${token}/supply/history`);
  assert.deepEqual(supply.items.map((x) => [x.type, x.amount_display]), [["burn", "1.5"], ["mint", "10.0"]]);
});

test("global composite state is shared, latest update wins and scopes stay independent", async () => {
  const data = await get(`/api/token/${token}/policy`);
  assert.equal(data.current_detail.type, "INTERSECT");
  assert.deepEqual(data.current_detail.composite.children.map((x) => x.type), ["ALLOWLIST", "BLOCKLIST"]);
  assert.deepEqual(data.current_detail.composite.children.map((x) => x.policy_id), [allow, block2]);
  assert.equal(data.current_detail.composite.updated_block, 600);
  assert.equal(data.current_scopes.length, 3);
  const shared = await get(`/api/token/${other}/policy`);
  assert.deepEqual(shared.current_detail, data.current_detail);
  add("PolicyUpdated", [ethers.id("SEIZE_RECEIVER_POLICY"), allow, 0], 700);
  const after = await get(`/api/token/${token}/policy`);
  assert.equal(after.current.bound, false);
  assert.equal(after.has_policy, true); // clearing one scope does not clear others
  const page = await get(`/api/token/${other}/history?category=policy&limit=1`);
  assert.equal(page.items[0].kind, "CompositePolicyUpdated");
  const next = await get(`/api/token/${other}/history?category=policy&cursor=${page.nextCursor}`);
  assert.ok(next.items.some((x) => x.kind === "PolicyUpdated"));
  assert.ok(next.items.some((x) => x.kind === "PolicyCreated"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE kind='CompositePolicyUpdated'").get().n, 0);
});

test("current seizure configuration honors exact scopes, revoked roles and pause", () => {
  add("RoleGranted", [ethers.id("SEIZE_ROLE"), caller, caller], 800, 0, other);
  assert.equal(seizureCapability(db, other).status, "none"); // transfer policy is not seize exempt
  add("PolicyUpdated", [ethers.id("SEIZE_EXEMPT_POLICY"), 0, composite], 801, 0, other);
  assert.equal(seizureCapability(db, other).status, "armed");
  add("Paused", [caller, [3]], 802, 0, other);
  assert.equal(seizureCapability(db, other).currently_armed, false);
  add("Unpaused", [caller, [3]], 803, 0, other);
  assert.equal(seizureCapability(db, other).currently_armed, true);
  add("RoleRevoked", [ethers.id("SEIZE_ROLE"), caller, caller], 804, 0, other);
  assert.equal(seizureCapability(db, other).status, "none");
  add("RoleRevoked", [ethers.id("SEIZE_ROLE"), caller, caller], 805);
  assert.equal(seizureCapability(db, token).status, "enforced");
  assert.equal(seizureCapability(db, token).currently_armed, false);
});

test("issuer admin materialization uses canonical token events across grant, revoke and regrant", () => {
  const role = ethers.ZeroHash;
  const state = () => db.prepare("SELECT admin_active FROM tokens WHERE address=?").get(other).admin_active;
  add("RoleGranted", [role, caller, caller], 900, 0, other);
  assert.equal(state(), 1);
  add("RoleRevoked", [role, caller, caller], 901, 0, other);
  assert.equal(state(), 0);
  add("RoleGranted", [role, caller, caller], 902, 0, other);
  assert.equal(state(), 1);
});

test("real indexer backfills separate Registry and Seized streams through JSON-RPC", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "b20scan-cobalt-test-"));
  const dbPath = path.join(dir, "test.db");
  await db.backup(dbPath);
  const fixture = new Database(dbPath);
  fixture.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('factory_cursor','1021')").run();
  fixture.close();
  const newId = ((2n << 56n) | 99n).toString();
  const logs = [
    encoded(registryIface, "PolicyCreated", [newId, caller, 2], POLICY_REGISTRY, 1012, 0),
    encoded(registryIface, "CompositePolicyUpdated", [newId, caller, [allow, block]], POLICY_REGISTRY, 1012, 1),
    encoded(tokenIface, "Seized", [caller, holder, treasury, 1n], token, 1013, 2),
    encoded(tokenIface, "Transfer", [zero, treasury, 1250000n], token, 1024, 0),
    encoded(tokenIface, "Transfer", [treasury, holder, 500000n], token, 1025, 0),
  ];
  let registryCalls = 0, seizeCalls = 0, splits = 0;
  const rpc = http.createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const call = JSON.parse(text);
    let result;
    if (call.method === "eth_chainId") result = ethers.toQuantity(8453);
    else if (call.method === "eth_blockNumber") result = ethers.toQuantity(1030);
    else if (call.method === "eth_getBlockByNumber") {
      const bn = Number(call.params[0]);
      result = { number: ethers.toQuantity(bn), hash: ethers.ZeroHash, parentHash: ethers.ZeroHash,
        timestamp: ethers.toQuantity(1700000000 + bn), nonce: "0x0000000000000000", difficulty: "0x0",
        gasLimit: "0x1c9c380", gasUsed: "0x0", miner: zero, extraData: "0x", transactions: [] };
    } else if (call.method === "eth_getLogs") {
      const filter = call.params[0];
      const from = Number(filter.fromBlock), to = Number(filter.toBlock);
      if (to - from > 4) {
        splits++;
        res.statusCode = 413;
        res.end(JSON.stringify({ error: "Payload Too Large" }));
        return;
      }
      if (filter.address && filter.address.toLowerCase() !== FACTORY.toLowerCase()) { assert.equal(filter.address.toLowerCase(), POLICY_REGISTRY.toLowerCase()); registryCalls++; }
      else seizeCalls++;
      const topics = Array.isArray(filter.topics[0]) ? filter.topics[0] : [filter.topics[0]];
      result = logs.filter((log) => log.blockNumber >= from && log.blockNumber <= to && topics.includes(log.topics[0]))
        .map((log) => ({ address: log.address, topics: log.topics, data: log.data, blockNumber: ethers.toQuantity(log.blockNumber),
          blockHash: ethers.ZeroHash, transactionHash: log.transactionHash, transactionIndex: "0x0", logIndex: ethers.toQuantity(log.index), removed: false }));
    } else throw new Error(`Unexpected RPC ${call.method}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  await new Promise((resolve) => rpc.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, ["indexer.js", "--cobalt-backfill"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, DB_PATH: dbPath, RPC_URL: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACK_URLS: "", START_BLOCK: "1000", COBALT_START_BLOCK: "1010", CONFIRMATIONS: "0", REGISTRY_CHUNK: "10", SEIZE_CHUNK: "10" },
    });
    let output = "";
    child.stdout.on("data", (part) => output += part);
    child.stderr.on("data", (part) => output += part);
    const timer = setTimeout(() => child.kill(), 15000);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(timer);
    assert.equal(code, 0, output);
    assert.ok(registryCalls > 0 && seizeCalls > 0 && splits > 0);
    const check = new Database(dbPath, { readonly: true });
    assert.equal(check.prepare("SELECT child_policy_ids FROM policy_state WHERE policy_id=?").get(newId).child_policy_ids, JSON.stringify([allow, block]));
    assert.equal(check.prepare("SELECT count(*) n FROM events WHERE tx=? AND kind='Seized'").get(logs[2].transactionHash).n, 1);
    assert.equal(check.prepare("SELECT value FROM meta WHERE key='registry_cursor'").get().value, "1021");
    assert.equal(check.prepare("SELECT value FROM meta WHERE key='seize_cursor'").get().value, "1021");
    check.close();
    // Full catch-up applies ordered Transfer batches exactly once, including
    // the normal follower path rather than only the additive Cobalt stream.
    const follower = spawn(process.execPath, ["indexer.js", "--once"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, DB_PATH: dbPath, RPC_URL: `http://127.0.0.1:${rpc.address().port}`,
        RPC_FALLBACK_URLS: "", START_BLOCK: "1000", COBALT_START_BLOCK: "1010", CONFIRMATIONS: "0", TOKEN_TOPIC_CHUNK: "10" },
    });
    let followerOutput = "";
    follower.stdout.on("data", part => followerOutput += part);
    follower.stderr.on("data", part => followerOutput += part);
    const followerTimer = setTimeout(() => follower.kill(), 15000);
    const followerCode = await new Promise(resolve => follower.once("exit", resolve));
    clearTimeout(followerTimer);
    assert.equal(followerCode, 0, followerOutput);
    const caughtUp = new Database(dbPath, { readonly: true });
    assert.equal(caughtUp.prepare("SELECT total_supply FROM tokens WHERE address=?").get(token).total_supply, "9750000");
    assert.equal(caughtUp.prepare("SELECT transfer_count FROM tokens WHERE address=?").get(token).transfer_count, 5);
    assert.equal(caughtUp.prepare("SELECT value FROM meta WHERE key='token_cursor'").get().value, "1030");
    caughtUp.close();
  } finally { await new Promise((resolve) => rpc.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test("browser script parses after Cobalt rendering changes", async () => {
  const html = await readFile(path.join(__dirname, "../public/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  for (const [, code] of scripts) new (require("node:vm").Script)(code);
});
