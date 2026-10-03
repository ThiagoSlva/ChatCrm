'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { inspectInstallation, readOnly, formatReport } = require('../scripts/check-installation');

const env = { APP_URL: 'https://support.example.test', NODE_ENV: 'production',
  DB_HOST: 'synthetic-host', DB_NAME: 'synthetic-database', DB_USER: 'synthetic-user',
  DB_PASSWORD: 'private-synthetic-value', SETUP_TOKEN: 's'.repeat(32) };
const groups = [
  ['cl_schema', 'cl_company', 'cl_users', 'cl_sessions'], ['cl_departments', 'cl_department_members'],
  ['cl_visitors', 'cl_chat_conversations', 'cl_chat_messages', 'cl_chat_limits'],
  ['cl_contacts'], ['cl_opportunities', 'cl_opportunity_events'],
  ['cl_conversation_contacts', 'cl_conversation_contact_events'], ['cl_portal_accounts', 'cl_portal_sessions'], ['cl_portal_subscription_events']
];
function model({ version = 1, tables = groups.slice(0, version).flat(), users = true,
  admin = true, company = true, markers, afterVersion = version, queryError, engine = 'InnoDB' } = {}) {
  const calls = []; let reads = 0; let closed = 0;
  async function read(options) {
    const sql = options.sql;
    assert.equal(options.timeout, 5000);
    assert.match(sql, /^(SELECT|SHOW)\b/);
    calls.push(sql);
    if (queryError) throw new Error(queryError);
    if (sql === 'SHOW TABLES') return [tables.map(name => ({ Table_name: name }))];
    if (sql === 'SELECT version FROM cl_schema WHERE id = 1') {
      return [markers || [{ version: reads++ ? afterVersion : version }]];
    }
    if (sql === 'SELECT 1') return [[{ value: 1 }]];
    if (sql.startsWith('SELECT TABLE_NAME AS tableName, ENGINE AS engine')) return [tables.map(tableName => ({ tableName, engine }))];
    if (sql.endsWith('LIMIT 0')) return [[]]; // Empty projections retrieve no identities or hashes.
    if (sql === 'SELECT 1 AS present FROM cl_users LIMIT 1') return [users ? [{ present: 1 }] : []];
    if (sql.includes("role = 'admin'")) return [admin ? [{ present: 1 }] : []];
    if (sql === 'SELECT 1 AS present FROM cl_company WHERE id = 1') return [company ? [{ present: 1 }] : []];
    throw new Error('Unexpected query: ' + sql);
  }
  const connection = { query: read, execute: read, end: async () => { closed++; } };
  return { calls, closed: () => closed, connect: async () => connection };
}
async function inspect(state, overrides = {}) {
  return inspectInstallation({ env, nodeVersion: '24.0.0', connect: state.connect, ...overrides });
}

