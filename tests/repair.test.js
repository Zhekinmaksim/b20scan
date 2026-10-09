const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ethers } = require('ethers');
const { repair, applyPrepared } = require('../repair-balances.js');

test('ledger repair preserves supply, reconstructs missed inflows and saves old state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'b20-repair-'));
  const file = path.join(dir, 'data.db'), db = new Database(file);
  const token = ethers.getAddress('0xb200000000000000000000000000000000000001');
  const [a,b,c] = [1,2,3].map(n => ethers.getAddress('0x' + n.toString(16).padStart(40,'0')));
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE tokens(address TEXT PRIMARY KEY,total_supply TEXT,transfer_count INTEGER,holder_count INTEGER);
    CREATE TABLE holders(token TEXT,account TEXT,balance TEXT,PRIMARY KEY(token,account));
    CREATE TABLE events(token TEXT,kind TEXT,block INTEGER,log_index INTEGER,args TEXT,applied INTEGER);
    CREATE INDEX idx_events_token ON events(token,block DESC);
    CREATE INDEX idx_events_block_log ON events(block DESC,log_index DESC);`);
  db.prepare('INSERT INTO meta VALUES(?,?)').run('token_cursor','3');
  db.prepare('INSERT INTO tokens VALUES(?,?,?,?)').run(token,'10',2,5);
  db.prepare('INSERT INTO holders VALUES(?,?,?)').run(token,a,'10');
  db.prepare('INSERT INTO holders VALUES(?,?,?)').run(token,c,'2');
  const event = db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)');
  event.run(token,'Transfer',1,0,JSON.stringify({from:ethers.ZeroAddress,to:a,amount:'10'}),1);
  event.run(token,'Transfer',2,0,JSON.stringify({from:a,to:b,amount:'3'}),0);
  event.run(token,'Transfer',3,0,JSON.stringify({from:b,to:c,amount:'2'}),1);
  db.close();
  try {
    const dry = repair(file,2,{dryRun:true});
    assert.equal(dry.pending,1);
    const before = new Database(file,{readonly:true});
    assert.equal(before.prepare('SELECT balance FROM holders WHERE account=?').get(a).balance,'10');
    before.close();
    const result = applyPrepared(file,dry.backupPath,dry.cursor);
    const after = new Database(file,{readonly:true});
    assert.deepEqual(after.prepare('SELECT total_supply,transfer_count,holder_count FROM tokens').get(),
      {total_supply:'10',transfer_count:3,holder_count:3});
    assert.deepEqual(after.prepare('SELECT balance FROM holders ORDER BY account').all().map(x=>x.balance),['7','1','2']);
    assert.equal(after.prepare('SELECT count(*) n FROM events WHERE applied=0').get().n,0);
    after.close();
    const backup = new Database(result.backupPath,{readonly:true});
    assert.equal(backup.prepare('SELECT transfers FROM old_tokens').get().transfers,2);
    assert.equal(backup.prepare('SELECT balance FROM old_holders WHERE account=?').get(a).balance,'10');
    backup.close();
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('confirmed chain repair changes only pending participants and verifies the full holder sum', async () => {
  const {repairChain,applyChainSnapshot}=require('../repair-chain-balances.js');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'b20-chain-repair-'));
  const file=path.join(dir,'data.db'),db=new Database(file);
  const token=ethers.getAddress('0xb200000000000000000000000000000000000001');
  const [a,b,c]=[1,2,3].map(n=>ethers.getAddress('0x'+n.toString(16).padStart(40,'0')));
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE tokens(address TEXT PRIMARY KEY,total_supply TEXT,transfer_count INTEGER,holder_count INTEGER);
    CREATE TABLE holders(token TEXT,account TEXT,balance TEXT,PRIMARY KEY(token,account));
    CREATE TABLE events(token TEXT,kind TEXT,block INTEGER,log_index INTEGER,args TEXT,applied INTEGER);
    CREATE INDEX idx_events_token ON events(token,block DESC);
    CREATE INDEX idx_events_block_log ON events(block DESC,log_index DESC);`);
  db.prepare('INSERT INTO meta VALUES(?,?)').run('token_cursor','3');
  db.prepare('INSERT INTO tokens VALUES(?,?,?,?)').run(token,'10',2,5);
  db.prepare('INSERT INTO holders VALUES(?,?,?)').run(token,a,'10');
  db.prepare('INSERT INTO holders VALUES(?,?,?)').run(token,c,'2');
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(token,'Transfer',2,0,JSON.stringify({from:a,to:b,amount:'3'}),0);
  db.close();
  const abi=new ethers.Interface(['function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)']);
  const provider={call:async request=>{
    assert.equal(request.blockTag,3);
    const tx=abi.parseTransaction({data:request.data});
    return abi.encodeFunctionResult(tx.name,[tx.name==='totalSupply'?10n:tx.args[0]===a?7n:1n]);
  }};
  try {
    const result=await repairChain(file,2,provider);
    assert.equal(result.accounts,2);
    const after=new Database(file,{readonly:true});
    assert.deepEqual(after.prepare('SELECT balance FROM holders ORDER BY account').all().map(x=>x.balance),['7','1','2']);
    assert.deepEqual(after.prepare('SELECT total_supply,holder_count,transfer_count FROM tokens').get(),
      {total_supply:'10',holder_count:3,transfer_count:3});
    assert.equal(after.prepare('SELECT applied FROM events').get().applied,1);
    after.close();
    assert.ok(JSON.parse(await fs.readFile(result.backupPath,'utf8')).plans[0].changes[0].old);
    const reset=new Database(file);
    reset.prepare('UPDATE tokens SET total_supply=?,transfer_count=?,holder_count=?').run('10',2,5);
    reset.exec('DELETE FROM holders; UPDATE events SET applied=0');
    reset.prepare('INSERT INTO holders VALUES(?,?,?)').run(token,a,'10');
    reset.prepare('INSERT INTO holders VALUES(?,?,?)').run(token,c,'2');
    reset.close();
    assert.equal(applyChainSnapshot(file,result.backupPath).pending,1);
    const restored=new Database(file,{readonly:true});
    assert.deepEqual(restored.prepare('SELECT balance FROM holders ORDER BY account').all().map(x=>x.balance),['7','1','2']);
    assert.equal(restored.prepare('SELECT applied FROM events').get().applied,1);
    restored.close();
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
