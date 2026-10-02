'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { digest, secret, hashPassword, verifyPassword } = require('../src/security');

const origin = 'https://chat.example.test';
const password = 'senha-atual-exclusiva-dos-testes';
const newPassword = 'nova-senha-exclusiva-dos-testes';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const users = [
    { id: 1, name: 'Admin', email: 'admin@example.test', role: 'admin', active: true, passwordHash: await hashPassword(password) },
    { id: 2, name: 'Operador', email: 'operator@example.test', role: 'operator', active: true, passwordHash: await hashPassword(password) }
  ];
  const sessions = new Map();
  const safe = user => ({ id: user.id, name: user.name, email: user.email, role: user.role });
  // Model one atomic user update; barriers below control the meaningful interleavings.
  let mutex = Promise.resolve();
  const serialized = work => {
    const result = mutex.then(work);
    mutex = result.catch(() => {});
    return result;
  };
  const repository = {
    status: async () => 'installed', company: async () => 'Empresa isolada de teste', close: async () => {},
    findUser: async email => {
      const user = users.find(value => value.email === email && value.active);
      return user ? { ...user } : null;
    },
    session: async token => {
      const user = users.find(value => value.id === sessions.get(digest(token)) && value.active);
      return user ? safe(user) : null;
    },
    revoke: async token => sessions.delete(digest(token)),
    createSession: (token, id, verifiedHash) => serialized(() => {
      const user = users.find(value => value.id === id && value.active);
      if (!user || typeof verifiedHash !== 'string' || user.passwordHash !== verifiedHash) return false;
      sessions.set(digest(token), id);
      return true;
    }),
    changePassword: (id, verifiedHash, passwordHash, token) => serialized(() => {
      const user = users.find(value => value.id === id && value.active);
      if (!user || user.passwordHash !== verifiedHash || sessions.get(digest(token)) !== id) return false;
      user.passwordHash = passwordHash;
      for (const [key, userId] of sessions) if (userId === id) sessions.delete(key);
      return true;
    })
  };
  const app = buildServer({ repository, env: { NODE_ENV: 'production', APP_URL: origin } });
  t.after(() => app.close());
  const adminToken = secret(); const adminOtherToken = secret();
  const operatorToken = secret(); const operatorOtherToken = secret();
  sessions.set(digest(adminToken), 1); sessions.set(digest(adminOtherToken), 1);
  sessions.set(digest(operatorToken), 2); sessions.set(digest(operatorOtherToken), 2);
  const headers = (token = operatorToken) => ({ origin, cookie: '__Host-cl_session=' + token, 'x-csrf-token': digest('csrf:' + token) });
  const payload = changes => ({ currentPassword: password, newPassword, confirmation: newPassword, ...changes });
  const change = (changes = {}, overrides = {}, token = operatorToken) => app.inject({ method: 'POST', url: '/api/auth/password', headers: { ...headers(token), ...overrides }, payload: payload(changes) });
  const login = (email = 'operator@example.test', value = password) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email, password: value } });
  const profile = token => app.inject({ url: '/api/auth/me', headers: { cookie: '__Host-cl_session=' + token } });
  return { app, repository, users, sessions, adminToken, adminOtherToken, operatorToken, operatorOtherToken, headers, payload, change, login, profile };
}

test('troca de senha exige sessao, origem propria e CSRF sem alterar dados recusados', async t => {
  const { app, users, sessions, payload, change } = await fixture(t);
  const hashes = users.map(user => user.passwordHash);
  const previousSessions = [...sessions];
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/password', headers: { origin }, payload: payload() })).statusCode, 401);
  for (const overrides of [{ origin: 'https://foreign.example.test' }, { origin: '' }, { 'x-csrf-token': '' }, { 'x-csrf-token': 'invalido' }]) {
    assert.equal((await change({}, overrides)).statusCode, 403);
  }
  assert.deepEqual(users.map(user => user.passwordHash), hashes);
  assert.deepEqual([...sessions], previousSessions);
});

test('senha atual, confirmacao e requisitos da nova senha sao verificados antes da alteracao', async t => {
  const { users, sessions, change } = await fixture(t);
  const hashes = users.map(user => user.passwordHash);
  const previousSessions = [...sessions];
  for (const changes of [
    { currentPassword: 'senha-atual-incorreta-de-teste' },
    { confirmation: 'confirmacao-diferente-de-teste' },
    { newPassword: 'curta', confirmation: 'curta' },
    { newPassword: 'a'.repeat(257), confirmation: 'a'.repeat(257) },
    { newPassword: password, confirmation: password }
  ]) assert.equal((await change(changes)).statusCode, 400);
  assert.deepEqual(users.map(user => user.passwordHash), hashes);
  assert.deepEqual([...sessions], previousSessions);
});

