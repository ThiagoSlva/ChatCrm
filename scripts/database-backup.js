'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const validators = require('./migrate-database');
const { withDeadline } = require('./check-installation');

// Fixed schema9 contract. Names/SQL never come from the backup or command line.
const definitions = [
  ['cl_schema','id,version'], ['cl_company','id,name'],
  ['cl_users','id,name,email,password_hash,role,active,created_at'],
  ['cl_sessions','token_hash,user_id,expires_at'],
  ['cl_departments','id,name,active,created_at,public_chat'], ['cl_department_members','department_id,user_id'],
  ['cl_visitors','id,name,token_hash,expires_at,created_at'],
  ['cl_chat_conversations','id,visitor_id,department_id,assigned_to,status,last_sequence,updated_at,created_at'],
  ['cl_chat_messages','conversation_id,sequence,sender,author_id,client_key,text,created_at'],
  ['cl_chat_limits','key_hash,window_start,count,expires_at'],
  ['cl_contacts','id,department_id,name,email,phone,company,kind,version,created_by,client_key,request_hash,created_at,updated_at'],
  ['cl_opportunities','id,contact_id,title,amount_cents,stage,version,created_by,client_key,request_hash,created_at,updated_at'],
  ['cl_opportunity_events','opportunity_id,version,actor_id,title,amount_cents,stage,created_at'],
  ['cl_conversation_contacts','conversation_id,contact_id,version,updated_by,updated_at'],
  ['cl_conversation_contact_events','conversation_id,version,contact_id,actor_id,created_at'],
  ['cl_portal_accounts','id,visitor_id,access_id,password_hash,recovery_hash,version,active,created_at'],
  ['cl_portal_sessions','token_hash,account_id,expires_at'],
  ['cl_portal_subscription_events','account_id,version,subscribed,notice_version,client_key,request_hash,created_at'],
  ['cl_campaigns','id,title,text,created_by,client_key,request_hash,audience_hash,notice_version,state,created_at'],
  ['cl_campaign_recipients','campaign_id,account_id,consent_version,state,delivered_at,read_at'],
  ['cl_campaign_batches','campaign_id,client_key,delivered,skipped,remaining,created_at']
].map(([name, columns]) => Object.freeze({ name, columns: Object.freeze(columns.split(',')) }));
Object.freeze(definitions);
const MAX_BYTES = 16 * 1024 * 1024, MAX_ROWS = 25000;
const lockSql = "SELECT GET_LOCK('conversa-livre-schema-v1', 10) AS acquired";
const releaseSql = "SELECT RELEASE_LOCK('conversa-livre-schema-v1')";
const sessions = new Set(['cl_sessions', 'cl_portal_sessions']);
const autoTables = new Set(['cl_users','cl_departments','cl_visitors','cl_chat_conversations',
  'cl_contacts','cl_opportunities','cl_portal_accounts','cl_campaigns']);
const uint = /^int(?:\(\d+\))? unsigned$/;
const baseTypes = {
  cl_schema: [/^tinyint(?:\(\d+\))? unsigned$/, uint],
  cl_company: [/^tinyint(?:\(\d+\))? unsigned$/, /^varchar\(120\)$/],
  cl_users: [uint, /^varchar\(100\)$/, /^varchar\(254\)$/, /^varchar\(200\)$/, /^enum\('admin','operator'\)$/, /^tinyint(?:\(\d+\))?$/, /^timestamp(?:\(0\))?$/],
  cl_sessions: [/^char\(64\)$/, uint, /^datetime(?:\(0\))?$/]
};
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const keys = (object, expected) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).sort().join(',') === [...expected].sort().join(',');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => '`' + value + '`';

