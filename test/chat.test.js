'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { digest, secret } = require('../src/security');

const origin = 'https://chat.example.test';
const visitorBase = '/api/chat/visitor';
const teamBase = '/api/chat/team';
const clientKey = () => secret().slice(0, 32);

// Isolated persistence model: team and visitor tokens are independent, permissions
// are checked at each operation, and writes serialize without a real database.
function fixture(t, options = {}) {
  const schemaVersion = options.schemaVersion ?? 3;
  const appOrigin = options.origin || origin;
  const users = [
    { id: 1, name: 'Admin', email: 'admin@example.test', role: 'admin', active: true },
    { id: 2, name: 'Vendas A', email: 'sales-a@example.test', role: 'operator', active: true },
    { id: 3, name: 'Suporte', email: 'support@example.test', role: 'operator', active: true },
    { id: 4, name: 'Vendas B', email: 'sales-b@example.test', role: 'operator', active: true }
  ];
  const departments = [
    { id: 10, name: 'Vendas', active: true, enabled: true },
    { id: 20, name: 'Suporte', active: true, enabled: true },
    { id: 30, name: 'Privado', active: true, enabled: false },
    { id: 40, name: 'Inativo', active: false, enabled: true }
  ];
  const memberships = new Set(['10:2', '20:3', '10:4']);
  const teamTokens = users.map(() => secret());
  const teamSessions = new Map(teamTokens.map((token, index) => [digest(token), users[index].id]));
  const visitorTokens = [secret(), secret()];
  const visitors = new Map(visitorTokens.map((token, index) => [digest(token), { id: index + 1, name: 'Visitante ' + (index + 1) }]));
  const conversations = [
    { id: 101, departmentId: 10, visitorId: 1, status: 'waiting', assignedTo: null },
    { id: 102, departmentId: 20, visitorId: 2, status: 'waiting', assignedTo: null },
    { id: 103, departmentId: 40, visitorId: 1, status: 'closed', assignedTo: null },
    { id: 104, departmentId: 30, visitorId: 2, status: 'closed', assignedTo: null },
    { id: 105, departmentId: 10, visitorId: 1, status: 'closed', assignedTo: 2 }
  ];
  const timestamp = '2026-10-02T00:00:00.000Z';
  const messages = new Map(conversations.map(conversation => [conversation.id, []]));
  for (let sequence = 1; sequence <= 5; sequence++) messages.get(105).push({ sequence, text: 'Texto ' + sequence, sender: sequence % 2 ? 'visitor' : 'team', createdAt: timestamp, authorId: sequence % 2 ? 1 : 2, clientKey: sequence.toString(16).padStart(32, '0') });
  const creationCounts = new Map();
  const sendingCounts = new Map();
  const calls = [];
  let nextVisitorId = 3;
  let lock = Promise.resolve();
  const serial = work => {
    const result = lock.then(work);
    lock = result.catch(() => {});
    return result;
  };
  const fail = statusCode => { const error = new Error('Persistence refused the operation.'); error.statusCode = statusCode; throw error; };
  const visitor = token => { const value = visitors.get(digest(token)); if (!value) fail(401); return value; };
  const team = (actorId, token, admin = false) => {
    const user = users.find(item => item.id === actorId && item.active && teamSessions.get(digest(token)) === actorId);
    if (!user) fail(401);
    if (admin && user.role !== 'admin') fail(403);
    return user;
  };
  const safeMessage = ({ sequence, text, sender, createdAt }) => ({ sequence, text, sender, createdAt });
  const safeConversation = conversation => ({ id: conversation.id, departmentId: conversation.departmentId,
    departmentName: departments.find(item => item.id === conversation.departmentId).name,
    visitorName: [...visitors.values()].find(item => item.id === conversation.visitorId)?.name || 'Visitante',
    status: conversation.status, assignedTo: conversation.assignedTo, updatedAt: timestamp });
  const ownConversation = (token, id) => {
    const identity = visitor(token);
    return conversations.find(item => item.id === id && item.visitorId === identity.id) || null;
  };
  const teamConversation = (actorId, token, id) => {
    const user = team(actorId, token);
    const conversation = conversations.find(item => item.id === id);
    const department = conversation && departments.find(item => item.id === conversation.departmentId && item.active);
    return department && (user.role === 'admin' || memberships.has(department.id + ':' + user.id)) ? conversation : null;
  };
  const history = (conversation, after, limit) => {
    if (!conversation) return null;
    const all = messages.get(conversation.id).filter(message => message.sequence > after);
    const selected = all.slice(0, limit).map(safeMessage);
    return { messages: selected, cursor: selected.at(-1)?.sequence ?? after, hasMore: all.length > selected.length };
  };
  const send = (conversation, sender, authorId, data) => {
    if (!conversation) return null;
    if (!departments.find(item => item.id === conversation.departmentId).active) return null;
    const rows = messages.get(conversation.id);
    const previous = rows.find(row => row.sender === sender && row.authorId === authorId && row.clientKey === data.clientKey);
    if (previous) {
      if (previous.text !== data.text) fail(409);
      return { message: safeMessage(previous), created: false };
    }
    if (conversation.status === 'closed') fail(409);
    if (sender === 'team' && conversation.assignedTo !== authorId) fail(409);
    const countKey = sender + ':' + authorId;
    const count = sendingCounts.get(countKey) || 0;
    if (count >= (sender === 'visitor' ? 10 : 30) || rows.length >= 500) fail(429);
    sendingCounts.set(countKey, count + 1);
    const message = { sequence: (rows.at(-1)?.sequence || 0) + 1, text: data.text, sender, createdAt: timestamp, authorId, clientKey: data.clientKey };
    rows.push(message);
    return { message: safeMessage(message), created: true };
  };
  const repository = {
    status: async () => 'installed', company: async () => 'Chat isolado', close: async () => {},
    capabilities: async () => ({ schemaVersion, departments: schemaVersion >= 2, chat: schemaVersion >= 3, ...(schemaVersion >= 4 ? { contacts: true } : {}) }),
    session: async token => {
      const user = users.find(item => item.id === teamSessions.get(digest(token)) && item.active);
      return user ? { ...user } : null;
    },
    revoke: async token => teamSessions.delete(digest(token)),
    listOperators: async (page, limit) => ({ users: users.filter(item => item.role === 'operator').slice((page - 1) * limit, page * limit), total: 3, page, limit }),
    listDepartments: async (id, page, limit) => ({ departments: departments.filter(item => users.find(user => user.id === id).role === 'admin' || (item.active && memberships.has(item.id + ':' + id))).map(({ enabled, ...item }) => item).slice((page - 1) * limit, page * limit), total: 4, page, limit }),
    listPublicChatDepartments: async () => ({ departments: departments.filter(item => item.active && item.enabled).map(({ id, name }) => ({ id, name })) }),
    chatChannel: async (actorId, token, id) => {
      calls.push(['chatChannel', actorId, token]); team(actorId, token, true);
      const department = departments.find(item => item.id === id);
      return department ? { enabled: department.enabled } : null;
    },
    setChatChannel: async (actorId, token, id, enabled) => serial(() => {
      calls.push(['setChatChannel', actorId, token]); team(actorId, token, true);
      const department = departments.find(item => item.id === id);
      if (!department) return null;
      department.enabled = enabled; return { enabled };
    }),
    createVisitor: async (token, name, ipDigest) => serial(() => {
      calls.push(['createVisitor', token, name, ipDigest]);
      const count = creationCounts.get(ipDigest) || 0;
      if (count >= 5) fail(429);
      creationCounts.set(ipDigest, count + 1);
      const identity = { id: nextVisitorId++, name };
      visitors.set(digest(token), identity); return { ...identity };
    }),
    visitorSession: async token => { const identity = visitors.get(digest(token)); return identity ? { ...identity } : null; },
    revokeVisitor: async token => visitors.delete(digest(token)),
    listVisitorConversations: async token => ({ conversations: conversations.filter(item => item.visitorId === visitor(token).id).sort((a, b) => b.id - a.id).slice(0, 20).map(safeConversation) }),
    createVisitorConversation: async (token, id) => serial(() => {
      const identity = visitor(token);
      const open = conversations.find(item => item.visitorId === identity.id && item.status !== 'closed');
      if (open) { if (open.departmentId !== id) fail(409); return { conversation: safeConversation(open), created: false }; }
      if (!departments.some(item => item.id === id && item.active && item.enabled)) fail(404);
      if (conversations.filter(item => item.visitorId === identity.id).length >= 20) fail(429);
      const conversation = { id: Math.max(...conversations.map(item => item.id)) + 1, departmentId: id, visitorId: identity.id, status: 'waiting', assignedTo: null };
      conversations.push(conversation); messages.set(conversation.id, []);
      return { conversation: safeConversation(conversation), created: true };
    }),
    visitorMessages: async (token, id, after, limit) => history(ownConversation(token, id), after, limit),
    sendVisitorMessage: async (token, id, data) => serial(() => {
      const identity = visitor(token); return send(ownConversation(token, id), 'visitor', identity.id, data);
    }),
    listChatConversations: async (actorId, token, page, limit, filters = {}) => {
      const { status = 'all', assignment = 'any', q = '' } = filters;
      calls.push(['listChatConversations', actorId, token, page, limit, { status, assignment, q }]); team(actorId, token);
      const all = conversations.filter(item => teamConversation(actorId, token, item.id)).sort((a, b) => b.id - a.id).map(safeConversation)
        .filter(item => status === 'all' || (status === 'active' ? item.status !== 'closed' : item.status === status))
        .filter(item => assignment === 'any' || (assignment === 'me' ? item.assignedTo === actorId : item.assignedTo === null))
        .filter(item => [item.visitorName, item.departmentName].some(name => name.normalize('NFC').toLowerCase().includes(q.toLowerCase())));
      return { conversations: all.slice((page - 1) * limit, page * limit), total: all.length, page, limit };
    },
    teamConversation: async (actorId, token, id) => {
      calls.push(['teamConversation', actorId, token, id]);
      const conversation = teamConversation(actorId, token, id);
      return conversation ? { conversation: safeConversation(conversation) } : null;
    },
    teamMessages: async (actorId, token, id, after, limit) => {
      calls.push(['teamMessages', actorId, token]); return history(teamConversation(actorId, token, id), after, limit);
    },
    sendTeamMessage: async (actorId, token, id, data) => serial(() => {
      calls.push(['sendTeamMessage', actorId, token]); return send(teamConversation(actorId, token, id), 'team', actorId, data);
    }),
    changeChatConversation: async (actorId, token, id, action) => serial(() => {
      calls.push(['changeChatConversation', actorId, token]);
      const conversation = teamConversation(actorId, token, id);
      if (!conversation) return null;
      const user = team(actorId, token);
      if (conversation.status === 'closed') fail(409);
      if (action === 'claim') {
        if (conversation.assignedTo !== null && conversation.assignedTo !== actorId) fail(409);
        conversation.assignedTo = actorId; conversation.status = 'open';
      } else {
        if (user.role !== 'admin' && conversation.assignedTo !== actorId) fail(409);
        if (action === 'release') { conversation.status = 'waiting'; conversation.assignedTo = null; }
        else if (action === 'close') conversation.status = 'closed';
        else fail(400);
      }
      return { conversation: safeConversation(conversation) };
    })
  };
  const app = buildServer({ repository, env: { NODE_ENV: options.development ? 'development' : 'production', APP_URL: appOrigin } });
  t.after(() => app.close());
  const secure = appOrigin.startsWith('https:');
  const visitorHeaders = (index = 0) => ({ origin: appOrigin, cookie: (secure ? '__Host-cl_visitor=' : 'cl_visitor=') + visitorTokens[index], 'x-csrf-token': digest('visitor-csrf:' + visitorTokens[index]) });
  const teamHeaders = (index = 0) => ({ origin: appOrigin, cookie: (secure ? '__Host-cl_session=' : 'cl_session=') + teamTokens[index], 'x-csrf-token': digest('csrf:' + teamTokens[index]) });
  const request = (method, url, payload, headers = {}) => app.inject({ method, url, payload, headers });
  const v = (method, url, payload, index = 0, overrides = {}) => request(method, visitorBase + url, payload, { ...visitorHeaders(index), ...overrides });
  const u = (method, url, payload, index = 0, overrides = {}) => request(method, teamBase + url, payload, { ...teamHeaders(index), ...overrides });
  return { app, repository, users, departments, memberships, visitors, visitorTokens, teamTokens, teamSessions, conversations, messages, sendingCounts, calls, visitorHeaders, teamHeaders, request, v, u };
}