test('configuration failures occur before opening any database connection', async () => {
  let connections = 0;
  const connect = async () => { connections++; throw new Error('Must not connect'); };
  for (const [config, version, code] of [
    [env, '23.0.0', 'runtime-unsupported'],
    [{ ...env, APP_URL: 'http://support.example.test' }, '24.0.0', 'url-invalid'],
    [{ ...env, APP_URL: 'https://user:password@support.example.test' }, '24.0.0', 'url-invalid'],
    [{ ...env, APP_URL: 'https://support.example.test/path' }, '24.0.0', 'url-invalid'],
    [{ ...env, APP_URL: 'https://support.example.test/?token=secret' }, '24.0.0', 'url-invalid'],
    [{ ...env, DB_PASSWORD: '' }, '24.0.0', 'database-config-missing'],
    [{ ...env, DB_PORT: '65536' }, '24.0.0', 'database-config-invalid']
  ]) {
    assert.equal((await inspectInstallation({ env: config, nodeVersion: version, connect })).code, code);
  }
  assert.equal(connections, 0);
});
test('loopback HTTP is accepted only outside production; Node22 is supported', async () => {
  const local = { ...env, APP_URL: 'http://127.0.0.1:3000', NODE_ENV: 'development' };
  const state = model();
  assert.equal((await inspect(state, { env: local, nodeVersion: '22.0.0' })).code, 'installed');
  assert.equal((await inspect(state, { env: { ...local, NODE_ENV: 'production' } })).code, 'url-invalid');
  assert.equal(state.closed(), 1);
});
test('installed v1 runs actual base validation with empty projections and flags pending modules', async () => {
  const state = model();
  const result = await inspect(state);
  assert.equal(result.code, 'installed'); assert.equal(result.ok, true);
  assert.deepEqual(result.modulesAvailable, ['authentication']);
  assert.ok(result.modulesPending.includes('portal'));
  assert.deepEqual(result.warnings, ['remove-setup-token']);
  assert.equal(state.calls.filter(sql => sql.endsWith('LIMIT 0')).length, 3);
  assert.equal(state.closed(), 1);
});
test('v6 compatibility reports portal pending and validates its registered version', async () => {
  const state = model({ version: 6 }); let validated;
  const result = await inspect(state, { validate: async (connection, version) => {
    validated = version;
    await connection.query('SELECT 1');
  } });
  assert.equal(validated, 6);
  assert.equal(result.code, 'installed'); assert.equal(result.ok, true);
  assert.deepEqual(result.modulesPending, ['portal', 'subscriptions']);
  assert.equal(state.closed(), 1);
});
test('v7 report can list portal without claiming operational homologation', async () => {
  const state = model({ version: 7 });
  const result = await inspect(state, { validate: async () => {} }); // Structural validators have their own migration tests.
  assert.equal(result.ok, true); assert.equal(result.schemaVersion, 7);
  assert.ok(result.modulesAvailable.includes('portal')); assert.deepEqual(result.modulesPending, ['subscriptions']);
  assert.match(formatReport(result), /Nao comprova HTTPS, cron, carga, backup ou restauracao/);
});
test('empty database remains untouched and requires explicit preparation', async () => {
  const state = model({ tables: [] });
  assert.equal((await inspect(state)).code, 'database-unprepared');
  assert.deepEqual(state.calls, ['SHOW TABLES']); assert.equal(state.closed(), 1);
});
test('foreign tables and absent marker are blocked without reading client tables', async () => {
  for (const [tables, code] of [[['another_project'], 'database-not-exclusive'],
    [['cl_users'], 'schema-incomplete'], [['cl_schema'], 'schema-incomplete']]) {
    const state = model({ tables, markers: [] });
    assert.equal((await inspect(state)).code, code);
    assert.ok(!state.calls.some(sql => sql.includes('FROM cl_users')));
    assert.equal(state.closed(), 1);
  }
});
test('missing and partial-migration tables prevent a successful report', async () => {
  for (const [tables, code] of [[['cl_schema', 'cl_users'], 'schema-incomplete'],
    [[...groups.slice(0, 6).flat(), 'cl_portal_accounts'], 'migration-incomplete']]) {
    const state = model({ version: 6, tables });
    assert.equal((await inspect(state)).code, code);
    assert.equal(state.closed(), 1);
  }
});
test('zero marker and future marker do not suggest downgrade or perform DDL', async () => {
  for (const [version, code] of [[0, 'database-unprepared'], [9, 'schema-incompatible']]) {
    const state = model({ version, tables: groups[0] });
    const result = await inspect(state);
    assert.equal(result.code, code); assert.equal(state.closed(), 1);
    if (version === 9) assert.match(formatReport(result), /nao diminua o marcador/);
  }
});
test('fresh installation requires a private setup secret without creating accounts', async () => {
  for (const [token, code] of [['', 'setup-secret-required'], ['s'.repeat(31), 'setup-secret-required'], ['s'.repeat(32), 'setup-ready']]) {
    const state = model({ users: false, admin: false, company: false });
    const result = await inspect(state, { env: { ...env, SETUP_TOKEN: token } });
    assert.equal(result.code, code);
    assert.equal(result.ok, code === 'setup-ready');
    assert.equal(state.closed(), 1);
  }
});
test('an existing installation does not need setup secret; inconsistent records fail', async () => {
  assert.equal((await inspect(model(), { env: { ...env, SETUP_TOKEN: '' } })).code, 'installed');
  for (const data of [{ admin: false }, { company: false }, { users: false }]) {
    const state = model(data);
    assert.equal((await inspect(state)).code, 'installation-inconsistent');
    assert.equal(state.closed(), 1);
  }
});
test('metadata validation failures and concurrent version change cannot pass', async () => {
  const bad = model();
  assert.equal((await inspect(bad, { validate: async () => { throw new Error(env.DB_PASSWORD); } })).code, 'schema-invalid');
  assert.equal(bad.closed(), 1);
  const changed = model({ afterVersion: 2 });
  assert.equal((await inspect(changed)).code, 'schema-changed');
  assert.equal(changed.closed(), 1);
});
test('errors never expose connection fields, setup secret or driver details', async () => {
  const result = await inspectInstallation({ env, nodeVersion: '24.0.0',
    connect: async () => { throw new Error(JSON.stringify(env)); } });
  assert.equal(result.code, 'database-unreachable');
  const output = JSON.stringify(result) + formatReport(result);
  for (const value of [env.DB_HOST, env.DB_NAME, env.DB_USER, env.DB_PASSWORD, env.SETUP_TOKEN]) assert.ok(!output.includes(value));
});
test('read-only adapter refuses writes, locking reads and file exports before dispatch', async () => {
  const calls = []; const connection = {
    query: async (...args) => { calls.push(args); return [[]]; },
    execute: async (...args) => { calls.push(args); return [[]]; }
  };
  const read = readOnly(connection);
  for (const sql of ['CREATE TABLE x (id INT)', 'UPDATE cl_users SET active=0', 'DELETE FROM cl_sessions',
    'SELECT id FROM cl_schema FOR UPDATE', "SELECT 1 INTO OUTFILE '/tmp/test'", 'DROP TABLE cl_users']) {
    assert.throws(() => read.query(sql), /only accepts read queries/);
  }
  assert.equal(calls.length, 0);
  await read.execute('SELECT version FROM cl_schema WHERE id = ?', [1]);
  assert.deepEqual(calls, [[{ sql: 'SELECT version FROM cl_schema WHERE id = ?', timeout: 5000 }, [1]]]);
});
test('CLI JSON and invalid arguments remain bounded and do not require a database', () => {
  const script = path.resolve(__dirname, '../scripts/check-installation.js');
  const privateEnv = { ...process.env, APP_URL: 'https://support.example.test', DB_HOST: '', DB_NAME: '', DB_USER: '', DB_PASSWORD: '' };
  const result = spawnSync(process.execPath, [script, '--json'], { env: privateEnv, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'database-config-missing' });
  assert.equal(result.stderr, '');
  const invalid = spawnSync(process.execPath, [script, '--password=do-not-echo'], { env: privateEnv, encoding: 'utf8', timeout: 10000 });
  assert.equal(invalid.status, 2);
  assert.ok(!invalid.stderr.includes('do-not-echo')); assert.equal(invalid.stdout, '');
});

test('nontransactional tables cannot be reported ready for installation', async () => {
  const state = model({ engine: 'MyISAM' });
  assert.equal((await inspect(state)).code, 'schema-invalid');
  assert.equal(state.closed(), 1);
});
test('database read failures close the connection and suppress raw errors', async () => {
  const state = model({ queryError: JSON.stringify(env) });
  const result = await inspect(state);
  assert.equal(result.code, 'database-unreachable');
  assert.equal(state.closed(), 1);
  assert.ok(!JSON.stringify(result).includes(env.DB_PASSWORD));
});
