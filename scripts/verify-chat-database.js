'use strict';

// Explicit integration verification. Only synthetic records are changed, then rolled back.
// Savepoints share one connection: these checks do not claim cross-process concurrency.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { databaseOptions, repositoryForPool } = require('../src/database');
const { loadEnvironment } = require('../src/server');
const { secret, digest, hashPassword } = require('../src/security');
const { verifyDepartmentSchema, verifyChatSchema } = require('./migrate-database');

async function preservationFingerprint(connection) {
  // SQL returns hashes only; existing identities, credential hashes and text are never output.
  const tables = [
    ['cl_schema', 'id, version', 'id'], ['cl_company', 'id, name', 'id'],
    ['cl_users', 'id, name, email, password_hash, role, active, created_at', 'id'],
    ['cl_sessions', 'token_hash, user_id, expires_at', 'token_hash'],
    ['cl_departments', 'id, name, active, public_chat, created_at', 'id'],
    ['cl_department_members', 'department_id, user_id', 'department_id, user_id'],
    ['cl_visitors', 'id, name, token_hash, expires_at, created_at', 'id'],
    ['cl_chat_conversations', 'id, visitor_id, department_id, assigned_to, status, last_sequence, updated_at, created_at', 'id'],
    ['cl_chat_messages', 'conversation_id, `sequence`, sender, author_id, client_key, text, created_at', 'conversation_id, `sequence`'],
    ['cl_chat_limits', 'key_hash, window_start, count, expires_at', 'key_hash']
  ];
  const [schema] = await connection.execute('SELECT version FROM cl_schema WHERE id = 1');
  if (Number(schema[0]?.version) >= 4) tables.push(['cl_contacts', 'id, department_id, name, email, phone, company, kind, version, created_by, client_key, request_hash, created_at, updated_at', 'id']);
  if (Number(schema[0]?.version) >= 5) tables.push(
    ['cl_opportunities', 'id, contact_id, title, amount_cents, stage, version, created_by, client_key, request_hash, created_at, updated_at', 'id'],
    ['cl_opportunity_events', 'opportunity_id, version, actor_id, title, amount_cents, stage, created_at', 'opportunity_id, version']
  );
  const fingerprints = [];
  for (const [table, fields, order] of tables) {
    const [rows] = await connection.query(`SELECT SHA2(JSON_ARRAY(${fields}), 256) AS fingerprint FROM ${table} ORDER BY ${order}`);
    const [ddl] = await connection.query('SHOW CREATE TABLE ' + table);
    // Compare logical schema; InnoDB may consume AUTO_INCREMENT numbers on rollback.
    const definition = String(Object.values(ddl[0])[1]).replace(/\bAUTO_INCREMENT=\d+\b/gi, '').replace(/\s+/g, ' ').trim();
    fingerprints.push([table, rows.map(row => row.fingerprint), digest(definition)]);
  }
  return digest(JSON.stringify(fingerprints));
}