test('entrada publica mostra somente areas ativas habilitadas e canal exige administrador', async t => {
  const { app, u, departments } = fixture(t);
  const response = await app.inject('/api/chat/public/departments');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { departments: [{ id: 10, name: 'Vendas' }, { id: 20, name: 'Suporte' }] });
  assert.deepEqual((await u('GET', '/channels/30')).json(), { enabled: false });
  assert.equal((await u('PUT', '/channels/30', { enabled: true }, 1)).statusCode, 403);
  assert.equal((await u('PUT', '/channels/30', { enabled: true })).statusCode, 200);
  assert.equal(departments[2].enabled, true);
  assert.equal((await u('GET', '/channels/999')).statusCode, 404);
});

test('sessao de visitante normaliza nome e usa cookie independente HTTPS com CSRF', async t => {
  const { request, repository, calls } = fixture(t);
  const created = await request('POST', visitorBase + '/session', { name: '  Jose\u0301  ' }, { origin });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().visitor, { id: 3, name: 'José' });
  const cookie = created.headers['set-cookie'];
  assert.match(cookie, /^__Host-cl_visitor=[a-f0-9]{64};/);
  for (const part of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=28800', 'Secure']) assert.equal(cookie.includes(part), true);
  const token = cookie.split(';')[0].split('=')[1];
  assert.equal(created.json().csrfToken, digest('visitor-csrf:' + token));
  assert.deepEqual(await repository.visitorSession(token), { id: 3, name: 'José' });
  assert.equal(calls[0][0], 'createVisitor');
  assert.match(calls[0][3], /^[a-f0-9]{64}$/);
  assert.equal(calls[0][3].includes('127.0.0.1'), false);
  const me = await request('GET', visitorBase + '/me', undefined, { cookie: cookie.split(';')[0] });
  assert.deepEqual(me.json(), created.json());
  assert.equal((await request('GET', '/api/auth/me', undefined, { cookie: cookie.split(';')[0] })).statusCode, 401);
});

