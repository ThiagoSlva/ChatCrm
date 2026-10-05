'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const backup = require('../scripts/database-backup');
const { parseArguments } = require('../scripts/backup-database');
const auto = new Set(['cl_users','cl_departments','cl_visitors','cl_chat_conversations','cl_contacts','cl_opportunities','cl_portal_accounts','cl_campaigns']);
const clone = value => JSON.parse(JSON.stringify(value));
function cleanupOwned(dir) {
  const resolved = fs.realpathSync(dir), temporaryRoot = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert.match(path.basename(resolved), /^chatcrm-backup-(test|cli)-/);
  fs.rmSync(resolved, { recursive: true, force: true });
}
function snapshot() {
  const payload = { schemaVersion: 9, createdAt: '2026-10-05T12:00:00.000Z', tables: backup.definitions.map(d =>
    ({ name: d.name, columns: [...d.columns], nextId: auto.has(d.name) ? 1 : null, rows: d.name === 'cl_schema' ? [[1,9]] : [] })) };
  return sign({ format: 'conversa-livre-database', version: 1, payload, sha256: '' });
}
function sign(s) { s.sha256 = crypto.createHash('sha256').update(JSON.stringify(s.payload)).digest('hex'); return s; }
function model(s = snapshot()) {
  const tables = clone(s.payload.tables), calls = [];
  let saved, inTransaction = false, fault = null, raced = false;
  const metadata = () => tables.map(t => ({ name: t.name, engine: 'InnoDB', nextId: t.nextId }));
  const c = {
    query: async sql => {
      calls.push(sql);
      if (sql === 'START TRANSACTION' || sql.startsWith('START TRANSACTION READ ONLY')) { saved = clone(tables); inTransaction = true; return [[]]; }
      if (sql === 'COMMIT') { inTransaction = false; if (fault === 'commit-response') throw Error('lost COMMIT response'); return [[]]; }
      if (sql === 'ROLLBACK') { if (inTransaction) tables.splice(0, tables.length, ...saved); inTransaction = false; return [[]]; }
      if (/^(SET SESSION|SET TRANSACTION)/.test(sql)) return [[]];
      if (sql.startsWith('SELECT id, version FROM cl_schema WHERE')) {
        if (raced) tables[1].rows.push([1,'concurrent first-access']);
        return [[{ id: 1, version: 9 }]];
      }
      if (sql.startsWith('SELECT 1 AS present FROM')) {
        const name = /FROM `(\w+)`/.exec(sql)[1]; return [tables.find(t => t.name === name).rows.length ? [{ present: 1 }] : []];
      }
      if (sql.startsWith('ALTER TABLE')) { const [,name,value] = /^ALTER TABLE `(\w+)` AUTO_INCREMENT = (\d+)$/.exec(sql); tables.find(t => t.name === name).nextId = Number(value); return [[]]; }
      if (sql.includes(' ORDER BY ')) {
        const [,name] = /FROM `(\w+)`/.exec(sql), [,limit,offset] = /LIMIT (\d+) OFFSET (\d+)$/.exec(sql), t = tables.find(t => t.name === name);
        return [t.rows.slice(Number(offset), Number(offset) + Number(limit)).map(row => Object.fromEntries(t.columns.map((field,i) => [field,row[i]])))];
      }
      throw Error('Unexpected query');
    },
    execute: async (sql, values) => {
      calls.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: fault === 'busy' ? 0 : 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('INSERT INTO')) {
        const name = /INSERT INTO `(\w+)`/.exec(sql)[1];
        if (fault === name) throw Error('Controlled insert failure');
        tables.find(t => t.name === name).rows.push(clone(values)); return [{ affectedRows: 1 }];
      }
      throw Error('Unexpected execute');
    }
  };
  return { c, tables, calls, validate: async () => metadata(), fault: value => { fault = value; }, race: () => { raced = true; } };
}

test('snapshot contract refuses corruption, SQL identifiers, incompatible schema, unknown fields and nested values before SQL', async () => {
  for (const mutate of [s => s.sha256 = 'a'.repeat(64), s => s.payload.schemaVersion = 8,
    s => s.sql = 'DROP DATABASE', s => s.payload.tables.reverse(), s => s.payload.tables[1].columns = ['id; DROP TABLE cl_users','name'],
    s => s.payload.tables[0].rows = [[1,8]], s => s.payload.tables[0].rows = [[1,9,0]],
    s => s.payload.tables[1].rows = [[1,{ password: 'nested' }]], s => s.payload.tables[2].nextId = null,
    s => s.payload.tables[1].nextId = 42, s => s.payload.tables[2].nextId = 0,
    s => s.payload.tables[2].rows = [[42,'a','b','hash','admin',1,'date']],
    s => s.payload.tables[2].nextId = 4294967297, s => s.payload.createdAt = 'not-a-date']) {
    const s = snapshot(); mutate(s);
    if (s.sha256 !== 'a'.repeat(64)) sign(s);
    const f = model(); await assert.rejects(backup.restoreSnapshot(f.c,s,{ validate:f.validate })); assert.equal(f.calls.length,0);
  }
});