async function verifyChatDatabase(connection) {
  const checks = [];
  const suffix = secret().slice(0, 16);
  const emails = ['admin', 'operator-a', 'operator-b'].map(name => `${name}-${suffix}@example.test`);
  const departmentNames = [`Chat A ${suffix}`, `Chat B ${suffix}`];
  const visitorNames = [`José ${suffix} %_!\\`, `Visitante B ${suffix}`];
  const teamTokens = [secret(), secret(), secret()];
  const visitorTokens = [secret(), secret()];
  const passwordHash = await hashPassword(secret());
  const message = text => ({ text, clientKey: secret().slice(0, 32) });
  const denied = (operation, status) => assert.rejects(operation, error => error.statusCode === status);
  let baseline;
  await connection.beginTransaction();
  try {
    await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
    const nested = {
      execute: (sql, values) => connection.execute(sql, values),
      beginTransaction: () => connection.query('SAVEPOINT cl_chat_verification'),
      commit: () => connection.query('RELEASE SAVEPOINT cl_chat_verification'),
      rollback: () => connection.query('ROLLBACK TO SAVEPOINT cl_chat_verification'),
      release: () => {}
    };
    const pool = { execute: nested.execute, getConnection: async () => nested, end: async () => {} };
    const repository = repositoryForPool(pool);
    const capabilities = await repository.capabilities();
    assert.equal([3, 4, 5].includes(capabilities.schemaVersion), true);
    assert.equal(capabilities.departments, true); assert.equal(capabilities.chat, true);
    if (capabilities.schemaVersion >= 4) assert.equal(capabilities.contacts, true);
    if (capabilities.schemaVersion >= 5) assert.equal(capabilities.opportunities, true);
    await verifyDepartmentSchema(connection);
    await verifyChatSchema(connection);
    checks.push('schema-v3-defaults-indexes-foreign-keys');
    baseline = await preservationFingerprint(connection);
    const ids = [];
    for (let i = 0; i < emails.length; i++) {
      const [result] = await connection.execute('INSERT INTO cl_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [`Equipe sintetica ${i}`, emails[i], passwordHash, i === 0 ? 'admin' : 'operator']);
      ids.push(Number(result.insertId));
      // Insert only synthetic sessions; avoid global expired-session cleanup by login.
      await connection.execute('INSERT INTO cl_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))', [digest(teamTokens[i]), ids[i]]);
    }
    const departments = [];
    for (const name of departmentNames) departments.push(await repository.createDepartment(ids[0], { name }));
    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], true);
    await repository.setDepartmentMember(ids[0], departments[1].id, ids[2], true);
    for (const area of departments) assert.deepEqual(await repository.chatChannel(ids[0], teamTokens[0], area.id), { enabled: false });
    const before = await repository.listPublicChatDepartments();
    assert.equal(before.departments.some(area => departments.some(own => own.id === area.id)), false);
    await denied(() => repository.setChatChannel(ids[1], teamTokens[1], departments[0].id, true), 403);
    await denied(() => repository.setChatChannel(ids[0], secret(), departments[0].id, true), 401);
    for (const area of departments) assert.deepEqual(await repository.setChatChannel(ids[0], teamTokens[0], area.id, true), { enabled: true });
    const published = await repository.listPublicChatDepartments();
    for (const area of departments) assert.deepEqual(published.departments.find(row => row.id === area.id), { id: area.id, name: area.name });
    checks.push('public-entry-default-private-admin-token-required');

    const visitors = [];
    for (let i = 0; i < visitorTokens.length; i++) visitors.push(await repository.createVisitor(visitorTokens[i], visitorNames[i], digest(`synthetic-ip:${suffix}:${i}`)));
    assert.deepEqual(Object.keys(visitors[0]).sort(), ['id', 'name']);
    assert.deepEqual(await repository.visitorSession(visitorTokens[0]), visitors[0]);
    const [stored] = await connection.execute('SELECT token_hash, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), expires_at) AS remaining FROM cl_visitors WHERE id = ?', [visitors[0].id]);
    assert.equal(stored[0].token_hash, digest(visitorTokens[0]));
    assert.ok(Number(stored[0].remaining) > 28000 && Number(stored[0].remaining) <= 28800);
    await denied(() => repository.createVisitorConversation(secret(), departments[0].id), 401);
    checks.push('visitor-separate-identity-hashed-token-eight-hour-expiry');

    const conversations = [];
    for (let i = 0; i < visitors.length; i++) {
      const created = await repository.createVisitorConversation(visitorTokens[i], departments[i].id);
      assert.equal(created.created, true);
      assert.equal(created.conversation.status, 'waiting');
      assert.equal(created.conversation.assignedTo, null);
      assert.deepEqual(Object.keys(created.conversation).sort(), ['assignedTo', 'departmentId', 'departmentName', 'id', 'status', 'updatedAt', 'visitorName']);
      conversations.push(created.conversation);
    }
    const reused = await repository.createVisitorConversation(visitorTokens[0], departments[0].id);
    assert.equal(reused.created, false); assert.equal(reused.conversation.id, conversations[0].id);
    await denied(() => repository.createVisitorConversation(visitorTokens[0], departments[1].id), 409);
    assert.equal(await repository.visitorMessages(visitorTokens[1], conversations[0].id, 0, 50), null);
    await denied(() => repository.sendVisitorMessage(visitorTokens[1], conversations[0].id, message('Alheia')), 404);
    assert.deepEqual((await repository.listVisitorConversations(visitorTokens[0])).conversations.map(row => row.id), [conversations[0].id]);
    checks.push('one-open-conversation-reused-visitor-isolation-safe-fields');

    const visitorMessage = message('  Olá 😀\nPreciso de ajuda  ');
    const first = await repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, visitorMessage);
    assert.equal(first.created, true); assert.equal(first.message.sequence, 1); assert.equal(first.message.sender, 'visitor');
    assert.equal(first.message.text, visitorMessage.text.trim());
    assert.deepEqual(Object.keys(first.message).sort(), ['createdAt', 'sender', 'sequence', 'text']);
    assert.equal(Number.isNaN(Date.parse(first.message.createdAt)), false);
    const replay = await repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, visitorMessage);
    assert.equal(replay.created, false); assert.deepEqual(replay.message, first.message);
    await denied(() => repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, { ...visitorMessage, text: 'Mudou' }), 409);
    for (const text of ['', 'x'.repeat(2001), 'texto\u0000', 'texto\u007f']) await denied(() => repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, message(text)), 400);
    const [rates] = await connection.execute('SELECT count FROM cl_chat_limits WHERE key_hash = ?', [digest(`message:visitor:${visitors[0].id}`)]);
    assert.equal(Number(rates[0].count), 1);
    checks.push('utf8-text-validation-idempotency-does-not-consume-rate');

    assert.deepEqual((await repository.listChatConversations(ids[1], teamTokens[1], 1, 20)).conversations.map(row => row.id), [conversations[0].id]);
    assert.deepEqual((await repository.listChatConversations(ids[2], teamTokens[2], 1, 20)).conversations.map(row => row.id), [conversations[1].id]);
    assert.equal(await repository.teamMessages(ids[2], teamTokens[2], conversations[0].id, 0, 50), null);
    await denied(() => repository.sendTeamMessage(ids[2], teamTokens[2], conversations[0].id, message('Outra area')), 404);
    await denied(() => repository.sendTeamMessage(ids[1], teamTokens[1], conversations[0].id, message('Sem assumir')), 409);
    const claimed = await repository.changeChatConversation(ids[1], teamTokens[1], conversations[0].id, 'claim');
    assert.equal(claimed.conversation.assignedTo, ids[1]); assert.equal(claimed.conversation.status, 'open');
    assert.deepEqual(await repository.changeChatConversation(ids[1], teamTokens[1], conversations[0].id, 'claim'), claimed);
    await repository.setDepartmentMember(ids[0], departments[0].id, ids[2], true);
    await denied(() => repository.changeChatConversation(ids[2], teamTokens[2], conversations[0].id, 'claim'), 409);
    await denied(() => repository.sendTeamMessage(ids[0], teamTokens[0], conversations[0].id, message('Admin sem assumir')), 409);
    const teamMessage = message('Posso ajudar.');
    const teamSent = await repository.sendTeamMessage(ids[1], teamTokens[1], conversations[0].id, teamMessage);
    assert.equal(teamSent.message.sequence, 2); assert.equal(teamSent.message.sender, 'team');
    const secondVisitorMessage = message('Obrigada.');
    assert.equal((await repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, secondVisitorMessage)).message.sequence, 3);
    checks.push('department-scope-claim-idempotency-current-assignee-only');

    const firstPage = await repository.visitorMessages(visitorTokens[0], conversations[0].id, 0, 2);
    assert.deepEqual(firstPage.messages.map(row => row.sequence), [1, 2]); assert.equal(firstPage.cursor, 2); assert.equal(firstPage.hasMore, true);
    const resumedRepository = repositoryForPool(pool);
    const nextPage = await resumedRepository.visitorMessages(visitorTokens[0], conversations[0].id, firstPage.cursor, 2);
    assert.deepEqual(nextPage.messages.map(row => row.sequence), [3]); assert.equal(nextPage.cursor, 3); assert.equal(nextPage.hasMore, false);
    const empty = await resumedRepository.visitorMessages(visitorTokens[0], conversations[0].id, 3, 2);
    assert.deepEqual(empty, { messages: [], cursor: 3, hasMore: false });
    checks.push('persisted-history-local-sequence-pagination-new-repository');

    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], false);
    assert.equal(await repository.teamMessages(ids[1], teamTokens[1], conversations[0].id, 0, 50), null);
    await denied(() => repository.sendTeamMessage(ids[1], teamTokens[1], conversations[0].id, teamMessage), 404);
    assert.equal(await repository.changeChatConversation(ids[1], teamTokens[1], conversations[0].id, 'release'), null);
    const released = await repository.changeChatConversation(ids[0], teamTokens[0], conversations[0].id, 'release');
    assert.equal(released.conversation.status, 'waiting'); assert.equal(released.conversation.assignedTo, null);
    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], true);
    await repository.changeChatConversation(ids[2], teamTokens[2], conversations[0].id, 'claim');
    // Identical persisted delivery is confirmed after reassignment, with current access.
    assert.equal((await repository.sendTeamMessage(ids[1], teamTokens[1], conversations[0].id, teamMessage)).created, false);
    await denied(() => repository.sendTeamMessage(ids[1], teamTokens[1], conversations[0].id, message('Nova apos troca')), 409);
    checks.push('membership-revalidated-admin-recovery-safe-replay-after-reassignment');

    await repository.setChatChannel(ids[0], teamTokens[0], departments[0].id, false);
    assert.equal((await repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, message('Conversa existente'))).created, true);
    const extraToken = secret();
    await repository.createVisitor(extraToken, `Visitante novo ${suffix}`, digest(`synthetic-ip:${suffix}:new`));
    await denied(() => repository.createVisitorConversation(extraToken, departments[0].id), 404);
    await repository.updateDepartment(ids[0], departments[0].id, { active: false });
    assert.ok((await repository.visitorMessages(visitorTokens[0], conversations[0].id, 0, 50)).messages.length > 0);
    assert.equal(await repository.teamMessages(ids[2], teamTokens[2], conversations[0].id, 0, 50), null);
    await denied(() => repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, visitorMessage), 404);
    await denied(() => repository.sendTeamMessage(ids[1], teamTokens[1], conversations[0].id, teamMessage), 404);
    await repository.updateDepartment(ids[0], departments[0].id, { active: true });
    assert.ok(await repository.teamMessages(ids[2], teamTokens[2], conversations[0].id, 0, 50));
    checks.push('public-entry-only-new-inactive-blocks-writes-preserves-history');

    // Populate only synthetic limit records. Retry a boundary rollover, without sleeps.
    async function exhaustedRate(scope, seconds, maximum, operation) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const [clock] = await connection.execute('SELECT FLOOR(UNIX_TIMESTAMP() / ?) * ? AS windowStart', [seconds, seconds]);
        const windowStart = Number(clock[0].windowStart);
        await connection.execute('INSERT INTO cl_chat_limits (key_hash, window_start, count, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)) ON DUPLICATE KEY UPDATE window_start = VALUES(window_start), count = VALUES(count), expires_at = VALUES(expires_at)', [digest(scope), windowStart, maximum]);
        let error;
        try { await operation(); } catch (caught) { error = caught; }
        if (error) { assert.equal(error.statusCode, 429); return; }
        const [after] = await connection.execute('SELECT FLOOR(UNIX_TIMESTAMP() / ?) * ? AS windowStart', [seconds, seconds]);
        assert.notEqual(Number(after[0].windowStart), windowStart, 'Persisted rate must block within the same window.');
      }
      assert.fail('No stable rate window during verification.');
    }
    const limitedIp = digest(`synthetic-ip:${suffix}:limited`);
    await exhaustedRate('visitor-session:' + limitedIp, 900, 5, () => repository.createVisitor(secret(), 'Visitante limitado', limitedIp));
    await exhaustedRate(`message:visitor:${visitors[0].id}`, 60, 10, () => repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, message('Limite visitante')));
    assert.equal((await repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, visitorMessage)).created, false);
    await exhaustedRate(`message:team:${ids[2]}`, 60, 30, () => repository.sendTeamMessage(ids[2], teamTokens[2], conversations[0].id, message('Limite equipe')));
    // Isolate the 500-message budget from the previously exhausted synthetic rate.
    const visitorRateKey = digest(`message:visitor:${visitors[0].id}`);
    await connection.execute('UPDATE cl_chat_limits SET count = 0 WHERE key_hash = ?', [visitorRateKey]);
    const [sequenceBefore] = await connection.execute('SELECT last_sequence FROM cl_chat_conversations WHERE id = ?', [conversations[0].id]);
    await connection.execute('UPDATE cl_chat_conversations SET last_sequence = 500 WHERE id = ?', [conversations[0].id]);
    await denied(() => repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, message('Limite conversa')), 429);
    assert.equal((await repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, visitorMessage)).created, false);
    const [unconsumedRate] = await connection.execute('SELECT count FROM cl_chat_limits WHERE key_hash = ?', [visitorRateKey]);
    assert.equal(Number(unconsumedRate[0].count), 0);
    await connection.execute('UPDATE cl_chat_conversations SET last_sequence = ? WHERE id = ?', [sequenceBefore[0].last_sequence, conversations[0].id]);
    checks.push('persisted-ip-visitor-team-rates-and-conversation-budget');

    await repository.changeChatConversation(ids[2], teamTokens[2], conversations[0].id, 'close');
    await denied(() => repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, message('Depois do fim')), 409);
    await denied(() => repository.sendTeamMessage(ids[2], teamTokens[2], conversations[0].id, message('Depois do fim')), 409);
    await denied(() => repository.changeChatConversation(ids[2], teamTokens[2], conversations[0].id, 'claim'), 409);
    assert.equal((await repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, visitorMessage)).created, false);
    assert.equal((await repository.sendTeamMessage(ids[1], teamTokens[1], conversations[0].id, teamMessage)).created, false);
    checks.push('closed-denies-new-messages-allows-current-access-identical-replay');

    // Query suffix confines administrator assertions to these synthetic departments.
    // Operators have memberships only in synthetic areas, so wildcard probes cannot
    // be satisfied by unrelated customer records already present in the database.
    await repository.changeChatConversation(ids[2], teamTokens[2], conversations[1].id, 'claim');
    await repository.setChatChannel(ids[0], teamTokens[0], departments[0].id, true);
    const waiting = await repository.createVisitorConversation(extraToken, departments[0].id);
    assert.equal(waiting.created, true);
    const queueIds = [conversations[0].id, conversations[1].id, waiting.conversation.id];
    const queue = (actorIndex, filters = {}, page = 1, limit = 20) => repository.listChatConversations(ids[actorIndex], teamTokens[actorIndex], page, limit, filters);
    const assertQueue = async (actorIndex, filters, expected) => {
      const result = await queue(actorIndex, filters);
      assert.deepEqual(result.conversations.map(row => row.id).sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
      assert.equal(result.total, expected.length);
      assert.equal(result.page, 1); assert.equal(result.limit, 20);
      for (const row of result.conversations) assert.deepEqual(Object.keys(row).sort(), ['assignedTo', 'departmentId', 'departmentName', 'id', 'status', 'updatedAt', 'visitorName']);
      return result;
    };
    await assertQueue(0, { q: suffix }, queueIds);
    await assertQueue(0, { status: 'active', q: suffix }, [conversations[1].id, waiting.conversation.id]);
    await assertQueue(0, { status: 'waiting', q: suffix }, [waiting.conversation.id]);
    await assertQueue(0, { status: 'open', q: suffix }, [conversations[1].id]);
    await assertQueue(0, { status: 'closed', q: suffix }, [conversations[0].id]);
    await assertQueue(2, { assignment: 'me' }, [conversations[0].id, conversations[1].id]);
    await assertQueue(2, { status: 'closed', assignment: 'me' }, [conversations[0].id]);
    await assertQueue(2, { status: 'active', assignment: 'me' }, [conversations[1].id]);
    await assertQueue(2, { status: 'active', assignment: 'unassigned' }, [waiting.conversation.id]);
    await assertQueue(1, { assignment: 'me' }, []);
    await assertQueue(1, {}, [conversations[0].id, waiting.conversation.id]);
    const firstFiltered = await queue(2, { assignment: 'me' }, 1, 1);
    const secondFiltered = await queue(2, { assignment: 'me' }, 2, 1);
    assert.deepEqual(firstFiltered.conversations.map(row => row.id), [conversations[1].id]);
    assert.deepEqual(secondFiltered.conversations.map(row => row.id), [conversations[0].id]);
    assert.equal(firstFiltered.total, 2); assert.equal(secondFiltered.total, 2);
    assert.deepEqual(await queue(2, { assignment: 'me' }, 3, 1), { conversations: [], total: 2, page: 3, limit: 1 });
    await assertQueue(0, { q: departmentNames[0] }, [conversations[0].id, waiting.conversation.id]);
    for (const q of ['%', '_', '!', '\\', '%_!\\', '  Jose\u0301 ' + suffix + '  ']) await assertQueue(1, { q }, [conversations[0].id]);
    await assertQueue(1, { status: 'closed', assignment: 'any', q: '%_!\\' }, [conversations[0].id]);
    for (const q of ["' OR 1=1 --", 'x'.repeat(100)]) await assertQueue(1, { q }, []);
    for (const filters of [{ status: 'unknown' }, { assignment: 'other' }, { q: 123 }, { q: 'nome\n' }, { q: ' ' + 'x'.repeat(100) }, { departmentId: departments[1].id }]) {
      await denied(() => queue(1, filters), 400);
    }
    checks.push('queue-status-assignment-literal-search-authorized-total-pagination');

    await repository.setChatChannel(ids[0], teamTokens[0], departments[0].id, false);
    const detail = await repository.teamConversation(ids[1], teamTokens[1], conversations[0].id);
    assert.deepEqual(Object.keys(detail), ['conversation']);
    assert.deepEqual(Object.keys(detail.conversation).sort(), ['assignedTo', 'departmentId', 'departmentName', 'id', 'status', 'updatedAt', 'visitorName']);
    assert.equal(detail.conversation.id, conversations[0].id); assert.equal(detail.conversation.status, 'closed');
    assert.equal(detail.conversation.assignedTo, ids[2]); assert.equal(detail.conversation.visitorName, visitorNames[0]);
    assert.equal(await repository.teamConversation(ids[1], teamTokens[1], conversations[1].id), null);
    await denied(() => repository.teamConversation(ids[1], secret(), conversations[0].id), 401);
    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], false);
    assert.equal(await repository.teamConversation(ids[1], teamTokens[1], conversations[0].id), null);
    await assertQueue(1, { status: 'closed', q: suffix }, []);
    await repository.setDepartmentMember(ids[0], departments[0].id, ids[1], true);
    assert.ok(await repository.teamConversation(ids[1], teamTokens[1], conversations[0].id));
    await repository.updateDepartment(ids[0], departments[0].id, { active: false });
    assert.equal(await repository.teamConversation(ids[1], teamTokens[1], conversations[0].id), null);
    assert.equal(await repository.teamConversation(ids[0], teamTokens[0], conversations[0].id), null);
    await assertQueue(1, { q: suffix }, []);
    await repository.updateDepartment(ids[0], departments[0].id, { active: true });
    assert.ok(await repository.teamConversation(ids[1], teamTokens[1], conversations[0].id));
    // Claim removes the item from unassigned without changing current access.
    await assertQueue(1, { status: 'active', assignment: 'unassigned' }, [waiting.conversation.id]);
    await repository.changeChatConversation(ids[1], teamTokens[1], waiting.conversation.id, 'claim');
    await assertQueue(1, { status: 'active', assignment: 'unassigned' }, []);
    assert.equal((await repository.teamConversation(ids[1], teamTokens[1], waiting.conversation.id)).conversation.assignedTo, ids[1]);
    checks.push('safe-conversation-detail-current-access-outside-queue-filter');

    await repository.revokeVisitor(visitorTokens[0]);
    assert.equal(await repository.visitorSession(visitorTokens[0]), null);
    await denied(() => repository.visitorMessages(visitorTokens[0], conversations[0].id, 0, 50), 401);
    await denied(() => repository.sendVisitorMessage(visitorTokens[0], conversations[0].id, visitorMessage), 401);
    await repository.revoke(teamTokens[1]);
    await denied(() => repository.teamConversation(ids[1], teamTokens[1], conversations[0].id), 401);
    await denied(() => repository.sendTeamMessage(ids[1], teamTokens[1], conversations[0].id, teamMessage), 401);
    await repository.setOperatorActive(ids[2], false);
    await denied(() => repository.teamConversation(ids[2], teamTokens[2], conversations[0].id), 401);
    await denied(() => repository.listChatConversations(ids[2], teamTokens[2], 1, 20), 401);
    checks.push('revoked-visitor-team-and-inactive-operator-denied');
  } finally { await connection.rollback(); }
  assert.equal(await preservationFingerprint(connection), baseline, 'Rollback must preserve all existing records.');
  const [remaining] = await connection.execute('SELECT COUNT(*) AS total FROM cl_users WHERE email IN (?, ?, ?)', emails);
  assert.equal(Number(remaining[0].total), 0);
  checks.push('all-synthetic-records-rolled-back-existing-records-preserved');
  return { verifiedAt: new Date().toISOString(), checks };
}

async function main() {
  loadEnvironment();
  const options = databaseOptions();
  if (!options) throw new Error('Configure o banco privado.');
  const connection = await mysql.createConnection(options);
  try { process.stdout.write('Chat verificado em transacao revertida: ' + JSON.stringify(await verifyChatDatabase(connection)) + '\n'); }
  finally { await connection.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Verificacao SQL do chat falhou. Nenhuma identidade ou credencial foi exibida.\n'); process.exitCode = 1; });
module.exports = { verifyChatDatabase };
