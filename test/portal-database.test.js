'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { portalRepository } = require('../src/portal-database');
const { chatRepository } = require('../src/chat-database');
const { digest, secret } = require('../src/security');
const encoded = letter => 'scrypt-v1$' + 'a'.repeat(32) + '$' + letter.repeat(128);
const passwordHash = encoded('b');
const newPasswordHash = encoded('c');
const access = secret().slice(0, 24);
const secondAccess = secret().slice(0, 24);
const recovery = digest(secret());
const nextRecovery = digest(secret());
const denied = (operation, code) => assert.rejects(operation, error => error.statusCode === code);

// Production repositories run over a stateful SQL adapter with rollback/fault injection.
// This is behavioral persistence simulation, not a real MariaDB concurrency test.
function fixture() {
  const visitorTokens = [secret(), secret(), secret()];
  let state = { schema: 7, clock: 1801521000, nextAccount: 1, nextConversation: 200,
    visitors: visitorTokens.map((token, index) => ({ id: index + 1, name: 'Synthetic ' + (index + 1), tokenHash: digest(token), valid: true })),
    accounts: [], sessions: [], limits: [],
    departments: [{ id: 10, name: 'Public synthetic', active: 1, public_chat: 1 }, { id: 20, name: 'PRIVATE AREA', active: 1, public_chat: 0 }, { id: 30, name: 'INACTIVE AREA', active: 0, public_chat: 0 }],
    conversations: [{ id: 101, visitorId: 1, departmentId: 10, status: 'waiting', assignedTo: null, lastSequence: 0 }, { id: 102, visitorId: 2, departmentId: 10, status: 'waiting', assignedTo: null, lastSequence: 0 }, { id: 103, visitorId: 1, departmentId: 20, status: 'closed', assignedTo: null, lastSequence: 0 }, { id: 104, visitorId: 1, departmentId: 30, status: 'closed', assignedTo: null, lastSequence: 0 }],
    messages: [], forcedCounts: {} };
  let nextFault = null; let serial = Promise.resolve(); const traces = [];
  const now = '2026-10-02T23:00:00.000Z';
  const safeConversation = row => {
    const area = state.departments.find(item => item.id === row.departmentId);
    const visitor = state.visitors.find(item => item.id === row.visitorId);
    return { ...row, visitorName: visitor.name, departmentName: area.name, updatedAt: now };
  };
  async function execute(sql, values = []) {
    traces.push(sql);
    if (nextFault && sql.startsWith(nextFault.sql)) { const fault = nextFault.error; nextFault = null; throw fault; }
    const rows = value => [value, []]; const changed = value => [{ affectedRows: value }, []];
    if (sql === 'SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE') return rows([{ id: 1 }]);
    if (sql.startsWith('SELECT id, name FROM cl_visitors')) return rows(state.visitors.filter(item => item.tokenHash === values[0] && item.valid).map(({ id, name }) => ({ id, name })));
    if (sql.startsWith('UPDATE cl_visitors SET expires_at')) { const visitor = state.visitors.find(item => item.id === values[0]); if (visitor) visitor.valid = false; return changed(visitor ? 1 : 0); }
    if (sql.startsWith('SELECT id FROM cl_portal_accounts WHERE visitor_id')) return rows(state.accounts.filter(item => item.visitorId === values[0]).map(item => ({ id: item.id })));
    if (sql.startsWith('INSERT INTO cl_portal_accounts ')) {
      if (state.accounts.some(item => item.visitorId === values[0] || item.accessId === values[1])) { const error = new Error(); error.code = 'ER_DUP_ENTRY'; throw error; }
      const account = { id: state.nextAccount++, visitorId: values[0], accessId: values[1], passwordHash: values[2], recoveryHash: values[3], version: 1, active: true };
      state.accounts.push(account); return [{ insertId: account.id, affectedRows: 1 }, []];
    }
    if (sql.startsWith('SELECT id, visitor_id AS visitorId, password_hash')) return rows(state.accounts.filter(item => item.accessId === values[0] && item.active));
    if (sql.startsWith('SELECT password_hash AS passwordHash, version FROM cl_portal_accounts')) return rows(state.accounts.filter(item => item.id === values[0] && item.active));
    if (sql.startsWith('SELECT id, visitor_id AS visitorId, recovery_hash')) return rows(state.accounts.filter(item => item.accessId === values[0] && item.active));
    if (sql.startsWith('UPDATE cl_portal_accounts SET password_hash')) {
      const account = state.accounts.find(item => item.id === values[2] && item.version === values[3] && item.active);
      if (account) { account.passwordHash = values[0]; account.recoveryHash = values[1]; account.version++; } return changed(account ? 1 : 0);
    }
    if (sql.startsWith('DELETE FROM cl_portal_sessions WHERE expires_at')) { const removed = state.sessions.filter(item => !item.valid).slice(0, 100); state.sessions = state.sessions.filter(item => !removed.includes(item)); return changed(removed.length); }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM cl_portal_sessions WHERE account_id')) return rows([{ total: state.sessions.filter(item => item.accountId === values[0] && item.valid).length }]);
    if (sql.startsWith('INSERT INTO cl_portal_sessions ')) { state.sessions.push({ hash: values[0], accountId: values[1], valid: true }); return changed(1); }
    if (sql.startsWith('DELETE FROM cl_portal_sessions WHERE token_hash')) { const previous = state.sessions.length; state.sessions = state.sessions.filter(item => item.hash !== values[0]); return changed(previous - state.sessions.length); }
    if (sql.startsWith('DELETE FROM cl_portal_sessions WHERE account_id')) { const previous = state.sessions.length; state.sessions = state.sessions.filter(item => item.accountId !== values[0]); return changed(previous - state.sessions.length); }
    if (sql.startsWith('SELECT a.id AS accountId, a.visitor_id AS visitorId')) {
      const session = state.sessions.find(item => item.hash === values[0] && item.valid);
      const account = session && state.accounts.find(item => item.id === session.accountId && item.active);
      const visitor = account && state.visitors.find(item => item.id === account.visitorId);
      return rows(visitor ? [{ accountId: account.id, visitorId: account.visitorId, accessId: account.accessId, name: visitor.name }] : []);
    }
    if (sql.startsWith('DELETE FROM cl_chat_limits ')) { const removed = state.limits.filter(item => item.expires <= state.clock).slice(0, 100); state.limits = state.limits.filter(item => !removed.includes(item)); return changed(removed.length); }
    if (sql.startsWith('SELECT UNIX_TIMESTAMP()')) return rows([{ now: state.clock }]);
    if (sql.startsWith('SELECT window_start AS windowStart, count FROM cl_chat_limits')) return rows(state.limits.filter(item => item.key === values[0]).map(item => ({ windowStart: item.start, count: item.count })));
    if (sql.startsWith('INSERT INTO cl_chat_limits ')) { const current = state.limits.find(item => item.key === values[0]); const replacement = { key: values[0], start: values[1], count: values[2], expires: values[1] + (sql.includes('INTERVAL 900 ') ? 900 : values[0] === digest('message:visitor:1') || values[0] === digest('message:visitor:2') ? 60 : 900) }; if (current) Object.assign(current, replacement); else state.limits.push(replacement); return changed(1); }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM ')) {
      const table = sql.slice('SELECT COUNT(*) AS total FROM '.length).split(' ')[0];
      const arrays = { cl_portal_accounts: state.accounts, cl_portal_sessions: state.sessions, cl_chat_limits: state.limits, cl_chat_conversations: state.conversations, cl_chat_messages: state.messages };
      const total = Object.hasOwn(state.forcedCounts, table) ? state.forcedCounts[table] : (table === 'cl_chat_conversations' && sql.includes('WHERE visitor_id') ? state.conversations.filter(item => item.visitorId === values[0]).length : arrays[table]?.length);
      if (total === undefined) throw new Error('Unknown count: ' + sql); return rows([{ total }]);
    }
    if (sql.startsWith('SELECT id, department_id AS departmentId FROM cl_chat_conversations')) return rows(state.conversations.filter(item => item.visitorId === values[0] && item.status !== 'closed').sort((a, b) => a.id - b.id).slice(0, 1));
    if (sql.startsWith('SELECT id, name, active, public_chat FROM cl_departments')) return rows(state.departments.filter(item => item.id === values[0]));
    if (sql.startsWith('SELECT id, visitor_id AS visitorId, department_id AS departmentId')) return rows(state.conversations.filter(item => item.id === values[0]));
    if (sql.startsWith('INSERT INTO cl_chat_conversations ')) { const conversation = { id: state.nextConversation++, visitorId: values[0], departmentId: values[1], status: 'waiting', assignedTo: null, lastSequence: 0 }; state.conversations.push(conversation); return [{ insertId: conversation.id, affectedRows: 1 }, []]; }
    if (sql.startsWith('SELECT c.id,')) {
      let selected = state.conversations.filter(item => sql.includes('WHERE c.visitor_id') ? item.visitorId === values[0] : item.id === values[0]);
      if (sql.includes('ORDER BY c.id DESC')) selected = selected.sort((a, b) => b.id - a.id).slice(0, 20);
      return rows(selected.map(item => { const data = safeConversation(item); const area = state.departments.find(area => area.id === item.departmentId); if (sql.includes('CASE WHEN') && !(area.active === 1 && area.public_chat === 1)) data.departmentName = 'Atendimento anterior'; return data; }));
    }
    if (sql.startsWith('SELECT ' + String.fromCharCode(96) + 'sequence' + String.fromCharCode(96))) {
      let selected = state.messages.filter(item => item.conversationId === values[0]);
      if (sql.includes('sender = ?')) selected = selected.filter(item => item.sender === values[1] && item.authorId === values[2] && item.clientKey === values[3]);
      else if (sql.includes(' > ?')) { const limit = Number(sql.match(/LIMIT (\d+)/)[1]); selected = selected.filter(item => item.sequence > values[1]).sort((a, b) => a.sequence - b.sequence).slice(0, limit); }
      else selected = selected.filter(item => item.sequence === values[1]);
      return rows(selected);
    }
    if (sql.startsWith('INSERT INTO cl_chat_messages ')) { state.messages.push({ conversationId: values[0], sequence: values[1], sender: values[2], authorId: values[3], clientKey: values[4], text: values[5], createdAt: now }); return changed(1); }
    if (sql.startsWith('UPDATE cl_chat_conversations SET last_sequence')) { const conversation = state.conversations.find(item => item.id === values[1]); conversation.lastSequence = values[0]; return changed(1); }
    throw new Error('Unhandled synthetic SQL: ' + sql);
  }
  const transaction = work => {
    const current = serial.then(async () => { const before = structuredClone(state); traces.push('BEGIN'); try { const result = await work({ execute }); traces.push('COMMIT'); return result; } catch (error) { state = before; traces.push('ROLLBACK'); throw error; } });
    serial = current.catch(() => {}); return current;
  };
  const capabilities = async () => { traces.push('CAPABILITIES'); return { schemaVersion: state.schema, chat: true, portal: state.schema === 7 }; };
  const repository = { ...portalRepository({ execute }, { transaction, capabilities }), ...chatRepository({ execute }, { transaction, capabilities }) };
  return { repository, visitorTokens, traces, get state() { return state; }, fault(sql) { const error = new Error('Synthetic SQL fault'); nextFault = { sql, error }; return error; } };
}
async function enroll(f, index = 0, identifier = access) {
  await f.repository.createPortalAccount(f.visitorTokens[index], { accessId: identifier, passwordHash, recoveryHash: recovery });
  const identity = await f.repository.findPortalAccount(identifier); const token = secret();
  assert.equal(await f.repository.createPortalSession(token, identity.id, identity.passwordHash, identity.version), true);
  return { ...identity, token, accessId: identifier };
}

