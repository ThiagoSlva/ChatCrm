'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const { registerAuth } = require('../src/auth');
const { registerOpportunities } = require('../src/opportunities');
const { digest, secret } = require('../src/security');
const origin = 'https://crm.example.test';
const base = '/api/crm/opportunities';
function fixture(t, schemaVersion = 5) {
  const users = [{ id: 1, name: 'Admin sintético', role: 'admin', active: true }, { id: 2, name: 'Operador A', role: 'operator', active: true }, { id: 3, name: 'Operador B', role: 'operator', active: true }];
  const tokens = users.map(() => secret());
  const sessions = new Map(tokens.map((token, i) => [digest(token), users[i].id]));
  const departments = [{ id: 10, name: 'Vendas', active: true }, { id: 20, name: 'Suporte', active: true }];
  const members = new Set(['10:2', '20:3']);
  const contacts = [{ id: 100, departmentId: 10, name: 'José %_!\\', company: 'Acme' }, { id: 200, departmentId: 20, name: 'Pessoa B', company: 'Outra' }];
  const rows = [], events = new Map(), keys = new Map(), calls = [];
  let beforePersist = null;
  const fail = code => { const error = new Error('Persistence refused'); error.statusCode = code; throw error; };
  const actor = (id, token) => {
    if (beforePersist) beforePersist();
    const user = users.find(user => user.id === id && user.active && sessions.get(digest(token)) === id);
    if (!user) fail(401); return user;
  };
  const allowed = (user, contactId) => {
    const contact = contacts.find(row => row.id === contactId);
    return contact && departments.some(area => area.id === contact.departmentId && area.active) && (user.role === 'admin' || members.has(contact.departmentId + ':' + user.id));
  };
  const safe = row => {
    const contact = contacts.find(contact => contact.id === row.contactId);
    return { id: row.id, contactId: row.contactId, contactName: contact.name, departmentId: contact.departmentId, departmentName: departments.find(area => area.id === contact.departmentId).name,
      title: row.title, amountCents: row.amountCents, currency: 'BRL', stage: row.stage, version: row.version, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
  };
  const event = (row, id) => ({ version: row.version, actorName: users.find(user => user.id === id).name, title: row.title, amountCents: row.amountCents, stage: row.stage, createdAt: '2026-10-02T00:00:00.000Z' });
  const find = (user, id) => rows.find(row => row.id === id && allowed(user, row.contactId));
  const repository = {
    async capabilities() { return { schemaVersion, departments: schemaVersion >= 2, chat: schemaVersion >= 3, contacts: schemaVersion >= 4, opportunities: schemaVersion >= 5 }; },
    async session(token) { return users.find(user => user.active && sessions.get(digest(token)) === user.id) || null; },
    async company() { return 'Empresa sintética'; }, async status() { return 'installed'; },
    async revoke(token) { sessions.delete(digest(token)); },
    async listOpportunities(id, token, page, limit, filters) {
      calls.push({ method: 'list', id, token, page, limit, filters }); const user = actor(id, token);
      const selected = rows.filter(row => {
        const contact = contacts.find(contact => contact.id === row.contactId);
        return allowed(user, row.contactId) && (!filters.contactId || row.contactId === filters.contactId) &&
          (!filters.departmentId || contact.departmentId === filters.departmentId) && (filters.stage === 'all' || row.stage === filters.stage) &&
          [row.title, contact.name, contact.company].some(value => value.toLowerCase().includes(filters.q.toLowerCase()));
      }).sort((a, b) => b.id - a.id);
      return { opportunities: selected.slice((page - 1) * limit, page * limit).map(safe), total: selected.length, page, limit };
    },
    async findOpportunity(id, token, opportunityId) {
      calls.push({ method: 'find', id, token, opportunityId }); const row = find(actor(id, token), opportunityId);
      return row ? { opportunity: safe(row) } : null;
    },
    async listOpportunityEvents(id, token, opportunityId, page, limit) {
      calls.push({ method: 'events', id, token, opportunityId, page, limit }); const row = find(actor(id, token), opportunityId);
      if (!row) return null; const list = [...events.get(opportunityId)].reverse();
      return { events: list.slice((page - 1) * limit, page * limit), total: list.length, page, limit };
    },
    async createOpportunity(id, token, input) {
      calls.push({ method: 'create', id, token, input }); const user = actor(id, token);
      const existing = keys.get(id + ':' + input.clientKey);
      if (!allowed(user, existing?.row.contactId || input.contactId)) fail(404);
      const fingerprint = JSON.stringify({ contactId: input.contactId, title: input.title, amountCents: input.amountCents });
      if (existing) { if (fingerprint !== existing.fingerprint) fail(409); return { opportunity: safe(existing.row), created: false }; }
      const row = { ...input, id: rows.length + 1, version: 1, stage: 'new' }; rows.push(row);
      keys.set(id + ':' + input.clientKey, { row, fingerprint }); events.set(row.id, [event(row, id)]);
      return { opportunity: safe(row), created: true };
    },
    async updateOpportunity(id, token, opportunityId, patch) {
      calls.push({ method: 'update', id, token, opportunityId, patch }); const row = find(actor(id, token), opportunityId);
      if (!row) return null; if (row.version !== patch.version) fail(409);
      const { version, ...changes } = patch;
      if (Object.entries(changes).some(([field, value]) => row[field] !== value)) {
        Object.assign(row, changes, { version: version + 1 }); events.get(row.id).push(event(row, id));
      }
      return { opportunity: safe(row) };
    }
  };
  const app = Fastify({ bodyLimit: 8192, ajv: { customOptions: { removeAdditional: false } } });
  const auth = registerAuth(app, repository, { APP_URL: origin, NODE_ENV: 'production' });
  registerOpportunities(app, repository, auth);
  app.setErrorHandler((error, request, reply) => reply.code(error.statusCode >= 400 && error.statusCode <= 503 ? error.statusCode : 500).send({ error: 'Operacao recusada.' }));
  t.after(() => app.close());
  const headers = index => ({ Cookie: '__Host-cl_session=' + tokens[index], Origin: origin, 'X-CSRF-Token': digest('csrf:' + tokens[index]) });
  const input = extra => ({ contactId: 100, title: 'Proposta sintética', clientKey: secret().slice(0, 32), ...extra });
  const create = (index = 1, payload = input()) => app.inject({ method: 'POST', url: base, headers: headers(index), payload });
  return { app, repository, headers, input, create, calls, rows, events, users, tokens, sessions, departments, members, setBefore: callback => { beforePersist = callback; } };
}
test('oportunidades exigem identidade da equipe e schema5 sem bloquear login antigo', async t => {
  for (const version of [1, 2, 3, 4, 5]) {
    const f = fixture(t, version);
    for (const url of [base, base + '/1', base + '/1/events']) {
      assert.equal((await f.app.inject(url)).statusCode, 401);
      assert.equal((await f.app.inject({ url, headers: { Cookie: '__Host-cl_visitor=' + f.tokens[1] } })).statusCode, 401);
      assert.equal((await f.app.inject({ url, headers: f.headers(1) })).statusCode, version === 5 ? (url === base ? 200 : 404) : 503);
    }
    assert.equal((await f.app.inject({ url: '/api/auth/me', headers: f.headers(1) })).statusCode, 200);
    assert.equal((await f.create()).statusCode, version === 5 ? 201 : 503);
  }
});
test('criar e editar oportunidades exigem origem propria e CSRF antes da persistencia', async t => {
  const f = fixture(t), id = (await f.create()).json().opportunity.id;
  const count = f.calls.length;
  for (const [method, url, payload] of [['POST', base, f.input()], ['PATCH', base + '/' + id, { version: 1, stage: 'won' }]]) {
    for (const headers of [{ ...f.headers(1), Origin: 'https://foreign.example.test' }, { Cookie: f.headers(1).Cookie, Origin: origin }, { ...f.headers(1), 'X-CSRF-Token': digest('csrf:' + f.tokens[2]) }]) {
      assert.equal((await f.app.inject({ method, url, payload, headers })).statusCode, 403);
    }
  }
  assert.equal(f.calls.length, count); assert.equal(f.rows[0].stage, 'new');
});
test('cadastro usa centavos inteiros BRL titulo NFC e campos seguros vinculados ao contato', async t => {
  const f = fixture(t), response = await f.create(1, f.input({ title: '  Instalac\u0327a\u0303o  ', amountCents: 123456 }));
  assert.equal(response.statusCode, 201); const opportunity = response.json().opportunity;
  assert.equal(opportunity.title, 'Instalação'); assert.equal(opportunity.amountCents, 123456); assert.equal(opportunity.currency, 'BRL'); assert.equal(opportunity.stage, 'new');
  assert.deepEqual(Object.keys(opportunity).sort(), ['amountCents', 'contactId', 'contactName', 'createdAt', 'currency', 'departmentId', 'departmentName', 'id', 'stage', 'title', 'updatedAt', 'version']);
  assert.equal(f.calls.at(-1).token, f.tokens[1]);
  const another = await f.create(); assert.equal(another.json().opportunity.amountCents, 0); assert.equal(f.rows.length, 2);
});
test('replay retorna oportunidade editada sem duplicar ou repetir evento inicial', async t => {
  const f = fixture(t), payload = f.input(), id = (await f.create(1, payload)).json().opportunity.id;
  await f.app.inject({ method: 'PATCH', url: base + '/' + id, headers: f.headers(1), payload: { version: 1, stage: 'proposal', amountCents: 999999999 } });
  const retry = await f.create(1, payload);
  assert.equal(retry.statusCode, 200); assert.equal(retry.json().opportunity.version, 2); assert.equal(retry.json().opportunity.stage, 'proposal');
  assert.equal(f.rows.length, 1); assert.equal(f.events.get(id).length, 2);
  assert.equal((await f.create(1, { ...payload, title: 'Outro título' })).statusCode, 409);
});
test('area e vinculo atuais protegem lista detalhe eventos edicao e reenvio', async t => {
  const f = fixture(t), payload = f.input(), id = (await f.create(1, payload)).json().opportunity.id;
  for (const index of [0, 1, 2]) {
    const h = f.headers(index);
    assert.equal((await f.app.inject({ url: base, headers: h })).json().total, index === 2 ? 0 : 1);
    for (const url of [base + '/' + id, base + '/' + id + '/events']) assert.equal((await f.app.inject({ url, headers: h })).statusCode, index === 2 ? 404 : 200);
  }
  f.members.delete('10:2');
  assert.equal((await f.create(1, payload)).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'PATCH', url: base + '/' + id, headers: f.headers(1), payload: { version: 1, stage: 'won' } })).statusCode, 404);
  f.departments[0].active = false;
  for (const url of [base + '/' + id, base + '/' + id + '/events']) assert.equal((await f.app.inject({ url, headers: f.headers(0) })).statusCode, 404);
});
test('filtros e busca literal mantem total escopo e pagina normalizados', async t => {
  const f = fixture(t); const id = (await f.create(1, f.input({ title: 'Proposta %_!\\' }))).json().opportunity.id; await f.create();
  await f.app.inject({ method: 'PATCH', url: base + '/' + id, headers: f.headers(1), payload: { version: 1, stage: 'qualified' } });
  const response = await f.app.inject({ url: base + '?stage=all&departmentId=10&contactId=100&page=2&limit=1', headers: f.headers(1) });
  assert.equal(response.json().total, 2); assert.equal(response.json().opportunities[0].id, id);
  const call = f.calls.at(-1); assert.deepEqual(call.filters, { stage: 'all', q: '', departmentId: 10, contactId: 100 });
  for (const q of ['%_!\\', 'Acme', '  Jose\u0301 ']) assert.equal((await f.app.inject({ url: base + '?stage=qualified&q=' + encodeURIComponent(q), headers: f.headers(1) })).json().total, 1);
  assert.equal((await f.app.inject({ url: base + '?departmentId=20', headers: f.headers(1) })).json().total, 0);
  assert.equal((await f.app.inject({ url: base + '?q=' + encodeURIComponent("' OR 1=1 --"), headers: f.headers(1) })).json().total, 0);
});
test('etapas e historico versionado nao sobrescrevem edicao concorrente e noop nao cria evento', async t => {
  const f = fixture(t); f.members.add('10:3'); const id = (await f.create()).json().opportunity.id;
  const updates = await Promise.all([f.app.inject({ method: 'PATCH', url: base + '/' + id, headers: f.headers(1), payload: { version: 1, stage: 'won' } }), f.app.inject({ method: 'PATCH', url: base + '/' + id, headers: f.headers(2), payload: { version: 1, title: 'Outro operador' } })]);
  assert.deepEqual(updates.map(r => r.statusCode).sort(), [200, 409]); assert.equal(f.events.get(id).length, 2);
  assert.equal((await f.app.inject({ method: 'PATCH', url: base + '/' + id, headers: f.headers(1), payload: { version: 2, stage: f.rows[0].stage } })).json().opportunity.version, 2);
  assert.equal(f.events.get(id).length, 2);
  const history = await f.app.inject({ url: base + '/' + id + '/events?page=1&limit=1', headers: f.headers(1) });
  assert.equal(history.statusCode, 200); assert.equal(history.json().total, 2); assert.equal(history.json().events[0].version, 2);
  assert.deepEqual(Object.keys(history.json().events[0]).sort(), ['actorName', 'amountCents', 'createdAt', 'stage', 'title', 'version']);
  const oldest = await f.app.inject({ url: base + '/' + id + '/events?page=2&limit=1', headers: f.headers(1) }); assert.equal(oldest.json().events[0].stage, 'new');
  assert.deepEqual((await f.app.inject({ url: base + '/' + id + '/events?page=3&limit=1', headers: f.headers(1) })).json().events, []);
});
test('campos tipos controles valores e tamanhos invalidos falham antes de persistir', async t => {
  const f = fixture(t);
  for (const extra of [{ title: ' ' }, { title: 'x'.repeat(151) }, { title: 'a\nb' }, { title: 'x'.repeat(149) + '😀' }, { title: 2 }, { contactId: '100' }, { contactId: 0 }, { clientKey: 'A'.repeat(32) }, { amountCents: '100' }, { amountCents: 1.2 }, { amountCents: -1 }, { amountCents: 1000000000 }, { currency: 'USD' }, { stage: 'new' }, { version: 1 }]) assert.equal((await f.create(1, f.input(extra))).statusCode, 400, JSON.stringify(extra));
  assert.equal(f.calls.length, 0);
});
test('consulta e historico rejeitam duplicatas extras e ids sem acessar persistencia', async t => {
  const f = fixture(t);
  for (const query of ['stage=bad', 'stage=new&stage=won', 'q=a&q=b', 'departmentId=10&departmentId=20', 'contactId=100&contactId=200', 'page=1&page=2', 'limit=1&limit=2', 'q=%00', 'q=' + encodeURIComponent(' ' + 'x'.repeat(100)), 'extra=1', 'page=10001', 'limit=51', 'contactId=0']) assert.equal((await f.app.inject({ url: base + '?' + query, headers: f.headers(1) })).statusCode, 400, query);
  for (const query of ['q=a', 'stage=new', 'extra=1', 'page=1&page=2', 'limit=0']) assert.equal((await f.app.inject({ url: base + '/1/events?' + query, headers: f.headers(1) })).statusCode, 400);
  for (const id of ['0', '4294967296', 'bad', '1.5']) for (const suffix of ['', '/events']) assert.equal((await f.app.inject({ url: base + '/' + id + suffix, headers: f.headers(1) })).statusCode, 400);
  assert.equal(f.calls.length, 0);
});
test('PATCH exige versao e campo editavel e nao permite trocar contato ou moeda', async t => {
  const f = fixture(t), id = (await f.create()).json().opportunity.id;
  const count = f.calls.length;
  for (const payload of [{ version: 1 }, { stage: 'won' }, { version: '1', stage: 'won' }, { version: 1, contactId: 200 }, { version: 1, currency: 'BRL' }, { version: 1, amountCents: null }, { version: 1, stage: 'all' }, { version: 0, title: 'Outra' }, { version: 1, title: '' }]) assert.equal((await f.app.inject({ method: 'PATCH', url: base + '/' + id, headers: f.headers(1), payload })).statusCode, 400);
  assert.equal(f.calls.length, count);
});
test('revogacao apos autorizacao HTTP e falha interna permanecem fechadas sem segredos', async t => {
  const f = fixture(t); f.setBefore(() => f.sessions.delete(digest(f.tokens[1])));
  assert.equal((await f.app.inject({ url: base, headers: f.headers(1) })).statusCode, 401);
  f.setBefore(null); f.sessions.set(digest(f.tokens[1]), 2);
  f.repository.findOpportunity = async () => { throw new Error('private path SQL password'); };
  const response = await f.app.inject({ url: base + '/1', headers: f.headers(1) }); assert.equal(response.statusCode, 500); assert.doesNotMatch(response.body, /private|password|SQL/);
});