test('instalacao nova com schema de chat nao cria visitante antes do primeiro administrador', async t => {
  const { request, repository, visitors, calls } = fixture(t);
  repository.status = async () => 'setup';
  const response = await request('POST', visitorBase + '/session', { name: 'Visitante prematuro' }, { origin });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(visitors.size, 2);
  assert.equal(calls.some(call => call[0] === 'createVisitor'), false);
});

test('visitante anonimo e cookie malformado nao acessam conversas ou mensagens', async t => {
  const { request } = fixture(t);
  for (const [method, url, payload] of [
    ['GET', '/me'], ['GET', '/conversations'], ['POST', '/conversations', { departmentId: 10 }],
    ['GET', '/conversations/101/messages'], ['POST', '/conversations/101/messages', { text: 'Oi', clientKey: clientKey() }]
  ]) {
    for (const cookie of ['', '__Host-cl_visitor=broken']) {
      assert.equal((await request(method, visitorBase + url, payload, { origin, cookie })).statusCode, 401);
    }
  }
});

test('equipe anonima e sessao publica nao acessam rotas privadas do chat', async t => {
  const { request, visitorHeaders } = fixture(t);
  for (const [method, url, payload] of [
    ['GET', '/channels/10'], ['PUT', '/channels/10', { enabled: false }], ['GET', '/conversations'], ['GET', '/conversations/101'],
    ['GET', '/conversations/101/messages'], ['POST', '/conversations/101/messages', { text: 'Forjado', clientKey: clientKey() }],
    ['POST', '/conversations/101/claim', {}], ['POST', '/conversations/101/release', {}], ['POST', '/conversations/101/close', {}]
  ]) {
    assert.equal((await request(method, teamBase + url, payload, { origin })).statusCode, 401);
    assert.equal((await request(method, teamBase + url, payload, visitorHeaders())).statusCode, 401);
  }
});

test('todas as escritas do chat exigem origem e o CSRF da identidade correta', async t => {
  const { v, u, request, teamHeaders, visitorHeaders, conversations, departments, messages } = fixture(t);
  for (const overrides of [{ origin: 'https://foreign.example.test' }, { origin: '' }, { 'x-csrf-token': '' }, { 'x-csrf-token': 'forged' }]) {
    for (const [url, payload] of [['/conversations', { departmentId: 10 }], ['/conversations/101/messages', { text: 'Oi', clientKey: clientKey() }], ['/logout', {}]]) {
      assert.equal((await v('POST', url, payload, 0, overrides)).statusCode, 403);
    }
    for (const [method, url, payload] of [
      ['PUT', '/channels/10', { enabled: false }], ['POST', '/conversations/101/claim', {}],
      ['POST', '/conversations/101/release', {}], ['POST', '/conversations/101/close', {}],
      ['POST', '/conversations/101/messages', { text: 'Oi', clientKey: clientKey() }]
    ]) assert.equal((await u(method, url, payload, 0, overrides)).statusCode, 403);
  }
  assert.equal((await request('POST', visitorBase + '/session', { name: 'Teste' }, { origin: 'https://foreign.example.test' })).statusCode, 403);
  assert.equal((await v('POST', '/logout', {}, 0, { 'x-csrf-token': teamHeaders()['x-csrf-token'] })).statusCode, 403);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 0, { 'x-csrf-token': visitorHeaders()['x-csrf-token'] })).statusCode, 403);
  assert.equal(conversations[0].status, 'waiting'); assert.equal(departments[0].enabled, true); assert.equal(messages.get(101).length, 0);
});

test('duas identidades visitantes nao leem nem escrevem no historico alheio', async t => {
  const { v, messages } = fixture(t);
  const own = await v('GET', '/conversations');
  assert.equal(own.statusCode, 200);
  assert.equal(own.json().conversations.every(conversation => conversation.visitorName === 'Visitante 1'), true);
  const foreign = await v('GET', '/conversations/102/messages');
  const absent = await v('GET', '/conversations/999/messages');
  assert.equal(foreign.statusCode, 404); assert.deepEqual(foreign.json(), absent.json());
  assert.equal((await v('POST', '/conversations/102/messages', { text: 'Forjado', clientKey: clientKey() })).statusCode, 404);
  assert.equal(messages.get(102).length, 0);
  const inactiveHistory = await v('GET', '/conversations/103/messages');
  assert.equal(inactiveHistory.statusCode, 200);
});

