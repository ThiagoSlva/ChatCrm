'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { digest, secret } = require('../src/security');

const origin = 'https://chat.example.test';
const base = '/api/team/departments';

// This fixture owns its state and checks the actor again at the persistence boundary.
// It exercises the HTTP contract without requiring a database or hosted credentials.
function fixture(t, schemaVersion = 2) {
  const users = [
    { id: 1, name: 'Admin', email: 'admin@example.test', role: 'admin', active: true, passwordHash: 'private-admin-hash' },
    { id: 2, name: 'Operador vendas', email: 'sales@example.test', role: 'operator', active: true, passwordHash: 'private-sales-hash' },
    { id: 3, name: 'Operador suporte', email: 'support@example.test', role: 'operator', active: true, passwordHash: 'private-support-hash' },
    { id: 4, name: 'Operador inativo', email: 'inactive@example.test', role: 'operator', active: false, passwordHash: 'private-inactive-hash' }
  ];
  const departments = [
    { id: 10, name: 'Vendas', active: true },
    { id: 20, name: 'Suporte', active: true },
    { id: 30, name: 'Anterior', active: false }
  ];
  const memberships = new Set(['10:2', '10:4', '20:3', '30:2']);
  const sessions = new Map();
  const tokens = users.map(() => secret());
  tokens.forEach((token, index) => sessions.set(digest(token), users[index].id));
  const safeUser = ({ passwordHash, ...fields }) => ({ ...fields });
  const safeDepartment = department => department && { ...department };
  const failure = statusCode => { const error = new Error('Persistence rejected the operation.'); error.statusCode = statusCode; throw error; };
  const actor = (id, admin = false) => {
    const user = users.find(candidate => candidate.id === id && candidate.active);
    if (!user || (admin && user.role !== 'admin')) failure(403);
    return user;
  };
  const accessible = (user, department) => user.role === 'admin' || (user.role === 'operator' && department.active && memberships.has(department.id + ':' + user.id));
  const pageOf = (all, page, limit, key) => ({ [key]: all.slice((page - 1) * limit, page * limit), total: all.length, page, limit });
  const repository = {
    status: async () => 'installed', company: async () => 'Empresa de teste', close: async () => {},
    capabilities: async () => ({ schemaVersion, departments: schemaVersion === 2 }),
    session: async token => {
      const user = users.find(candidate => candidate.id === sessions.get(digest(token)) && candidate.active);
      return user ? safeUser(user) : null;
    },
    revoke: async token => sessions.delete(digest(token)),
    listOperators: async (page, limit) => pageOf(users.filter(user => user.role === 'operator').map(safeUser), page, limit, 'users'),
    listDepartments: async (userId, page, limit) => {
      const user = users.find(candidate => candidate.id === userId);
      const visible = user?.active ? departments.filter(department => accessible(user, department)).sort((a, b) => b.id - a.id) : [];
      return pageOf(visible.map(safeDepartment), page, limit, 'departments');
    },
    findDepartment: async (userId, id) => {
      const user = users.find(candidate => candidate.id === userId);
      return user?.active ? safeDepartment(departments.find(department => department.id === id && accessible(user, department))) || null : null;
    },
    createDepartment: async (adminId, data) => {
      actor(adminId, true);
      if (departments.length >= 50 || departments.some(department => department.name.toLowerCase() === data.name.toLowerCase())) failure(409);
      const department = { id: Math.max(...departments.map(item => item.id)) + 1, name: data.name, active: true };
      departments.push(department);
      return safeDepartment(department);
    },
    updateDepartment: async (adminId, id, patch) => {
      actor(adminId, true);
      const department = departments.find(candidate => candidate.id === id);
      if (!department) return null;
      if (patch.name !== undefined && departments.some(candidate => candidate.id !== id && candidate.name.toLowerCase() === patch.name.toLowerCase())) failure(409);
      Object.assign(department, patch);
      return safeDepartment(department);
    },
    listDepartmentMembers: async (adminId, id, page, limit) => {
      actor(adminId, true);
      if (!departments.some(department => department.id === id)) return null;
      return pageOf(users.filter(user => user.role === 'operator' && memberships.has(id + ':' + user.id)).sort((a, b) => b.id - a.id).map(safeUser), page, limit, 'users');
    },
    setDepartmentMember: async (adminId, id, operatorId, member) => {
      actor(adminId, true);
      if (!departments.some(department => department.id === id) || !users.some(user => user.id === operatorId && user.role === 'operator')) return null;
      const key = id + ':' + operatorId;
      if (member) memberships.add(key); else memberships.delete(key);
      return { departmentId: id, userId: operatorId, member };
    }
  };
  const app = buildServer({ repository, env: { NODE_ENV: 'production', APP_URL: origin } });
  t.after(() => app.close());
  const headers = (index = 0) => ({ origin, cookie: '__Host-cl_session=' + tokens[index], 'x-csrf-token': digest('csrf:' + tokens[index]) });
  const request = (method, url = base, payload, index = 0, overrides = {}) => app.inject({ method, url, payload, headers: { ...headers(index), ...overrides } });
  return { app, repository, users, departments, memberships, sessions, tokens, headers, request };
}

