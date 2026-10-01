'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { digest, secret, hashPassword, verifyPassword } = require('../src/security');
const origin = 'https://chat.example.test';
const password = 'operator-test-password-exclusive';

async function fixture(t) {
  const users = [
    { id: 1, name: 'Admin', email: 'admin@example.test', role: 'admin', active: true },
    { id: 2, name: 'Operador', email: 'operator@example.test', role: 'operator', active: true, passwordHash: await hashPassword(password) }
  ];
  const sessions = new Map();
  const safe = user => { const { passwordHash, ...fields } = user; return fields; };
  const repository = {
    status: async () => 'installed', company: async () => 'Equipe de teste', close: async () => {},
    session: async token => { const user = users.find(u => u.id === sessions.get(digest(token)) && u.active); return user ? safe(user) : null; },
    revoke: async token => sessions.delete(digest(token)),
    findUser: async email => users.find(u => u.email === email && u.active),
    createSession: async (token, id) => { if (!users.some(u => u.id === id && u.active)) return false; sessions.set(digest(token), id); return true; },
    listOperators: async (page, limit) => { const all = users.filter(u => u.role === 'operator'); return { users: all.slice((page - 1) * limit, page * limit).map(safe), total: all.length, page, limit }; },
    createOperator: async data => { if (users.some(u => u.email === data.email) || users.length >= 201) { const error = new Error(); error.statusCode = 409; throw error; } const user = { ...data, id: users.length + 1, role: 'operator', active: true }; users.push(user); return safe(user); },
    setOperatorActive: async (id, active) => { const user = users.find(u => u.id === id && u.role === 'operator'); if (!user) return null; user.active = active; if (!active) for (const [token, userId] of sessions) if (userId === id) sessions.delete(token); return safe(user); }
  };
  const app = buildServer({ repository, env: { NODE_ENV: 'production', APP_URL: origin } });
  t.after(() => app.close());
  const token = secret(); const operatorToken = secret();
  sessions.set(digest(token), 1); sessions.set(digest(operatorToken), 2);
  const headers = (value = token) => ({ origin, cookie: '__Host-cl_session=' + value, 'x-csrf-token': digest('csrf:' + value) });
  const create = (changes = {}, overrides = {}) => app.inject({ method: 'POST', url: '/api/team/operators', headers: { ...headers(), ...overrides }, payload: { name: ' Novo operador ', email: 'NEW@example.test', password, ...changes } });
  const patch = (id, payload, overrides = {}) => app.inject({ method: 'PATCH', url: '/api/team/operators/' + id, headers: { ...headers(), ...overrides }, payload });
  return { app, repository, users, sessions, token, operatorToken, headers, create, patch };
}

test('gestao de equipe recusa anonimos e operadores em leitura e escrita', async t => {
  const { app, headers, operatorToken } = await fixture(t);
  for (const [method, url, payload] of [['GET', '/api/team/operators'], ['POST', '/api/team/operators', { name: 'Teste', email: 'test@example.test', password }], ['PATCH', '/api/team/operators/2', { active: false }]]) {
    assert.equal((await app.inject({ method, url, payload, headers: { origin } })).statusCode, 401);
    assert.equal((await app.inject({ method, url, payload, headers: headers(operatorToken) })).statusCode, 403);
  }
});

test('escritas da equipe exigem origem e CSRF antes de alterar usuarios', async t => {
  const { create, patch, users } = await fixture(t);
  for (const headers of [{ origin: 'https://foreign.example.test' }, { 'x-csrf-token': '' }]) {
    assert.equal((await create({}, headers)).statusCode, 403);
    assert.equal((await patch(2, { active: false }, headers)).statusCode, 403);
  }
  assert.equal(users.length, 2); assert.equal(users[1].active, true);
});

test('cadastro normaliza identidade, usa hash e nao permite escolher papel administrativo', async t => {
  const { create, users } = await fixture(t);
  assert.equal((await create({ role: 'admin' })).statusCode, 400);
  assert.equal((await create({ password: 'curta' })).statusCode, 400);
  assert.equal((await create({ name: '   ' })).statusCode, 400);
  const response = await create();
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().user, { id: 3, name: 'Novo operador', email: 'new@example.test', role: 'operator', active: true });
  assert.equal(await verifyPassword(password, users[2].passwordHash), true);
  assert.equal((await create()).statusCode, 409);
  assert.equal(users.length, 3);
});

test('desativacao encerra sessoes e reativacao nao ressuscita cookies antigos', async t => {
  const { app, patch, operatorToken, headers } = await fixture(t);
  const profile = () => app.inject({ url: '/api/auth/me', headers: headers(operatorToken) });
  const login = () => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email: 'operator@example.test', password } });
  assert.equal((await profile()).statusCode, 200);
  assert.equal((await patch(2, { active: false })).statusCode, 200);
  assert.equal((await profile()).statusCode, 401);
  assert.equal((await login()).statusCode, 401);
  assert.equal((await patch(2, { active: true })).statusCode, 200);
  assert.equal((await profile()).statusCode, 401);
  assert.equal((await login()).statusCode, 200);
});

test('administrador nao pode ser desativado por rota de operadores e pagina e limitada', async t => {
  const { app, patch, users, headers } = await fixture(t);
  assert.equal((await patch(1, { active: false })).statusCode, 404);
  assert.equal((await patch(999, { active: false })).statusCode, 404);
  assert.equal((await patch(2, { active: false, role: 'admin' })).statusCode, 400);
  assert.equal(users[0].active, true);
  const response = await app.inject({ url: '/api/team/operators?page=2&limit=1', headers: headers() });
  assert.deepEqual(response.json(), { users: [], total: 1, page: 2, limit: 1 });
  for (const query of ['limit=51', 'page=0', 'page=1%20OR%201=1', 'role=admin']) assert.equal((await app.inject({ url: '/api/team/operators?' + query, headers: headers() })).statusCode, 400);
});

test('login em andamento nao emite cookie se o usuario foi desativado durante o hash', async t => {
  const { app, repository, users } = await fixture(t);
  const original = repository.findUser;
  repository.findUser = async email => { const user = await original(email); users[1].active = false; return user; };
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email: 'operator@example.test', password } });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['set-cookie'], undefined);
});