test('conversa aberta e reutilizada na mesma area e nova conversa respeita canal publico', async t => {
  const { v, conversations } = fixture(t);
  const reused = await v('POST', '/conversations', { departmentId: 10 });
  assert.equal(reused.statusCode, 200); assert.equal(reused.json().conversation.id, 101);
  assert.equal((await v('POST', '/conversations', { departmentId: 20 })).statusCode, 409);
  conversations[0].status = 'closed';
  for (const id of [30, 40, 999]) assert.equal((await v('POST', '/conversations', { departmentId: id })).statusCode, 404);
  const created = await v('POST', '/conversations', { departmentId: 20 });
  assert.equal(created.statusCode, 201); assert.equal(created.json().conversation.status, 'waiting');
  assert.equal(created.json().conversation.assignedTo, null);
  assert.equal((await v('POST', '/conversations', { departmentId: 20 })).json().conversation.id, created.json().conversation.id);
});

test('sessao publica existente nao e substituida e historico de vinte conversas limita criacao', async t => {
  const { v, conversations, visitors } = fixture(t);
  const existing = await v('POST', '/session', { name: 'Outro nome' });
  assert.equal(existing.statusCode, 409); assert.equal(existing.headers['set-cookie'], undefined);
  assert.equal(visitors.size, 2);
  conversations[0].status = 'closed';
  for (let id = 200; conversations.filter(item => item.visitorId === 1).length < 20; id++) {
    conversations.push({ id, visitorId: 1, departmentId: 10, status: 'closed', assignedTo: null });
  }
  assert.equal((await v('GET', '/conversations')).json().conversations.length, 20);
  assert.equal((await v('POST', '/conversations', { departmentId: 10 })).statusCode, 429);
  assert.equal(conversations.filter(item => item.visitorId === 1).length, 20);
});

test('fila de equipe e historico respeitam vinculo atual e recebem token da sessao', async t => {
  const { u, calls, teamTokens, memberships } = fixture(t);
  const sales = await u('GET', '/conversations', undefined, 1);
  assert.equal(sales.statusCode, 200);
  assert.equal(sales.json().conversations.every(conversation => conversation.departmentId === 10), true);
  const support = await u('GET', '/conversations', undefined, 2);
  assert.equal(support.json().conversations.every(conversation => conversation.departmentId === 20), true);
  assert.equal((await u('GET', '/conversations/102/messages', undefined, 1)).statusCode, 404);
  assert.equal((await u('POST', '/conversations/102/claim', {}, 1)).statusCode, 404);
  assert.equal((await u('GET', '/conversations/103/messages')).statusCode, 404);
  assert.equal((await u('GET', '/conversations/101/messages', undefined, 1)).statusCode, 200);
  assert.equal(calls.filter(call => ['listChatConversations', 'teamMessages', 'changeChatConversation'].includes(call[0])).every(call => call[2] === teamTokens[call[1] - 1]), true);
  memberships.delete('10:2');
  assert.equal((await u('GET', '/conversations/101/messages', undefined, 1)).statusCode, 404);
  assert.deepEqual((await u('GET', '/conversations', undefined, 1)).json().conversations, []);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, 404);
});

test('fila sem filtros preserva contrato anterior e repassa valores normalizados com token', async t => {
  const { u, calls, teamTokens } = fixture(t);
  const response = await u('GET', '/conversations', undefined, 1);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().conversations.map(row => row.id), [105, 101]);
  assert.deepEqual({ ...response.json(), conversations: [] }, { conversations: [], total: 2, page: 1, limit: 20 });
  assert.deepEqual(calls.at(-1), ['listChatConversations', 2, teamTokens[1], 1, 20, { status: 'all', assignment: 'any', q: '' }]);
  const emptySearch = await u('GET', '/conversations?status=all&assignment=any&q=', undefined, 1);
  assert.deepEqual(emptySearch.json(), response.json());
});

test('status e responsavel combinam filtros dentro da area autorizada antes de paginar', async t => {
  const { u } = fixture(t);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, 200);
  const cases = [
    ['', 0, [105, 104, 102, 101]], ['status=active', 0, [102, 101]],
    ['status=waiting', 0, [102]], ['status=open', 0, [101]], ['status=closed', 0, [105, 104]],
    ['assignment=me', 1, [105, 101]], ['status=closed&assignment=me', 1, [105]],
    ['status=active&assignment=me', 1, [101]], ['assignment=unassigned', 0, [104, 102]],
    ['status=active&assignment=unassigned', 0, [102]], ['status=waiting&assignment=me', 1, []],
    ['status=active&assignment=unassigned', 1, []], ['assignment=me', 2, []]
  ];
  for (const [query, actor, expected] of cases) {
    const response = await u('GET', '/conversations?' + query, undefined, actor);
    assert.equal(response.statusCode, 200, query);
    assert.deepEqual(response.json().conversations.map(row => row.id), expected, query);
    assert.equal(response.json().total, expected.length, query);
  }
  const first = await u('GET', '/conversations?assignment=me&page=1&limit=1', undefined, 1);
  const second = await u('GET', '/conversations?assignment=me&page=2&limit=1', undefined, 1);
  const beyond = await u('GET', '/conversations?assignment=me&page=3&limit=1', undefined, 1);
  assert.deepEqual(first.json().conversations.map(row => row.id), [105]);
  assert.deepEqual(second.json().conversations.map(row => row.id), [101]);
  assert.deepEqual(beyond.json(), { conversations: [], total: 2, page: 3, limit: 1 });
});

test('busca normaliza NFC e trata porcento underline exclamacao e barra como texto literal', async t => {
  const { u, visitors, departments, calls } = fixture(t);
  [...visitors.values()][0].name = 'José 100%_!\\ literal';
  departments[1].name = 'Suporte especial %_!\\';
  const search = (q, actor = 1) => u('GET', '/conversations?q=' + encodeURIComponent(q), undefined, actor);
  for (const q of ['%', '_', '!', '\\', '%_!\\']) {
    const response = await search(q);
    assert.equal(response.statusCode, 200, q);
    assert.deepEqual(response.json().conversations.map(row => row.id), [105, 101], q);
    assert.equal(response.json().total, 2);
  }
  const unicode = await search('  Jose\u0301  ');
  assert.deepEqual(unicode.json().conversations.map(row => row.id), [105, 101]);
  assert.equal(calls.at(-1)[5].q, 'José');
  const area = await search('Suporte especial %_!\\', 0);
  assert.deepEqual(area.json().conversations.map(row => row.id), [102]);
  assert.equal((await search('Suporte', 1)).json().total, 0);
  for (const q of ["' OR 1=1 --", '100%_!\\ desconhecido', '<script>alert(1)</script>', '123', 'x'.repeat(100)]) {
    const response = await search(q, 0);
    assert.equal(response.statusCode, 200, q);
    assert.deepEqual(response.json().conversations, []);
    assert.equal(response.json().total, 0);
  }
  const combined = await u('GET', '/conversations?status=closed&assignment=me&q=' + encodeURIComponent('%_!\\'), undefined, 1);
  assert.deepEqual(combined.json().conversations.map(row => row.id), [105]);
  assert.equal(combined.json().total, 1);
});