test('departamentos exigem sessao em todas as rotas', async t => {
  const { app, departments, memberships } = fixture(t);
  for (const [method, url, payload] of [
    ['GET', base], ['GET', base + '/10'], ['POST', base, { name: 'Financeiro' }],
    ['PATCH', base + '/10', { active: false }], ['GET', base + '/10/members'],
    ['PUT', base + '/10/members/3', { member: true }]
  ]) {
    assert.equal((await app.inject({ method, url, payload, headers: { origin } })).statusCode, 401);
  }
  assert.equal(departments.length, 3);
  assert.equal(memberships.has('10:3'), false);
});

test('operador ve somente departamentos ativos associados sem revelar IDs alheios', async t => {
  const { request } = fixture(t);
  const own = await request('GET', base, undefined, 1);
  assert.equal(own.statusCode, 200);
  assert.deepEqual(own.json(), { departments: [{ id: 10, name: 'Vendas', active: true }], total: 1, page: 1, limit: 20 });
  assert.equal((await request('GET', base + '?limit=50', undefined, 1)).json().limit, 50);
  assert.deepEqual((await request('GET', base + '/10', undefined, 1)).json(), { department: { id: 10, name: 'Vendas', active: true } });
  const foreign = await request('GET', base + '/20', undefined, 1);
  const absent = await request('GET', base + '/999', undefined, 1);
  assert.equal(foreign.statusCode, 404);
  assert.equal(absent.statusCode, 404);
  assert.deepEqual(foreign.json(), absent.json());
  assert.equal((await request('GET', base + '/30', undefined, 1)).statusCode, 404);
  assert.equal((await request('GET', base, undefined, 3)).statusCode, 401);
});

test('somente administrador pode gerir departamentos e consultar membros', async t => {
  const { request, departments, memberships } = fixture(t);
  for (const [method, url, payload] of [
    ['POST', base, { name: 'Financeiro' }], ['PATCH', base + '/10', { name: 'Outro' }],
    ['GET', base + '/10/members'], ['PUT', base + '/10/members/3', { member: true }]
  ]) assert.equal((await request(method, url, payload, 1)).statusCode, 403);
  const all = await request('GET');
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().total, 3);
  assert.equal(all.json().departments.find(department => department.id === 30).active, false);
  assert.equal(departments[0].name, 'Vendas');
  assert.equal(memberships.has('10:3'), false);
});

test('escritas de departamentos exigem origem e CSRF sem modificar estado', async t => {
  const { request, departments, memberships } = fixture(t);
  for (const overrides of [{ origin: 'https://foreign.example.test' }, { origin: '' }, { 'x-csrf-token': '' }, { 'x-csrf-token': 'forged' }]) {
    for (const [method, url, payload] of [
      ['POST', base, { name: 'Financeiro' }], ['PATCH', base + '/10', { active: false }],
      ['PUT', base + '/10/members/3', { member: true }]
    ]) assert.equal((await request(method, url, payload, 0, overrides)).statusCode, 403);
  }
  assert.equal(departments.length, 3);
  assert.equal(departments[0].active, true);
  assert.equal(memberships.has('10:3'), false);
});

test('cadastro e renomeacao normalizam nomes e recusam duplicados sem alterar estado', async t => {
  const { request, departments } = fixture(t);
  const created = await request('POST', base, { name: '  Financeiro  ' });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json(), { department: { id: 31, name: 'Financeiro', active: true } });
  assert.equal((await request('POST', base, { name: 'financeiro' })).statusCode, 409);
  assert.equal((await request('PATCH', base + '/31', { name: ' suporte ' })).statusCode, 409);
  assert.equal(departments[3].name, 'Financeiro');
  const renamed = await request('PATCH', base + '/31', { name: '  Financeiro novo ', active: false });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual(renamed.json(), { department: { id: 31, name: 'Financeiro novo', active: false } });
  assert.equal((await request('PATCH', base + '/31', { name: 'Financeiro novo' })).statusCode, 200);
});

