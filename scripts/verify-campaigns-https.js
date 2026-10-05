'use strict';
// Manual, disposable test installation only. Never called by startup/cron/CI.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { definitions, MAX_BYTES, readSnapshot, privatePath, withConnection, validateDatabase } = require('./database-backup');
const { campaignsFingerprint } = require('./verify-campaigns-database');
const { secret, digest, hashPassword } = require('../src/security');
const { NOTICE_VERSION } = require('../src/subscriptions-database');
const { httpsClient, verifyFlow } = require('./campaigns-https-flow');
const LOCK = 'SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE';
const q = value => '`' + value + '`'; // Only compiled identifiers reach this function.
const clean = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => assert.deepEqual(a, b);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const hex = (value, length) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value);
const uint = value => Number.isInteger(value) && value > 0 && value <= 4294967295;
const sorted = rows => rows.map(row => JSON.stringify(row)).sort();
const rowHash = rows => digest(JSON.stringify(sorted(rows)));
const mutable = new Set(['cl_users','cl_sessions','cl_visitors','cl_portal_accounts','cl_portal_sessions',
  'cl_portal_subscription_events','cl_campaigns','cl_campaign_recipients','cl_campaign_batches']);

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {};
  for (const arg of args) {
    if (arg === '--allow-temporary-fixtures' || arg === '--cleanup-only') {
      const key = arg.slice(2); if (Object.hasOwn(options, key)) return null; options[key] = true;
    } else {
      const match = /^--(origin|backup|journal|commit)=(.+)$/.exec(arg);
      if (!match || Object.hasOwn(options, match[1])) return null; options[match[1]] = match[2];
    }
  }
  if (!options['allow-temporary-fixtures'] || !hex(options.commit, 40) || !options.origin || !options.backup || !options.journal) return null;
  try { const url = new URL(options.origin); if (url.protocol !== 'https:' || url.origin !== options.origin) return null; } catch { return null; }
  if (!path.isAbsolute(options.backup) || !path.isAbsolute(options.journal) || path.resolve(options.backup) === path.resolve(options.journal)) return null;
  return options;
}

async function rows(c) {
  const result = {}; let count=0,bytes=0;
  for (const table of definitions) {
    const columns = table.columns.map(q).join(','); const data = [];
    for (let offset = 0; ; offset += 200) {
      const page = (await c.query('SELECT ' + columns + ' FROM ' + q(table.name) + ' ORDER BY ' + columns + ' LIMIT 200 OFFSET ' + offset))[0];
      const values=page.map(row => table.columns.map(column => row[column]));
      count+=values.length;bytes+=Buffer.byteLength(JSON.stringify(values));assert(count<=25000&&bytes<=MAX_BYTES);
      data.push(...values);
      if (page.length < 200) break;
    }
    result[table.name] = clean(data);
  }
  return result;
}
function backupRows(snapshot) { return Object.fromEntries(snapshot.payload.tables.map(table => [table.name, table.rows])); }
function hashes(data) { return Object.fromEntries(definitions.map(table => [table.name, rowHash(data[table.name])])); }
function preflight(data) {
  equal(data.cl_schema, [[1,9]]); assert.equal(data.cl_company.length, 1); assert.equal(data.cl_company[0][0], 1);
  assert.equal(data.cl_users.length, 1); const admin = data.cl_users[0]; assert(uint(admin[0])); equal(admin.slice(4,6), ['admin',1]);
  for (const table of definitions.slice(3)) if (table.name !== 'cl_chat_limits') equal(data[table.name], []);
  return admin[0];
}

