'use strict';

const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { databaseOptions, repositoryForPool } = require('../src/database');
const { loadEnvironment } = require('../src/server');
const { secret, digest, hashPassword } = require('../src/security');
const { verifyDepartmentSchema, verifyChatSchema, verifyContactSchema, verifyOpportunitySchema } = require('./migrate-database');

const TABLES = Object.freeze(['cl_schema', 'cl_company', 'cl_users', 'cl_sessions', 'cl_departments', 'cl_department_members', 'cl_visitors', 'cl_chat_conversations', 'cl_chat_messages', 'cl_chat_limits', 'cl_contacts', 'cl_opportunities', 'cl_opportunity_events']);
const LOCK = 'SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE';
const PHASE_MS = 8000;
const fail = message => { throw new Error(message); };
const integer = value => Number.isInteger(value) && value > 0 && value <= 4294967295;

function assertOptIn(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== '--allow-temporary-fixtures') fail('Exige consentimento explicito para fixtures temporariamente confirmadas.');
  return true;
}

async function inspectDedicatedSchema(connection) {
  const [tables] = await connection.query('SHOW TABLES');
  const names = tables.map(row => Object.values(row)[0]).sort();
  assert.deepEqual(names, [...TABLES].sort(), 'Somente banco dedicado com as treze tabelas conhecidas.');
  const [schema] = await connection.query('SELECT id, version FROM cl_schema ORDER BY id');
  assert.equal(schema.length, 1); assert.equal(Number(schema[0].id), 1); assert.equal(Number(schema[0].version), 5);
}

async function inspectPreflight(connection) {
  await inspectDedicatedSchema(connection);
  const [company] = await connection.query('SELECT id FROM cl_company ORDER BY id');
  assert.equal(company.length, 1); assert.equal(Number(company[0].id), 1);
  const [users] = await connection.query('SELECT id, role, active FROM cl_users ORDER BY id');
  assert.equal(users.length, 1); assert.equal(users[0].role, 'admin'); assert.equal(Number(users[0].active), 1);
  const adminId = Number(users[0].id); assert.equal(integer(adminId), true);
  for (const table of TABLES.slice(3)) {
    const [rows] = await connection.query('SELECT COUNT(*) AS total FROM ' + table);
    assert.equal(Number(rows[0]?.total), 0, 'Tabelas operacionais devem estar vazias.');
  }
  return { schemaVersion: 5, adminId, tableCount: TABLES.length };
}

async function preservationFingerprint(connection) {
  const definitions = [
    ['cl_schema', 'id, version', 'id'], ['cl_company', 'id, name', 'id'],
    ['cl_users', 'id, name, email, password_hash, role, active, created_at', 'id'],
    ['cl_sessions', 'token_hash, user_id, expires_at', 'token_hash'],
    ['cl_departments', 'id, name, active, public_chat, created_at', 'id'],
    ['cl_department_members', 'department_id, user_id', 'department_id, user_id'],
    ['cl_visitors', 'id, name, token_hash, expires_at, created_at', 'id'],
    ['cl_chat_conversations', 'id, visitor_id, department_id, assigned_to, status, last_sequence, updated_at, created_at', 'id'],
    ['cl_chat_messages', 'conversation_id, `sequence`, sender, author_id, client_key, text, created_at', 'conversation_id, `sequence`'],
    ['cl_chat_limits', 'key_hash, window_start, count, expires_at', 'key_hash'],
    ['cl_contacts', 'id, department_id, name, email, phone, company, kind, version, created_by, client_key, request_hash, created_at, updated_at', 'id'],
    ['cl_opportunities', 'id, contact_id, title, amount_cents, stage, version, created_by, client_key, request_hash, created_at, updated_at', 'id'],
    ['cl_opportunity_events', 'opportunity_id, version, actor_id, title, amount_cents, stage, created_at', 'opportunity_id, version']
  ];
  const hashes = [];
  for (const [table, fields, order] of definitions) {
    const [rows] = await connection.query('SELECT SHA2(JSON_ARRAY(' + fields + '), 256) AS fingerprint FROM ' + table + ' ORDER BY ' + order);
    const [ddl] = await connection.query('SHOW CREATE TABLE ' + table);
    const logical = String(Object.values(ddl[0])[1]).replace(/\bAUTO_INCREMENT=\d+\b/gi, '').replace(/\s+/g, ' ').trim();
    hashes.push([table, rows.map(row => row.fingerprint), digest(logical)]);
  }
  return digest(JSON.stringify(hashes));
}

