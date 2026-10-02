'use strict';

const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { databaseOptions, repositoryForPool } = require('../src/database');
const { loadEnvironment } = require('../src/server');
const { secret, digest, hashPassword } = require('../src/security');
const { verifyDepartmentSchema, verifyChatSchema, verifyContactSchema, verifyOpportunitySchema, verifyConversationContactSchema } = require('./migrate-database');

async function preservationFingerprint(connection) {
  // Hash rows in SQL; never output existing identities, tokens or message content.
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
    ['cl_opportunity_events', 'opportunity_id, version, actor_id, title, amount_cents, stage, created_at', 'opportunity_id, version'],
    ['cl_conversation_contacts', 'conversation_id, contact_id, version, updated_by, updated_at', 'conversation_id'],
    ['cl_conversation_contact_events', 'conversation_id, version, contact_id, actor_id, created_at', 'conversation_id, version']
  ];
  const fingerprints = [];
  for (const [table, fields, order] of tables) {
    const [rows] = await connection.query('SELECT SHA2(JSON_ARRAY(' + fields + '), 256) AS fingerprint FROM ' + table + ' ORDER BY ' + order);
    const [ddl] = await connection.query('SHOW CREATE TABLE ' + table);
    // Consumed InnoDB auto-increment numbers can advance despite rollback.
    const definition = String(Object.values(ddl[0])[1]).replace(/\bAUTO_INCREMENT=\d+\b/gi, '').replace(/\s+/g, ' ').trim();
    fingerprints.push([table, rows.map(row => row.fingerprint), digest(definition)]);
  }
  return digest(JSON.stringify(fingerprints));
}