test('cadastro exige cookie atual, expira credencial anonima e conserva visitante e historico', async () => {
  const f = fixture(); const input = { accessId: access, passwordHash, recoveryHash: recovery };
  const created = await f.repository.createPortalAccount(f.visitorTokens[0], input);
  assert.deepEqual(created, { created: true, account: { accessId: access, name: 'Synthetic 1' } });
  assert.equal(f.state.accounts[0].visitorId, 1); assert.equal(f.state.visitors[0].valid, false); assert.equal(f.state.sessions.length, 0);
  assert.equal(await f.repository.visitorSession(f.visitorTokens[0]), null);
  await denied(() => f.repository.createPortalAccount(f.visitorTokens[0], { ...input, accessId: secondAccess }), 401);
  f.state.visitors[0].valid = true;
  await denied(() => f.repository.createPortalAccount(f.visitorTokens[0], { ...input, accessId: secondAccess }), 409);
  assert.equal(f.state.accounts.length, 1); assert.equal(f.state.conversations.find(item => item.id === 101).visitorId, 1);
  f.state.visitors[1].valid = false; await denied(() => f.repository.createPortalAccount(f.visitorTokens[1], input), 401);
});

test('duas contas isolam historico e envio; DTO mascara area privada e nao publica identidades internas', async () => {
  const f = fixture(); const a = await enroll(f); const b = await enroll(f, 1, secondAccess);
  assert.deepEqual(await f.repository.portalSession(a.token), { accessId: access, name: 'Synthetic 1' });
  const own = await f.repository.listPortalConversations(a.token);
  assert.deepEqual(own.conversations.map(item => item.id), [104, 103, 101]);
  assert.equal(own.conversations.filter(item => item.id !== 101).every(item => item.departmentName === 'Atendimento anterior'), true);
  for (const item of own.conversations) assert.deepEqual(Object.keys(item).sort(), ['departmentName', 'id', 'status', 'updatedAt']);
  assert.equal(await f.repository.portalMessages(b.token, 101, 0, 20), null);
  await denied(() => f.repository.sendPortalMessage(b.token, 101, { text: 'private', clientKey: secret().slice(0, 32) }), 404);
  assert.deepEqual((await f.repository.listPortalConversations(b.token)).conversations.map(item => item.id), [102]);
  assert.equal(await f.repository.portalSession(f.visitorTokens[0]), null);
});