function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function deadline(promise, timeoutMs) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Prazo da coordenacao excedido.')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

// A promise deadline does not cancel SQL. Abort the mysql2 socket on a command
// timeout; actual driver callbacks settle all commands. Cleanup must reacquire
// the schema lock on a surviving connection. If neither survives, fail closed.
function guardedConnection(raw, timeoutMs = PHASE_MS) {
  let dead = false;
  raw.on('error', () => { dead = true; });
  async function call(method, args) {
    if (dead) fail('Conexao de verificacao encerrada.');
    const timer = setTimeout(() => {
      dead = true;
      const error = new Error('Prazo SQL excedido.'); error.code = 'CHATCRM_SQL_DEADLINE';
      raw.connection.stream.destroy(error);
    }, timeoutMs);
    try { return await raw[method](...args); }
    catch (error) { if (error.fatal || raw.connection._fatalError || raw.connection._protocolError) dead = true; throw error; }
    finally { clearTimeout(timer); }
  }
  return {
    get alive() { return !dead; },
    execute: (...args) => call('execute', args), query: (...args) => call('query', args),
    beginTransaction: () => call('beginTransaction', []), commit: () => call('commit', []), rollback: () => call('rollback', []),
    release: () => {}, end: async () => { if (!dead) await call('end', []); }
  };
}
function pinnedRepository(connection) {
  return repositoryForPool({ execute: (...args) => connection.execute(...args), getConnection: async () => connection, end: async () => {} });
}

async function runLockedRace(first, second, operationA, operationB, { timeoutMs = PHASE_MS } = {}) {
  const acquiredA = deferred(); const releaseA = deferred(); const attemptedB = deferred();
  const pending = []; let commitIssued = false; let acquiredB = false;
  const wrap = (connection, side) => {
    let schemaAcquired = false;
    return {
    query: (...args) => { assert.equal(schemaAcquired, true, 'Repo nao pode ler antes do schema lock.'); return connection.query(...args); },
    execute: async (sql, values) => {
      if (sql !== LOCK) assert.equal(schemaAcquired, true, 'Schema lock deve ser a primeira query da transacao.');
      if (sql === LOCK && side === 'B') attemptedB.resolve();
      const result = await connection.execute(sql, values);
      if (sql === LOCK) schemaAcquired = true;
      if (sql === LOCK && side === 'A') { acquiredA.resolve(); await releaseA.promise; }
      if (sql === LOCK && side === 'B') { acquiredB = true; assert.equal(commitIssued, true, 'Segundo escritor nao pode adquirir antes de liberar o primeiro.'); }
      return result;
    },
    beginTransaction: () => connection.beginTransaction(),
    commit: () => { if (side === 'A') commitIssued = true; return connection.commit(); },
    rollback: () => connection.rollback(), release: () => {}
    };
  };
  const start = (operation, connection) => {
    const promise = Promise.resolve().then(() => operation(connection));
    promise.catch(() => {}); pending.push(promise); return promise;
  };
  try {
    const a = start(operationA, wrap(first, 'A'));
    await deadline(Promise.race([acquiredA.promise, a.then(() => fail('Primeira operacao nao adquiriu o lock.'))]), timeoutMs);
    // A pauses after acquiring the lock, before any consistent read. Server
    // rejection, rather than elapsed client time, proves that B cannot acquire it.
    await second.query('SET SESSION innodb_lock_wait_timeout = 1');
    await second.beginTransaction();
    try {
      await assert.rejects(() => second.execute(LOCK), error => Number(error.errno) === 1205 && error.code === 'ER_LOCK_WAIT_TIMEOUT');
      assert.equal(commitIssued, false); assert.equal(acquiredB, false);
    } finally { await second.rollback(); }
    // The one-second probe is intentionally short. Give the actual competing
    // writer a bounded five-second server wait for ordinary shared-host latency.
    await second.query('SET SESSION innodb_lock_wait_timeout = 5');
    const b = start(operationB, wrap(second, 'B'));
    await deadline(Promise.race([attemptedB.promise, b.then(() => fail('Segunda operacao nao tentou o lock.'))]), timeoutMs);
    assert.equal(acquiredB, false); assert.equal(commitIssued, false);
    releaseA.resolve();
    return await Promise.allSettled([a, b]);
  } finally {
    releaseA.resolve();
    // Never clean up while any started DML is running, including failure paths.
    await Promise.allSettled(pending);
  }
}