test('filtros invalidos extras duplicados e controles sao recusados antes de consultar fila', async t => {
  const { u, calls } = fixture(t);
  const queries = [
    'status=unknown', 'status=ACTIVE', 'status=', 'assignment=other', 'assignment=ME', 'assignment=',
    'q=' + encodeURIComponent('x'.repeat(101)), 'q=' + encodeURIComponent(' ' + 'x'.repeat(100)),
    ...['\u0000', '\u0001', '\n', '\r', '\t', '\u007f'].map(char => 'q=' + encodeURIComponent('nome' + char)),
    'status=all&status=closed', 'assignment=any&assignment=me', 'q=um&q=dois',
    'page=1&page=2', 'limit=1&limit=2', 'q[]=um', 'status[]=all', 'assignment[]=me',
    'q=Vendas&departmentId=20', 'status=all&userId=1', 'assignment=me&token=forged'
  ];
  for (const query of queries) assert.equal((await u('GET', '/conversations?' + query, undefined, 1)).statusCode, 400, query);
  assert.equal(calls.some(call => call[0] === 'listChatConversations'), false);
});

test('detalhe seguro permanece autorizado quando assumir retira conversa da fila sem responsavel', async t => {
  const { u, calls, teamTokens, departments } = fixture(t);
  const before = await u('GET', '/conversations?status=active&assignment=unassigned', undefined, 1);
  assert.deepEqual(before.json().conversations.map(row => row.id), [101]);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, 200);
  const after = await u('GET', '/conversations?status=active&assignment=unassigned', undefined, 1);
  assert.deepEqual(after.json(), { conversations: [], total: 0, page: 1, limit: 20 });
  departments[0].enabled = false;
  const detail = await u('GET', '/conversations/101', undefined, 1);
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json(), { conversation: {
    id: 101, departmentId: 10, departmentName: 'Vendas', visitorName: 'Visitante 1',
    status: 'open', assignedTo: 2, updatedAt: '2026-10-02T00:00:00.000Z'
  } });
  assert.deepEqual(calls.at(-1), ['teamConversation', 2, teamTokens[1], 101]);
  for (const privateField of ['visitorId', 'email', 'password', 'token', 'clientKey', 'last_sequence']) assert.equal(detail.body.includes(privateField), false);
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Ainda posso responder', clientKey: clientKey() }, 1)).statusCode, 201);
  assert.equal((await u('GET', '/conversations/104')).statusCode, 200);
  for (const id of [102, 103, 104, 999]) assert.equal((await u('GET', '/conversations/' + id, undefined, 1)).statusCode, 404);
});

test('detalhe e contagem filtrada perdem acesso com vinculo removido e area desativada na mesma sessao', async t => {
  const { u, memberships, departments } = fixture(t);
  assert.equal((await u('GET', '/conversations/105', undefined, 1)).statusCode, 200);
  memberships.delete('10:2');
  assert.equal((await u('GET', '/conversations/105', undefined, 1)).statusCode, 404);
  assert.deepEqual((await u('GET', '/conversations?status=closed&assignment=me&q=Visitante', undefined, 1)).json(), { conversations: [], total: 0, page: 1, limit: 20 });
  memberships.add('10:2');
  assert.equal((await u('GET', '/conversations/105', undefined, 1)).statusCode, 200);
  departments[0].active = false;
  assert.equal((await u('GET', '/conversations/105', undefined, 1)).statusCode, 404);
  assert.equal((await u('GET', '/conversations/105')).statusCode, 404);
  assert.equal((await u('GET', '/conversations?assignment=me', undefined, 1)).json().total, 0);
  departments[0].active = true;
  assert.equal((await u('GET', '/conversations/105', undefined, 1)).statusCode, 200);
});

test('leituras de detalhe e fila revalidam sessao ator vinculo e area depois da autenticacao', async t => {
  for (const revoke of ['session', 'inactive', 'membership', 'department']) {
    for (const route of ['/conversations/101', '/conversations?status=active&assignment=unassigned&q=Visitante']) {
      const { u, repository, teamTokens, teamSessions, users, memberships, departments } = fixture(t);
      const original = repository.session;
      repository.session = async token => {
        const identity = await original(token);
        if (revoke === 'session') teamSessions.delete(digest(teamTokens[1]));
        else if (revoke === 'inactive') users[1].active = false;
        else if (revoke === 'membership') memberships.delete('10:2');
        else departments[0].active = false;
        return identity;
      };
      const response = await u('GET', route, undefined, 1);
      assert.equal(response.statusCode, ['session', 'inactive'].includes(revoke) ? 401 : (route.includes('/101') ? 404 : 200), revoke + route);
      if (response.statusCode === 200) assert.deepEqual(response.json(), { conversations: [], total: 0, page: 1, limit: 20 });
    }
  }
});