test('read-only capture uses consistent snapshot, paginates and always releases owned lock', async () => {
  const f = model(); const s = await backup.captureSnapshot(f.c,{ validate:f.validate, now:()=>new Date('2026-10-05T12:00:00Z') });
  assert.deepEqual(s,snapshot()); assert(f.calls.includes('START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT'));
  assert(f.calls.some(sql => /LIMIT 200 OFFSET 0$/.test(sql))); assert(f.calls.includes('ROLLBACK'));
  assert(f.calls.at(-1).includes('RELEASE_LOCK')); assert(!f.calls.some(sql => /^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)/.test(sql)));
});

test('failed capture rolls back and releases; busy migration does not start a transaction', async () => {
  const f = model(); await assert.rejects(backup.captureSnapshot(f.c,{ validate:async()=>{ throw Error('Invalid schema'); } }));
  assert(f.calls.includes('ROLLBACK')); assert(f.calls.at(-1).includes('RELEASE_LOCK'));
  const g=model();g.fault('busy');await assert.rejects(backup.captureSnapshot(g.c,{validate:g.validate}),{code:'database-busy'});
  assert.equal(g.calls.length,1);
});

test('incorrect base column types fail before reading private records',async()=>{
  const seen=[];
  const c={query:async sql=>{
    seen.push(sql);
    if(sql==='SHOW TABLES')return[backup.definitions.map(d=>({name:d.name}))];
    if(sql==='SELECT id, version FROM cl_schema')return[[{id:1,version:9}]];
    if(sql.includes('information_schema.TABLES'))return[backup.definitions.map(d=>({name:d.name,engine:'InnoDB',nextId:auto.has(d.name)?1:null}))];
    if(sql==='SHOW TRIGGERS')return[[]];
    if(sql==='SHOW FULL COLUMNS FROM `cl_schema`')return[[{Field:'id',Type:'varchar(100)',Null:'NO'},{Field:'version',Type:'int unsigned',Null:'NO'}]];
    throw Error('Private records must not be read');
  }};
  await assert.rejects(backup.validateDatabase(c),{code:'database-incompatible'});
  assert(!seen.some(sql=>sql.includes('FROM `cl_users`')));
});

test('unsafe driver conversion and too many rows cannot silently produce a backup', async () => {
  const f = model(); f.tables[1].rows = [[1,new Date()]];
  await assert.rejects(backup.captureSnapshot(f.c,{validate:f.validate}),{code:'backup-invalid'});
  const g = model();g.tables[1].rows = Array.from({length:backup.MAX_ROWS},(_,i)=>[i+1,'synthetic']);
  await assert.rejects(backup.captureSnapshot(g.c,{validate:g.validate}),{code:'backup-too-large'});
  assert(g.calls.some(sql=>/OFFSET 200$/.test(sql))); assert(g.calls.at(-1).includes('RELEASE_LOCK'));
});

test('oversized artifact is refused offline',()=>{
  const s=snapshot();s.payload.tables[1].rows=[[1,'x'.repeat(backup.MAX_BYTES)]];sign(s);
  assert.throws(()=>backup.validateSnapshot(s),{code:'backup-too-large'});
});

test('occupied target including only a quota row refuses before counters or records change',async()=>{
  for(const index of [1,2,3,9,16]){
    const f=model();f.tables[index].rows.push(Array(f.tables[index].columns.length).fill('existing'));
    await assert.rejects(backup.restoreSnapshot(f.c,snapshot(),{validate:f.validate}),{code:'restore-target-not-empty'});
    assert(!f.calls.some(sql=>/^(INSERT|ALTER|DELETE|UPDATE|DROP|TRUNCATE)/.test(sql)));
  }
});

test('restore rechecks emptiness under marker lock, commits parameterized data and revokes sessions',async()=>{
  const s=snapshot();s.payload.tables[1].rows=[[1,"Unicode 😃 'quotes'\nline"]];
  s.payload.tables[3].rows=[['a'.repeat(64),7,'2099-01-01 00:00:00']];s.payload.tables[16].rows=[['b'.repeat(64),14,'2099-01-01 00:00:00']];sign(s);
  const f=model();const result=await backup.restoreSnapshot(f.c,s,{validate:f.validate});
  assert.equal(result.revokedSessions,2);assert.equal(result.rowsRestored,1);assert.deepEqual(f.tables[1].rows,s.payload.tables[1].rows);
  assert.equal(f.tables[3].rows.length,0);assert.equal(f.tables[16].rows.length,0);
  assert(f.calls.some(sql=>sql.endsWith('FOR UPDATE')));assert(f.calls.some(sql=>sql.startsWith('INSERT INTO')&&sql.endsWith('VALUES (?,?)')));
  assert(!f.calls.some(sql=>sql.includes('Unicode')));assert(f.calls.includes('COMMIT'));
  const g=model();g.race();await assert.rejects(backup.restoreSnapshot(g.c,s,{validate:g.validate}),{code:'restore-target-not-empty'});assert(!g.calls.some(sql=>sql.startsWith('INSERT INTO')));
});

