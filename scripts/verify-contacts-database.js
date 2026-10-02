'use strict';

const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { databaseOptions, repositoryForPool } = require('../src/database');
const { loadEnvironment } = require('../src/server');
const { secret, digest, hashPassword } = require('../src/security');
const { verifyDepartmentSchema, verifyChatSchema, verifyContactSchema } = require('./migrate-database');

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
    ['cl_contacts', 'id, department_id, name, email, phone, company, kind, version, created_by, client_key, request_hash, created_at, updated_at', 'id']
  ];
  const [schema] = await connection.execute('SELECT version FROM cl_schema WHERE id = 1');
  if (Number(schema[0]?.version) >= 5) tables.push(
    ['cl_opportunities', 'id, contact_id, title, amount_cents, stage, version, created_by, client_key, request_hash, created_at, updated_at', 'id'],
    ['cl_opportunity_events', 'opportunity_id, version, actor_id, title, amount_cents, stage, created_at', 'opportunity_id, version']
  );
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

async function verifyContactsDatabase(connection) {
  const checks = [];
  const suffix = secret().slice(0, 16);
  const emails = ['contacts-admin', 'contacts-a', 'contacts-b'].map(name => name + '-' + suffix + '@example.test');
  const tokens = [secret(), secret(), secret()];
  const passwordHash = await hashPassword(secret());
  const denied = (operation, code) => assert.rejects(operation, error => error.statusCode === code);
  const safeFields = ['company', 'createdAt', 'departmentId', 'departmentName', 'email', 'id', 'kind', 'name', 'phone', 'updatedAt', 'version'];
  let baseline;
  await connection.beginTransaction();
  try {
    // Fix the authorization/scope lock before the first consistent read.
    await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
    const nested = {
      execute: (sql, values) => connection.execute(sql, values),
      beginTransaction: () => connection.query('SAVEPOINT cl_contacts_verification'),
      commit: () => connection.query('RELEASE SAVEPOINT cl_contacts_verification'),
      rollback: () => connection.query('ROLLBACK TO SAVEPOINT cl_contacts_verification'),
      release: () => {}
    };
    const pool = { execute: nested.execute, getConnection: async () => nested, end: async () => {} };
    const repository = repositoryForPool(pool);
    const capabilities = await repository.capabilities();
    assert.equal([4, 5, 6].includes(capabilities.schemaVersion), true);
    assert.equal(capabilities.departments, true); assert.equal(capabilities.chat, true); assert.equal(capabilities.contacts, true);
    if (capabilities.schemaVersion >= 5) assert.equal(capabilities.opportunities, true);
    await verifyDepartmentSchema(connection); await verifyChatSchema(connection); await verifyContactSchema(connection);
    checks.push('schema-v4-contact-columns-defaults-indexes-foreign-keys');
    baseline = await preservationFingerprint(connection);
    const ids = [];
    for (let i = 0; i < emails.length; i++) {
      const [result] = await connection.execute('INSERT INTO cl_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', ['Contato sintetico ' + i, emails[i], passwordHash, i === 0 ? 'admin' : 'operator']);
      ids.push(Number(result.insertId));
      // Avoid login/global cleanup: insert only these synthetic sessions directly.
      await connection.execute('INSERT INTO cl_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))', [digest(tokens[i]), ids[i]]);
    }
    const departments = [];
    for (const name of ['Contatos A ' + suffix, 'Contatos B ' + suffix]) departments.push(await repository.createDepartment(ids[0], { name }));
    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], true);
    await repository.setDepartmentMember(ids[0], departments[1].id, ids[2], true);
    const original = {
      departmentId: departments[0].id, name: '  Jose\u0301 ' + suffix + ' %_!\\  ',
      email: '  SPECIAL-' + suffix + '@EXAMPLE.TEST  ', phone: ' +55 (11) 90000-0000 ',
      company: '  Empresa ' + suffix + '  ', kind: 'lead', clientKey: secret().slice(0, 32)
    };
    const first = await repository.createContact(ids[1], tokens[1], original);
    assert.equal(first.created, true); assert.equal(first.contact.version, 1);
    assert.equal(first.contact.name, 'José ' + suffix + ' %_!\\');
    assert.equal(first.contact.email, 'special-' + suffix + '@example.test');
    assert.equal(first.contact.phone, '+55 (11) 90000-0000'); assert.equal(first.contact.company, 'Empresa ' + suffix);
    assert.deepEqual(Object.keys(first.contact).sort(), safeFields);
    assert.equal(Number.isNaN(Date.parse(first.contact.createdAt)), false);
    assert.equal(Number.isNaN(Date.parse(first.contact.updatedAt)), false);
    const second = await repository.createContact(ids[2], tokens[2], { departmentId: departments[1].id, name: 'Contato B ' + suffix, kind: 'contact', clientKey: secret().slice(0, 32) });
    const third = await repository.createContact(ids[1], tokens[1], { departmentId: departments[0].id, name: 'Cliente A ' + suffix, kind: 'customer', clientKey: secret().slice(0, 32) });
    for (const result of [second, third]) {
      assert.equal(result.created, true); assert.equal(result.contact.version, 1);
      assert.equal(result.contact.email, ''); assert.equal(result.contact.phone, ''); assert.equal(result.contact.company, '');
      assert.deepEqual(Object.keys(result.contact).sort(), safeFields);
    }
    checks.push('safe-contact-create-normalized-fields-empty-defaults-utc-dates');

    assert.equal(await repository.findContact(ids[1], tokens[1], second.contact.id), null);
    assert.equal(await repository.findContact(ids[2], tokens[2], first.contact.id), null);
    assert.equal(await repository.updateContact(ids[2], tokens[2], first.contact.id, { version: 1, name: 'Outra area' }), null);
    await denied(() => repository.createContact(ids[2], tokens[2], { ...original, clientKey: secret().slice(0, 32) }), 404);
    await denied(() => repository.findContact(ids[1], tokens[2], first.contact.id), 401);
    assert.equal((await repository.findContact(ids[0], tokens[0], first.contact.id)).contact.id, first.contact.id);
    checks.push('current-team-token-and-department-scope-isolate-contact-detail-writes');

    const replay = await repository.createContact(ids[1], tokens[1], { ...original, name: first.contact.name, email: first.contact.email, phone: first.contact.phone, company: first.contact.company });
    assert.equal(replay.created, false); assert.deepEqual(replay.contact, first.contact);
    await denied(() => repository.createContact(ids[1], tokens[1], { ...original, email: 'different@example.test' }), 409);
    const independentKey = await repository.createContact(ids[2], tokens[2], { departmentId: departments[1].id, name: 'Outra pessoa ' + suffix, kind: 'lead', clientKey: original.clientKey });
    assert.equal(independentKey.created, true); assert.notEqual(independentKey.contact.id, first.contact.id);
    const [stored] = await connection.execute('SELECT created_by, client_key, request_hash FROM cl_contacts WHERE id = ?', [first.contact.id]);
    assert.equal(Number(stored[0].created_by), ids[1]); assert.equal(stored[0].client_key, original.clientKey);
    assert.match(stored[0].request_hash, /^[a-f0-9]{64}$/);
    const storedRequestHash = stored[0].request_hash;
    checks.push('actor-scoped-canonical-create-idempotency-divergent-request-conflict');

    const query = (actor, filters = {}, page = 1, limit = 20) => repository.listContacts(ids[actor], tokens[actor], page, limit, filters);
    async function expectList(actor, filters, expected) {
      const result = await query(actor, filters);
      assert.deepEqual(result.contacts.map(row => row.id).sort((a, b) => a - b), expected.map(row => row.contact.id).sort((a, b) => a - b));
      assert.equal(result.total, expected.length); assert.equal(result.page, 1); assert.equal(result.limit, 20);
      for (const row of result.contacts) assert.deepEqual(Object.keys(row).sort(), safeFields);
      return result;
    }
    await expectList(0, { q: suffix }, [first, second, third, independentKey]);
    await expectList(1, {}, [first, third]); await expectList(2, {}, [second, independentKey]);
    await expectList(0, { q: suffix, kind: 'lead' }, [first, independentKey]);
    await expectList(0, { q: suffix, kind: 'contact' }, [second]); await expectList(0, { q: suffix, kind: 'customer' }, [third]);
    await expectList(0, { q: suffix, departmentId: departments[0].id }, [first, third]);
    await expectList(1, { departmentId: departments[1].id }, []);
    await expectList(1, { kind: 'lead', departmentId: departments[0].id }, [first]);
    const page1 = await query(1, {}, 1, 1); const page2 = await query(1, {}, 2, 1);
    assert.deepEqual(page1.contacts.map(row => row.id), [third.contact.id]); assert.deepEqual(page2.contacts.map(row => row.id), [first.contact.id]);
    assert.equal(page1.total, 2); assert.equal(page2.total, 2);
    assert.deepEqual(await query(1, {}, 3, 1), { contacts: [], total: 2, page: 3, limit: 1 });
    checks.push('contact-kind-department-filters-isolated-total-and-empty-page');

    for (const q of ['%', '_', '!', '\\', '%_!\\', '  Jose\u0301 ' + suffix + '  ', 'special-' + suffix, '+55 (11)', 'Empresa ' + suffix]) await expectList(1, { q }, [first]);
    for (const q of ["' OR 1=1 --", 'x'.repeat(100)]) await expectList(1, { q }, []);
    await expectList(1, { kind: 'lead', q: '%_!\\' }, [first]);
    checks.push('literal-contact-search-name-email-phone-company-nfc-wildcards');

    for (const input of [
      { ...original, name: 123 }, { ...original, departmentId: String(departments[0].id) }, { ...original, name: 'x' },
      { ...original, name: 'nome\u0000' }, { ...original, email: 'invalid' }, { ...original, phone: 'texto' },
      { ...original, company: 'x'.repeat(101) }, { ...original, kind: 'all' }, { ...original, createdBy: ids[0] }, { ...original, clientKey: 'A'.repeat(32) }
    ]) await denied(() => repository.createContact(ids[1], tokens[1], input), 400);
    for (const patch of [{ version: 1 }, { version: 0, name: 'Valido' }, { version: 1, departmentId: departments[1].id, name: 'Valido' }, { version: 1, createdBy: ids[0], name: 'Valido' }, { version: 1, company: 'nome\t' }]) {
      await denied(() => repository.updateContact(ids[1], tokens[1], first.contact.id, patch), 400);
    }
    for (const filters of [{ kind: 'unknown' }, { q: 123 }, { q: 'nome\n' }, { q: ' ' + 'x'.repeat(100) }, { departmentId: '1' }, { createdBy: ids[0] }]) await denied(() => query(1, filters), 400);
    await denied(() => query(1, {}, 0, 20), 400); await denied(() => query(1, {}, 1, 51), 400);
    const [createdCount] = await connection.execute('SELECT COUNT(*) AS total FROM cl_contacts WHERE created_by IN (?, ?, ?)', ids);
    assert.equal(Number(createdCount[0].total), 4);
    assert.deepEqual((await repository.findContact(ids[1], tokens[1], first.contact.id)).contact, first.contact);
    checks.push('strict-contact-types-fields-controls-and-validation-without-mutation');

    const noop = await repository.updateContact(ids[1], tokens[1], first.contact.id, { version: 1, name: original.name, email: original.email });
    assert.deepEqual(noop.contact, first.contact);
    const updated = await repository.updateContact(ids[1], tokens[1], first.contact.id, { version: 1, company: 'Novo ' + suffix, kind: 'customer' });
    assert.equal(updated.contact.version, 2); assert.equal(updated.contact.company, 'Novo ' + suffix); assert.equal(updated.contact.kind, 'customer');
    assert.equal(updated.contact.departmentId, first.contact.departmentId); assert.equal(updated.contact.createdAt, first.contact.createdAt);
    await denied(() => repository.updateContact(ids[1], tokens[1], first.contact.id, { version: 1, company: 'Sobrescrever' }), 409);
    assert.deepEqual((await repository.findContact(ids[1], tokens[1], first.contact.id)).contact, updated.contact);
    await connection.execute('UPDATE cl_contacts SET version = 4294967295 WHERE id = ?', [first.contact.id]);
    await denied(() => repository.updateContact(ids[1], tokens[1], first.contact.id, { version: 4294967295, company: 'Overflow' }), 409);
    await connection.execute('UPDATE cl_contacts SET version = 2 WHERE id = ?', [first.contact.id]);
    checks.push('contact-version-cas-stale-conflict-normalized-noop-no-overflow');

    const afterEditReplay = await repository.createContact(ids[1], tokens[1], original);
    assert.equal(afterEditReplay.created, false); assert.deepEqual(afterEditReplay.contact, updated.contact);
    await denied(() => repository.createContact(ids[1], tokens[1], { ...original, company: 'Novo ' + suffix }), 409);
    const [editedStorage] = await connection.execute('SELECT created_by, department_id, client_key, request_hash FROM cl_contacts WHERE id = ?', [first.contact.id]);
    assert.equal(Number(editedStorage[0].created_by), ids[1]); assert.equal(Number(editedStorage[0].department_id), departments[0].id);
    assert.equal(editedStorage[0].client_key, original.clientKey); assert.equal(editedStorage[0].request_hash, storedRequestHash);
    checks.push('create-replay-returns-current-edited-contact-original-hash-remains');

    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], false);
    await expectList(1, { q: suffix }, []);
    assert.equal(await repository.findContact(ids[1], tokens[1], first.contact.id), null);
    assert.equal(await repository.updateContact(ids[1], tokens[1], first.contact.id, { version: 2, name: 'Revogado' }), null);
    for (const input of [original, { ...original, name: 'Divergente' }, { ...original, clientKey: secret().slice(0, 32) }]) await denied(() => repository.createContact(ids[1], tokens[1], input), 404);
    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], true);
    assert.deepEqual((await repository.findContact(ids[1], tokens[1], first.contact.id)).contact, updated.contact);
    await repository.updateDepartment(ids[0], departments[0].id, { active: false });
    await expectList(1, {}, []); await expectList(0, { q: suffix, departmentId: departments[0].id }, []);
    assert.equal(await repository.findContact(ids[0], tokens[0], first.contact.id), null);
    assert.equal(await repository.updateContact(ids[0], tokens[0], first.contact.id, { version: 2, name: 'Area inativa' }), null);
    await denied(() => repository.createContact(ids[1], tokens[1], original), 404);
    await repository.updateDepartment(ids[0], departments[0].id, { active: true });
    assert.deepEqual((await repository.findContact(ids[1], tokens[1], first.contact.id)).contact, updated.contact);
    checks.push('current-membership-active-department-revalidated-before-replay-preserves-data');

    await repository.revoke(tokens[1]);
    await denied(() => query(1), 401); await denied(() => repository.findContact(ids[1], tokens[1], first.contact.id), 401);
    await denied(() => repository.createContact(ids[1], tokens[1], original), 401);
    await denied(() => repository.updateContact(ids[1], tokens[1], first.contact.id, { version: 2, name: 'Sessao revogada' }), 401);
    await repository.setOperatorActive(ids[2], false);
    await denied(() => query(2), 401); await denied(() => repository.findContact(ids[2], tokens[2], second.contact.id), 401);
    checks.push('revoked-team-token-and-inactive-operator-denied');
  } finally { await connection.rollback(); }
  assert.equal(await preservationFingerprint(connection), baseline, 'Rollback must preserve existing records and logical schemas.');
  const [remaining] = await connection.execute('SELECT COUNT(*) AS total FROM cl_users WHERE email IN (?, ?, ?)', emails);
  assert.equal(Number(remaining[0].total), 0);
  checks.push('all-synthetic-contact-records-rolled-back-existing-data-schema-preserved');
  return { verifiedAt: new Date().toISOString(), checks };
}

async function main() {
  loadEnvironment();
  const options = databaseOptions();
  if (!options) throw new Error('Configure o banco privado.');
  const connection = await mysql.createConnection(options);
  try { process.stdout.write('Contatos verificados em transacao revertida: ' + JSON.stringify(await verifyContactsDatabase(connection)) + '\n'); }
  finally { await connection.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Verificacao SQL de contatos falhou. Nenhuma identidade ou credencial foi exibida.\n'); process.exitCode = 1; });
module.exports = { verifyContactsDatabase };