test('mensagem anonima anterior e portal compartilham autor idempotente; autorizacao antecede replay', async () => {
  const f = fixture(); const payload = { text: 'Synthetic original', clientKey: secret().slice(0, 32) };
  const first = await f.repository.sendVisitorMessage(f.visitorTokens[0], 101, payload); const a = await enroll(f);
  const replay = await f.repository.sendPortalMessage(a.token, 101, payload);
  assert.equal(first.created, true); assert.equal(replay.created, false); assert.deepEqual(replay.message, first.message);
  assert.equal(f.state.messages.length, 1); assert.equal(f.state.messages[0].authorId, 1);
  f.state.conversations[0].status = 'closed'; assert.equal((await f.repository.sendPortalMessage(a.token, 101, payload)).created, false);
  await denied(() => f.repository.sendPortalMessage(a.token, 101, { ...payload, text: 'different' }), 409);
  await denied(() => f.repository.sendPortalMessage(a.token, 101, { text: 'new', clientKey: secret().slice(0, 32) }), 409);
  f.state.accounts[0].active = false;
  await denied(() => f.repository.sendPortalMessage(a.token, 101, payload), 401); await denied(() => f.repository.listPortalConversations(a.token), 401);
});

test('abertura portal reutiliza uma ativa e aplica canal publico, historico20 e quotas existentes', async () => {
  const f = fixture(); const a = await enroll(f);
  assert.equal((await f.repository.createPortalConversation(a.token, 10)).created, false);
  await denied(() => f.repository.createPortalConversation(a.token, 20), 409);
  f.state.conversations[0].status = 'closed';
  await denied(() => f.repository.createPortalConversation(a.token, 20), 404);
  await denied(() => f.repository.createPortalConversation(a.token, 30), 404);
  const opened = await f.repository.createPortalConversation(a.token, 10); assert.equal(opened.created, true);
  assert.deepEqual(Object.keys(opened.conversation).sort(), ['departmentName', 'id', 'status', 'updatedAt']);
  f.state.conversations.find(item => item.id === opened.conversation.id).status = 'closed';
  while (f.state.conversations.filter(item => item.visitorId === 1).length < 20) f.state.conversations.push({ id: f.state.nextConversation++, visitorId: 1, departmentId: 10, status: 'closed', assignedTo: null, lastSequence: 0 });
  await denied(() => f.repository.createPortalConversation(a.token, 10), 429);
});