function validateSnapshot(snapshot) {
  if (!keys(snapshot, ['format','version','payload','sha256']) || snapshot.format !== 'conversa-livre-database' ||
    snapshot.version !== 1 || !/^[a-f0-9]{64}$/.test(snapshot.sha256 || '') ||
    !keys(snapshot.payload, ['schemaVersion','createdAt','tables'])) fail('backup-invalid');
  const payload = snapshot.payload;
  if (payload.schemaVersion !== 9 || typeof payload.createdAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(payload.createdAt) ||
    !Number.isFinite(Date.parse(payload.createdAt)) || !Array.isArray(payload.tables) || payload.tables.length !== definitions.length) fail('backup-invalid');
  let count = 0;
  for (let i = 0; i < definitions.length; i++) {
    const table = payload.tables[i], definition = definitions[i];
    if (!keys(table, ['name','columns','nextId','rows']) || table.name !== definition.name ||
      !Array.isArray(table.columns) || JSON.stringify(table.columns) !== JSON.stringify(definition.columns) ||
      !(table.nextId === null || (Number.isSafeInteger(table.nextId) && table.nextId >= 1 && table.nextId <= 4294967296)) ||
      !Array.isArray(table.rows)) fail('backup-invalid');
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length !== definition.columns.length || row.some(value =>
        !(value === null || typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))))) fail('backup-invalid');
    }
    if (autoTables.has(table.name) !== (table.nextId !== null)) fail('backup-invalid');
    if (table.nextId !== null) {
      const maximum = table.rows.reduce((max, row) => Math.max(max, Number(row[0])), 0);
      if (!Number.isSafeInteger(maximum) || table.nextId <= maximum ||
        table.rows.some(row => !Number.isSafeInteger(Number(row[0])) || Number(row[0]) < 1)) fail('backup-invalid');
    }
    count += table.rows.length;
    if (count > MAX_ROWS) fail('backup-too-large');
  }
  if (JSON.stringify(payload.tables[0].rows) !== '[[1,9]]') fail('backup-invalid');
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES) fail('backup-too-large');
  if (digest(payload) !== snapshot.sha256) fail('backup-checksum-mismatch');
  return { schemaVersion: 9, tables: definitions.length, rows: count, sha256: snapshot.sha256 };
}