async function sessionSettings(connection) {
  let variable = 'transaction_isolation'; let rows;
  try { [rows] = await connection.query('SELECT @@SESSION.transaction_isolation AS isolationLevel, @@SESSION.innodb_lock_wait_timeout AS lockTimeout, CONNECTION_ID() AS connectionId'); }
  catch (error) {
    if (Number(error.errno) !== 1193) throw error;
    variable = 'tx_isolation';
    [rows] = await connection.query('SELECT @@SESSION.tx_isolation AS isolationLevel, @@SESSION.innodb_lock_wait_timeout AS lockTimeout, CONNECTION_ID() AS connectionId');
  }
  return { ...rows[0], variable };
}
async function setIsolation(connection, value) {
  const normalized = String(value).replace(/-/g, ' ').toUpperCase();
  assert.ok(['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].includes(normalized));
  await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL ' + normalized);
}

async function setupFixtures(connection, registry) {
  await connection.beginTransaction();
  try {
    await connection.execute(LOCK);
    await inspectPreflight(connection);
    const [user] = await connection.execute('INSERT INTO cl_users (name, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)', [registry.user.name, registry.user.email, registry.user.passwordHash, 'operator']);
    registry.user.id = Number(user.insertId);
    const [department] = await connection.execute('INSERT INTO cl_departments (name, active, public_chat) VALUES (?, 1, 0)', [registry.department.name]);
    registry.department.id = Number(department.insertId);
    await connection.execute('INSERT INTO cl_department_members (department_id, user_id) VALUES (?, ?)', [registry.department.id, registry.user.id]);
    await connection.execute('INSERT INTO cl_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))', [registry.session.tokenHash, registry.user.id]);
    registry.contact.requestHash = digest(JSON.stringify({ departmentId: registry.department.id, name: registry.contact.name, email: '', phone: '', company: '', kind: 'lead' }));
    const [contact] = await connection.execute("INSERT INTO cl_contacts (department_id, name, email, phone, company, kind, version, created_by, client_key, request_hash, created_at, updated_at) VALUES (?, ?, '', '', '', 'lead', 1, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [registry.department.id, registry.contact.name, registry.user.id, registry.contact.clientKey, registry.contact.requestHash]);
    registry.contact.id = Number(contact.insertId);
    registry.opportunity.requestHash = digest(JSON.stringify({ contactId: registry.contact.id, title: registry.opportunity.initialTitle, amountCents: 0 }));
    registry.commitAttempted = true; // COMMIT response can be lost after success.
    await connection.commit(); registry.committed = true;
  } catch (error) { try { await connection.rollback(); } catch {} throw error; }
}

function validateRegistry(registry) {
  assert.ok(registry && (registry.committed === true || registry.commitAttempted === true));
  for (const entity of ['user', 'department', 'contact']) assert.equal(integer(registry[entity]?.id), true);
  for (const value of [registry.contact.clientKey, registry.opportunity.clientKey]) assert.match(value, /^[a-f0-9]{32}$/);
  for (const value of [registry.session.tokenHash, registry.contact.requestHash, registry.opportunity.requestHash]) assert.match(value, /^[a-f0-9]{64}$/);
  assert.match(registry.user.email, /^concurrency-[a-f0-9]{16}@example\.test$/);
  const suffix = registry.user.email.slice(12, 28);
  assert.equal(registry.user.name, 'Operador concorrencia ' + suffix);
  assert.equal(registry.department.name, 'Concorrencia ' + suffix);
  assert.equal(registry.contact.name, 'Contato concorrencia ' + suffix);
  assert.equal(registry.opportunity.initialTitle, 'Venda concorrencia ' + suffix);
  assert.deepEqual(registry.opportunity.contenders, [{ title: 'Venda A ' + suffix, stage: 'qualified' }, { title: 'Venda B ' + suffix, stage: 'proposal' }]);
}

async function cleanupFixtures(connection, registry) {
  validateRegistry(registry);
  const { user, department, contact, opportunity, session } = registry;
  const result = { users: 0, departments: 0, contacts: 0, opportunities: 0, events: 0, sessions: 0, memberships: 0 };
  await connection.beginTransaction();
  try {
    await connection.execute(LOCK);
    await inspectDedicatedSchema(connection);
    const select = async (sql, values) => (await connection.execute(sql + ' FOR UPDATE', values))[0];
    const users = await select('SELECT id, name, email, password_hash, role, active FROM cl_users WHERE id = ? OR email = ?', [user.id, user.email]);
    const departments = await select('SELECT id, name, active, public_chat FROM cl_departments WHERE id = ? OR name = ?', [department.id, department.name]);
    const contacts = await select('SELECT id, department_id, name, email, phone, company, kind, version, created_by, client_key, request_hash FROM cl_contacts WHERE id = ? OR department_id = ? OR created_by = ? OR client_key = ?', [contact.id, department.id, user.id, contact.clientKey]);
    const sessions = await select('SELECT token_hash, user_id FROM cl_sessions WHERE user_id = ? OR token_hash = ?', [user.id, session.tokenHash]);
    const members = await select('SELECT department_id, user_id FROM cl_department_members WHERE department_id = ? OR user_id = ?', [department.id, user.id]);
    const opportunities = await select('SELECT id, contact_id, title, amount_cents, stage, version, created_by, client_key, request_hash FROM cl_opportunities WHERE contact_id = ? OR created_by = ? OR client_key = ?', [contact.id, user.id, opportunity.clientKey]);
    assert.ok(opportunities.length <= 1);
    const opportunityId = opportunities.length ? Number(opportunities[0].id) : 0;
    const events = await select('SELECT opportunity_id, version, actor_id, title, amount_cents, stage FROM cl_opportunity_events WHERE actor_id = ? OR opportunity_id = ? ORDER BY version', [user.id, opportunityId]);
    const conversations = await select('SELECT id FROM cl_chat_conversations WHERE department_id = ? OR assigned_to = ?', [department.id, user.id]);
    const messages = await select("SELECT conversation_id FROM cl_chat_messages WHERE sender = 'team' AND author_id = ?", [user.id]);
    // Validate every dependency and sentinel before the first DELETE.
    assert.equal(conversations.length, 0); assert.equal(messages.length, 0);
    const absent = users.length === 0 && departments.length === 0 && contacts.length === 0;
    if (absent) {
      assert.equal(sessions.length + members.length + opportunities.length + events.length, 0);
      await connection.commit(); return result;
    }
    assert.equal(users.length, 1); assert.equal(departments.length, 1); assert.equal(contacts.length, 1);
    assert.deepEqual({ ...users[0], id: Number(users[0].id), active: Number(users[0].active) }, { id: user.id, name: user.name, email: user.email, password_hash: user.passwordHash, role: 'operator', active: 1 });
    assert.deepEqual({ ...departments[0], id: Number(departments[0].id), active: Number(departments[0].active), public_chat: Number(departments[0].public_chat) }, { id: department.id, name: department.name, active: 1, public_chat: 0 });
    const expectedContact = { id: contact.id, department_id: department.id, name: contact.name, email: '', phone: '', company: '', kind: 'lead', version: 1, created_by: user.id, client_key: contact.clientKey, request_hash: contact.requestHash };
    const normalizedContact = { ...contacts[0] };
    for (const field of ['id', 'department_id', 'version', 'created_by']) normalizedContact[field] = Number(normalizedContact[field]);
    assert.deepEqual(normalizedContact, expectedContact);
    assert.equal(sessions.length, 1); assert.equal(sessions[0].token_hash, session.tokenHash); assert.equal(Number(sessions[0].user_id), user.id);
    assert.equal(members.length, 1); assert.equal(Number(members[0].department_id), department.id); assert.equal(Number(members[0].user_id), user.id);
    if (opportunities.length) {
      const row = opportunities[0]; assert.equal(integer(opportunityId), true);
      if (opportunity.id !== undefined) assert.equal(opportunityId, opportunity.id);
      assert.equal(Number(row.contact_id), contact.id); assert.equal(Number(row.created_by), user.id);
      assert.equal(row.client_key, opportunity.clientKey); assert.equal(row.request_hash, opportunity.requestHash); assert.equal(Number(row.amount_cents), 0);
      const version = Number(row.version); assert.ok(version === 1 || version === 2);
      const current = version === 1 ? { title: opportunity.initialTitle, stage: 'new' } : opportunity.contenders.find(item => item.title === row.title && item.stage === row.stage);
      assert.ok(current); assert.equal(row.title, current.title); assert.equal(row.stage, current.stage); assert.equal(events.length, version);
      for (let index = 0; index < events.length; index++) {
        const event = events[index]; const snapshot = index === 0 ? { title: opportunity.initialTitle, stage: 'new' } : current;
        assert.equal(Number(event.opportunity_id), opportunityId); assert.equal(Number(event.actor_id), user.id); assert.equal(Number(event.version), index + 1);
        assert.equal(Number(event.amount_cents), 0); assert.equal(event.title, snapshot.title); assert.equal(event.stage, snapshot.stage);
      }
    } else assert.equal(events.length, 0);
    const remove = async (table, where, values, expected, key) => {
      const [removed] = await connection.execute('DELETE FROM ' + table + ' WHERE ' + where, values);
      assert.equal(Number(removed.affectedRows), expected); result[key] = expected;
    };
    if (opportunityId) {
      await remove('cl_opportunity_events', 'opportunity_id = ? AND actor_id = ?', [opportunityId, user.id], events.length, 'events');
      await remove('cl_opportunities', 'id = ? AND created_by = ? AND client_key = ?', [opportunityId, user.id, opportunity.clientKey], 1, 'opportunities');
    }
    await remove('cl_contacts', 'id = ? AND created_by = ? AND client_key = ?', [contact.id, user.id, contact.clientKey], 1, 'contacts');
    await remove('cl_department_members', 'department_id = ? AND user_id = ?', [department.id, user.id], 1, 'memberships');
    await remove('cl_sessions', 'token_hash = ? AND user_id = ?', [session.tokenHash, user.id], 1, 'sessions');
    await remove('cl_departments', 'id = ? AND name = ? AND public_chat = 0', [department.id, department.name], 1, 'departments');
    await remove('cl_users', 'id = ? AND email = ? AND role = ?', [user.id, user.email, 'operator'], 1, 'users');
    await connection.commit(); return result;
  } catch (error) { try { await connection.rollback(); } catch {} throw error; }
}

async function verifyCrmConcurrency(first, second, { allowTemporaryFixtures = false } = {}) {
  if (allowTemporaryFixtures !== true) fail('Fixtures confirmadas exigem opt-in explicito.');
  const checks = []; const pending = []; const settings = []; let baseline; let registry; let failure; let cleaned = false;
  try {
    await inspectPreflight(first);
    await verifyDepartmentSchema(first); await verifyChatSchema(first); await verifyContactSchema(first); await verifyOpportunitySchema(first);
    baseline = await preservationFingerprint(first);
    checks.push('schema5-dedicated-empty-operational-tables-preflight');
    settings.push(await sessionSettings(first), await sessionSettings(second));
    assert.notEqual(Number(settings[0].connectionId), Number(settings[1].connectionId));
    for (const connection of [first, second]) {
      await setIsolation(connection, 'REPEATABLE READ'); await connection.query('SET SESSION innodb_lock_wait_timeout = 1');
      assert.equal(String((await sessionSettings(connection)).isolationLevel).replace(/-/g, ' ').toUpperCase(), 'REPEATABLE READ');
    }
    checks.push('two-distinct-physical-connections-repeatable-read');
    const suffix = secret().slice(0, 16); const token = secret();
    registry = {
      user: { name: 'Operador concorrencia ' + suffix, email: 'concurrency-' + suffix + '@example.test', passwordHash: await hashPassword(secret()) },
      department: { name: 'Concorrencia ' + suffix }, session: { tokenHash: digest(token) },
      contact: { name: 'Contato concorrencia ' + suffix, clientKey: secret().slice(0, 32) },
      opportunity: { clientKey: secret().slice(0, 32), initialTitle: 'Venda concorrencia ' + suffix, contenders: [{ title: 'Venda A ' + suffix, stage: 'qualified' }, { title: 'Venda B ' + suffix, stage: 'proposal' }] }
    };
    await setupFixtures(first, registry);
    checks.push('synthetic-private-fixtures-committed-without-real-account-change');
    const input = { contactId: registry.contact.id, title: registry.opportunity.initialTitle, amountCents: 0, clientKey: registry.opportunity.clientKey };
    const actorId = registry.user.id;
    const create = connection => pinnedRepository(connection).createOpportunity(actorId, token, input);
    const creation = runLockedRace(first, second, create, create); pending.push(creation);
    const created = await creation;
    assert.equal(created.every(item => item.status === 'fulfilled'), true);
    assert.deepEqual(created.map(item => item.value.created).sort(), [false, true]);
    assert.deepEqual(created[0].value.opportunity, created[1].value.opportunity);
    registry.opportunity.id = created[0].value.opportunity.id;
    assert.equal(created[0].value.opportunity.version, 1); assert.equal(created[0].value.opportunity.stage, 'new');
    const repository = pinnedRepository(first);
    const initialEvents = await repository.listOpportunityEvents(actorId, token, registry.opportunity.id, 1, 50);
    assert.equal(initialEvents.total, 1); assert.equal(initialEvents.events[0].version, 1);
    checks.push('server-lock-timeout-proves-second-blocked-before-create-read');
    checks.push('parallel-identical-key-one-create-one-replay-single-initial-event');
    const updates = registry.opportunity.contenders.map(item => ({ version: 1, ...item }));
    const cas = runLockedRace(first, second,
      connection => pinnedRepository(connection).updateOpportunity(actorId, token, registry.opportunity.id, updates[0]),
      connection => pinnedRepository(connection).updateOpportunity(actorId, token, registry.opportunity.id, updates[1]));
    pending.push(cas); const outcomes = await cas;
    const winners = outcomes.filter(item => item.status === 'fulfilled'); const losers = outcomes.filter(item => item.status === 'rejected');
    assert.equal(winners.length, 1); assert.equal(losers.length, 1); assert.equal(losers[0].reason.statusCode, 409);
    const current = (await repository.findOpportunity(actorId, token, registry.opportunity.id)).opportunity;
    assert.deepEqual(current, winners[0].value.opportunity); assert.equal(current.version, 2);
    const winner = registry.opportunity.contenders.find(item => item.title === current.title && item.stage === current.stage); assert.ok(winner);
    const history = await repository.listOpportunityEvents(actorId, token, current.id, 1, 50);
    assert.equal(history.total, 2); assert.deepEqual(history.events.map(item => item.version), [2, 1]);
    assert.equal(history.events[0].title, winner.title); assert.equal(history.events[0].stage, winner.stage); assert.equal(history.events[1].title, input.title);
    checks.push('server-lock-timeout-proves-second-blocked-before-cas-read');
    checks.push('parallel-same-version-one-winner-one409-no-stale-overwrite-one-event');
  } catch (error) { failure = error; }
  finally {
    await Promise.allSettled(pending);
    const available = [first, second].find(connection => connection.alive !== false);
    if (registry?.commitAttempted) {
      if (!available) failure = new Error('Sem conexao viva para validar e limpar fixtures. Exige revisao privada.');
      else {
        try { await cleanupFixtures(available, registry); cleaned = true; }
        catch { failure = new Error('Limpeza segura nao confirmada. Exige revisao privada das fixtures.'); }
      }
    }
    if (baseline && available && (!registry?.commitAttempted || cleaned)) {
      try {
        assert.equal(await preservationFingerprint(available), baseline, 'Registros e DDL logico devem ser preservados.');
        await inspectPreflight(available); checks.push('owned-fixtures-cleaned-thirteen-table-records-logical-ddl-preserved');
      } catch { failure = new Error('Preservacao final nao confirmada. Exige revisao privada.'); }
    }
    for (let index = 0; index < settings.length; index++) {
      const connection = [first, second][index]; if (connection.alive === false) continue;
      try {
        await setIsolation(connection, settings[index].isolationLevel);
        const wait = Number(settings[index].lockTimeout); assert.ok(Number.isSafeInteger(wait) && wait >= 0);
        await connection.query('SET SESSION innodb_lock_wait_timeout = ' + wait);
      } catch { failure = new Error('Restauracao da sessao SQL nao confirmada.'); }
    }
  }
  if (failure) throw failure;
  return { ok: true, verifiedAt: new Date().toISOString(), checks };
}

async function main() {
  assertOptIn(process.argv.slice(2));
  loadEnvironment(); const options = databaseOptions(); if (!options) fail('Configure o banco privado.');
  const connections = [];
  try {
    connections.push(guardedConnection(await mysql.createConnection(options)));
    connections.push(guardedConnection(await mysql.createConnection(options)));
    const result = await verifyCrmConcurrency(connections[0], connections[1], { allowTemporaryFixtures: true });
    process.stdout.write('Concorrencia CRM verificada: ' + JSON.stringify(result) + '\n');
  } finally { await Promise.allSettled(connections.map(connection => connection.end())); }
}
if (require.main === module) main().catch(() => {
  process.stderr.write('Verificacao de concorrencia CRM falhou. Preservacao nao confirmada; revise o ambiente privado antes de repetir. Nenhuma identidade ou credencial foi exibida.\n');
  process.exitCode = 1;
});
module.exports = { TABLES, assertOptIn, inspectPreflight, preservationFingerprint, cleanupFixtures, runLockedRace, guardedConnection, verifyCrmConcurrency };