test('area desativada preserva historico mas bloqueia envio e conta/sessao revogadas negam acesso', async () => {
  const f = fixture(); const a = await enroll(f);
  f.state.departments[0].active = 0;
  assert.deepEqual(await f.repository.portalMessages(a.token, 101, 0, 20), { messages: [], cursor: 0, hasMore: false });
  await denied(() => f.repository.sendPortalMessage(a.token, 101, { text: 'test', clientKey: secret().slice(0, 32) }), 404);
  f.state.sessions[0].valid = false; assert.equal(await f.repository.portalSession(a.token), null);
  await denied(() => f.repository.portalMessages(a.token, 101, 0, 20), 401);
});

test('login usa CAS do hash e versao atuais e limita cinco sessoes sem alterar outra conta', async () => {
  const f = fixture(); const a = await enroll(f); const b = await enroll(f, 1, secondAccess);
  assert.equal(await f.repository.createPortalSession(secret(), a.id, newPasswordHash, 1), false);
  assert.equal(await f.repository.createPortalSession(secret(), a.id, passwordHash, 2), false);
  for (let i = 0; i < 4; i++) assert.equal(await f.repository.createPortalSession(secret(), a.id, passwordHash, 1), true);
  await denied(() => f.repository.createPortalSession(secret(), a.id, passwordHash, 1), 429);
  await f.repository.revokePortalSession(a.token); assert.equal(await f.repository.portalSession(a.token), null); assert.notEqual(await f.repository.portalSession(b.token), null);
  f.state.accounts[0].active = false; assert.equal(await f.repository.createPortalSession(secret(), a.id, passwordHash, 1), false);
});