async function validateDatabase(c) {
  const [names] = await c.query('SHOW TABLES');
  if (names.map(row => Object.values(row)[0]).sort().join(',') !== definitions.map(d => d.name).sort().join(',')) fail('database-incompatible');
  const [marker] = await c.query('SELECT id, version FROM cl_schema');
  if (marker.length !== 1 || marker[0].id !== 1 || marker[0].version !== 9) fail('database-incompatible');
  const [tables] = await c.query('SELECT TABLE_NAME AS name, ENGINE AS engine, AUTO_INCREMENT AS nextId FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  if (tables.length !== definitions.length || definitions.some(d => !tables.some(t => t.name === d.name && t.engine?.toLowerCase() === 'innodb'))) fail('database-incompatible');
  const [triggers] = await c.query('SHOW TRIGGERS');
  if (triggers.length) fail('database-incompatible');
  for (const d of definitions) {
    const [columns] = await c.query('SHOW FULL COLUMNS FROM ' + identifier(d.name));
    if (columns.map(column => column.Field).join(',') !== d.columns.join(',')) fail('database-incompatible');
    if (baseTypes[d.name] && columns.some((column, i) => column.Null !== 'NO' ||
      !baseTypes[d.name][i].test(String(column.Type).toLowerCase()))) fail('database-incompatible');
  }
  for (const name of ['verifyDepartmentSchema','verifyChatSchema','verifyContactSchema','verifyOpportunitySchema',
    'verifyConversationContactSchema','verifyPortalSchema','verifySubscriptionSchema','verifyCampaignSchema']) await validators[name](c);
  return tables;
}

async function collect(c, metadata) {
  let count = 0;
  const tables = [];
  for (const definition of definitions) {
    const fields = definition.columns.map(identifier).join(',');
    const nextId = metadata.find(t => t.name === definition.name).nextId;
    const table = { name: definition.name, columns: [...definition.columns], nextId: nextId === null ? null : Number(nextId), rows: [] };
    tables.push(table);
    let offset = 0;
    // Small pages also bound the driver response before the overall size check.
    for (;;) {
      const limit = Math.min(200, MAX_ROWS - count + 1);
      const [rows] = await c.query('SELECT ' + fields + ' FROM ' + identifier(definition.name) + ' ORDER BY ' + fields + ' LIMIT ' + limit + ' OFFSET ' + offset);
      count += rows.length;
      if (count > MAX_ROWS) fail('backup-too-large');
      table.rows.push(...rows.map(row => definition.columns.map(column => row[column])));
      if (Buffer.byteLength(JSON.stringify(tables)) > MAX_BYTES) fail('backup-too-large');
      if (rows.length < limit) break;
      offset += rows.length;
    }
  }
  return tables;
}

async function captureSnapshot(c, { validate = validateDatabase, now = () => new Date() } = {}) {
  const [lock] = await c.execute(lockSql);
  if (Number(lock[0]?.acquired) !== 1) fail('database-busy');
  let transaction = false;
  try {
    await c.query("SET SESSION time_zone = '+00:00'");
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.query('START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT'); transaction = true;
    const metadata = await validate(c);
    const payload = { schemaVersion: 9, createdAt: now().toISOString(), tables: await collect(c, metadata) };
    const snapshot = { format: 'conversa-livre-database', version: 1, payload, sha256: digest(payload) };
    validateSnapshot(snapshot);
    await c.query('ROLLBACK'); transaction = false;
    return snapshot;
  } finally {
    try { if (transaction) await c.query('ROLLBACK'); } finally { await c.execute(releaseSql); }
  }
}

async function requireEmptyData(c) {
  for (const definition of definitions.slice(1)) {
    const [rows] = await c.query('SELECT 1 AS present FROM ' + identifier(definition.name) + ' LIMIT 1');
    if (rows.length) fail('restore-target-not-empty');
  }
}

// Restore ONLY to previously prepared, empty schema9. No creation/DROP/TRUNCATE,
// no update of existing records and no SQL loaded from the backup.
async function restoreSnapshot(c, snapshot, { validate = validateDatabase } = {}) {
  const summary = validateSnapshot(snapshot);
  const [lock] = await c.execute(lockSql);
  if (Number(lock[0]?.acquired) !== 1) fail('database-busy');
  let transaction = false;
  try {
    await c.query("SET SESSION time_zone = '+00:00'");
    await c.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
    const metadata = await validate(c);
    await requireEmptyData(c);
    // Maintenance/offline required. DDL implicitly commits; do it before the data
    // transaction. Recheck emptiness afterward, then lock the first-access marker.
    for (const table of snapshot.payload.tables) {
      const actual = metadata.find(t => t.name === table.name);
      if ((actual.nextId === null) !== (table.nextId === null)) fail('backup-invalid');
      if (table.nextId !== null) {
        const maximum = table.rows.reduce((max, row) => Math.max(max, Number(row[0])), 0);
        if (!Number.isSafeInteger(maximum) || table.nextId <= maximum) fail('backup-invalid');
        if (table.nextId > Number(actual.nextId)) await c.query('ALTER TABLE ' + identifier(table.name) + ' AUTO_INCREMENT = ' + table.nextId);
      }
    }
    await c.query('START TRANSACTION'); transaction = true;
    const [marker] = await c.query('SELECT id, version FROM cl_schema WHERE id = 1 FOR UPDATE');
    if (marker.length !== 1 || marker[0].version !== 9) fail('database-incompatible');
    await requireEmptyData(c);
    let revokedSessions = 0;
    for (const table of snapshot.payload.tables.slice(1)) {
      if (sessions.has(table.name)) { revokedSessions += table.rows.length; continue; }
      const sql = 'INSERT INTO ' + identifier(table.name) + ' (' + table.columns.map(identifier).join(',') + ') VALUES (' + table.columns.map(() => '?').join(',') + ')';
      for (const row of table.rows) await c.execute(sql, row);
    }
    const restored = await collect(c, await validate(c));
    for (let i = 0; i < restored.length; i++) {
      const expected = snapshot.payload.tables[i];
      if (JSON.stringify(restored[i].rows) !== JSON.stringify(sessions.has(expected.name) ? [] : expected.rows)) fail('restore-verification-failed');
      if (restored[i].nextId !== expected.nextId) fail('restore-verification-failed');
    }
    await c.query('COMMIT'); transaction = false;
    return { ...summary, rowsRestored: summary.rows - 1 - revokedSessions, revokedSessions };
  } finally {
    try { if (transaction) await c.query('ROLLBACK'); } finally { await c.execute(releaseSql); }
  }
}

function privatePath(file) {
  if (!path.isAbsolute(file)) fail('backup-path-invalid');
  const parent = fs.realpathSync(path.dirname(file));
  const project = fs.realpathSync(path.resolve(__dirname, '..'));
  const relative = path.relative(project, parent);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) ||
    parent.split(/[\\/]/).some(part => /^(public|public_html|www|htdocs|\.git)$/i.test(part))) fail('backup-path-invalid');
  if (process.platform !== 'win32' && (fs.statSync(parent).mode & 0o077)) fail('backup-permissions-invalid');
  return path.join(parent, path.basename(file));
}