test('duas assuncoes tem um vencedor e somente responsavel responde', async t => {
  const { u, conversations } = fixture(t);
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Sem assumir', clientKey: clientKey() }, 1)).statusCode, 409);
  const candidates = [1, 3];
  const responses = await Promise.all(candidates.map(index => u('POST', '/conversations/101/claim', {}, index)));
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
  const winner = candidates[responses.findIndex(response => response.statusCode === 200)];
  const loser = candidates.find(index => index !== winner);
  assert.equal(conversations[0].assignedTo, winner + 1);
  assert.equal((await u('POST', '/conversations/101/claim', {}, winner)).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Minha resposta', clientKey: clientKey() }, winner)).statusCode, 201);
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Outra resposta', clientKey: clientKey() }, loser)).statusCode, 409);
  assert.equal((await u('POST', '/conversations/101/release', {}, loser)).statusCode, 409);
  assert.equal((await u('POST', '/conversations/101/close', {}, loser)).statusCode, 409);
  const released = await u('POST', '/conversations/101/release', {}, winner);
  assert.equal(released.statusCode, 200); assert.equal(released.json().conversation.status, 'waiting');
  assert.equal(released.json().conversation.assignedTo, null);
});

test('administrador recupera atendimento de operador inativo e fechamento impede envios', async t => {
  const { u, v, users } = fixture(t);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, 200);
  users[1].active = false;
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Inativo', clientKey: clientKey() }, 1)).statusCode, 401);
  assert.equal((await u('POST', '/conversations/101/release', {})).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/claim', {})).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/close', {})).statusCode, 200);
  assert.equal((await v('POST', '/conversations/101/messages', { text: 'Apos fechar', clientKey: clientKey() })).statusCode, 409);
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Apos fechar', clientKey: clientKey() })).statusCode, 409);
  assert.equal((await u('POST', '/conversations/101/claim', {})).statusCode, 409);
  assert.equal((await v('GET', '/conversations/101/messages')).statusCode, 200);
});

test('desabilitar entrada preserva atendimento e desativar area bloqueia novos envios', async t => {
  const { u, v, departments } = fixture(t);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, 200);
  assert.equal((await u('PUT', '/channels/10', { enabled: false })).statusCode, 200);
  assert.equal((await v('POST', '/conversations/101/messages', { text: 'Ja aberto', clientKey: clientKey() })).statusCode, 201);
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Resposta', clientKey: clientKey() }, 1)).statusCode, 201);
  departments[0].active = false;
  assert.equal((await v('POST', '/conversations/101/messages', { text: 'Area inativa', clientKey: clientKey() })).statusCode, 404);
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Area inativa', clientKey: clientKey() }, 1)).statusCode, 404);
  assert.equal((await v('GET', '/conversations/101/messages')).json().messages.length, 2);
  assert.equal((await u('GET', '/conversations/101/messages', undefined, 1)).statusCode, 404);
});

test('reenvio e idempotente por conversa e autor sem duplicar ou aceitar conteudo divergente', async t => {
  const { v, u, messages } = fixture(t);
  const key = clientKey();
  const payload = { text: '  Ola <b>mundo</b>  ', clientKey: key };
  const first = await v('POST', '/conversations/101/messages', payload);
  assert.equal(first.statusCode, 201);
  assert.deepEqual(first.json().message, { sequence: 1, text: 'Ola <b>mundo</b>', sender: 'visitor', createdAt: '2026-10-02T00:00:00.000Z' });
  const retry = await v('POST', '/conversations/101/messages', payload);
  assert.equal(retry.statusCode, 200); assert.deepEqual(retry.json(), first.json());
  assert.equal((await v('POST', '/conversations/101/messages', { text: 'Diferente', clientKey: key })).statusCode, 409);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Equipe com chave igual', clientKey: key }, 1)).statusCode, 201);
  assert.equal(messages.get(101).length, 2);
  assert.equal(first.body.includes('authorId'), false); assert.equal(first.body.includes('clientKey'), false);
});

test('reenvio ja persistido confirma apos fechamento mas acesso revogado ainda e negado', async t => {
  const { v, u, memberships, departments, messages } = fixture(t);
  const visitorPayload = { text: 'Mensagem persistida', clientKey: clientKey() };
  const teamPayload = { text: 'Resposta persistida', clientKey: clientKey() };
  assert.equal((await v('POST', '/conversations/101/messages', visitorPayload)).statusCode, 201);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/messages', teamPayload, 1)).statusCode, 201);
  assert.equal((await u('POST', '/conversations/101/release', {}, 1)).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 3)).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/messages', teamPayload, 1)).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/close', {}, 3)).statusCode, 200);
  assert.equal((await v('POST', '/conversations/101/messages', visitorPayload)).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/messages', teamPayload, 1)).statusCode, 200);
  memberships.delete('10:2');
  assert.equal((await u('POST', '/conversations/101/messages', teamPayload, 1)).statusCode, 404);
  departments[0].active = false;
  assert.equal((await v('POST', '/conversations/101/messages', visitorPayload)).statusCode, 404);
  assert.equal(messages.get(101).length, 2);
});

test('cursor avanca apenas pelo lote retornado e historico nao perde mensagens', async t => {
  const { v, u } = fixture(t);
  const first = await v('GET', '/conversations/105/messages?after=0&limit=2');
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().messages.map(message => message.sequence), [1, 2]);
  assert.equal(first.json().cursor, 2); assert.equal(first.json().hasMore, true);
  const second = await v('GET', '/conversations/105/messages?after=2&limit=2');
  assert.deepEqual(second.json().messages.map(message => message.sequence), [3, 4]);
  assert.equal(second.json().cursor, 4); assert.equal(second.json().hasMore, true);
  const last = await u('GET', '/conversations/105/messages?after=4&limit=2', undefined, 1);
  assert.deepEqual(last.json().messages.map(message => message.sequence), [5]);
  assert.equal(last.json().cursor, 5); assert.equal(last.json().hasMore, false);
  const empty = await v('GET', '/conversations/105/messages?after=99&limit=2');
  assert.deepEqual(empty.json(), { messages: [], cursor: 99, hasMore: false });
});

test('tipos extras e autoria forjada sao recusados antes da persistencia', async t => {
  const { request, v, u, messages, visitors } = fixture(t);
  for (const payload of [{ name: 123 }, { name: 'Teste', id: 9 }, { name: 'Teste', email: 'other@example.test' }, { name: ' x ' }, { name: 'Dois\nnomes' }]) {
    assert.equal((await request('POST', visitorBase + '/session', payload, { origin })).statusCode, 400);
  }
  for (const payload of [{ departmentId: '10' }, { departmentId: 10, visitorId: 2 }, { departmentId: 10, assignedTo: 1 }, { departmentId: 0 }]) {
    assert.equal((await v('POST', '/conversations', payload)).statusCode, 400);
  }
  for (const payload of [{ enabled: 'true' }, { enabled: 1 }, { enabled: true, active: true }]) assert.equal((await u('PUT', '/channels/10', payload)).statusCode, 400);
  for (const payload of [
    { text: 123, clientKey: clientKey() }, { text: 'Oi', clientKey: 123 }, { text: 'Oi', clientKey: 'A'.repeat(32) },
    { text: 'Oi', clientKey: clientKey(), sender: 'team' }, { text: 'Oi', clientKey: clientKey(), userId: 1 },
    { text: 'Oi', clientKey: clientKey(), sequence: 100 }, { text: 'Oi', clientKey: clientKey(), visitorId: 2 }
  ]) {
    assert.equal((await v('POST', '/conversations/101/messages', payload)).statusCode, 400);
    assert.equal((await u('POST', '/conversations/101/messages', payload, 1)).statusCode, 400);
  }
  for (const action of ['claim', 'release', 'close']) assert.equal((await u('POST', '/conversations/101/' + action, { assignedTo: 2 }, 1)).statusCode, 400);
  assert.equal((await v('POST', '/logout', { visitorId: 2 })).statusCode, 400);
  assert.equal(visitors.size, 2); assert.equal(messages.get(101).length, 0);
});