test('entradas invalidas e propriedades extras sao recusadas antes da persistencia', async t => {
  const { request, departments, memberships } = fixture(t);
  for (const name of ['', 'x', '   ', ' x ', 123, 'a'.repeat(101), 'Dois\nnomes', 'Dois\u0000nomes']) {
    assert.equal((await request('POST', base, { name })).statusCode, 400);
    assert.equal((await request('PATCH', base + '/10', { name })).statusCode, 400);
  }
  for (const payload of [{ name: 'Teste', active: true }, { name: 'Teste', role: 'admin' }, { name: 'Teste', id: 7 }, { name: 'Teste', members: [2] }]) {
    assert.equal((await request('POST', base, payload)).statusCode, 400);
  }
  for (const payload of [{}, { active: {} }, { active: 'false' }, { active: false, role: 'admin' }, { name: 'Teste', userId: 2 }]) {
    assert.equal((await request('PATCH', base + '/10', payload)).statusCode, 400);
  }
  for (const payload of [{}, { member: {} }, { member: 1 }, { member: true, role: 'admin' }, { member: true, departmentId: 20 }]) {
    assert.equal((await request('PUT', base + '/10/members/3', payload)).statusCode, 400);
  }
  assert.equal(departments.length, 3);
  assert.equal(departments[0].name, 'Vendas');
  assert.equal(memberships.has('10:3'), false);
});

test('IDs e paginacao ficam limitados e nao permitem injetar criterios de acesso', async t => {
  const { request } = fixture(t);
  for (const id of ['0', '-1', '1.5', '4294967296', 'abc', '1%20OR%201=1']) {
    assert.equal((await request('GET', base + '/' + id)).statusCode, 400);
    assert.equal((await request('PATCH', base + '/' + id, { active: false })).statusCode, 400);
    assert.equal((await request('GET', base + '/' + id + '/members')).statusCode, 400);
    assert.equal((await request('PUT', base + '/10/members/' + id, { member: true })).statusCode, 400);
  }
  assert.equal((await request('GET', base + '/4294967295')).statusCode, 404);
  for (const query of ['page=0', 'page=10001', 'page=1.5', 'page=1%20OR%201=1', 'limit=0', 'limit=51', 'role=admin', 'userId=3', 'active=true']) {
    assert.equal((await request('GET', base + '?' + query)).statusCode, 400);
    assert.equal((await request('GET', base + '/10/members?' + query)).statusCode, 400);
  }
  assert.deepEqual((await request('GET', base + '?page=2&limit=1')).json(), { departments: [{ id: 20, name: 'Suporte', active: true }], total: 3, page: 2, limit: 1 });
  assert.deepEqual((await request('GET', base + '?page=2&limit=1', undefined, 1)).json(), { departments: [], total: 1, page: 2, limit: 1 });
});

test('associacao e remocao sao idempotentes e nao alteram papeis ou usuarios', async t => {
  const { request, memberships, users } = fixture(t);
  const before = users.map(user => ({ ...user }));
  for (const member of [true, true, false, false]) {
    const response = await request('PUT', base + '/10/members/3', { member });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { departmentId: 10, userId: 3, member });
    assert.equal(memberships.has('10:3'), member);
  }
  for (const [departmentId, userId] of [[10, 1], [10, 999], [999, 2]]) {
    assert.equal((await request('PUT', base + '/' + departmentId + '/members/' + userId, { member: true })).statusCode, 404);
  }
  assert.deepEqual(users, before);
  assert.equal((await request('PUT', base + '/20/members/4', { member: true })).statusCode, 200);
  assert.equal(memberships.has('20:4'), true);
  assert.equal((await request('GET', base + '/20', undefined, 3)).statusCode, 401);
});

test('remocao nega a proxima requisicao da mesma sessao e reativacao preserva vinculos', async t => {
  const { request, memberships, sessions } = fixture(t);
  assert.equal((await request('GET', base + '/10', undefined, 1)).statusCode, 200);
  assert.equal((await request('PUT', base + '/10/members/2', { member: false })).statusCode, 200);
  assert.equal((await request('GET', base + '/10', undefined, 1)).statusCode, 404);
  assert.equal((await request('GET', '/api/auth/me', undefined, 1)).statusCode, 200);
  assert.equal((await request('PUT', base + '/10/members/2', { member: true })).statusCode, 200);
  assert.equal((await request('PATCH', base + '/10', { active: false })).statusCode, 200);
  assert.equal(memberships.has('10:2'), true);
  assert.equal((await request('GET', base + '/10', undefined, 1)).statusCode, 404);
  assert.deepEqual((await request('GET', base, undefined, 1)).json().departments, []);
  assert.equal((await request('PATCH', base + '/10', { active: true })).statusCode, 200);
  assert.equal((await request('GET', base + '/10', undefined, 1)).statusCode, 200);
  assert.equal(sessions.size, 4);
});

