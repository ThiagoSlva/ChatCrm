'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Readable}=require('node:stream');
const {spawnSync}=require('node:child_process');
const {digest}=require('../src/security');
const {TABLES,parseArguments,verifyBackup,validateRegistry,validateOwnedRows,cleanupFixtures,httpsClient}=require('../scripts/verify-portal-https');
const origin='https://support.example.test';
function fixture() {
 const suffix='a'.repeat(32),date='2026-10-03T12:00:00.000Z',hash='scrypt-v1$'+'b'.repeat(32)+'$'+'c'.repeat(128);
 const seed=Object.fromEntries(TABLES.slice(2).map(t=>[t,[]]));
 seed.cl_users=[{id:2,name:'Operador HTTPS '+suffix,email:'portal-https-'+suffix+'@example.test',password_hash:hash,role:'operator',active:1,created_at:date}];
 seed.cl_departments=[{id:3,name:'HTTPS '+suffix,active:1,public_chat:0,created_at:date}];
 seed.cl_department_members=[{department_id:3,user_id:2}];
 seed.cl_sessions=[{token_hash:digest('team'),user_id:2,expires_at:date}];
 seed.cl_visitors=[0,1].map(i=>({id:i+4,name:'Cliente HTTPS '+i+' '+suffix,token_hash:digest('guest'+i),expires_at:date,created_at:date}));
 seed.cl_portal_accounts=[0,1].map(i=>({id:i+6,visitor_id:i+4,access_id:String(i+1).repeat(24),password_hash:hash,recovery_hash:digest('recover'+i),version:1,active:1,created_at:date}));
 seed.cl_chat_conversations=[0,1].map(i=>({id:i+8,visitor_id:i+4,department_id:3,assigned_to:null,status:'waiting',last_sequence:0,updated_at:date,created_at:date}));
 seed.cl_portal_sessions=[0,1,2].map(i=>({token_hash:digest('portal'+i),account_id:i===2?7:6,expires_at:date})).sort((a,b)=>a.token_hash.localeCompare(b.token_hash));
 const r={schemaVersion:7,suffix,baseline:digest('original database'),adminId:1,user:{id:2},departmentId:3,seed,messages:[0,1,2].map(i=>({conversation_id:8,sequence:i+1,sender:i===1?'team':'visitor',author_id:i===1?2:4,client_key:String(i+1).repeat(32),text:['Pergunta sintetica ','Resposta sintetica ','Retorno sintetico '][i]+suffix}))};
 const rows=structuredClone(seed); rows.cl_users.unshift({id:1,role:'admin',active:1});
 return {r,rows};
}
function model({foreign=false,changed=false,clean=false}={}) {
 const f=fixture(),trace=[];
 if(foreign) f.rows.cl_contacts.push({id:91,department_id:3});
 let rows=structuredClone(f.rows),saved;
 let deletes=0;
 const connection={
 async beginTransaction(){trace.push('BEGIN');saved=structuredClone(rows);},
 async rollback(){trace.push('ROLLBACK');rows=saved;},
 async commit(){trace.push('COMMIT');},
 async query(sql){trace.push(sql);const table=sql.match(/^SELECT \* FROM (cl_\w+) ORDER BY /)?.[1];assert(table);return [structuredClone(rows[table]),[]];},
 async execute(sql,values){trace.push(sql);if(sql.startsWith('SELECT id FROM cl_schema'))return [[{id:1}],[]];
 const m=sql.match(/^DELETE FROM (cl_\w+) WHERE (.+) IN /);assert(m);
 const before=rows[m[1]].length;rows[m[1]]=rows[m[1]].filter(x=>!values.includes(x[m[2]]));deletes++;
 return [{affectedRows:before-rows[m[1]].length},[]];}
 };
 return {...f,trace,connection,get rows(){return rows;},fingerprint:async()=>clean?f.r.baseline:deletes===10&&!changed?f.r.baseline:digest('fixture or changed')};
}
test('portal HTTPS exige opt-in, origem exata e manifesto absoluto; limpeza tambem exige opt-in',()=>{
 const manifest=path.resolve(os.tmpdir(),'private-manifest.json'),base=['--allow-temporary-fixtures','--origin='+origin,'--backup-manifest='+manifest];
 assert.deepEqual(parseArguments(base,origin),{origin,manifestFile:manifest,cleanupOnly:false});
 assert.equal(parseArguments([...base,'--cleanup-only'],origin).cleanupOnly,true);
 for(const args of [base.slice(1),[...base,'--unknown'],[...base,base[0]],base.map(a=>a.startsWith('--backup')?'--backup-manifest=relative.json':a),base.map(a=>a.startsWith('--origin')?'--origin=http://support.example.test':a),base.map(a=>a.startsWith('--origin')?'--origin='+origin+'/path':a),base.map(a=>a.startsWith('--origin')?'--origin=https://user:password@support.example.test':a)])assert.throws(()=>parseArguments(args,origin));
 assert.throws(()=>parseArguments(base,'https://another.example.test'));
});
test('backup exige bytes/hash/schema/fingerprint e detecta corrupcao de mesmo tamanho',async()=>{
 const dir=path.resolve(os.tmpdir(),'private-portal-backup'),manifest=path.join(dir,'manifest.json'),backup=path.join(dir,'dump.sql');
 const content=Buffer.from('synthetic backup');
 const data={schemaVersion:7,databaseFingerprint:digest('db'),backupSha256:digest(content),backupBytes:content.length,backup};
 let bytes=content,mode=0o600,regular=true,alias=false;
 const fake={realpathSync:file=>alias&&file===backup?path.join(dir,'different.sql'):file,statSync:()=>({mode:0o700}),lstatSync:file=>({mode,size:file===backup?bytes.length:100,isFile:()=>regular,isSymbolicLink:()=>false}),readFileSync:()=>JSON.stringify(data),createReadStream:()=>Readable.from([bytes])};
 assert.deepEqual(await verifyBackup(manifest,fake),data);
 bytes=Buffer.from('Synthetic backup');await assert.rejects(verifyBackup(manifest,fake));bytes=content;
 for(const mutation of [()=>{data.schemaVersion=6;},()=>{data.databaseFingerprint='bad';},()=>{data.backupBytes=0;},()=>{data.backupSha256='bad';}]){
 const saved=structuredClone(data);mutation();await assert.rejects(verifyBackup(manifest,fake));Object.assign(data,saved);}
 mode=0o644;await assert.rejects(verifyBackup(manifest,fake));mode=0o600;
 regular=false;await assert.rejects(verifyBackup(manifest,fake));regular=true;
 alias=true;await assert.rejects(verifyBackup(manifest,fake));
});
test('registro privado so aceita operador/area/visitantes/contas e chaves proprios',()=>{
 const {r}=fixture();validateRegistry(r);
 for(const mutate of [x=>x.user.id=x.adminId,x=>x.seed.cl_departments[0].public_chat=1,x=>x.seed.cl_users[0].role='admin',x=>x.seed.cl_portal_accounts[1].visitor_id=999,x=>x.seed.cl_portal_accounts[1].id=x.seed.cl_portal_accounts[0].id,x=>x.messages[0].author_id=x.adminId,x=>x.messages[1].client_key=x.messages[0].client_key,x=>x.seed.cl_contacts.push({id:1})]){
 const other=structuredClone(r);mutate(other);assert.throws(()=>validateRegistry(other));}
});
test('limpeza valida todas as dependencias antes do primeiro DELETE e recusa registros estrangeiros',async()=>{
 const f=model({foreign:true});const before=structuredClone(f.rows);
 await assert.rejects(cleanupFixtures(f.connection,f.r,f.fingerprint));
 assert.equal(f.trace.some(x=>x.startsWith('DELETE ')),false);
 assert.equal(f.trace.at(-1),'ROLLBACK');assert.deepEqual(f.rows,before);
});
test('limpeza remove somente IDs/chaves conhecidos e confirma preservacao antes de commit',async()=>{
 const f=model();await cleanupFixtures(f.connection,f.r,f.fingerprint);
 assert.equal(f.trace.filter(x=>x.startsWith('DELETE ')).length,10);
 assert.equal(f.trace.at(-1),'COMMIT');
 assert.deepEqual(f.rows.cl_users,[{id:1,role:'admin',active:1}]);
 for(const table of TABLES.slice(3))assert.deepEqual(f.rows[table],[]);
});
test('divergencia do fingerprint depois da limpeza reverte todos os DELETEs',async()=>{
 const f=model({changed:true}),before=structuredClone(f.rows);
 await assert.rejects(cleanupFixtures(f.connection,f.r,f.fingerprint));
 assert.equal(f.trace.at(-1),'ROLLBACK');assert.deepEqual(f.rows,before);
});
test('resposta de commit perdida pode ser retomada sem novo DELETE quando baseline ja foi restaurada',async()=>{
 const f=model({clean:true});assert.deepEqual(await cleanupFixtures(f.connection,f.r,f.fingerprint),{alreadyClean:true});
 assert.equal(f.trace.some(x=>x.startsWith('DELETE ')),false);assert.equal(f.trace.at(-1),'ROLLBACK');
});
test('mensagem externa, autoria alterada, sequencia incorreta ou sessao desconhecida bloqueiam limpeza',()=>{
 for(const mutate of [
 x=>x.rows.cl_chat_messages.push({...x.r.messages[0],author_id:1,created_at:'2026-10-03'}),
 x=>{x.rows.cl_chat_messages=[{...x.r.messages[0],created_at:'2026-10-03'}];x.rows.cl_chat_conversations[0].last_sequence=2;},
 x=>x.rows.cl_portal_sessions.push({token_hash:digest('foreign'),account_id:6}),
 x=>x.rows.cl_chat_limits.push({key_hash:digest('foreign'),count:1}),
 x=>x.rows.cl_chat_conversations[1].status='closed'
 ]){const f=fixture();mutate(f);assert.throws(()=>validateOwnedRows(f.r,f.rows));}
});
test('limpeza aceita mensagens planejadas e sessoes proprias remanescentes apos logout',()=>{
 const f=fixture();f.rows.cl_chat_messages=f.r.messages.map(m=>({...m,created_at:'2026-10-03'}));f.rows.cl_chat_conversations[0].last_sequence=3;
 f.rows.cl_chat_conversations[0].status='closed';f.rows.cl_chat_conversations[0].assigned_to=2;
 f.rows.cl_portal_sessions.pop();f.rows.cl_chat_limits=[{key_hash:digest('message:visitor:4'),count:2},{key_hash:digest('message:team:2'),count:1}];
 validateOwnedRows(f.r,f.rows);
});
test('cliente HTTP limita origem, recusa redirecionamento, exige cookie separado e envia CSRF nas escritas',async()=>{
 const observed=[];const fake=async(url,init)=>{observed.push({url:String(url),init});return {status:200,text:async()=>JSON.stringify({ok:true})};};
 const client=httpsClient(origin,'__Host-cl_portal=synthetic','csrf-synthetic',fake);
 await client('/api/portal/me');await client('/api/portal/logout','POST',{});
 assert.equal(observed[0].init.headers.Cookie,'__Host-cl_portal=synthetic');
 assert.equal(observed[1].init.redirect,'error');assert.equal(observed[1].init.headers.Origin,origin);assert.equal(observed[1].init.headers['X-CSRF-Token'],'csrf-synthetic');assert(observed[1].init.signal instanceof AbortSignal);
 await assert.rejects(client('//other.example.test/api/portal/me'));await assert.rejects(client('https://other.example.test/api/portal/me'));await assert.rejects(client('/api/portal/me','DELETE'));assert.equal(observed.length,2);
});
test('cliente HTTPS recusa resposta excessiva ou JSON invalido sem registrar corpo',async()=>{
 await assert.rejects(httpsClient(origin,'','',async()=>({status:200,text:async()=>'x'.repeat(32769)}))('/api/portal/me'));
 await assert.rejects(httpsClient(origin,'','',async()=>({status:200,text:async()=>'private-invalid-json'}))('/api/portal/me'));
});
test('CLI sem opt-in nao conecta, nao imprime parametros privados e importacao nao executa fluxo',()=>{
 const result=spawnSync(process.execPath,['scripts/verify-portal-https.js'],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:5000,env:{...process.env,APP_URL:origin,DB_PASSWORD:'synthetic-never-output'}});
 assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/Nenhuma credencial/);assert(!result.stderr.includes('synthetic-never-output'));
});
