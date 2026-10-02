'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const { registerAuth } = require('../src/auth');
const { registerConversationContacts } = require('../src/conversation-contacts');
const { digest, secret } = require('../src/security');
const origin = 'https://crm.example.test';
const base = '/api/crm/conversations/100/contact';
function fixture(t, schemaVersion = 6) {
  const users = [{ id: 1, name: 'Admin', role: 'admin', active: true }, { id: 2, name: 'Operador A', role: 'operator', active: true }, { id: 3, name: 'Operador B', role: 'operator', active: true }];
  const tokens = users.map(() => secret());
  const sessions = new Map(tokens.map((token, i) => [digest(token), users[i].id]));
  const members = new Set(['10:2', '20:3']);
  const conversation = { id: 100, departmentId: 10, assignedTo: 2, status: 'open', active: true };
  const contacts = [{ id: 200, departmentId: 10, name: 'Contato A', kind: 'lead' }, { id: 201, departmentId: 10, name: 'Contato B', kind: 'customer' }, { id: 300, departmentId: 20, name: 'Outra área', kind: 'contact' }];
  const state = { version: 0, contactId: null, events: [], globalEvents: 0, before: null };
  const calls = [];
  const fail = statusCode => { throw Object.assign(new Error('Refused'), { statusCode }); };
  const actor = (id, token) => {
    state.before?.(); state.before = null;
    const user = users.find(user => user.id === id && user.active && sessions.get(digest(token)) === id);
    if (!user) fail(401); return user;
  };
  const visible = (user, id) => id === 100 && conversation.active && (user.role === 'admin' || members.has('10:' + user.id));
  const canEdit = user => conversation.status === 'open' && conversation.assignedTo === user.id;
  const safe = user => {
    const contact = contacts.find(row => row.id === state.contactId);
    return { conversationId: 100, departmentId: 10, version: state.version, contactId: contact?.id ?? null, contactName: contact?.name ?? null,
      contactKind: contact?.kind ?? null, updatedAt: state.version ? '2026-10-02T00:00:00.000Z' : null, canEdit: canEdit(user) };
  };
  const repository = {
    async capabilities() { return { schemaVersion, departments: true, chat: true, contacts: true, opportunities: true, ...(schemaVersion === 6 ? { conversationContacts: true } : {}) }; },
    async session(token) { return users.find(user => user.active && user.id === sessions.get(digest(token))) || null; },
    async company() { return 'Empresa sintética'; }, async status() { return 'installed'; },
    async getConversationContact(id, token, conversationId) {
      calls.push({ method: 'get', id, token, conversationId }); const user = actor(id, token);
      return visible(user, conversationId) ? { link: safe(user) } : null;
    },
    async setConversationContact(id, token, conversationId, input) {
      calls.push({ method: 'set', id, token, conversationId, input: { ...input } }); const user = actor(id, token);
      if (!visible(user, conversationId)) return null;
      if (!canEdit(user)) fail(409);
      if (input.contactId !== null && !contacts.some(row => row.id === input.contactId && row.departmentId === 10)) return null;
      if (input.version !== state.version) fail(409);
      if (input.contactId !== state.contactId) {
        if (state.version >= 100 || state.globalEvents >= 50000) fail(429);
        state.contactId = input.contactId; state.version++; state.globalEvents++;
        state.events.push({ version: state.version, contactId: state.contactId, actorId: id });
      }
      return { link: safe(user) };
    },
    async listConversationContactEvents(id, token, conversationId, page, limit) {
      calls.push({ method: 'events', id, token, conversationId, page, limit }); const user = actor(id, token);
      if (!visible(user, conversationId)) return null;
      const events = [...state.events].reverse().slice((page - 1) * limit, page * limit).map(row => ({ version: row.version, contactId: row.contactId,
        contactName: contacts.find(contact => contact.id === row.contactId)?.name ?? null,
        actorName: users.find(user => user.id === row.actorId).name, createdAt: '2026-10-02T00:00:00.000Z' }));
      return { events, total: state.events.length, page, limit };
    }
  };
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  const auth = registerAuth(app, repository, { APP_URL: origin, NODE_ENV: 'production' });
  registerConversationContacts(app, repository, auth);
  app.setErrorHandler((error, request, reply) => reply.code(error.statusCode >= 400 && error.statusCode <= 503 ? error.statusCode : 500).send({ error: 'Operação recusada.' }));
  t.after(() => app.close());
  const headers = index => ({ Cookie: '__Host-cl_session=' + tokens[index], Origin: origin, 'X-CSRF-Token': digest('csrf:' + tokens[index]) });
  const get = (index = 1, url = base) => app.inject({ url, headers: headers(index) });
  const patch = (input, index = 1) => app.inject({ method: 'PATCH', url: base, headers: headers(index), payload: input });
  return { app, get, patch, headers, users, tokens, sessions, members, conversation, contacts, state, calls };
}
test('association requires staff identity and schema6 while previous login remains available', async t => {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const f = fixture(t, version);
    for (const url of [base, base + '/events']) {
      assert.equal((await f.app.inject(url)).statusCode, 401);
      assert.equal((await f.app.inject({ url, headers: { Cookie: '__Host-cl_visitor=' + f.tokens[1] } })).statusCode, 401);
      assert.equal((await f.get(1, url)).statusCode, version === 6 ? 200 : 503);
    }
    assert.equal((await f.get(1, '/api/auth/me')).statusCode, 200);
    assert.equal((await f.patch({ version: 0, contactId: 200 })).statusCode, version === 6 ? 200 : 503);
  }
});
test('association writes require same origin and matching staff CSRF before persistence', async t => {
  const f = fixture(t);
  for (const headers of [{ ...f.headers(1), Origin: 'https://other.example.test' }, { Cookie: f.headers(1).Cookie, Origin: origin }, { ...f.headers(1), 'X-CSRF-Token': digest('csrf:' + f.tokens[0]) }]) {
    assert.equal((await f.app.inject({ method: 'PATCH', url: base, headers, payload: { version: 0, contactId: 200 } })).statusCode, 403);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.state.version, 0);
});
test('unlinked state uses version0 and safe fields and null noop creates no relationship event', async t => {
  const f = fixture(t); const response = await f.get();
  assert.deepEqual(response.json().link, { conversationId: 100, departmentId: 10, version: 0, contactId: null, contactName: null, contactKind: null, updatedAt: null, canEdit: true });
  assert.equal((await f.patch({ version: 0, contactId: null })).json().link.version, 0);
  assert.equal((await f.get(1, base + '/events')).json().total, 0);
  assert.equal(f.state.events.length, 0); assert.equal(f.calls[0].token, f.tokens[1]);
});
test('link replace unlink and relink retain versions and paginated private history', async t => {
  const f = fixture(t);
  for (const [version, contactId] of [[0, 200], [1, 201], [2, null], [3, 200]]) {
    const response = await f.patch({ version, contactId }); assert.equal(response.statusCode, 200);
    assert.equal(response.json().link.version, version + 1); assert.equal(response.json().link.contactId, contactId);
  }
  const history = (await f.get(1, base + '/events?page=2&limit=2')).json();
  assert.equal(history.total, 4); assert.equal(history.page, 2); assert.equal(history.limit, 2);
  assert.deepEqual(history.events.map(row => row.version), [2, 1]);
  assert.deepEqual(Object.keys(history.events[0]).sort(), ['actorName', 'contactId', 'contactName', 'createdAt', 'version']);
  assert.deepEqual((await f.get(1, base + '/events?page=3&limit=2')).json().events, []);
  f.contacts[0].name = 'Nome atual'; f.users[1].active = false;
  const adminHistory = (await f.get(0, base + '/events')).json();
  assert.equal(adminHistory.events[0].contactName, 'Nome atual'); assert.equal(adminHistory.events[0].actorName, 'Operador A');
});
test('CAS detects duplicate and conflicting stale changes without overwriting or extra events', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.patch({ version: 0, contactId: 200 }), f.patch({ version: 0, contactId: 201 })]);
  assert.deepEqual(results.map(response => response.statusCode).sort(), [200, 409]);
  assert.equal(f.state.version, 1); assert.equal(f.state.events.length, 1);
  assert.equal((await f.patch({ version: 0, contactId: f.state.contactId })).statusCode, 409);
  assert.equal((await f.patch({ version: 1, contactId: f.state.contactId })).statusCode, 200);
  assert.equal(f.state.events.length, 1);
});
test('only current owner of an open conversation edits and even admin cannot cross contact area', async t => {
  const f = fixture(t);
  assert.equal((await f.get(0)).json().link.canEdit, false);
  assert.equal((await f.patch({ version: 0, contactId: 200 }, 0)).statusCode, 409);
  f.conversation.assignedTo = 1;
  assert.equal((await f.patch({ version: 0, contactId: 300 }, 0)).statusCode, 404);
  assert.equal((await f.patch({ version: 0, contactId: 200 }, 0)).statusCode, 200);
  for (const status of ['closed', 'waiting']) {
    f.conversation.status = status;
    assert.equal((await f.get(0)).json().link.canEdit, false);
    assert.equal((await f.patch({ version: 1, contactId: null }, 0)).statusCode, 409);
  }
  assert.equal(f.state.events.length, 1);
});
test('current session membership and active area are revalidated before read and mutation', async t => {
  const f = fixture(t); await f.patch({ version: 0, contactId: 200 });
  assert.equal((await f.get(2)).statusCode, 404); assert.equal((await f.get(2, base + '/events')).statusCode, 404);
  f.state.before = () => f.members.delete('10:2');
  assert.equal((await f.patch({ version: 1, contactId: null })).statusCode, 404);
  assert.equal((await f.get()).statusCode, 404);
  f.conversation.active = false;
  assert.equal((await f.get(0)).statusCode, 404);
  f.sessions.delete(digest(f.tokens[0]));
  assert.equal((await f.get(0)).statusCode, 401);
  assert.equal(f.state.version, 1); assert.equal(f.state.events.length, 1);
});
test('nullable contact cannot coerce invalid values into unlink and invalid bodies never persist', async t => {
  const f = fixture(t); await f.patch({ version: 0, contactId: 200 }); const before = f.calls.length;
  for (const contactId of [0, false, true, '', '200', 'null', -1, 1.5, 4294967296, [], {}]) {
    assert.equal((await f.patch({ version: 1, contactId })).statusCode, 400, JSON.stringify(contactId));
  }
  for (const input of [{ version: '1', contactId: null }, { version: false, contactId: null }, { version: null, contactId: null }, { version: -1, contactId: null }, { version: 1.2, contactId: null }, { version: 4294967296, contactId: null }, { contactId: null }, { version: 1 }, { version: 1, contactId: null, userId: 1 }, []]) {
    assert.equal((await f.patch(input)).statusCode, 400);
  }
  assert.equal(f.calls.length, before); assert.equal(f.state.contactId, 200); assert.equal(f.state.version, 1);
});
test('detail history pagination and identifiers reject extras and duplicate query values', async t => {
  const f = fixture(t);
  for (const query of ['q=a', 'page=1', 'extra=1']) assert.equal((await f.get(1, base + '?' + query)).statusCode, 400);
  for (const query of ['page=1&page=2', 'limit=1&limit=2', 'limit=0', 'limit=51', 'page=0', 'page=10001', 'q=a', 'extra=1']) assert.equal((await f.get(1, base + '/events?' + query)).statusCode, 400);
  for (const id of ['0', '4294967296', 'bad', '1.5']) for (const suffix of ['', '/events']) assert.equal((await f.get(1, '/api/crm/conversations/' + id + '/contact' + suffix)).statusCode, 400);
  assert.equal(f.calls.length, 0);
});
test('version and history quotas refuse changes while still allowing an authorized noop', async t => {
  const f = fixture(t); await f.patch({ version: 0, contactId: 200 });
  f.state.version = 100;
  assert.equal((await f.patch({ version: 100, contactId: 201 })).statusCode, 429);
  assert.equal((await f.patch({ version: 100, contactId: 200 })).statusCode, 200);
  f.state.version = 1; f.state.globalEvents = 50000;
  assert.equal((await f.patch({ version: 1, contactId: null })).statusCode, 429);
  assert.equal((await f.patch({ version: 1, contactId: 200 })).statusCode, 200);
  assert.equal(f.state.events.length, 1);
});