test('insert failure rolls back all transactional data; counter DDL remains explicit and retry stays safe',async()=>{
  const s=snapshot();s.payload.tables[1].rows=[[1,'synthetic']];s.payload.tables[2].nextId=42;
  s.payload.tables[2].rows=[[7,'synthetic','test@example.test','hash','admin',1,'date']];sign(s);
  const f=model();f.fault('cl_users');await assert.rejects(backup.restoreSnapshot(f.c,s,{validate:f.validate}));
  assert.equal(f.tables[1].rows.length,0);assert.equal(f.tables[2].nextId,42);assert(f.calls.includes('ROLLBACK'));
  f.fault(null);await backup.restoreSnapshot(f.c,s,{validate:f.validate});assert.equal(f.tables[1].rows.length,1);
});

test('lost COMMIT response is unconfirmed and replay cannot duplicate restored records',async()=>{
  const s=snapshot();s.payload.tables[1].rows=[[1,'synthetic']];sign(s);const f=model();f.fault('commit-response');
  await assert.rejects(backup.restoreSnapshot(f.c,s,{validate:f.validate}));assert.equal(f.tables[1].rows.length,1);
  f.fault(null);await assert.rejects(backup.restoreSnapshot(f.c,s,{validate:f.validate}),{code:'restore-target-not-empty'});
});

test('private files roundtrip, never overwrite, refuse symlinks and cannot live inside checkout/public directories',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chatcrm-backup-test-'));t.after(()=>cleanupOwned(dir));
  const file=path.join(dir,'private.json'),s=snapshot();backup.writeSnapshot(file,s);assert.deepEqual(backup.readSnapshot(file),s);
  assert.throws(()=>backup.writeSnapshot(file,s));assert.throws(()=>backup.privatePath('relative.json'));
  assert.throws(()=>backup.privatePath(path.resolve(__dirname,'../private.json')),{code:'backup-path-invalid'});
  fs.mkdirSync(path.join(dir,'public'));assert.throws(()=>backup.privatePath(path.join(dir,'public','private.json')),{code:'backup-path-invalid'});
  if(process.platform!=='win32'){
    assert.equal(fs.statSync(file).mode&511,384);const link=path.join(dir,'link.json');fs.symlinkSync(file,link);assert.throws(()=>backup.readSnapshot(link));
    fs.chmodSync(file,420);assert.throws(()=>backup.readSnapshot(file),{code:'backup-permissions-invalid'});
  }
});

test('CLI help/verification stay independent of database and arguments never accept credentials',t=>{
  for(const args of [[],['--restore','file'],['--create','file','--force'],['--password','secret'],['--verify','--json']])assert.equal(parseArguments(args),null);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chatcrm-backup-cli-'));t.after(()=>cleanupOwned(dir));
  const file=path.join(dir,'private.json');backup.writeSnapshot(file,snapshot());
  for(const args of [['--help'],['--verify',file]]){
    const result=spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/backup-database.js'),...args],{encoding:'utf8',timeout:4000,env:{...process.env,DB_HOST:'nonexistent.test',DB_USER:'private',DB_NAME:'private',DB_PASSWORD:'do-not-print'}});
    assert.equal(result.status,0);assert(!(result.stdout+result.stderr).includes('do-not-print'));
  }
});

test('bounded connection shuts down stalled query/prepare/close and a late opening socket',async()=>{
  const env={DB_HOST:'synthetic',DB_NAME:'synthetic',DB_USER:'synthetic',DB_PASSWORD:'private'};
  for(const method of ['query','execute','end']){
    let destroyed=0;const c={query:async()=>[[]],execute:async()=>[[]],end:async()=>{},destroy:()=>destroyed++};c[method]=async()=>new Promise(()=>{});
    await assert.rejects(backup.withConnection(env,c=>c[method==='end'?'query':method]('SELECT 1'),{connect:async()=>c,timeoutMs:15}));assert.equal(destroyed,1);
  }
  let complete,destroyed=0;await assert.rejects(backup.withConnection(env,()=>{}, {connect:()=>new Promise(resolve=>complete=resolve),timeoutMs:15}));
  complete({destroy:()=>destroyed++});await new Promise(resolve=>setImmediate(resolve));assert.equal(destroyed,1);
});