async function verifyConversationContactsDatabase(connection) {
  const checks = [];
  const suffix = secret().slice(0, 16);
  const emails = ['association-admin', 'association-a', 'association-b'].map(name => name + '-' + suffix + '@example.test');
  const tokens = [secret(), secret(), secret()];
  const visitorTokens = [secret(), secret(), secret()];
  const passwordHash = await hashPassword(secret());
  const actorNames = ['Associacao sintetica 0', 'Associacao sintetica 1', 'Associacao sintetica 2'];
  const linkFields = ['canEdit', 'contactId', 'contactKind', 'contactName', 'conversationId', 'departmentId', 'updatedAt', 'version'];
  const eventFields = ['actorName', 'contactId', 'contactName', 'createdAt', 'version'];
  const denied = (operation, code) => assert.rejects(operation, error => error.statusCode === code);
  let baseline;
  let pendingEventFailure = null;
  let operationFailure;
  await connection.beginTransaction();
  try {
    // The outer transaction remains uncommitted; repositories use nested savepoints.
    await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
    const nested = {
      execute: async (sql, values) => {
        if (pendingEventFailure && sql.startsWith('INSERT INTO cl_conversation_contact_events ') && values?.[0] === pendingEventFailure.id) {
          const fault = pendingEventFailure;
          pendingEventFailure = null;
          if (fault.zeroRows) return [{ affectedRows: 0 }, []];
          throw fault.error;
        }
        return connection.execute(sql, values);
      },
      beginTransaction: () => connection.query('SAVEPOINT cl_association_verification'),
      commit: () => connection.query('RELEASE SAVEPOINT cl_association_verification'),
      rollback: () => connection.query('ROLLBACK TO SAVEPOINT cl_association_verification'),
      release: () => {}
    };
    const pool = { execute: nested.execute, getConnection: async () => nested, end: async () => {} };
    const repository = repositoryForPool(pool);
    assert.deepEqual(await repository.capabilities(), { schemaVersion: 6, departments: true, chat: true, contacts: true, opportunities: true, conversationContacts: true });
    await verifyDepartmentSchema(connection); await verifyChatSchema(connection); await verifyContactSchema(connection);
    await verifyOpportunitySchema(connection); await verifyConversationContactSchema(connection);
    baseline = await preservationFingerprint(connection);
    checks.push('schema-v6-association-columns-defaults-indexes-local-foreign-keys');

    const actors = [];
    for (let index = 0; index < emails.length; index++) {
      const [result] = await connection.execute('INSERT INTO cl_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [actorNames[index], emails[index], passwordHash, index === 0 ? 'admin' : 'operator']);
      actors.push(Number(result.insertId));
      await connection.execute('INSERT INTO cl_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))', [digest(tokens[index]), actors[index]]);
    }
    const departments = [];
    for (const name of ['Associacao A ' + suffix, 'Associacao B ' + suffix]) departments.push(await repository.createDepartment(actors[0], { name }));
    await repository.setDepartmentMember(actors[0], departments[0].id, actors[1], true);
    await repository.setDepartmentMember(actors[0], departments[1].id, actors[2], true);
    const contacts = [];
    for (const [actorIndex, departmentIndex, kind] of [[1, 0, 'lead'], [1, 0, 'contact'], [2, 1, 'customer']]) {
      contacts.push((await repository.createContact(actors[actorIndex], tokens[actorIndex], { departmentId: departments[departmentIndex].id, name: 'Contato ' + contacts.length + ' ' + suffix, kind, clientKey: secret().slice(0, 32) })).contact);
    }
    const visitors = [];
    const conversations = [];
    for (let index = 0; index < visitorTokens.length; index++) {
      const [visitor] = await connection.execute('INSERT INTO cl_visitors (name, token_hash, expires_at, created_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR), UTC_TIMESTAMP())', ['Visitante independente ' + index + ' ' + suffix, digest(visitorTokens[index])]);
      visitors.push(Number(visitor.insertId));
      const [conversation] = await connection.execute('INSERT INTO cl_chat_conversations (visitor_id, department_id, assigned_to, status, last_sequence, updated_at, created_at) VALUES (?, ?, ?, ?, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())', [visitors[index], departments[index === 1 ? 1 : 0].id, index === 2 ? null : actors[index === 1 ? 2 : 1], index === 2 ? 'waiting' : 'open']);
      conversations.push(Number(conversation.insertId));
    }
    const read = (actorIndex, index = 0) => repository.getConversationContact(actors[actorIndex], tokens[actorIndex], conversations[index]);
    const write = (actorIndex, version, contactId, index = 0) => repository.setConversationContact(actors[actorIndex], tokens[actorIndex], conversations[index], { version, contactId });
    const history = (actorIndex, index = 0, page = 1, limit = 20) => repository.listConversationContactEvents(actors[actorIndex], tokens[actorIndex], conversations[index], page, limit);
    const empty = await read(1);
    assert.deepEqual(empty, { link: { conversationId: conversations[0], departmentId: departments[0].id, version: 0, contactId: null, contactName: null, contactKind: null, updatedAt: null, canEdit: true } });
    assert.deepEqual(await write(1, 0, null), empty);
    assert.deepEqual(await history(1), { events: [], total: 0, page: 1, limit: 20 });
    const [absent] = await connection.execute('SELECT COUNT(*) AS total FROM cl_conversation_contacts WHERE conversation_id = ?', [conversations[0]]);
    assert.equal(Number(absent[0].total), 0);
    assert.equal((await read(0)).link.canEdit, false);
    await denied(() => write(0, 0, contacts[0].id), 409);
    assert.equal((await read(1, 2)).link.canEdit, false);
    await denied(() => write(1, 0, contacts[0].id, 2), 409);
    checks.push('absent-version-zero-null-noop-no-row-owner-open-required-including-admin');

    assert.equal(await read(2), null); assert.equal(await history(2), null);
    assert.equal(await write(2, 0, contacts[2].id), null);
    await denied(() => write(1, 0, contacts[2].id), 404);
    await denied(() => repository.getConversationContact(actors[1], tokens[2], conversations[0]), 401);
    const first = await write(1, 0, contacts[0].id);
    assert.equal(first.link.version, 1); assert.equal(first.link.contactId, contacts[0].id);
    assert.equal(first.link.contactName, contacts[0].name); assert.equal(first.link.contactKind, 'lead');
    assert.deepEqual(Object.keys(first.link).sort(), linkFields);
    assert.equal(Number.isNaN(Date.parse(first.link.updatedAt)), false);
    const firstHistory = await history(1);
    assert.equal(firstHistory.total, 1); assert.deepEqual(Object.keys(firstHistory.events[0]).sort(), eventFields);
    assert.deepEqual(firstHistory.events[0], { version: 1, contactId: contacts[0].id, contactName: contacts[0].name, actorName: actorNames[1], createdAt: first.link.updatedAt });
    const [identity] = await connection.execute('SELECT visitor_id FROM cl_chat_conversations WHERE id = ?', [conversations[0]]);
    assert.equal(Number(identity[0].visitor_id), visitors[0]);
    const visitorView = await repository.listVisitorConversations(visitorTokens[0]);
    assert.equal(visitorView.conversations.length, 1);
    assert.equal(Object.keys(visitorView.conversations[0]).some(field => /contact|email|phone|company/i.test(field)), false);
    checks.push('same-department-link-safe-fields-snapshot-without-merging-visitor-identity');

    assert.deepEqual(await write(1, 1, contacts[0].id), first);
    await denied(() => write(1, 0, contacts[0].id), 409);
    assert.equal((await history(1)).total, 1);
    const second = await write(1, 1, contacts[1].id);
    assert.equal(second.link.version, 2); assert.equal(second.link.contactId, contacts[1].id);
    const removed = await write(1, 2, null);
    assert.equal(removed.link.version, 3); assert.equal(removed.link.contactId, null);
    assert.equal(removed.link.contactName, null); assert.equal(removed.link.contactKind, null);
    assert.equal(Number.isNaN(Date.parse(removed.link.updatedAt)), false);
    const [retained] = await connection.execute('SELECT contact_id, version FROM cl_conversation_contacts WHERE conversation_id = ?', [conversations[0]]);
    assert.equal(retained[0].contact_id, null); assert.equal(Number(retained[0].version), 3);
    const relinked = await write(1, 3, contacts[0].id);
    assert.equal(relinked.link.version, 4);
    await denied(() => write(1, 1, contacts[0].id), 409);
    assert.deepEqual(await write(1, 4, contacts[0].id), relinked);
    assert.equal((await history(1)).total, 4);
    checks.push('cas-before-noop-link-replace-unlink-relink-retained-version-prevents-aba');

    const history1 = await history(1, 0, 1, 2); const history2 = await history(1, 0, 2, 2);
    assert.deepEqual(history1.events.map(event => event.version), [4, 3]);
    assert.deepEqual(history2.events.map(event => event.version), [2, 1]);
    assert.deepEqual(history1.events.map(event => event.contactId), [contacts[0].id, null]);
    assert.deepEqual(history2.events.map(event => event.contactId), [contacts[1].id, contacts[0].id]);
    assert.equal(history1.total, 4); assert.equal(history2.total, 4);
    assert.deepEqual(await history(1, 0, 3, 2), { events: [], total: 4, page: 3, limit: 2 });
    for (const event of [...history1.events, ...history2.events]) assert.deepEqual(Object.keys(event).sort(), eventFields);
    const renamed = (await repository.updateContact(actors[1], tokens[1], contacts[0].id, { version: 1, name: 'Contato atual ' + suffix, kind: 'customer' })).contact;
    assert.equal((await read(1)).link.contactName, renamed.name); assert.equal((await read(1)).link.contactKind, 'customer');
    const currentNames = await history(1);
    assert.equal(currentNames.total, 4);
    const renamedEvents = currentNames.events.filter(event => event.contactId === contacts[0].id);
    assert.deepEqual(renamedEvents.map(event => event.version), [4, 1]);
    assert.equal(renamedEvents.every(event => event.contactName === renamed.name), true);
    checks.push('descending-event-pagination-current-contact-names-and-kind-no-private-fields');

    for (const patch of [{ version: '4', contactId: null }, { version: -1, contactId: null }, { version: 4294967296, contactId: null }, { version: 4, contactId: String(contacts[0].id) }, { version: 4, contactId: 0 }, { version: 4 }, { contactId: null }, { version: 4, contactId: null, actorId: actors[0] }, [], null]) {
      await denied(() => repository.setConversationContact(actors[1], tokens[1], conversations[0], patch), 400);
    }
    await denied(() => repository.getConversationContact(actors[1], tokens[1], String(conversations[0])), 400);
    await denied(() => repository.getConversationContact(0, tokens[1], conversations[0]), 400);
    await denied(() => repository.getConversationContact(actors[1], 'invalid', conversations[0]), 401);
    await denied(() => history(1, 0, 0, 20), 400); await denied(() => history(1, 0, 1, 51), 400);
    assert.equal((await read(1)).link.version, 4); assert.equal((await history(1)).total, 4);
    checks.push('strict-numeric-ids-version-patch-fields-tokens-and-history-pagination');

    // Reject event snapshots only for this verifier's synthetic conversations.
    const updateFault = new Error('Synthetic association event failure.');
    pendingEventFailure = { id: conversations[0], error: updateFault };
    await assert.rejects(() => write(1, 4, contacts[1].id), error => error === updateFault);
    assert.equal(pendingEventFailure, null); assert.equal((await read(1)).link.version, 4); assert.equal((await read(1)).link.contactId, contacts[0].id); assert.equal((await history(1)).total, 4);
    const createFault = new Error('Synthetic association event failure.');
    pendingEventFailure = { id: conversations[1], error: createFault };
    await assert.rejects(() => write(2, 0, contacts[2].id, 1), error => error === createFault);
    assert.equal(pendingEventFailure, null); assert.equal((await read(2, 1)).link.version, 0); assert.equal((await history(2, 1)).total, 0);
    pendingEventFailure = { id: conversations[0], zeroRows: true };
    await assert.rejects(() => write(1, 4, null));
    assert.equal(pendingEventFailure, null); assert.equal((await read(1)).link.version, 4); assert.equal((await history(1)).total, 4);
    checks.push('controlled-event-failure-and-zero-row-snapshot-roll-back-create-and-update');

    // Defensive joins hide foreign department identities even in inconsistent synthetic rows.
    await connection.execute('UPDATE cl_conversation_contacts SET contact_id = ? WHERE conversation_id = ?', [contacts[2].id, conversations[0]]);
    await connection.execute('UPDATE cl_conversation_contact_events SET contact_id = ? WHERE conversation_id = ? AND version = 1', [contacts[2].id, conversations[0]]);
    const hidden = (await read(1)).link;
    assert.equal(hidden.contactId, null); assert.equal(hidden.contactName, null); assert.equal(hidden.contactKind, null);
    const hiddenEvent = (await history(1)).events.find(event => event.version === 1);
    assert.equal(hiddenEvent.contactId, null); assert.equal(hiddenEvent.contactName, null);
    await connection.execute('UPDATE cl_conversation_contacts SET contact_id = ? WHERE conversation_id = ?', [contacts[0].id, conversations[0]]);
    await connection.execute('UPDATE cl_conversation_contact_events SET contact_id = ? WHERE conversation_id = ? AND version = 1', [contacts[0].id, conversations[0]]);
    checks.push('link-and-history-contact-joins-hide-identities-from-other-departments');

    await connection.execute("UPDATE cl_chat_conversations SET status = 'open', assigned_to = ? WHERE id = ?", [actors[0], conversations[0]]);
    assert.equal((await read(1)).link.canEdit, false); await denied(() => write(1, 4, null), 409);
    assert.equal((await read(0)).link.canEdit, true);
    await denied(() => write(0, 4, contacts[2].id), 404);
    const adminLink = await write(0, 4, contacts[1].id);
    assert.equal(adminLink.link.version, 5); assert.equal((await history(0)).events[0].actorName, actorNames[0]);
    await connection.execute("UPDATE cl_chat_conversations SET status = 'closed' WHERE id = ?", [conversations[0]]);
    assert.equal((await read(0)).link.canEdit, false); await denied(() => write(0, 5, null), 409);
    assert.equal((await history(1)).total, 5);
    await connection.execute("UPDATE cl_chat_conversations SET status = 'open', assigned_to = ? WHERE id = ?", [actors[1], conversations[0]]);
    checks.push('responsible-revalidated-admin-same-area-rule-closed-history-readable-write-denied');

    // Exercise the per-conversation COUNT limit with only synthetic rows, not global saturation.
    await connection.execute("UPDATE cl_chat_conversations SET status = 'open', assigned_to = ? WHERE id = ?", [actors[1], conversations[2]]);
    await connection.execute('INSERT INTO cl_conversation_contacts (conversation_id, contact_id, version, updated_by, updated_at) VALUES (?, ?, 100, ?, UTC_TIMESTAMP())', [conversations[2], contacts[0].id, actors[1]]);
    for (let version = 1; version <= 100; version++) await connection.execute('INSERT INTO cl_conversation_contact_events (conversation_id, version, contact_id, actor_id, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [conversations[2], version, contacts[0].id, actors[1]]);
    assert.equal((await write(1, 100, contacts[0].id, 2)).link.version, 100);
    await denied(() => write(1, 99, contacts[0].id, 2), 409);
    await denied(() => write(1, 100, contacts[1].id, 2), 429);
    assert.equal((await history(1, 2)).total, 100);
    await connection.execute('UPDATE cl_conversation_contacts SET version = 4294967295 WHERE conversation_id = ?', [conversations[0]]);
    await denied(() => write(1, 4294967295, null), 409);
    await connection.execute('UPDATE cl_conversation_contacts SET version = 5 WHERE conversation_id = ?', [conversations[0]]);
    checks.push('per-conversation-count-limit-noop-at-limit-stale-first-no-version-overflow');

    await repository.setDepartmentMember(actors[0], departments[0].id, actors[1], false);
    assert.equal(await read(1), null); assert.equal(await history(1), null); assert.equal(await write(1, 5, null), null);
    await repository.setDepartmentMember(actors[0], departments[0].id, actors[1], true);
    assert.equal((await read(1)).link.version, 5);
    await repository.updateDepartment(actors[0], departments[0].id, { active: false });
    for (const actorIndex of [0, 1]) { assert.equal(await read(actorIndex), null); assert.equal(await history(actorIndex), null); assert.equal(await write(actorIndex, 5, null), null); }
    await repository.updateDepartment(actors[0], departments[0].id, { active: true });
    assert.equal((await read(1)).link.version, 5); assert.equal((await history(1)).total, 5);
    checks.push('membership-and-active-department-revalidated-for-detail-write-and-history');

    await connection.execute('UPDATE cl_sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE token_hash = ?', [digest(tokens[1])]);
    await denied(() => read(1), 401); await denied(() => history(1), 401); await denied(() => write(1, 5, null), 401);
    await connection.execute('UPDATE cl_sessions SET expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR) WHERE token_hash = ?', [digest(tokens[1])]);
    await connection.execute('UPDATE cl_users SET name = ?, active = 0 WHERE id = ?', ['Autor atual inativo ' + suffix, actors[1]]);
    await denied(() => read(1), 401); await denied(() => history(1), 401);
    const inactiveHistory = await history(0);
    assert.equal(inactiveHistory.total, 5);
    assert.deepEqual(inactiveHistory.events.map(event => event.version), [5, 4, 3, 2, 1]);
    assert.equal(inactiveHistory.events.filter(event => event.version < 5).every(event => event.actorName === 'Autor atual inativo ' + suffix), true);
    await connection.execute('UPDATE cl_users SET active = 1 WHERE id = ?', [actors[1]]);
    await repository.revoke(tokens[1]);
    await denied(() => read(1), 401); await denied(() => history(1), 401); await denied(() => write(1, 5, null), 401);
    checks.push('expired-revoked-session-inactive-actor-denied-current-historical-name-readable');
  } catch (error) { operationFailure = error; }
  finally {
    pendingEventFailure = null;
    await connection.rollback();
  }
  // Check preservation also after a functional assertion fails, when a baseline exists.
  if (baseline) assert.equal(await preservationFingerprint(connection), baseline, 'Rollback must preserve previous records and logical schemas.');
  const [remaining] = await connection.execute('SELECT COUNT(*) AS total FROM cl_users WHERE email IN (?, ?, ?)', emails);
  assert.equal(Number(remaining[0].total), 0);
  if (operationFailure) throw operationFailure;
  checks.push('all-synthetic-association-records-rolled-back-fifteen-table-data-and-schema-preserved');
  return { verifiedAt: new Date().toISOString(), checks };
}

async function main() {
  loadEnvironment();
  const options = databaseOptions();
  if (!options) throw new Error('Configure o banco privado.');
  const connection = await mysql.createConnection(options);
  try { process.stdout.write('Associacao atendimento-contato verificada em transacao revertida: ' + JSON.stringify(await verifyConversationContactsDatabase(connection)) + '\n'); }
  finally { await connection.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Verificacao SQL de associacao falhou. Nenhuma identidade ou credencial foi exibida.\n'); process.exitCode = 1; });
module.exports = { verifyConversationContactsDatabase, preservationFingerprint };
