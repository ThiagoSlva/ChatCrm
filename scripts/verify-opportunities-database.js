'use strict';

const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { databaseOptions, repositoryForPool } = require('../src/database');
const { loadEnvironment } = require('../src/server');
const { secret, digest, hashPassword } = require('../src/security');
const { verifyDepartmentSchema, verifyChatSchema, verifyContactSchema, verifyOpportunitySchema } = require('./migrate-database');

async function preservationFingerprint(connection) {
  // Read hashes only. Existing identities, hashes, tokens and content are not output.
  const tables = [
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
  const fingerprints = [];
  for (const [table, fields, order] of tables) {
    const [rows] = await connection.query('SELECT SHA2(JSON_ARRAY(' + fields + '), 256) AS fingerprint FROM ' + table + ' ORDER BY ' + order);
    const [ddl] = await connection.query('SHOW CREATE TABLE ' + table);
    // InnoDB does not roll back consumed AUTO_INCREMENT numbers. Compare logical
    // schema, excluding the next-number counter, which can legitimately advance.
    const definition = String(Object.values(ddl[0])[1]).replace(/\bAUTO_INCREMENT=\d+\b/gi, '').replace(/\s+/g, ' ').trim();
    fingerprints.push([table, rows.map(row => row.fingerprint), digest(definition)]);
  }
  return digest(JSON.stringify(fingerprints));
}

async function verifyOpportunitiesDatabase(connection) {
  const checks = [];
  const suffix = secret().slice(0, 16);
  const emails = ['opportunity-admin', 'opportunity-a', 'opportunity-b'].map(name => name + '-' + suffix + '@example.test');
  const tokens = [secret(), secret(), secret()];
  const passwordHash = await hashPassword(secret());
  const denied = (operation, code) => assert.rejects(operation, error => error.statusCode === code);
  const safeFields = ['amountCents', 'contactId', 'contactName', 'createdAt', 'currency', 'departmentId', 'departmentName', 'id', 'stage', 'title', 'updatedAt', 'version'];
  const eventFields = ['actorName', 'amountCents', 'createdAt', 'stage', 'title', 'version'];
  const actorNames = ['Oportunidade sintetica 0', 'Oportunidade sintetica 1', 'Oportunidade sintetica 2'];
  let baseline;
  let pendingEventFailure = null;
  await connection.beginTransaction();
  try {
    await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
    const nested = {
      execute: async (sql, values) => {
        if (pendingEventFailure && sql.startsWith('INSERT INTO cl_opportunity_events') && values?.[1] === pendingEventFailure.id) {
          const error = pendingEventFailure.error;
          pendingEventFailure = null;
          throw error;
        }
        const result = await connection.execute(sql, values);
        if (pendingEventFailure && pendingEventFailure.id === null && sql.startsWith('INSERT INTO cl_opportunities ')) pendingEventFailure.id = Number(result[0].insertId);
        return result;
      },
      beginTransaction: () => connection.query('SAVEPOINT cl_opportunities_verification'),
      commit: () => connection.query('RELEASE SAVEPOINT cl_opportunities_verification'),
      rollback: () => connection.query('ROLLBACK TO SAVEPOINT cl_opportunities_verification'),
      release: () => {}
    };
    const pool = { execute: nested.execute, getConnection: async () => nested, end: async () => {} };
    const repository = repositoryForPool(pool);
    const capabilities = await repository.capabilities();
    assert.equal([5, 6, 7].includes(capabilities.schemaVersion), true);
    assert.equal(capabilities.opportunities, true);
    if (capabilities.schemaVersion >= 6) assert.equal(capabilities.conversationContacts, true);
    await verifyDepartmentSchema(connection); await verifyChatSchema(connection); await verifyContactSchema(connection); await verifyOpportunitySchema(connection);
    checks.push('schema-v5-opportunity-event-columns-defaults-indexes-foreign-keys');
    baseline = await preservationFingerprint(connection);
    const ids = [];
    for (let i = 0; i < emails.length; i++) {
      const [result] = await connection.execute('INSERT INTO cl_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [actorNames[i], emails[i], passwordHash, i === 0 ? 'admin' : 'operator']);
      ids.push(Number(result.insertId));
      await connection.execute('INSERT INTO cl_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))', [digest(tokens[i]), ids[i]]);
    }
    const departments = [];
    for (const name of ['Oportunidades A ' + suffix, 'Oportunidades B ' + suffix]) departments.push(await repository.createDepartment(ids[0], { name }));
    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], true);
    await repository.setDepartmentMember(ids[0], departments[1].id, ids[2], true);
    const contacts = [];
    contacts.push((await repository.createContact(ids[1], tokens[1], { departmentId: departments[0].id, name: 'José ' + suffix, company: 'Empresa ' + suffix, kind: 'lead', clientKey: secret().slice(0, 32) })).contact);
    contacts.push((await repository.createContact(ids[2], tokens[2], { departmentId: departments[1].id, name: 'Pessoa B ' + suffix, kind: 'contact', clientKey: secret().slice(0, 32) })).contact);
    const original = { contactId: contacts[0].id, title: '  Proposta Jose\u0301 ' + suffix + ' %_!\\  ', clientKey: secret().slice(0, 32) };
    const first = await repository.createOpportunity(ids[1], tokens[1], original);
    const second = await repository.createOpportunity(ids[1], tokens[1], { contactId: contacts[0].id, title: 'Outra venda ' + suffix, amountCents: 12345, clientKey: secret().slice(0, 32) });
    const third = await repository.createOpportunity(ids[2], tokens[2], { contactId: contacts[1].id, title: 'Venda B ' + suffix, amountCents: 999999999, clientKey: secret().slice(0, 32) });
    for (const result of [first, second, third]) {
      assert.equal(result.created, true); assert.equal(result.opportunity.stage, 'new'); assert.equal(result.opportunity.version, 1);
      assert.equal(result.opportunity.currency, 'BRL'); assert.deepEqual(Object.keys(result.opportunity).sort(), safeFields);
      assert.equal(Number.isNaN(Date.parse(result.opportunity.createdAt)), false); assert.equal(Number.isNaN(Date.parse(result.opportunity.updatedAt)), false);
    }
    assert.equal(first.opportunity.title, 'Proposta José ' + suffix + ' %_!\\'); assert.equal(first.opportunity.amountCents, 0);
    assert.equal(second.opportunity.amountCents, 12345); assert.equal(third.opportunity.amountCents, 999999999);
    const history = (actor, id, page = 1, limit = 20) => repository.listOpportunityEvents(ids[actor], tokens[actor], id, page, limit);
    const initialHistory = await history(1, first.opportunity.id);
    assert.equal(initialHistory.total, 1); assert.deepEqual(Object.keys(initialHistory.events[0]).sort(), eventFields);
    assert.deepEqual(initialHistory.events[0], { version: 1, actorName: actorNames[1], title: first.opportunity.title, amountCents: 0, stage: 'new', createdAt: first.opportunity.updatedAt });
    checks.push('safe-opportunity-multiple-per-contact-fixed-currency-initial-snapshot');

    const replay = await repository.createOpportunity(ids[1], tokens[1], { ...original, title: first.opportunity.title, amountCents: 0 });
    assert.equal(replay.created, false); assert.deepEqual(replay.opportunity, first.opportunity); assert.equal((await history(1, first.opportunity.id)).total, 1);
    await denied(() => repository.createOpportunity(ids[1], tokens[1], { ...original, amountCents: 1 }), 409);
    const fourth = await repository.createOpportunity(ids[2], tokens[2], { contactId: contacts[1].id, title: 'Outra pessoa ' + suffix, clientKey: original.clientKey });
    assert.equal(fourth.created, true); assert.notEqual(fourth.opportunity.id, first.opportunity.id);
    const [stored] = await connection.execute('SELECT created_by, client_key, request_hash FROM cl_opportunities WHERE id = ?', [first.opportunity.id]);
    assert.equal(Number(stored[0].created_by), ids[1]); assert.equal(stored[0].client_key, original.clientKey); assert.match(stored[0].request_hash, /^[a-f0-9]{64}$/);
    const storedHash = stored[0].request_hash;
    checks.push('actor-scoped-opportunity-create-replay-no-event-divergent-request-conflict');

    assert.equal(await repository.findOpportunity(ids[2], tokens[2], first.opportunity.id), null);
    assert.equal(await history(2, first.opportunity.id), null);
    assert.equal(await repository.updateOpportunity(ids[2], tokens[2], first.opportunity.id, { version: 1, stage: 'won' }), null);
    await denied(() => repository.createOpportunity(ids[2], tokens[2], { ...original, clientKey: secret().slice(0, 32) }), 404);
    await denied(() => repository.findOpportunity(ids[1], tokens[2], first.opportunity.id), 401);
    assert.equal((await repository.findOpportunity(ids[0], tokens[0], first.opportunity.id)).opportunity.id, first.opportunity.id);
    checks.push('opportunity-detail-events-and-writes-current-team-contact-department-scope');

    const noop = await repository.updateOpportunity(ids[1], tokens[1], first.opportunity.id, { version: 1, title: original.title, amountCents: 0, stage: 'new' });
    assert.deepEqual(noop.opportunity, first.opportunity); assert.equal((await history(1, first.opportunity.id)).total, 1);
    let current = (await repository.updateOpportunity(ids[1], tokens[1], first.opportunity.id, { version: 1, title: 'Novo ' + suffix + ' %_!\\', amountCents: 54321, stage: 'qualified' })).opportunity;
    assert.equal(current.version, 2); assert.equal(current.stage, 'qualified'); assert.equal(current.amountCents, 54321);
    assert.equal(current.contactId, contacts[0].id); assert.equal(current.createdAt, first.opportunity.createdAt);
    const qualified = await repository.listOpportunities(ids[1], tokens[1], 1, 20, { stage: 'qualified' });
    assert.equal(qualified.total, 1); assert.equal(qualified.opportunities[0].id, first.opportunity.id);
    await denied(() => repository.updateOpportunity(ids[1], tokens[1], first.opportunity.id, { version: 1, title: 'Stale' }), 409);
    for (const stage of ['proposal', 'won', 'lost', 'new']) {
      const updated = await repository.updateOpportunity(ids[1], tokens[1], first.opportunity.id, { version: current.version, stage });
      assert.equal(updated.opportunity.version, current.version + 1); assert.equal(updated.opportunity.stage, stage); current = updated.opportunity;
    }
    assert.equal(current.version, 6); assert.equal((await history(1, first.opportunity.id)).total, 6);
    assert.deepEqual((await repository.updateOpportunity(ids[1], tokens[1], first.opportunity.id, { version: 6, stage: 'new' })).opportunity, current);
    assert.equal((await history(1, first.opportunity.id)).total, 6);
    await connection.execute('UPDATE cl_opportunities SET version = 4294967295 WHERE id = ?', [first.opportunity.id]);
    await denied(() => repository.updateOpportunity(ids[1], tokens[1], first.opportunity.id, { version: 4294967295, stage: 'won' }), 409);
    await connection.execute('UPDATE cl_opportunities SET version = 6 WHERE id = ?', [first.opportunity.id]);
    const afterEdit = await repository.createOpportunity(ids[1], tokens[1], original);
    assert.equal(afterEdit.created, false); assert.deepEqual(afterEdit.opportunity, current); assert.equal((await history(1, first.opportunity.id)).total, 6);
    const [unchangedHash] = await connection.execute('SELECT contact_id, created_by, request_hash FROM cl_opportunities WHERE id = ?', [first.opportunity.id]);
    assert.equal(Number(unchangedHash[0].contact_id), contacts[0].id); assert.equal(Number(unchangedHash[0].created_by), ids[1]); assert.equal(unchangedHash[0].request_hash, storedHash);
    checks.push('version-cas-stale-noop-reopen-overflow-safe-current-create-replay');

    const history1 = await history(1, first.opportunity.id, 1, 2); const history2 = await history(1, first.opportunity.id, 2, 2); const history3 = await history(1, first.opportunity.id, 3, 2);
    assert.deepEqual(history1.events.map(row => row.version), [6, 5]); assert.deepEqual(history2.events.map(row => row.version), [4, 3]); assert.deepEqual(history3.events.map(row => row.version), [2, 1]);
    for (const page of [history1, history2, history3]) {
      assert.equal(page.total, 6); assert.equal(page.limit, 2);
      for (const event of page.events) { assert.deepEqual(Object.keys(event).sort(), eventFields); assert.equal(event.actorName, actorNames[1]); }
    }
    assert.deepEqual(await history(1, first.opportunity.id, 4, 2), { events: [], total: 6, page: 4, limit: 2 });
    assert.equal(history3.events[0].amountCents, 54321); assert.equal(history3.events[0].stage, 'qualified'); assert.equal(history3.events[1].title, first.opportunity.title);
    checks.push('immutable-event-snapshots-descending-version-pagination-and-safe-actor-name');

    await repository.updateOpportunity(ids[1], tokens[1], second.opportunity.id, { version: 1, stage: 'proposal' });
    await repository.updateOpportunity(ids[2], tokens[2], third.opportunity.id, { version: 1, stage: 'won' });
    await repository.updateOpportunity(ids[2], tokens[2], fourth.opportunity.id, { version: 1, stage: 'lost' });
    const query = (actor, filters = {}, page = 1, limit = 20) => repository.listOpportunities(ids[actor], tokens[actor], page, limit, filters);
    async function expectList(actor, filters, expected) {
      const result = await query(actor, filters);
      assert.deepEqual(result.opportunities.map(row => row.id).sort((a, b) => a - b), expected.map(row => row.opportunity.id).sort((a, b) => a - b));
      assert.equal(result.total, expected.length); assert.equal(result.page, 1); assert.equal(result.limit, 20);
      for (const row of result.opportunities) assert.deepEqual(Object.keys(row).sort(), safeFields);
      return result;
    }
    await expectList(0, { q: suffix }, [first, second, third, fourth]); await expectList(1, {}, [first, second]); await expectList(2, {}, [third, fourth]);
    for (const [stage, expected] of [['new', [first]], ['qualified', []], ['proposal', [second]], ['won', [third]], ['lost', [fourth]]]) await expectList(0, { q: suffix, stage }, expected);
    await expectList(0, { q: suffix, departmentId: departments[0].id }, [first, second]);
    await expectList(1, { departmentId: departments[1].id }, []); await expectList(1, { contactId: contacts[1].id }, []);
    await expectList(1, { contactId: contacts[0].id, stage: 'proposal' }, [second]);
    const page1 = await query(1, {}, 1, 1); const page2 = await query(1, {}, 2, 1);
    assert.deepEqual(page1.opportunities.map(row => row.id), [second.opportunity.id]); assert.deepEqual(page2.opportunities.map(row => row.id), [first.opportunity.id]);
    assert.equal(page1.total, 2); assert.equal(page2.total, 2);
    assert.deepEqual(await query(1, {}, 3, 1), { opportunities: [], total: 2, page: 3, limit: 1 });
    checks.push('stage-contact-department-filters-isolated-total-and-empty-page');

    for (const q of ['%', '_', '!', '\\', '%_!\\', 'Novo ' + suffix]) await expectList(1, { q }, [first]);
    for (const q of ['  Jose\u0301 ' + suffix + '  ', 'Empresa ' + suffix]) await expectList(1, { q }, [first, second]);
    for (const q of ["' OR 1=1 --", 'x'.repeat(100)]) await expectList(1, { q }, []);
    await expectList(1, { stage: 'new', q: '%_!\\', contactId: contacts[0].id }, [first]);
    checks.push('literal-opportunity-title-contact-company-search-nfc-wildcards');

    for (const input of [{ ...original, title: 123 }, { ...original, title: 'x' }, { ...original, title: 'nome\n' }, { ...original, title: 'x'.repeat(151) }, { ...original, contactId: String(contacts[0].id) }, { ...original, amountCents: -1 }, { ...original, amountCents: 1.5 }, { ...original, amountCents: 1000000000 }, { ...original, amountCents: '1' }, { ...original, stage: 'won' }, { ...original, currency: 'USD' }, { ...original, createdBy: ids[0] }]) await denied(() => repository.createOpportunity(ids[1], tokens[1], input), 400);
    for (const patch of [{ version: 6 }, { version: 0, stage: 'new' }, { version: 6, contactId: contacts[1].id, title: 'Valido' }, { version: 6, stage: 'invalid' }, { version: 6, amountCents: '1' }, { version: 6, actorId: ids[0], stage: 'won' }]) await denied(() => repository.updateOpportunity(ids[1], tokens[1], first.opportunity.id, patch), 400);
    for (const filters of [{ stage: 'invalid' }, { q: 123 }, { q: 'nome\t' }, { q: 'x'.repeat(101) }, { contactId: '1' }, { departmentId: 0 }, { userId: ids[0] }]) await denied(() => query(1, filters), 400);
    await denied(() => history(1, first.opportunity.id, 0, 20), 400); await denied(() => history(1, first.opportunity.id, 1, 51), 400);
    assert.deepEqual((await repository.findOpportunity(ids[1], tokens[1], first.opportunity.id)).opportunity, current); assert.equal((await history(1, first.opportunity.id)).total, 6);
    checks.push('strict-opportunity-types-amount-bounds-immutable-contact-fields-no-mutation');

    // Only this verifier's synthetic INSERT SELECT snapshots can be rejected.
    // Real DML runs before the controlled fault and must roll back to its savepoint.
    const updateFault = new Error('Synthetic event failure.');
    pendingEventFailure = { id: first.opportunity.id, error: updateFault };
    await assert.rejects(() => repository.updateOpportunity(ids[1], tokens[1], first.opportunity.id, { version: 6, title: 'Falha atomica' }), error => error === updateFault);
    assert.equal(pendingEventFailure, null); assert.deepEqual((await repository.findOpportunity(ids[1], tokens[1], first.opportunity.id)).opportunity, current); assert.equal((await history(1, first.opportunity.id)).total, 6);
    const failedKey = secret().slice(0, 32); const createFault = new Error('Synthetic event failure.');
    pendingEventFailure = { id: null, error: createFault };
    await assert.rejects(() => repository.createOpportunity(ids[1], tokens[1], { contactId: contacts[0].id, title: 'Falha criacao ' + suffix, clientKey: failedKey }), error => error === createFault);
    assert.equal(pendingEventFailure, null);
    const [orphan] = await connection.execute('SELECT COUNT(*) AS total FROM cl_opportunities WHERE created_by = ? AND client_key = ?', [ids[1], failedKey]);
    assert.equal(Number(orphan[0].total), 0);
    const [syntheticCounts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_opportunities WHERE created_by IN (?, ?, ?)', ids);
    assert.equal(Number(syntheticCounts[0].total), 4);
    checks.push('controlled-event-insert-failure-rolls-back-create-update-version-no-orphan');

    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], false);
    await expectList(1, { q: suffix }, []);
    assert.equal(await repository.findOpportunity(ids[1], tokens[1], first.opportunity.id), null); assert.equal(await history(1, first.opportunity.id), null);
    assert.equal(await repository.updateOpportunity(ids[1], tokens[1], first.opportunity.id, { version: 6, stage: 'won' }), null);
    for (const input of [original, { ...original, amountCents: 1 }, { ...original, clientKey: secret().slice(0, 32) }]) await denied(() => repository.createOpportunity(ids[1], tokens[1], input), 404);
    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], true);
    await repository.updateDepartment(ids[0], departments[0].id, { active: false });
    await expectList(0, { q: suffix, departmentId: departments[0].id }, []); assert.equal(await repository.findOpportunity(ids[0], tokens[0], first.opportunity.id), null); assert.equal(await history(0, first.opportunity.id), null);
    await denied(() => repository.createOpportunity(ids[1], tokens[1], original), 404);
    await repository.updateDepartment(ids[0], departments[0].id, { active: true });
    assert.deepEqual((await repository.findOpportunity(ids[1], tokens[1], first.opportunity.id)).opportunity, current); assert.equal((await history(1, first.opportunity.id)).total, 6);
    checks.push('current-contact-department-membership-access-before-replay-preserves-history');

    await repository.revoke(tokens[1]);
    await denied(() => query(1), 401); await denied(() => history(1, first.opportunity.id), 401); await denied(() => repository.createOpportunity(ids[1], tokens[1], original), 401);
    await repository.setOperatorActive(ids[2], false);
    await denied(() => query(2), 401); await denied(() => history(2, third.opportunity.id), 401);
    assert.equal((await history(0, third.opportunity.id)).events.every(row => row.actorName === actorNames[2]), true);
    checks.push('revoked-session-inactive-operator-denied-historical-actor-name-preserved');
  } finally { pendingEventFailure = null; await connection.rollback(); }
  assert.equal(await preservationFingerprint(connection), baseline, 'Rollback must preserve previous records and logical schemas.');
  const [remaining] = await connection.execute('SELECT COUNT(*) AS total FROM cl_users WHERE email IN (?, ?, ?)', emails);
  assert.equal(Number(remaining[0].total), 0);
  checks.push('all-synthetic-opportunity-records-rolled-back-existing-data-schema-preserved');
  return { verifiedAt: new Date().toISOString(), checks };
}

async function main() {
  loadEnvironment();
  const options = databaseOptions();
  if (!options) throw new Error('Configure o banco privado.');
  const connection = await mysql.createConnection(options);
  try { process.stdout.write('Oportunidades verificadas em transacao revertida: ' + JSON.stringify(await verifyOpportunitiesDatabase(connection)) + '\n'); }
  finally { await connection.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Verificacao SQL de oportunidades falhou. Nenhuma identidade ou credencial foi exibida.\n'); process.exitCode = 1; });
module.exports = { verifyOpportunitiesDatabase };
