'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const { registerAuth } = require('../src/auth');
const { registerContacts } = require('../src/contacts');
const { digest, secret } = require('../src/security');
const origin = 'https://crm.example.test';
const base = '/api/crm/contacts';

function fixture(t, schemaVersion = 4) {
  const users = [{ id: 1, role: 'admin', active: true }, { id: 2, role: 'operator', active: true }, { id: 3, role: 'operator', active: true }];
  const tokens = users.map(() => secret());
  const sessions = new Map(tokens.map((token, i) => [digest(token), users[i].id]));
  const departments = [{ id: 10, name: 'Vendas', active: true }, { id: 20, name: 'Suporte', active: true }, { id: 30, name: 'Inativo', active: false }];
  const members = new Set(['10:2', '20:3']);
  const rows = [], keys = new Map(), calls = [];
  const fail = statusCode => { const error = new Error('Persistence failure'); error.statusCode = statusCode; throw error; };
  const actor = (id, token) => {
    const user = users.find(user => user.id === id && user.active && sessions.get(digest(token)) === id);
    if (!user) fail(401); return user;
  };
  const allowed = (user, id) => departments.some(area => area.id === id && area.active) && (user.role === 'admin' || members.has(id + ':' + user.id));
  const safe = row => ({ id: row.id, departmentId: row.departmentId, departmentName: departments.find(area => area.id === row.departmentId).name,
    name: row.name, email: row.email, phone: row.phone, company: row.company, kind: row.kind, version: row.version, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' });
  let beforePersist = null;
  const repository = {
    async capabilities() { return { schemaVersion, departments: schemaVersion >= 2, chat: schemaVersion >= 3, contacts: schemaVersion >= 4 }; },
    async session(token) { return users.find(user => user.active && sessions.get(digest(token)) === user.id) || null; },
    async company() { return 'Empresa sintética'; },
    async status() { return 'installed'; },
    async revoke(token) { sessions.delete(digest(token)); },
    async listContacts(id, token, page, limit, filters) {
      calls.push({ method: 'list', id, token, page, limit, filters }); if (beforePersist) beforePersist();
      const user = actor(id, token), q = filters.q.toLowerCase();
      const selected = rows.filter(row => allowed(user, row.departmentId) && (!filters.departmentId || row.departmentId === filters.departmentId) &&
        (filters.kind === 'all' || row.kind === filters.kind) && ['name', 'email', 'phone', 'company'].some(field => row[field].toLowerCase().includes(q))).sort((a, b) => b.id - a.id);
      return { contacts: selected.slice((page - 1) * limit, page * limit).map(safe), total: selected.length, page, limit };
    },
    async findContact(id, token, contactId) {
      calls.push({ method: 'find', id, token, contactId }); if (beforePersist) beforePersist();
      const user = actor(id, token), row = rows.find(row => row.id === contactId && allowed(user, row.departmentId));
      return row ? { contact: safe(row) } : null;
    },
    async createContact(id, token, input) {
      calls.push({ method: 'create', id, token, input }); if (beforePersist) beforePersist();
      const user = actor(id, token); if (!allowed(user, input.departmentId)) fail(404);
      const { clientKey, ...data } = input, fingerprint = JSON.stringify(data), key = id + ':' + clientKey, existing = keys.get(key);
      if (existing) { if (existing.fingerprint !== fingerprint) fail(409); return { contact: safe(existing.row), created: false }; }
      const row = { ...data, id: rows.length + 1, version: 1 }; rows.push(row); keys.set(key, { row, fingerprint });
      return { contact: safe(row), created: true };
    },
    async updateContact(id, token, contactId, patch) {
      calls.push({ method: 'update', id, token, contactId, patch }); if (beforePersist) beforePersist();
      const user = actor(id, token), row = rows.find(row => row.id === contactId && allowed(user, row.departmentId));
      if (!row) return null; if (patch.version !== row.version) fail(409);
      const { version, ...fields } = patch;
      if (Object.entries(fields).some(([key, value]) => row[key] !== value)) Object.assign(row, fields, { version: version + 1 });
      return { contact: safe(row) };
    }
  };
  const app = Fastify({ bodyLimit: 8192, ajv: { customOptions: { removeAdditional: false } } });
  const auth = registerAuth(app, repository, { APP_URL: origin, NODE_ENV: 'production' });
  registerContacts(app, repository, auth);
  app.setErrorHandler((error, request, reply) => reply.code(error.statusCode >= 400 && error.statusCode <= 503 ? error.statusCode : 500).send({ error: 'Operacao recusada.' }));
  t.after(() => app.close());
  const headers = index => ({ Cookie: '__Host-cl_session=' + tokens[index], Origin: origin, 'X-CSRF-Token': digest('csrf:' + tokens[index]) });
  const input = extra => ({ departmentId: 10, name: 'Pessoa sintética', kind: 'lead', clientKey: secret().slice(0, 32), ...extra });
  const create = async (index = 1, payload = input()) => app.inject({ method: 'POST', url: base, headers: headers(index), payload });
  return { app, repository, users, tokens, sessions, members, departments, rows, calls, headers, input, create, setBefore: callback => { beforePersist = callback; } };
}

test('contatos bloqueiam anonimo, visitante e schema antigo sem perder acesso da equipe', async t => {
  for (const version of [1, 2, 3, 4]) {
    const f = fixture(t, version);
    assert.equal((await f.app.inject(base)).statusCode, 401);
    assert.equal((await f.app.inject({ url: base, headers: { Cookie: '__Host-cl_visitor=' + f.tokens[1] } })).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/api/auth/me', headers: f.headers(1) })).statusCode, 200);
    assert.equal((await f.app.inject({ url: base, headers: f.headers(1) })).statusCode, version === 4 ? 200 : 503);
    assert.equal((await f.create()).statusCode, version === 4 ? 201 : 503);
  }
});
test('POST e PATCH exigem origem propria e CSRF da identidade antes de persistir', async t => {
  const f = fixture(t); const made = await f.create(); const id = made.json().contact.id;
  for (const [method, url, payload] of [['POST', base, f.input()], ['PATCH', base + '/' + id, { version: 1, kind: 'customer' }]]) {
    for (const headers of [{ ...f.headers(1), Origin: 'https://foreign.example.test' }, { Cookie: f.headers(1).Cookie, Origin: origin }, { ...f.headers(1), 'X-CSRF-Token': digest('csrf:' + f.tokens[2]) }]) {
      assert.equal((await f.app.inject({ method, url, payload, headers })).statusCode, 403);
    }
  }
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].kind, 'lead');
});
test('cadastro normaliza NFC, e-mail e vazios e limita campos publicos da equipe', async t => {
  const f = fixture(t), response = await f.create(1, f.input({ name: '  Jose\u0301  ', email: ' PERSON@EXAMPLE.TEST ', phone: ' +55 (11) 9999-0000 ', company: '  Empresa  ' }));
  assert.equal(response.statusCode, 201); const contact = response.json().contact;
  assert.equal(contact.name, 'José'); assert.equal(contact.email, 'person@example.test'); assert.equal(contact.phone, '+55 (11) 9999-0000'); assert.equal(contact.company, 'Empresa');
  assert.deepEqual(Object.keys(contact).sort(), ['company', 'createdAt', 'departmentId', 'departmentName', 'email', 'id', 'kind', 'name', 'phone', 'updatedAt', 'version']);
  assert.equal(f.calls.at(-1).token, f.tokens[1]);
});
test('reenvio de criacao reutiliza contato atual sem duplicar nem sobrescrever edicao', async t => {
  const f = fixture(t), payload = f.input(); const first = await f.create(1, payload);
  const id = first.json().contact.id;
  assert.equal((await f.app.inject({ method: 'PATCH', url: base + '/' + id, payload: { version: 1, kind: 'customer' }, headers: f.headers(1) })).statusCode, 200);
  const retry = await f.create(1, payload); assert.equal(retry.statusCode, 200); assert.equal(retry.json().contact.version, 2); assert.equal(retry.json().contact.kind, 'customer'); assert.equal(f.rows.length, 1);
  assert.equal((await f.create(1, { ...payload, name: 'Texto diferente' })).statusCode, 409); assert.equal(f.rows.length, 1);
});
test('escopo atual por departamento vale em listagem, detalhe, edicao e reenvio', async t => {
  const f = fixture(t), payload = f.input(); const id = (await f.create(1, payload)).json().contact.id;
  for (const index of [0, 1, 2]) {
    const response = await f.app.inject({ url: base, headers: f.headers(index) }); assert.equal(response.json().total, index === 2 ? 0 : 1);
    assert.equal((await f.app.inject({ url: base + '/' + id, headers: f.headers(index) })).statusCode, index === 2 ? 404 : 200);
  }
  f.members.delete('10:2');
  assert.equal((await f.create(1, payload)).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'PATCH', url: base + '/' + id, payload: { version: 1, name: 'Outro nome' }, headers: f.headers(1) })).statusCode, 404);
  f.departments[0].active = false;
  assert.equal((await f.app.inject({ url: base + '/' + id, headers: f.headers(0) })).statusCode, 404);
  assert.equal((await f.app.inject({ url: base, headers: f.headers(0) })).json().total, 0);
});
test('pesquisa literal, classificacao, departamento e paginas mantem total e filtros normalizados', async t => {
  const f = fixture(t);
  await f.create(1, f.input({ name: 'José %_!\\', company: 'Acme', kind: 'lead' }));
  await f.create(1, f.input({ name: 'Pessoa B', email: 'b@example.test', kind: 'customer' }));
  const response = await f.app.inject({ url: base + '?page=1&limit=1&kind=all&departmentId=10', headers: f.headers(1) });
  assert.equal(response.json().total, 2); assert.equal(response.json().contacts.length, 1);
  const empty = await f.app.inject({ url: base + '?page=3&limit=1&kind=all', headers: f.headers(1) }); assert.equal(empty.json().total, 2); assert.deepEqual(empty.json().contacts, []);
  for (const q of ['%_!\\', 'Acme', '  Jose\u0301 ']) {
    const r = await f.app.inject({ url: base + '?q=' + encodeURIComponent(q) + '&kind=lead', headers: f.headers(1) }); assert.equal(r.json().total, 1, q);
  }
  assert.equal((await f.app.inject({ url: base + '?q=' + encodeURIComponent("' OR 1=1 --"), headers: f.headers(1) })).json().total, 0);
  assert.equal((await f.app.inject({ url: base + '?departmentId=20', headers: f.headers(1) })).json().total, 0);
});
test('tipos, campos extras, classificacoes, controles e tamanhos invalidos nao acessam repositorio', async t => {
  const f = fixture(t);
  const invalid = [{ name: ' ' }, { name: 'x'.repeat(101) }, { name: 'Nome\n' }, { email: 'invalid' }, { email: 'á@example.test' }, { email: 'e'.repeat(255) }, { email: 'mail@example.test\r' }, { phone: '119999#' }, { phone: '1'.repeat(41) }, { company: 'x'.repeat(101) }, { name: 123 }, { departmentId: '10' }, { kind: 'qualified' }, { clientKey: 123 }, { clientKey: 'A'.repeat(32) }, { company: null }, { active: true }, { version: 1 }];
  for (const changes of invalid) assert.equal((await f.create(1, f.input(changes))).statusCode, 400, JSON.stringify(changes));
  assert.equal(f.calls.length, 0);
});
test('consultas duplicadas, controle e limites invalidos nao acessam persistencia', async t => {
  const f = fixture(t);
  for (const query of ['kind=lost', 'kind=lead&kind=customer', 'departmentId=10&departmentId=20', 'page=1&page=2', 'limit=1&limit=2', 'q=a&q=b', 'q=%00', 'extra=1', 'q=' + 'x'.repeat(101), 'q=' + encodeURIComponent(' ' + 'x'.repeat(100)), 'departmentId=0', 'limit=51', 'page=10001']) {
    assert.equal((await f.app.inject({ url: base + '?' + query, headers: f.headers(1) })).statusCode, 400, query);
  }
  assert.equal(f.calls.length, 0);
});
test('versao obrigatoria evita sobrescrever outro operador e noop conserva versao', async t => {
  const f = fixture(t); f.members.add('10:3'); const id = (await f.create()).json().contact.id;
  const url = base + '/' + id;
  const responses = await Promise.all([f.app.inject({ method: 'PATCH', url, payload: { version: 1, kind: 'customer' }, headers: f.headers(1) }), f.app.inject({ method: 'PATCH', url, payload: { version: 1, name: 'Outro operador' }, headers: f.headers(2) })]);
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409]); assert.equal(f.rows[0].version, 2);
  assert.equal((await f.app.inject({ method: 'PATCH', url, payload: { version: 2, kind: f.rows[0].kind }, headers: f.headers(1) })).json().contact.version, 2);
  for (const payload of [{ version: 2 }, { kind: 'lead' }, { version: '2', kind: 'lead' }, { version: 2, departmentId: 20 }, { version: 0, name: 'Outra' }, { version: 2, name: '' }]) assert.equal((await f.app.inject({ method: 'PATCH', url, payload, headers: f.headers(1) })).statusCode, 400);
});
test('revogacao entre autorizacao HTTP e leitura transacional impede persistencia', async t => {
  const f = fixture(t); f.setBefore(() => f.sessions.delete(digest(f.tokens[1])));
  assert.equal((await f.app.inject({ url: base, headers: f.headers(1) })).statusCode, 401);
  assert.equal(f.rows.length, 0);
});
test('erro interno de persistencia e ids fora do limite nao vazam informacao', async t => {
  const f = fixture(t);
  f.repository.findContact = async () => { throw new Error('private database path password SQL'); };
  assert.equal((await f.app.inject({ url: base + '/1', headers: f.headers(1) })).statusCode, 500);
  assert.doesNotMatch((await f.app.inject({ url: base + '/1', headers: f.headers(1) })).body, /password|SQL|private/);
  for (const id of ['0', '4294967296', 'bad', '1.5']) assert.equal((await f.app.inject({ url: base + '/' + id, headers: f.headers(1) })).statusCode, 400);
});