test('recuperacao CAS rotaciona segredo, invalida todas sessoes e rejeita credenciais verificadas antes', async () => {
  const f = fixture(); const a = await enroll(f); const another = secret();
  await f.repository.createPortalSession(another, a.id, passwordHash, 1);
  assert.equal(await f.repository.recoverPortalAccount(access, digest('wrong'), 1, newPasswordHash, nextRecovery), false);
  assert.equal(await f.repository.recoverPortalAccount(access, recovery, 2, newPasswordHash, nextRecovery), false);
  assert.equal(await f.repository.recoverPortalAccount(access, recovery, 1, newPasswordHash, nextRecovery), true);
  assert.equal(f.state.accounts[0].version, 2); assert.equal(f.state.accounts[0].recoveryHash, nextRecovery); assert.equal(f.state.visitors[0].valid, false);
  assert.equal(await f.repository.portalSession(a.token), null); assert.equal(await f.repository.portalSession(another), null);
  assert.equal(await f.repository.createPortalSession(secret(), a.id, passwordHash, 1), false);
  assert.equal(await f.repository.recoverPortalAccount(access, recovery, 1, passwordHash, digest(secret())), false);
  assert.equal(await f.repository.createPortalSession(secret(), a.id, newPasswordHash, 2), true);
});

test('falha depois de INSERT/UPDATE reverte cadastro e recuperacao incluindo sessao e cookie', async () => {
  const f = fixture(); const beforeRegistration = structuredClone(f.state); const fault = f.fault('UPDATE cl_visitors SET expires_at');
  await assert.rejects(() => f.repository.createPortalAccount(f.visitorTokens[0], { accessId: access, passwordHash, recoveryHash: recovery }), error => error === fault);
  assert.deepEqual(f.state, beforeRegistration);
  const a = await enroll(f); const beforeRecovery = structuredClone(f.state); const recoveryFault = f.fault('DELETE FROM cl_portal_sessions WHERE account_id');
  await assert.rejects(() => f.repository.recoverPortalAccount(access, recovery, 1, newPasswordHash, nextRecovery), error => error === recoveryFault);
  assert.deepEqual(f.state, beforeRecovery); assert.notEqual(await f.repository.portalSession(a.token), null);
});