test('troca de senha recusa identidade e papel fornecidos no corpo', async t => {
  const { users, sessions, change } = await fixture(t);
  const hashes = users.map(user => user.passwordHash);
  const previousSessions = [...sessions];
  for (const changes of [{ id: 1 }, { userId: 1 }, { email: 'admin@example.test' }, { role: 'admin' }]) {
    assert.equal((await change(changes)).statusCode, 400);
  }
  assert.deepEqual(users.map(user => user.passwordHash), hashes);
  assert.deepEqual([...sessions], previousSessions);
});

test('operador troca somente a propria senha, revoga todas as suas sessoes e precisa entrar novamente', async t => {
  const { users, sessions, change, login, profile, adminToken, adminOtherToken, operatorToken, operatorOtherToken } = await fixture(t);
  const adminHash = users[0].passwordHash;
  const result = await change();
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { passwordChanged: true, authenticated: false });
  assert.match(result.headers['set-cookie'], /^__Host-cl_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0; Secure$/);
  assert.equal(users[0].passwordHash, adminHash);
  assert.equal(users[1].role, 'operator');
  assert.equal(await verifyPassword(newPassword, users[1].passwordHash), true);
  assert.equal(await verifyPassword(password, users[1].passwordHash), false);
  assert.deepEqual([...sessions.values()], [1, 1]);
  for (const token of [operatorToken, operatorOtherToken]) assert.equal((await profile(token)).statusCode, 401);
  for (const token of [adminToken, adminOtherToken]) assert.equal((await profile(token)).statusCode, 200);
  assert.equal((await login()).statusCode, 401);
  const freshLogin = await login('operator@example.test', newPassword);
  assert.equal(freshLogin.statusCode, 200);
  const freshToken = freshLogin.headers['set-cookie'].split(';')[0].split('=')[1];
  assert.equal((await profile(freshToken)).statusCode, 200);
});

test('administrador tambem troca apenas sua senha sem alterar os operadores', async t => {
  const { users, sessions, change, profile, adminToken, adminOtherToken, operatorToken } = await fixture(t);
  const operatorHash = users[1].passwordHash;
  assert.equal((await change({}, {}, adminToken)).statusCode, 200);
  assert.equal(users[1].passwordHash, operatorHash);
  assert.equal(await verifyPassword(newPassword, users[0].passwordHash), true);
  assert.deepEqual([...sessions.values()], [2, 2]);
  for (const token of [adminToken, adminOtherToken]) assert.equal((await profile(token)).statusCode, 401);
  assert.equal((await profile(operatorToken)).statusCode, 200);
});

test('login iniciado com senha antiga nao cria sessao depois de uma troca concluida', { timeout: 10000 }, async t => {
  const { repository, sessions, change, login } = await fixture(t);
  const captured = deferred(); const resume = deferred();
  const original = repository.findUser;
  let firstLookup = true;
  repository.findUser = async email => {
    const snapshot = await original(email);
    if (firstLookup) { firstLookup = false; captured.resolve(); await resume.promise; }
    return snapshot;
  };
  const pendingLogin = login();
  let changed;
  try { await captured.promise; changed = await change(); }
  finally { resume.resolve(); }
  const result = await pendingLogin;
  assert.equal(changed.statusCode, 200);
  assert.equal(result.statusCode, 401);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal([...sessions.values()].includes(2), false);
});

test('sessao revogada durante a verificacao impede troca e preserva o hash atual', { timeout: 10000 }, async t => {
  const { repository, users, sessions, operatorToken, operatorOtherToken, change } = await fixture(t);
  const captured = deferred(); const resume = deferred();
  const original = repository.findUser;
  const originalHash = users[1].passwordHash;
  repository.findUser = async email => {
    const snapshot = await original(email);
    captured.resolve(); await resume.promise;
    return snapshot;
  };
  const pendingChange = change();
  try { await captured.promise; await repository.revoke(operatorToken); }
  finally { resume.resolve(); }
  const result = await pendingChange;
  assert.equal(result.statusCode, 409);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(users[1].passwordHash, originalHash);
  assert.equal(sessions.get(digest(operatorOtherToken)), 2);
});

test('duas trocas concorrentes baseadas no mesmo hash tem somente uma vencedora', { timeout: 10000 }, async t => {
  const { repository, users, sessions, change } = await fixture(t);
  const bothReady = deferred();
  const original = repository.changePassword;
  let arrivals = 0;
  repository.changePassword = async (...args) => {
    if (++arrivals === 2) bothReady.resolve();
    await bothReady.promise;
    return original(...args);
  };
  const candidates = [newPassword, 'segunda-nova-senha-exclusiva-de-teste'];
  const responses = await Promise.all(candidates.map(value => change({ newPassword: value, confirmation: value })));
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
  const winner = responses.findIndex(response => response.statusCode === 200);
  assert.equal(await verifyPassword(candidates[winner], users[1].passwordHash), true);
  assert.equal(await verifyPassword(candidates[1 - winner], users[1].passwordHash), false);
  assert.equal([...sessions.values()].includes(2), false);
});