test('texto vazio gigante ou com controles e recusado e HTML permanece literal', async t => {
  const { v } = fixture(t);
  for (const text of ['', '   ', 'a'.repeat(2001), 'texto\u0000controle', 'texto\u007fcontrole', 'texto\u001bcontrole', 'texto\u000bcontrole']) {
    assert.equal((await v('POST', '/conversations/101/messages', { text, clientKey: clientKey() })).statusCode, 400);
  }
  const accepted = await v('POST', '/conversations/101/messages', { text: ' <script>alert(1)</script>\nLinha\tfinal\r\n ', clientKey: clientKey() });
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.json().message.text, '<script>alert(1)</script>\nLinha\tfinal');
  const boundary = await v('POST', '/conversations/101/messages', { text: '  ' + 'a'.repeat(2000) + '  ', clientKey: clientKey() });
  assert.equal(boundary.statusCode, 201); assert.equal(boundary.json().message.text.length, 2000);
  assert.equal((await v('POST', '/conversations/101/messages', { text: 'a'.repeat(9000), clientKey: clientKey() })).statusCode, 413);
});

test('IDs cursores e paginacao tem limites e nao aceitam filtros de outra identidade', async t => {
  const { v, u } = fixture(t);
  for (const id of ['0', '-1', '1.5', '4294967296', 'abc', '1%20OR%201=1']) {
    assert.equal((await v('GET', '/conversations/' + id + '/messages')).statusCode, 400);
    assert.equal((await u('POST', '/conversations/' + id + '/claim', {}, 1)).statusCode, 400);
    assert.equal((await u('GET', '/conversations/' + id, undefined, 1)).statusCode, 400);
    assert.equal((await u('GET', '/channels/' + id)).statusCode, 400);
  }
  for (const query of ['after=-1', 'after=1.5', 'after=4294967296', 'limit=0', 'limit=51', 'visitorId=2', 'userId=1', 'after=0%20OR%201=1']) {
    assert.equal((await v('GET', '/conversations/105/messages?' + query)).statusCode, 400);
    assert.equal((await u('GET', '/conversations/105/messages?' + query, undefined, 1)).statusCode, 400);
  }
  for (const query of ['page=0', 'page=10001', 'limit=51', 'departmentId=20', 'assignedTo=1']) assert.equal((await u('GET', '/conversations?' + query, undefined, 1)).statusCode, 400);
  const page = await u('GET', '/conversations?page=2&limit=1', undefined, 1);
  assert.equal(page.statusCode, 200); assert.equal(page.json().page, 2); assert.equal(page.json().limit, 1);
  assert.equal(page.json().conversations.length, 1); assert.equal(page.json().total, 2);
});

test('logout revoga somente visitante e sessao de equipe nao vira identidade publica', async t => {
  const { request, v, visitorHeaders, teamHeaders } = fixture(t);
  const combined = { ...visitorHeaders(), cookie: visitorHeaders().cookie + '; ' + teamHeaders().cookie };
  const logout = await request('POST', visitorBase + '/logout', {}, combined);
  assert.equal(logout.statusCode, 200); assert.deepEqual(logout.json(), { authenticated: false });
  assert.match(logout.headers['set-cookie'], /^__Host-cl_visitor=;/); assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await v('GET', '/me')).statusCode, 401);
  assert.equal((await request('GET', '/api/auth/me', undefined, teamHeaders())).statusCode, 200);
  assert.equal((await request('GET', visitorBase + '/me', undefined, teamHeaders())).statusCode, 401);
  assert.equal((await v('GET', '/me', undefined, 1)).statusCode, 200);
  const inverse = fixture(t);
  const teamLogout = await inverse.request('POST', '/api/auth/logout', {}, { ...inverse.teamHeaders(), cookie: inverse.teamHeaders().cookie + '; ' + inverse.visitorHeaders().cookie });
  assert.equal(teamLogout.statusCode, 200); assert.match(teamLogout.headers['set-cookie'], /^__Host-cl_session=;/);
  assert.equal((await inverse.v('GET', '/me')).statusCode, 200);
  assert.equal((await inverse.request('GET', '/api/auth/me', undefined, inverse.teamHeaders())).statusCode, 401);
});

test('sessao ou vinculo removido entre autorizacao e persistencia bloqueia escrita', async t => {
  for (const revoke of ['session', 'membership']) {
    const { u, repository, teamTokens, teamSessions, memberships, conversations } = fixture(t);
    const original = repository.session;
    repository.session = async token => {
      const identity = await original(token);
      if (revoke === 'session') teamSessions.delete(digest(teamTokens[1])); else memberships.delete('10:2');
      return identity;
    };
    assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, revoke === 'session' ? 401 : 404);
    assert.equal(conversations[0].assignedTo, null);
  }
  const { v, repository, visitors, visitorTokens, messages } = fixture(t);
  const original = repository.visitorSession;
  repository.visitorSession = async token => { const identity = await original(token); visitors.delete(digest(visitorTokens[0])); return identity; };
  assert.equal((await v('POST', '/conversations/101/messages', { text: 'Revogado', clientKey: clientKey() })).statusCode, 401);
  assert.equal(messages.get(101).length, 0);
});

