'use strict';

function registerContacts(app, repository, auth) {
  const id = { type: 'integer', minimum: 1, maximum: 4294967295 };
  const kinds = ['lead', 'contact', 'customer'];
  const text = maximum => ({ type: 'string', maxLength: maximum, pattern: '^[^\\u0000-\\u001f\\u007f]*$' });
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  const fields = { name: { ...text(100), minLength: 2 }, email: text(254), phone: text(40), company: text(100), kind: { type: 'string', enum: kinds } };
  const query = object({
    page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    kind: { type: 'string', enum: ['all', ...kinds], default: 'all' },
    q: { ...text(100), default: '' }, departmentId: id
  }, []);
  const fail = (reply, code, error) => reply.code(code).send({ error });
  const missing = reply => fail(reply, 404, 'Contato ou area nao disponivel.');
  const strictBody = types => async (request, reply) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) ||
      Object.entries(types).some(([key, type]) => Object.hasOwn(request.body, key) && typeof request.body[key] !== type)) return fail(reply, 400, 'Dados invalidos.');
  };
  async function strictQuery(request, reply) {
    for (const key of ['page', 'limit', 'kind', 'q', 'departmentId']) {
      if (Object.hasOwn(request.query, key) && typeof request.query[key] !== 'string') return fail(reply, 400, 'Filtros invalidos.');
    }
    if (typeof request.query.q === 'string' && request.query.q.length > 100) return fail(reply, 400, 'Busca muito longa.');
  }
  async function team(request, reply, write = false) {
    const user = await auth.authorize(request, reply, { write });
    if (!user) return null;
    if (!repository?.capabilities || !(await repository.capabilities()).contacts) {
      fail(reply, 503, 'Contatos aguardam preparacao da instalacao.'); return null;
    }
    return { user, token: auth.readToken(request) };
  }
  function normalizedFields(input, reply) {
    const limits = { name: 100, email: 254, phone: 40, company: 100 };
    for (const [key, maximum] of Object.entries(limits)) {
      if (Object.hasOwn(input, key) && input[key].length > maximum) { fail(reply, 400, 'Campo muito longo.'); return null; }
    }
    const result = { ...input };
    for (const field of ['name', 'company']) if (Object.hasOwn(result, field)) result[field] = result[field].trim().normalize('NFC');
    for (const field of ['email', 'phone']) if (Object.hasOwn(result, field)) result[field] = result[field].trim();
    if (Object.hasOwn(result, 'email')) result.email = result.email.toLowerCase();
    if ((Object.hasOwn(result, 'name') && (result.name.length < 2 || result.name.length > 100)) ||
      (Object.hasOwn(result, 'company') && result.company.length > 100) ||
      (result.email && (!/^[\x20-\x7e]*$/.test(result.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email))) ||
      (Object.hasOwn(result, 'phone') && !/^[0-9+() -]*$/.test(result.phone))) {
      fail(reply, 400, 'Confira nome, e-mail e telefone.'); return null;
    }
    return result;
  }
  app.get('/api/crm/contacts', { preValidation: strictQuery, schema: { querystring: query } }, async (request, reply) => {
    const session = await team(request, reply); if (!session) return;
    const q = request.query.q.trim().normalize('NFC');
    if (q.length > 100) return fail(reply, 400, 'Busca muito longa.');
    const filters = { kind: request.query.kind, q };
    if (Object.hasOwn(request.query, 'departmentId')) filters.departmentId = request.query.departmentId;
    return repository.listContacts(session.user.id, session.token, request.query.page, request.query.limit, filters);
  });
  app.get('/api/crm/contacts/:id', { schema: { params: object({ id }) } }, async (request, reply) => {
    const session = await team(request, reply); if (!session) return;
    return await repository.findContact(session.user.id, session.token, request.params.id) || missing(reply);
  });
  app.post('/api/crm/contacts', { preValidation: strictBody({ departmentId: 'number', name: 'string', email: 'string', phone: 'string', company: 'string', kind: 'string', clientKey: 'string' }),
    schema: { body: object({ departmentId: id, ...fields, clientKey: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, ['departmentId', 'name', 'kind', 'clientKey']) }
  }, async (request, reply) => {
    const session = await team(request, reply, true); if (!session) return;
    const input = normalizedFields({ email: '', phone: '', company: '', ...request.body }, reply); if (!input) return;
    const result = await repository.createContact(session.user.id, session.token, input);
    return reply.code(result.created ? 201 : 200).send({ contact: result.contact });
  });
  app.patch('/api/crm/contacts/:id', { preValidation: strictBody({ version: 'number', name: 'string', email: 'string', phone: 'string', company: 'string', kind: 'string' }),
    schema: { params: object({ id }), body: { ...object({ version: id, ...fields }, ['version']), minProperties: 2 } }
  }, async (request, reply) => {
    const session = await team(request, reply, true); if (!session) return;
    const patch = normalizedFields(request.body, reply); if (!patch) return;
    return await repository.updateContact(session.user.id, session.token, request.params.id, patch) || missing(reply);
  });
}

module.exports = { registerContacts };