function writeJournal(file, registry, create = false) {
  const destination = privatePath(file); const next = create ? destination : destination + '.next';
  if (!create) readJournal(destination);
  const fd = fs.openSync(next, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(registry) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!create) fs.renameSync(next, destination);
}
function readJournal(file) {
  const source = privatePath(file), stat = fs.lstatSync(source);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0);
  const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd); assert.equal(opened.ino, stat.ino);
    if (process.platform !== 'win32') assert.equal(opened.dev, stat.dev);
    assert(opened.size <= 1024 * 1024); const bytes = Buffer.alloc(opened.size + 1);
    let length = 0, n; while (length < bytes.length && (n = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += n;
    assert.equal(length, opened.size); return JSON.parse(bytes.subarray(0,length).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function validateRegistry(r, snapshot) {
  const original = backupRows(snapshot), adminId = preflight(original);
  assert(r && r.kind === 'campaigns-https-v1' && r.schemaVersion === 9 && hex(r.suffix,32) && hex(r.commit,40) && hex(r.baseline,64));
  assert.equal(r.backupChecksum, snapshot.sha256); equal(r.originalHashes, hashes(original)); assert.equal(r.adminId, adminId);
  const url = new URL(r.origin); assert.equal(url.protocol, 'https:'); assert.equal(url.origin, r.origin);
  assert(r.seed && r.intents && Array.isArray(r.intents) && r.intents.length <= 60);
  const user = r.seed.cl_users; assert.equal(user.length, 1); assert(uint(user[0][0]) && user[0][0] !== adminId);
  assert.equal(user[0][1], 'Operador HTTPS ' + r.suffix); assert.equal(user[0][2], 'https-' + r.suffix + '@example.test'); equal(user[0].slice(4,6), ['operator',1]);
  assert.match(user[0][3], /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/); assert(date(user[0][6]));
  equal(Object.keys(r.seed).sort(), ['cl_users','cl_sessions','cl_visitors','cl_portal_accounts','cl_portal_sessions'].sort());
  assert.equal(r.seed.cl_sessions.length, 2); equal(r.seed.cl_sessions.map(s => s[1]).sort((a,b)=>a-b), [adminId,user[0][0]].sort((a,b)=>a-b));
  for (const s of r.seed.cl_sessions) assert(hex(s[0],64) && date(s[2]));
  assert.equal(new Set(r.seed.cl_sessions.map(s=>s[0])).size,2);
  for (const name of ['cl_visitors','cl_portal_accounts','cl_portal_sessions']) assert.equal(r.seed[name].length, 53);
  const visitors = r.seed.cl_visitors, accounts = r.seed.cl_portal_accounts;
  assert.equal(new Set(visitors.map(v=>v[0])).size,53); assert.equal(new Set(accounts.map(a=>a[0])).size,53);
  assert.equal(new Set(accounts.map(a=>a[2])).size,53); assert.equal(new Set(r.seed.cl_portal_sessions.map(s=>s[0])).size,53);
  for (let i=0;i<53;i++) {
    const v=visitors[i],a=accounts[i],s=r.seed.cl_portal_sessions[i];
    assert(uint(v[0]) && uint(a[0])); assert.equal(v[1], 'Cliente HTTPS ' + i + ' ' + r.suffix); assert(hex(v[2],64) && date(v[3]) && date(v[4]));
    assert.equal(a[1],v[0]); assert(hex(a[2],24)); assert.equal(a[3],user[0][3]); assert(hex(a[4],64)); equal(a.slice(5,7),[1,1]); assert(date(a[7]));
    assert.equal(s[1],a[0]); assert(hex(s[0],64) && date(s[2]));
  }
  const seenChoices=new Set(), seenCampaigns=new Set(); let campaignCount=0,batchCount=0;
  for(const intent of r.intents) {
    if(intent.kind==='choice') {
      const b=intent.body; assert(Number.isInteger(intent.index)&&intent.index>=0&&intent.index<53);
      assert(b && typeof b.subscribed==='boolean' && b.noticeVersion===NOTICE_VERSION && hex(b.clientKey,32));
      assert(Number.isInteger(b.version)&&b.version>=0&&b.version<=2); assert(!seenChoices.has(b.clientKey)); seenChoices.add(b.clientKey);
    } else if(intent.kind==='campaign') {
      const b=intent.body; assert(b&&hex(b.clientKey,32)&&hex(b.audienceHash,64)); assert(!seenCampaigns.has(b.clientKey)); seenCampaigns.add(b.clientKey);
      assert.equal(b.title,(campaignCount++ ? 'Cancelamento HTTPS ' : 'Ensaio HTTPS ')+r.suffix);
      assert.equal(b.text,'Somente dados ficticios. Texto literal <b>teste</b>.');
      assert(Array.isArray(intent.audience)&&intent.audience.length>0&&intent.audience.length<=53);
      assert.equal(new Set(intent.audience.map(x=>x.accountId)).size,intent.audience.length);
      for(const recipient of intent.audience) assert(accounts.some(a=>a[0]===recipient.accountId)&&[1,3].includes(recipient.consentVersion));
      assert.equal(b.audienceHash,digest(JSON.stringify([NOTICE_VERSION,intent.audience])));
    } else if(intent.kind==='batch') { assert(uint(intent.campaignId)&&hex(intent.key,32)); batchCount++; }
    else assert.fail('Unknown journal intent');
  }
  assert(campaignCount<=2 && batchCount<=1);
}

function validateOwned(r, data, snapshot) {
  validateRegistry(r,snapshot); const original=backupRows(snapshot), ids=r.seed.cl_portal_accounts.map(a=>a[0]);
  for(const table of definitions) if(!mutable.has(table.name)) assert.equal(rowHash(data[table.name]),r.originalHashes[table.name]);
  equal(sorted(data.cl_users),sorted([...original.cl_users,...r.seed.cl_users]));
  equal(sorted(data.cl_visitors),sorted(r.seed.cl_visitors)); equal(sorted(data.cl_portal_sessions),sorted(r.seed.cl_portal_sessions));
  assert(data.cl_sessions.length<=2);
  for(const row of data.cl_sessions) assert(r.seed.cl_sessions.some(seed=>JSON.stringify(seed)===JSON.stringify(row)));
  assert.equal(new Set(data.cl_sessions.map(row=>row[0])).size,data.cl_sessions.length);
  assert.equal(data.cl_portal_accounts.length,53);
  for(const account of data.cl_portal_accounts) {
    const seed=r.seed.cl_portal_accounts.find(a=>a[0]===account[0]); assert(seed);
    equal(account.slice(0,6),seed.slice(0,6)); equal(account.slice(7),seed.slice(7));
    assert(account[6]===1 || (account[6]===0 && account[0]===ids[1]));
  }
  const choices=r.intents.filter(i=>i.kind==='choice'); assert(data.cl_portal_subscription_events.length<=choices.length);
  for(const event of data.cl_portal_subscription_events) {
    const intent=choices.find(i=>ids[i.index]===event[0]&&i.body.clientKey===event[4]); assert(intent);
    const b=intent.body; equal(event.slice(0,6),[ids[intent.index],b.version+1,b.subscribed?1:0,NOTICE_VERSION,b.clientKey,digest(JSON.stringify([b.version,b.subscribed,NOTICE_VERSION]))]); assert(date(event[6]));
  }
  const requests=r.intents.filter(i=>i.kind==='campaign'); assert(data.cl_campaigns.length<=requests.length);
  for(const campaign of data.cl_campaigns) {
    const intent=requests.find(i=>i.body.clientKey===campaign[4]); assert(intent); assert(uint(campaign[0])); const b=intent.body;
    equal(campaign.slice(1,8),[b.title,b.text,r.adminId,b.clientKey,digest(JSON.stringify([b.title,b.text,b.audienceHash])),b.audienceHash,NOTICE_VERSION]);
    assert(['queued','cancelled'].includes(campaign[8])&&date(campaign[9]));
    const recipients=data.cl_campaign_recipients.filter(row=>row[0]===campaign[0]); assert.equal(recipients.length,intent.audience.length);
    for(const row of recipients) {
      assert(intent.audience.some(a=>a.accountId===row[1]&&a.consentVersion===row[2])); assert(['pending','delivered','skipped','cancelled'].includes(row[3]));
      assert(row[3]==='delivered' ? date(row[4])&&(row[5]===null||date(row[5])) : row[4]===null&&row[5]===null);
    }
  }
  for(const row of data.cl_campaign_recipients) assert(data.cl_campaigns.some(c=>c[0]===row[0])&&ids.includes(row[1]));
  assert(data.cl_campaign_batches.length<=1);
  for(const batch of data.cl_campaign_batches) {
    assert(r.intents.some(i=>i.kind==='batch'&&i.campaignId===batch[0]&&i.key===batch[1])); assert(data.cl_campaigns.some(c=>c[0]===batch[0]));
    assert(batch.slice(2,5).every(n=>Number.isInteger(n)&&n>=0&&n<=53)&&batch[2]+batch[3]<=50&&date(batch[5]));
  }
}

async function cleanup(c,r,snapshot,fingerprint=campaignsFingerprint) {
  validateRegistry(r,snapshot); await c.query('START TRANSACTION'); let transaction=true;
  try {
    await c.execute(LOCK);
    if(await fingerprint(c)===r.baseline) { await c.query('ROLLBACK'); transaction=false; return {alreadyClean:true,preserved:true}; }
    const current=await rows(c); validateOwned(r,current,snapshot); // ALL validation before ANY deletion.
    const remove=async(name,column,values,count)=>{
      if(!values.length) {assert.equal(count,0);return;}
      const [result]=await c.execute('DELETE FROM '+q(name)+' WHERE '+q(column)+' IN ('+values.map(()=>'?').join(',')+')',values); assert.equal(result.affectedRows,count);
    };
    const campaignIds=current.cl_campaigns.map(row=>row[0]), accountIds=r.seed.cl_portal_accounts.map(row=>row[0]);
    for(const name of ['cl_campaign_batches','cl_campaign_recipients']) await remove(name,'campaign_id',campaignIds,current[name].length);
    await remove('cl_campaigns','id',campaignIds,current.cl_campaigns.length);
    await remove('cl_portal_subscription_events','account_id',accountIds,current.cl_portal_subscription_events.length);
    await remove('cl_portal_sessions','token_hash',r.seed.cl_portal_sessions.map(row=>row[0]),current.cl_portal_sessions.length);
    await remove('cl_portal_accounts','id',accountIds,53);
    await remove('cl_visitors','id',r.seed.cl_visitors.map(row=>row[0]),53);
    await remove('cl_sessions','token_hash',r.seed.cl_sessions.map(row=>row[0]),current.cl_sessions.length);
    await remove('cl_users','id',[r.seed.cl_users[0][0]],1);
    equal(hashes(await rows(c)),r.originalHashes); assert.equal(await fingerprint(c),r.baseline);
    await c.query('COMMIT'); transaction=false;
    assert.equal(await fingerprint(c),r.baseline); return {alreadyClean:false,preserved:true};
  } finally { if(transaction) await c.query('ROLLBACK'); }
}

async function seed(c,r,staff,portal,journal) {
  await c.query('START TRANSACTION'); let transaction=true;
  try {
    await c.execute(LOCK); const original=await rows(c); preflight(original); equal(hashes(original),r.originalHashes);
    assert.equal(await campaignsFingerprint(c),r.baseline);
    const passwordHash=await hashPassword(secret());
    const [operator]=await c.execute("INSERT INTO cl_users (name,email,password_hash,role,active,created_at) VALUES (?,?,?,'operator',1,UTC_TIMESTAMP())",['Operador HTTPS '+r.suffix,'https-'+r.suffix+'@example.test',passwordHash]);
    const operatorId=Number(operator.insertId);
    for(let i=0;i<2;i++) await c.execute('INSERT INTO cl_sessions (token_hash,user_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[digest(staff[i]),i?operatorId:r.adminId]);
    const visitorIds=[],accountIds=[];
    for(let i=0;i<53;i++) {
      const [visitor]=await c.execute('INSERT INTO cl_visitors (name,token_hash,expires_at,created_at) VALUES (?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR),UTC_TIMESTAMP())',['Cliente HTTPS '+i+' '+r.suffix,digest(secret())]); visitorIds.push(Number(visitor.insertId));
      const [account]=await c.execute('INSERT INTO cl_portal_accounts (visitor_id,access_id,password_hash,recovery_hash,version,active,created_at) VALUES (?,?,?,?,1,1,UTC_TIMESTAMP())',[visitorIds[i],secret().slice(0,24),passwordHash,digest(secret())]); accountIds.push(Number(account.insertId));
      await c.execute('INSERT INTO cl_portal_sessions (token_hash,account_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[digest(portal[i]),accountIds[i]]);
    }
    const current=await rows(c); r.seed={cl_users:current.cl_users.filter(row=>row[0]===operatorId),cl_sessions:current.cl_sessions,
      cl_visitors:visitorIds.map(id=>current.cl_visitors.find(row=>row[0]===id)),cl_portal_accounts:accountIds.map(id=>current.cl_portal_accounts.find(row=>row[0]===id)),
      cl_portal_sessions:accountIds.map(id=>current.cl_portal_sessions.find(row=>row[1]===id))};
    r.stage='seed-commit-attempted'; writeJournal(journal,r,true); // Must exist durably before COMMIT.
    await c.query('COMMIT'); transaction=false; r.stage='seed-confirmed'; writeJournal(journal,r);
  } finally { if(transaction) await c.query('ROLLBACK'); }
}

async function main() {
  const args=parseArguments(process.argv.slice(2));
  if(!args||args.help) {
    (args?process.stdout:process.stderr).write('Uso: node scripts/verify-campaigns-https.js --origin=https://chat.example.test --backup=CAMINHO_ABSOLUTO --journal=CAMINHO_ABSOLUTO_NOVO --commit=SHA40 --allow-temporary-fixtures [--cleanup-only]\nGuia: docs/VERIFICACAO-HTTPS-CAMPANHAS.md\n'); process.exitCode=args?0:2; return;
  }
  const backup=readSnapshot(args.backup),journal=privatePath(args.journal); preflight(backupRows(backup));
  if(!args['cleanup-only']) { assert(!fs.existsSync(journal)&&!fs.existsSync(journal+'.next'));
    const age=Date.now()-Date.parse(backup.payload.createdAt); assert(age>=0&&age<=30*60*1000); }
  require('../src/server').loadEnvironment(); assert.equal(args.origin,process.env.APP_URL);
  const request=httpsClient(args.origin);
  if(!args['cleanup-only']) { const health=await request('/health'); assert.equal(health.status,200); assert.equal(health.data.commit,args.commit); assert.equal(health.data.campaignsImplemented,true); }
  let registry=args['cleanup-only']?readJournal(journal):null,checks=[],cleaned=null;
  await withConnection(process.env,async c=>{
    await c.query("SET SESSION time_zone = '+00:00'"); await validateDatabase(c);
    const [lock]=await c.execute("SELECT GET_LOCK('conversa-livre-schema-v1',0) AS acquired"); assert.equal(Number(lock[0].acquired),1);
    try {
      if(args['cleanup-only']) { validateRegistry(registry,backup); assert.equal(registry.origin,args.origin); assert.equal(registry.commit,args.commit); cleaned=await cleanup(c,registry,backup); }
      else {
        equal(hashes(await rows(c)),hashes(backupRows(backup)));
        registry={kind:'campaigns-https-v1',schemaVersion:9,suffix:secret().slice(0,32),origin:args.origin,commit:args.commit,
          backupChecksum:backup.sha256,adminId:preflight(backupRows(backup)),originalHashes:hashes(backupRows(backup)),baseline:await campaignsFingerprint(c),intents:[]};
        const staff=[secret(),secret()],portal=Array.from({length:53},()=>secret()); let failure;
        try {
          await seed(c,registry,staff,portal,journal);
          checks=await verifyFlow({request,staff,portal,suffix:registry.suffix,
            record:async intent=>{
              if(intent.kind==='campaign') {
                const current=await rows(c); validateOwned(registry,current,backup);
                intent.audience=registry.seed.cl_portal_accounts.filter(a=>current.cl_portal_accounts.some(row=>row[0]===a[0]&&row[6]===1)).flatMap(a=>{
                  const latest=current.cl_portal_subscription_events.filter(row=>row[0]===a[0]).sort((a,b)=>b[1]-a[1])[0];
                  return latest&&latest[2]===1?[{accountId:a[0],consentVersion:latest[1]}]:[];
                }).sort((a,b)=>a.accountId-b.accountId);
                assert.equal(intent.body.audienceHash,digest(JSON.stringify([NOTICE_VERSION,intent.audience])));
              }
              registry.intents.push(intent); validateRegistry(registry,backup); writeJournal(journal,registry);
            },
            ownQueue:async id=>{const current=await rows(c);validateOwned(registry,current,backup);assert(current.cl_campaigns.some(row=>row[0]===id));},
            disableAccount:async index=>{assert.equal(index,1);await c.execute('UPDATE cl_portal_accounts SET active=0 WHERE id=?',[registry.seed.cl_portal_accounts[index][0]]);}
          });
        } catch(error) { failure=error; }
        // A seed may have committed even if its acknowledgement was lost. Never replay it.
        if(fs.existsSync(journal)) cleaned=await cleanup(c,registry,backup);
        if(failure) { if(cleaned) {registry.stage='cleaned-after-failure';writeJournal(journal,registry);} throw failure; }
      }
      registry.stage='cleaned'; if(!args['cleanup-only']) registry.checks=checks; writeJournal(journal,registry);
    } finally { await c.execute("SELECT RELEASE_LOCK('conversa-livre-schema-v1')"); }
  });
  process.stdout.write(JSON.stringify({ok:true,code:args['cleanup-only']?'campaigns-fixtures-cleaned':'campaigns-https-verified',commit:args.commit,checks,cleanup:cleaned,
    ...(args['cleanup-only']?{httpNotExercised:true}:{sessionsSeeded:true,loginNotExercised:true})})+'\n');
}
module.exports={parseArguments,rows,hashes,preflight,validateRegistry,validateOwned,cleanup,writeJournal,readJournal};
if(require.main===module) main().catch(()=>{process.stderr.write('Ensaio nao confirmado. Preserve backup e journal privados; nenhuma credencial foi exibida. Nao repita fixtures. Use somente --cleanup-only com os mesmos parametros e diagnostique divergencias antes de retomar.\n');process.exitCode=1;});