test('limites persistidos recusam novos envios mas preservam reenvio identico', async t => {
  const { v, u, messages } = fixture(t);
  const visitorPayloads = Array.from({ length: 10 }, (_, i) => ({ text: 'Texto ' + i, clientKey: clientKey() }));
  for (const payload of visitorPayloads) assert.equal((await v('POST', '/conversations/101/messages', payload)).statusCode, 201);
  assert.equal((await v('POST', '/conversations/101/messages', { text: 'Excesso', clientKey: clientKey() })).statusCode, 429);
  assert.equal((await v('POST', '/conversations/101/messages', visitorPayloads[0])).statusCode, 200);
  assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, 200);
  const teamPayload = { text: 'Texto equipe', clientKey: clientKey() };
  assert.equal((await u('POST', '/conversations/101/messages', teamPayload, 1)).statusCode, 201);
  for (let i = 1; i < 30; i++) assert.equal((await u('POST', '/conversations/101/messages', { text: 'Texto equipe ' + i, clientKey: clientKey() }, 1)).statusCode, 201);
  assert.equal((await u('POST', '/conversations/101/messages', { text: 'Excesso', clientKey: clientKey() }, 1)).statusCode, 429);
  assert.equal((await u('POST', '/conversations/101/messages', teamPayload, 1)).statusCode, 200);
  assert.equal(messages.get(101).length, 40);
});

test('sessoes novas por endereco nao confiam em cabecalho proxy arbitrario', async t => {
  const { request, calls } = fixture(t);
  for (let i = 0; i < 5; i++) {
    assert.equal((await request('POST', visitorBase + '/session', { name: 'Teste ' + i }, { origin, 'x-forwarded-for': '198.51.100.' + (i + 1) })).statusCode, 201);
  }
  assert.equal((await request('POST', visitorBase + '/session', { name: 'Excesso' }, { origin, 'x-forwarded-for': '203.0.113.1' })).statusCode, 429);
  assert.equal(new Set(calls.filter(call => call[0] === 'createVisitor').map(call => call[3])).size, 1);
});

test('schemas antigos preservam acesso e departamentos enquanto chat retorna503', async t => {
  for (const schemaVersion of [1, 2]) {
    const { request, u, v, repository, teamHeaders } = fixture(t, { schemaVersion });
    for (const method of ['listPublicChatDepartments', 'chatChannel', 'setChatChannel', 'createVisitor', 'visitorSession', 'listVisitorConversations', 'createVisitorConversation', 'visitorMessages', 'sendVisitorMessage', 'listChatConversations', 'teamConversation', 'teamMessages', 'sendTeamMessage', 'changeChatConversation']) {
      repository[method] = () => { throw new Error('Chat persistence called before migration'); };
    }
    assert.equal((await request('GET', '/api/auth/me', undefined, teamHeaders())).statusCode, 200);
    assert.equal((await request('GET', '/api/team/operators', undefined, teamHeaders())).statusCode, 200);
    if (schemaVersion === 2) assert.equal((await request('GET', '/api/team/departments', undefined, teamHeaders())).statusCode, 200);
    assert.equal((await request('GET', '/api/chat/public/departments')).statusCode, 503);
    assert.equal((await request('POST', visitorBase + '/session', { name: 'Teste' }, { origin })).statusCode, 503);
    assert.equal((await v('GET', '/conversations')).statusCode, 503);
    assert.equal((await u('GET', '/conversations')).statusCode, 503);
    assert.equal((await u('GET', '/conversations/101')).statusCode, 503);
    assert.equal((await u('POST', '/conversations/101/claim', {}, 1)).statusCode, 503);
  }
});

test('schema4 preserva canais fila detalhes e atendimento visitante-equipe do chat', async t => {
  const { request, u, v, teamHeaders } = fixture(t, { schemaVersion: 4 });
  const me = await request('GET', '/api/auth/me', undefined, teamHeaders(1));
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json().capabilities, { schemaVersion: 4, departments: true, chat: true, contacts: true });
  assert.equal((await request('GET', '/api/chat/public/departments')).statusCode, 200);
  assert.deepEqual((await u('GET', '/channels/10')).json(), { enabled: true });
  const queue = await u('GET', '/conversations?status=active&assignment=unassigned', undefined, 1);
  assert.equal(queue.statusCode, 200); assert.equal(queue.json().total, 1);
  assert.deepEqual(queue.json().conversations.map(row => row.id), [101]);
  assert.equal((await u('GET', '/conversations/101', undefined, 1)).json().conversation.status, 'waiting');
  const claimed = await u('POST', '/conversations/101/claim', {}, 1);
  assert.equal(claimed.statusCode, 200); assert.equal(claimed.json().conversation.assignedTo, 2);
  assert.equal((await u('PUT', '/channels/10', { enabled: false })).statusCode, 200);
  const visitor = await v('POST', '/conversations/101/messages', { text: 'Visitante com schema4', clientKey: clientKey() });
  const team = await u('POST', '/conversations/101/messages', { text: 'Equipe com schema4', clientKey: clientKey() }, 1);
  assert.equal(visitor.statusCode, 201); assert.equal(team.statusCode, 201);
  const history = await u('GET', '/conversations/101/messages', undefined, 1);
  assert.equal(history.statusCode, 200);
  assert.deepEqual(history.json().messages.map(row => [row.sequence, row.sender, row.text]), [[1, 'visitor', 'Visitante com schema4'], [2, 'team', 'Equipe com schema4']]);
});

test('falha de persistencia e generica e cookie HTTP fica restrito ao desenvolvimento local', async t => {
  const { app, repository } = fixture(t);
  repository.listPublicChatDepartments = async () => { throw new Error('DB_PASSWORD=private-value SELECT token_hash FROM cl_visitors /home/private'); };
  const response = await app.inject('/api/chat/public/departments');
  assert.equal(response.statusCode, 500); assert.deepEqual(response.json(), { error: 'Nao foi possivel concluir a requisicao.' });
  const local = fixture(t, { development: true, origin: 'http://127.0.0.1:3001' });
  const started = await local.request('POST', visitorBase + '/session', { name: 'Local' }, { origin: 'http://127.0.0.1:3001' });
  assert.equal(started.statusCode, 201); assert.match(started.headers['set-cookie'], /^cl_visitor=/);
  assert.equal(started.headers['set-cookie'].includes('Secure'), false);
  const productionHttp = fixture(t, { origin: 'http://chat.example.test' });
  assert.equal((await productionHttp.request('POST', visitorBase + '/session', { name: 'Inseguro' }, { origin: 'http://chat.example.test' })).statusCode, 503);
});
