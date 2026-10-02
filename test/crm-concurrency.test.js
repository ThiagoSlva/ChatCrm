'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { TABLES, assertOptIn, inspectPreflight, cleanupFixtures, preservationFingerprint, guardedConnection, verifyCrmConcurrency, runLockedRace } = require('../scripts/verify-crm-concurrency');

test('manual CRM concurrency requires exactly one explicit fixture acknowledgement', () => {
  assert.doesNotThrow(() => assertOptIn(['--allow-temporary-fixtures']));
  for (const args of [[], ['--allow-temporary-fixtures', 'extra'], ['--allow-temporary-fixtures', '--allow-temporary-fixtures'], ['--unknown'], ['allow-temporary-fixtures']]) {
    assert.throws(() => assertOptIn(args));
  }
});

test('CLI without acknowledgement fails without exposing private configuration', () => {
  const privateMarker = 'synthetic-private-marker-never-output';
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/verify-crm-concurrency.js')], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, DB_HOST: '127.0.0.1', DB_NAME: privateMarker, DB_USER: privateMarker, DB_PASSWORD: privateMarker, DB_PORT: 'invalid' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.length > 0);
  assert.equal(result.stderr.includes(privateMarker), false);
});

function preflightConnection(overrides = {}) {
  const log = [];
  const data = {
    tables: TABLES.map(name => ({ Table: name })), schema: [{ id: 1, version: 5 }],
    company: [{ id: 1 }], users: [{ id: 7, role: 'admin', active: 1 }], occupied: {}, ...overrides
  };
  return { log, async query(sql) {
    log.push(sql);
    if (sql === 'SHOW TABLES') return [data.tables];
    if (sql.includes('FROM cl_schema')) return [data.schema];
    if (sql.includes('FROM cl_company')) return [data.company];
    if (sql.includes('FROM cl_users')) return [data.users];
    const table = sql.match(/FROM (cl_\w+)/)?.[1];
    assert.ok(TABLES.includes(table));
    return [[{ total: data.occupied[table] || 0 }]];
  } };
}
test('preflight accepts only schema5 dedicated installed empty database without mutation', async () => {
  const connection = preflightConnection();
  assert.deepEqual(await inspectPreflight(connection), { schemaVersion: 5, adminId: 7, tableCount: 13 });
  assert.equal(connection.log.filter(sql => sql.includes('COUNT(*)')).length, 10);
  assert.ok(connection.log.every(sql => /^(SHOW|SELECT) /.test(sql)));
});
test('preflight refuses other tables, versions, installations, identities and occupied operations', async () => {
  const variants = [
    { tables: [...TABLES.map(name => ({ Table: name })), { Table: 'another_site' }] },
    { schema: [{ id: 1, version: 4 }] }, { schema: [{ id: 1, version: 5 }, { id: 2, version: 5 }] },
    { company: [] }, { users: [{ id: 7, role: 'operator', active: 1 }] },
    { users: [{ id: 7, role: 'admin', active: 0 }] },
    { users: [{ id: 7, role: 'admin', active: 1 }, { id: 8, role: 'operator', active: 1 }] },
    ...TABLES.slice(3).map(table => ({ occupied: { [table]: 1 } }))
  ];
  for (const variant of variants) {
    const connection = preflightConnection(variant);
    await assert.rejects(() => inspectPreflight(connection));
    assert.ok(connection.log.every(sql => /^(SHOW|SELECT) /.test(sql)));
  }
});
test('library opt-in failure never accesses either connection', async () => {
  let accessed = 0;
  const poison = new Proxy({}, { get() { accessed++; throw new Error('Unexpected DB access'); } });
  await assert.rejects(() => verifyCrmConcurrency(poison, poison));
  assert.equal(accessed, 0);
});
function cleanupConnection(change = () => {}) {
  const suffix = 'a'.repeat(16);
  const registry = {
    committed: true,
    user: { id: 17, name: 'Operador concorrencia ' + suffix, email: 'concurrency-' + suffix + '@example.test', passwordHash: 'synthetic-hash' },
    department: { id: 31, name: 'Concorrencia ' + suffix }, session: { tokenHash: 'b'.repeat(64) },
    contact: { id: 48, name: 'Contato concorrencia ' + suffix, clientKey: 'c'.repeat(32), requestHash: 'd'.repeat(64) },
    opportunity: { id: 59, clientKey: 'e'.repeat(32), requestHash: 'f'.repeat(64), initialTitle: 'Venda concorrencia ' + suffix,
      contenders: [{ title: 'Venda A ' + suffix, stage: 'qualified' }, { title: 'Venda B ' + suffix, stage: 'proposal' }] }
  };
  const data = {
    cl_users: [{ id: 17, name: registry.user.name, email: registry.user.email, password_hash: registry.user.passwordHash, role: 'operator', active: 1 }],
    cl_departments: [{ id: 31, name: registry.department.name, active: 1, public_chat: 0 }],
    cl_contacts: [{ id: 48, department_id: 31, name: registry.contact.name, email: '', phone: '', company: '', kind: 'lead', version: 1, created_by: 17, client_key: registry.contact.clientKey, request_hash: registry.contact.requestHash }],
    cl_sessions: [{ token_hash: registry.session.tokenHash, user_id: 17 }],
    cl_department_members: [{ department_id: 31, user_id: 17 }],
    cl_opportunities: [{ id: 59, contact_id: 48, title: registry.opportunity.contenders[0].title, amount_cents: 0, stage: 'qualified', version: 2, created_by: 17, client_key: registry.opportunity.clientKey, request_hash: registry.opportunity.requestHash }],
    cl_opportunity_events: [
      { opportunity_id: 59, version: 1, actor_id: 17, title: registry.opportunity.initialTitle, amount_cents: 0, stage: 'new' },
      { opportunity_id: 59, version: 2, actor_id: 17, title: registry.opportunity.contenders[0].title, amount_cents: 0, stage: 'qualified' }
    ], cl_chat_conversations: [], cl_chat_messages: []
  };
  change(data, registry);
  const log = [];
  const connection = {
    log, async query(sql) { log.push({ sql }); return preflightConnection().query(sql); }, async beginTransaction() { log.push({ sql: 'BEGIN' }); },
    async commit() { log.push({ sql: 'COMMIT' }); }, async rollback() { log.push({ sql: 'ROLLBACK' }); },
    async execute(sql, values) {
      log.push({ sql, values });
      if (sql === 'SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE') return [[{ id: 1 }]];
      const table = sql.match(/FROM (cl_\w+)/)?.[1]; assert.ok(Object.hasOwn(data, table));
      if (sql.startsWith('SELECT ')) return [structuredClone(data[table])];
      assert.ok(sql.startsWith('DELETE FROM '));
      return [{ affectedRows: data[table].length }];
    }
  };
  return { connection, registry, data };
}
test('cleanup validates every dependency before deleting only owned IDs in child order', async () => {
  const { connection, registry } = cleanupConnection();
  assert.deepEqual(await cleanupFixtures(connection, registry), { users: 1, departments: 1, contacts: 1, opportunities: 1, events: 2, sessions: 1, memberships: 1 });
  const firstDelete = connection.log.findIndex(item => item.sql.startsWith('DELETE'));
  assert.ok(firstDelete > 0);
  assert.equal(connection.log.slice(firstDelete).some(item => item.sql.startsWith('SELECT')), false);
  const deletes = connection.log.filter(item => item.sql.startsWith('DELETE'));
  assert.deepEqual(deletes.map(item => item.sql.match(/FROM (cl_\w+)/)[1]), ['cl_opportunity_events', 'cl_opportunities', 'cl_contacts', 'cl_department_members', 'cl_sessions', 'cl_departments', 'cl_users']);
  assert.ok(deletes.every(item => item.sql.includes(' WHERE ') && item.values.length >= 2));
  assert.deepEqual(deletes.at(-1).values, [17, registry.user.email, 'operator']);
  assert.equal(connection.log.at(-1).sql, 'COMMIT');
});
test('cleanup refuses foreign ownership, altered snapshots and new dependencies before any DELETE', async () => {
  const changes = [
    data => { data.cl_users[0].password_hash = 'someone-elses-hash'; },
    data => { data.cl_departments[0].public_chat = 1; },
    data => { data.cl_contacts[0].created_by = 7; },
    data => { data.cl_sessions[0].token_hash = '9'.repeat(64); },
    data => { data.cl_department_members.push({ department_id: 31, user_id: 7 }); },
    data => { data.cl_opportunities.push({ ...data.cl_opportunities[0], id: 60 }); },
    data => { data.cl_opportunity_events[1].actor_id = 7; },
    data => { data.cl_opportunity_events[1].title = 'Unrelated history'; },
    data => { data.cl_chat_conversations.push({ id: 90 }); },
    data => { data.cl_chat_messages.push({ conversation_id: 90 }); }
  ];
  for (const change of changes) {
    const { connection, registry } = cleanupConnection(change);
    await assert.rejects(() => cleanupFixtures(connection, registry));
    assert.equal(connection.log.some(item => item.sql.startsWith('DELETE')), false);
    assert.equal(connection.log.at(-1).sql, 'ROLLBACK');
  }
});
test('cleanup handles uncertain fixture COMMIT and confirmed absence without broad deletion', async () => {
  const uncertain = cleanupConnection((_, registry) => { registry.committed = false; registry.commitAttempted = true; });
  assert.equal((await cleanupFixtures(uncertain.connection, uncertain.registry)).users, 1);
  const absent = cleanupConnection(data => { for (const table of Object.keys(data)) data[table] = []; });
  assert.deepEqual(await cleanupFixtures(absent.connection, absent.registry), { users: 0, departments: 0, contacts: 0, opportunities: 0, events: 0, sessions: 0, memberships: 0 });
  assert.equal(absent.connection.log.some(item => item.sql.startsWith('DELETE')), false);
});
test('cleanup rolls back a delete count mismatch instead of accepting partial removal', async () => {
  const { connection, registry } = cleanupConnection();
  const execute = connection.execute;
  connection.execute = async (sql, values) => sql.startsWith('DELETE FROM cl_contacts') ? [{ affectedRows: 0 }] : execute(sql, values);
  await assert.rejects(() => cleanupFixtures(connection, registry));
  assert.equal(connection.log.at(-1).sql, 'ROLLBACK');
  assert.equal(connection.log.some(item => item.sql === 'COMMIT'), false);
});
test('failed server contention proof releases first writer and awaits it before returning', async () => {
  let firstFinished = false; let secondRolledBack = false; let secondStarted = false;
  const first = { async execute() { return [[{ id: 1 }]]; }, async commit() { firstFinished = true; } };
  const second = {
    async query() {}, async beginTransaction() {}, async execute() { throw Object.assign(new Error('Different failure'), { code: 'UNEXPECTED', errno: 999 }); },
    async rollback() { secondRolledBack = true; }
  };
  await assert.rejects(() => runLockedRace(first, second,
    async connection => { await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE'); await connection.commit(); },
    async () => { secondStarted = true; }, { timeoutMs: 1000 }));
  assert.equal(firstFinished, true); assert.equal(secondRolledBack, true); assert.equal(secondStarted, false);
});

test('race refuses a repository read before schema locking without dispatching it to SQL', async () => {
  for (const method of ['query', 'execute']) {
    let dispatched = false;
    const connection = { async query() { dispatched = true; }, async execute() { dispatched = true; } };
    await assert.rejects(() => runLockedRace(connection, connection,
      wrapper => wrapper[method]('SELECT version FROM cl_schema WHERE id = 1'),
      async () => {}, { timeoutMs: 1000 }), /antes|primeira/);
    assert.equal(dispatched, false);
  }
});
test('SQL watchdog aborts the socket and waits for the driver rejection, then refuses reuse', async () => {
  const { EventEmitter } = require('node:events');
  const raw = new EventEmitter();
  let rejectCommand; let destroyed = false; let calls = 0;
  raw.connection = { stream: { destroy(error) { destroyed = true; rejectCommand(error); } } };
  raw.execute = () => { calls++; return new Promise((_, reject) => { rejectCommand = reject; }); };
  const guarded = guardedConnection(raw, 20);
  await assert.rejects(() => guarded.execute('SELECT synthetic'), error => error.code === 'CHATCRM_SQL_DEADLINE' && destroyed);
  assert.equal(guarded.alive, false);
  await assert.rejects(() => guarded.execute('SELECT cannot-reuse'));
  assert.equal(calls, 1);
});
test('fatal SQL callback closes the guarded connection even without a global error event', async () => {
  const { EventEmitter } = require('node:events');
  const raw = new EventEmitter(); raw.connection = { stream: { destroy() {} } };
  raw.execute = async () => { throw Object.assign(new Error('Connection lost'), { fatal: true }); };
  const guarded = guardedConnection(raw, 1000);
  await assert.rejects(() => guarded.execute('SELECT synthetic'));
  assert.equal(guarded.alive, false);
});
test('preservation includes all thirteen tables and detects schema or record changes except auto increment', async () => {
  const connection = (counter, extra = '', changedRows = false) => ({
    async query(sql) {
      const table = sql.match(/(?:FROM|TABLE) (cl_\w+)/)[1];
      if (sql.startsWith('SHOW CREATE')) return [[{ Table: table, 'Create Table': 'CREATE TABLE ' + table + ' (id int PRIMARY KEY)' + extra + ' ENGINE=InnoDB AUTO_INCREMENT=' + counter }]];
      assert.ok(sql.startsWith('SELECT SHA2(JSON_ARRAY('));
      return [[{ fingerprint: changedRows && table === 'cl_users' ? 'changed-existing-record' : 'original-' + table }]];
    }
  });
  const before = await preservationFingerprint(connection(1));
  assert.equal(await preservationFingerprint(connection(30)), before);
  assert.notEqual(await preservationFingerprint(connection(1, ' ALTERED')), before);
  assert.notEqual(await preservationFingerprint(connection(1, '', true)), before);
});

test('cleanup refuses changed schema or unknown tables before deleting committed fixtures', async () => {
  for (const variant of [{ schema: [{ id: 1, version: 6 }] }, { tables: [...TABLES.map(name => ({ Table: name })), { Table: 'unknown_dependency' }] }]) {
    const { connection, registry } = cleanupConnection();
    connection.query = async sql => { connection.log.push({ sql }); return preflightConnection(variant).query(sql); };
    await assert.rejects(() => cleanupFixtures(connection, registry));
    assert.equal(connection.log.some(item => item.sql.startsWith('DELETE')), false);
    assert.equal(connection.log.at(-1).sql, 'ROLLBACK');
  }
});
