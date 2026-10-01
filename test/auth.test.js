'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { hashPassword, verifyPassword, digest } = require('../src/security');
const origin = 'https://chat.example.test';
const setupToken = 'test-only-setup-secret-never-configure-in-production';
const password = 'Senha-de-teste-exclusiva-2026';

function fixture(t, options = {}) {
  let installed = false;
  let currentUser;
  const sessions = new Map();
  const repository = {
    status: async () => installed ? 'installed' : 'setup',
    install: async data => { if (installed) { const error = new Error(); error.statusCode = 409; throw error; } installed = true; currentUser = { id: 1, name: data.name, email: data.email, role: 'admin', passwordHash: data.passwordHash }; },
    findUser: async email => currentUser?.email === email ? currentUser : null,
    createSession: async (token, id) => sessions.set(digest(token), id),
    session: async token => sessions.has(digest(token)) ? { id: 1, name: currentUser.name, email: currentUser.email, role: 'admin' } : null,
    revoke: async token => sessions.delete(digest(token)),
    company: async () => 'Empresa de teste', close: async () => {}
  };
  const app = buildServer({ repository, env: { APP_URL: origin, NODE_ENV: 'production', SETUP_TOKEN: setupToken, ...options.env } });
  t.after(() => app.close());
  const post = (url, payload, headers = {}) => app.inject({ method: 'POST', url, payload, headers: { origin, ...headers } });
  const install = (changes = {}) => post('/api/install', { company: 'Empresa de teste', name: 'Pessoa de teste', email: 'admin@example.test', password, setupToken, ...changes });
  return { app, post, install, repository, sessions };
}

test('senha usa sal exclusivo e compara sem guardar texto original', async () => {
  const a = await hashPassword(password);
  const b = await hashPassword(password);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword('outra senha de teste', a), false);
  assert.equal(await verifyPassword(password, 'formato invalido'), false);
  assert.equal(a.includes(password), false);
});

test('instalacao sem configuracao fica bloqueada e nao revela valores privados', async (t) => {
  const app = buildServer({ repository: null, env: {} });
  t.after(() => app.close());
  assert.deepEqual((await app.inject('/api/installation')).json(), { state: 'configuration-required' });
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.test', password }, headers: { origin } })).statusCode, 503);
});

test('URL HTTP em producao e segredo ausente impedem instalacao', async (t) => {
  const { app, install } = fixture(t, { env: { APP_URL: 'http://chat.example.test', SETUP_TOKEN: '' } });
  assert.equal((await app.inject('/api/installation')).json().state, 'configuration-required');
  assert.equal((await install()).statusCode, 503);
});

test('segredo incorreto e origem estrangeira nao criam administrador', async (t) => {
  const { install, post, app } = fixture(t);
  assert.equal((await install({ setupToken: 'outro-segredo-de-teste-com-mais-de-32-caracteres' })).statusCode, 403);
  assert.equal((await post('/api/auth/login', { email: 'admin@example.test', password }, { origin: 'https://evil.example.test' })).statusCode, 403);
  assert.equal((await app.inject('/api/installation')).json().state, 'setup');
});

test('primeiro administrador e criado uma unica vez, inclusive em concorrencia', async (t) => {
  const { install, app } = fixture(t);
  const responses = await Promise.all([install(), install()]);
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 409]);
  assert.equal((await app.inject('/api/installation')).json().state, 'installed');
  assert.equal((await install()).statusCode, 409);
});

test('login protege cookie, perfil nao expoe hash e logout exige CSRF e revoga sessao', async (t) => {
  const { install, post, app, sessions } = fixture(t);
  await install();
  assert.equal((await app.inject('/api/auth/me')).statusCode, 401);
  const login = await post('/api/auth/login', { email: 'ADMIN@example.test', password });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers['set-cookie'];
  assert.match(setCookie, /^__Host-cl_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  const cookie = setCookie.split(';')[0];
  assert.equal(sessions.has(cookie.split('=')[1]), false);
  const profile = (await app.inject({ url: '/api/auth/me', headers: { cookie } })).json();
  assert.equal(profile.user.role, 'admin');
  assert.equal(profile.user.passwordHash, undefined);
  assert.equal((await post('/api/auth/logout', {}, { cookie })).statusCode, 403);
  const logout = await post('/api/auth/logout', {}, { cookie, 'x-csrf-token': profile.csrfToken });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode, 401);
});

test('login incorreto nao revela existencia do e-mail', async (t) => {
  const { install, post } = fixture(t);
  await install();
  const existing = await post('/api/auth/login', { email: 'admin@example.test', password: 'outra-senha-de-teste' });
  const unknown = await post('/api/auth/login', { email: 'unknown@example.test', password });
  assert.equal(existing.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(existing.json(), unknown.json());
});

test('tentativas repetidas sao limitadas, mesmo com cabecalho proxy forjado', async (t) => {
  const { install, post } = fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await install({ setupToken: 'outro-segredo-de-teste-com-mais-de-32-caracteres' })).statusCode, 403);
  assert.equal((await post('/api/auth/login', { email: 'admin@example.test', password }, { 'x-forwarded-for': '198.51.100.7' })).statusCode, 429);
});

test('entradas fracas, gigantes e email SQL sao recusados antes de acessar banco', async (t) => {
  const { install, app } = fixture(t);
  for (const changes of [{ password: 'curta' }, { password: 'a'.repeat(257) }, { email: "' OR 1=1;--" }, { name: '   ' }, { company: '   ' }]) assert.equal((await install(changes)).statusCode, 400);
  assert.equal((await app.inject('/api/installation')).json().state, 'setup');
});

test('erro de banco retorna estado generico sem senha, SQL ou caminho', async (t) => {
  const { app, repository } = fixture(t);
  repository.status = async () => { throw new Error('DB_PASSWORD=segredo-privado SELECT * FROM cl_users /home/private'); };
  const response = await app.inject('/api/installation');
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { state: 'database-unavailable' });
});