function writeSnapshot(file, snapshot) {
  const summary = validateSnapshot(snapshot), destination = privatePath(file);
  const fd = fs.openSync(destination, 'wx', 0o600);
  // A failed write leaves an unconfirmed private file. Never overwrite/delete it.
  try { fs.writeFileSync(fd, JSON.stringify(snapshot) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return summary;
}

function readSnapshot(file) {
  const source = privatePath(file), stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES + 1 ||
    (process.platform !== 'win32' && (stat.mode & 0o077))) fail('backup-permissions-invalid');
  const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    // Windows can report different dev values for path-stat versus descriptor-stat.
    if (opened.size > MAX_BYTES + 1 || opened.ino !== stat.ino ||
      (process.platform !== 'win32' && opened.dev !== stat.dev)) fail('backup-invalid');
    // Bound the read even if the owner grows the file after fstat.
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0, read;
    while (length < buffer.length && (read = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += read;
    if (length > opened.size) fail('backup-invalid');
    const snapshot = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    validateSnapshot(snapshot); return snapshot;
  } finally { fs.closeSync(fd); }
}

async function withConnection(env, work, { connect = options => require('mysql2/promise').createConnection(options), timeoutMs = 15000 } = {}) {
  const options = require('../src/database').databaseOptions(env);
  if (!options) fail('database-config-missing');
  let c, destroyed = false;
  const destroy = () => { if (c && !destroyed) { destroyed = true; try { c.destroy(); } catch {} } };
  let late = false;
  const opening = Promise.resolve().then(() => connect({ ...options, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }));
  opening.then(value => { if (late) { try { value.destroy(); } catch {} } }, () => {});
  try { c = await withDeadline(() => opening, timeoutMs, () => { late = true; destroy(); });
    const bounded = {};
    for (const method of ['query','execute']) bounded[method] = (sql, values) => withDeadline(() => c[method]({ sql, timeout: timeoutMs }, values), timeoutMs, destroy).catch(error => {
      if (error.code === 'PROTOCOL_SEQUENCE_TIMEOUT') destroy(); throw error;
    });
    return await work(bounded);
  } finally {
    if (c && !destroyed) { try { await withDeadline(() => c.end(), timeoutMs, destroy); } catch (error) { destroy(); throw error; } }
  }
}

module.exports = { definitions, MAX_BYTES, MAX_ROWS, validateSnapshot, validateDatabase, captureSnapshot,
  restoreSnapshot, writeSnapshot, readSnapshot, privatePath, withConnection };