test('limites de login persistem recusas e janelas por IP e identificador, inclusive outro repo/processo', async () => {
  const f = fixture(); const ip = digest('Synthetic IP');
  for (let index = 0; index < 10; index++) assert.equal(await f.repository.portalAttempt(ip, access), true);
  assert.equal(await f.repository.portalAttempt(ip, access), false);
  assert.equal(f.state.limits.find(item => item.key === digest('portal-attempt-ip:' + ip)).count, 11);
  assert.equal(await f.repository.portalAttempt(digest('Second IP'), access), false);
  assert.equal(f.state.limits.find(item => item.key === digest('portal-attempt-ip:' + digest('Second IP'))).count, 1);
  assert.equal(await f.repository.portalAttempt(ip, secondAccess), false);
  f.state.clock += 900; assert.equal(await f.repository.portalAttempt(ip, access), true);
  f.state.forcedCounts.cl_chat_limits = 10000;
  const before = structuredClone(f.state.limits); assert.equal(await f.repository.portalAttempt(digest('Third IP'), secret().slice(0, 24)), false); assert.deepEqual(f.state.limits, before);
});

test('todas entradas transacionais travam schema antes de leitura; schema6 falha503 sem portal', async () => {
  const f = fixture(); await f.repository.portalAttempt(digest('Synthetic IP'), access); const a = await enroll(f);
  await f.repository.listPortalConversations(a.token); await f.repository.portalMessages(a.token, 101, 0, 20);
  for (let i = 0; i < f.traces.length; i++) if (f.traces[i] === 'BEGIN') { assert.equal(f.traces[i + 1], 'SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE'); assert.equal(f.traces[i + 2], 'CAPABILITIES'); }
  f.state.schema = 6;
  await denied(() => f.repository.portalAttempt(digest('Synthetic IP'), access), 503); await denied(() => f.repository.findPortalAccount(access), 503); await denied(() => f.repository.listPortalConversations(a.token), 503);
});

test('IDs, hashes, campos e segredo de recuperacao repetido sao rejeitados antes de gravar', async () => {
  const f = fixture(); const a = await enroll(f);
  for (const input of [null, [], { accessId: access, passwordHash, recoveryHash: recovery, visitorId: 2 }, { accessId: access, passwordHash: 'plain', recoveryHash: recovery }, { accessId: access, passwordHash, recoveryHash: 'plain' }]) await denied(() => f.repository.createPortalAccount(f.visitorTokens[1], input), 400);
  await denied(() => f.repository.portalAttempt('wrong', access), 400); await denied(() => f.repository.findPortalAccount('wrong'), 400);
  await denied(() => f.repository.createPortalSession(secret(), a.id, passwordHash, '1'), 400); await denied(() => f.repository.recoverPortalAccount(access, recovery, 1, passwordHash, recovery), 400);
  await denied(() => f.repository.createPortalConversation(a.token, '10'), 400); await denied(() => f.repository.portalMessages(a.token, '101', 0, 20), 400); await denied(() => f.repository.portalMessages(a.token, 101, -1, 20), 400);
  await denied(() => f.repository.sendPortalMessage(a.token, 101, { text: 'test', clientKey: 'wrong' }), 400);
  assert.equal(await f.repository.portalSession('wrong'), null);
});