test('lista de membros e paginada sem hashes e inclui associados inativos para o administrador', async t => {
  const { request } = fixture(t);
  const response = await request('GET', base + '/10/members?page=2&limit=1');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { users: [{ id: 2, name: 'Operador vendas', email: 'sales@example.test', role: 'operator', active: true }], total: 2, page: 2, limit: 1 });
  assert.deepEqual((await request('GET', base + '/10/members?page=1&limit=1')).json().users, [{ id: 4, name: 'Operador inativo', email: 'inactive@example.test', role: 'operator', active: false }]);
  assert.equal(response.body.includes('password'), false);
  assert.equal(response.body.includes('private-'), false);
  assert.equal((await request('GET', base + '/999/members')).statusCode, 404);
});

test('ator desativado ou destituido apos a sessao nao consegue concluir operacoes', async t => {
  for (const change of [user => { user.active = false; }, user => { user.role = 'operator'; }]) {
    for (const [method, url, payload] of [
      ['POST', base, { name: 'Financeiro' }], ['PATCH', base + '/10', { active: false }],
      ['GET', base + '/10/members'], ['PUT', base + '/10/members/3', { member: true }]
    ]) {
      const { request, repository, users, departments, memberships } = fixture(t);
      const session = repository.session;
      repository.session = async token => {
        const copy = await session(token);
        change(users[0]);
        return copy;
      };
      assert.equal((await request(method, url, payload)).statusCode, 403);
      assert.equal(departments.length, 3);
      assert.equal(departments[0].active, true);
      assert.equal(memberships.has('10:3'), false);
    }
  }
  for (const url of [base, base + '/10']) {
    const { request, repository, users } = fixture(t);
    const session = repository.session;
    repository.session = async token => { const copy = await session(token); users[1].active = false; return copy; };
    const response = await request('GET', url, undefined, 1);
    assert.equal(response.statusCode, url === base ? 200 : 404);
    if (url === base) assert.deepEqual(response.json(), { departments: [], total: 0, page: 1, limit: 20 });
  }
});

test('limite de cinquenta departamentos nao permite novo cadastro', async t => {
  const { request, departments } = fixture(t);
  for (let id = 100; departments.length < 50; id++) departments.push({ id, name: 'Departamento ' + id, active: true });
  assert.equal((await request('POST', base, { name: 'Quinquagesimo primeiro' })).statusCode, 409);
  assert.equal(departments.length, 50);
});

test('schema v1 preserva perfil e equipe enquanto departamentos aguardam migracao explicita', async t => {
  const { request, repository } = fixture(t, 1);
  const unavailable = () => { throw new Error('Department persistence must not run before migration.'); };
  for (const key of ['listDepartments', 'findDepartment', 'createDepartment', 'updateDepartment', 'listDepartmentMembers', 'setDepartmentMember']) repository[key] = unavailable;
  const profile = await request('GET', '/api/auth/me');
  assert.equal(profile.statusCode, 200);
  assert.deepEqual(profile.json().capabilities, { schemaVersion: 1, departments: false });
  assert.equal(profile.json().user.passwordHash, undefined);
  assert.equal((await request('GET', '/api/team/operators')).statusCode, 200);
  for (const [method, url, payload] of [
    ['GET', base], ['GET', base + '/10'], ['POST', base, { name: 'Financeiro' }],
    ['PATCH', base + '/10', { active: false }], ['GET', base + '/10/members'],
    ['PUT', base + '/10/members/3', { member: true }]
  ]) assert.equal((await request(method, url, payload)).statusCode, 503);
});

test('capacidade v2 e erros de persistencia nao revelam SQL, hashes ou caminhos', async t => {
  const { request, repository } = fixture(t);
  const profile = await request('GET', '/api/auth/me');
  assert.equal(profile.statusCode, 200);
  assert.deepEqual(profile.json().capabilities, { schemaVersion: 2, departments: true });
  repository.listDepartments = async () => { throw new Error('DB_PASSWORD=private-value SELECT password_hash FROM cl_users /home/private'); };
  const response = await request('GET');
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: 'Nao foi possivel concluir a requisicao.' });
  repository.listDepartments = async () => { const error = new Error('Schema privado indisponivel'); error.statusCode = 503; throw error; };
  const unavailable = await request('GET');
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { error: 'Nao foi possivel concluir a requisicao.' });
});
