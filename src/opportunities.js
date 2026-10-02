'use strict';

function registerOpportunities(app, repository, auth) {
  const id = { type: 'integer', minimum: 1, maximum: 4294967295 };
  const amount = { type: 'integer', minimum: 0, maximum: 999999999 };
  const stages = ['new', 'qualified', 'proposal', 'won', 'lost'];
  const text = maximum => ({ type: 'string', maxLength: maximum, pattern: '^[^\\u0000-\\u001f\\u007f]*$' });
  const title = { ...text(150), minLength: 2 };
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  const pagination = { page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } };
  const query = object({ ...pagination, stage: { type: 'string', enum: ['all', ...stages], default: 'all' }, q: { ...text(100), default: '' }, departmentId: id, contactId: id }, []);
  const fail = (reply, code, error) => reply.code(code).send({ error });
  const missing = reply => fail(reply, 404, 'Oportunidade ou contato nao disponivel.');
  const strictBody = types => async (request, reply) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) ||
      Object.entries(types).some(([key, type]) => Object.hasOwn(request.body, key) && typeof request.body[key] !== type)) return fail(reply, 400, 'Dados invalidos.');
    if (typeof request.body.title === 'string' && request.body.title.length > 150) return fail(reply, 400, 'Titulo muito longo.');
  };
  async function strictQuery(request, reply) {
    for (const key of ['page', 'limit', 'stage', 'q', 'departmentId', 'contactId']) {
      if (Object.hasOwn(request.query, key) && typeof request.query[key] !== 'string') return fail(reply, 400, 'Filtros invalidos.');
    }
    if (typeof request.query.q === 'string' && request.query.q.length > 100) return fail(reply, 400, 'Busca muito longa.');
  }
  async function team(request, reply, write = false) {
    const user = await auth.authorize(request, reply, { write });
    if (!user) return null;
    if (!repository?.capabilities || (await repository.capabilities()).opportunities !== true) {
      fail(reply, 503, 'Vendas aguardam preparacao da instalacao.'); return null;
    }
    return { user, token: auth.readToken(request) };
  }
  function normalizeTitle(input, reply) {
    const result = { ...input };
    if (Object.hasOwn(result, 'title')) {
      result.title = result.title.trim().normalize('NFC');
      if (result.title.length < 2 || result.title.length > 150) { fail(reply, 400, 'Confira o titulo da oportunidade.'); return null; }
    }
    return result;
  }
  app.get('/api/crm/opportunities', { preValidation: strictQuery, schema: { querystring: query } }, async (request, reply) => {
    const session = await team(request, reply); if (!session) return;
    const q = request.query.q.trim().normalize('NFC');
    if (q.length > 100) return fail(reply, 400, 'Busca muito longa.');
    const filters = { stage: request.query.stage, q };
    for (const key of ['departmentId', 'contactId']) if (Object.hasOwn(request.query, key)) filters[key] = request.query[key];
    return repository.listOpportunities(session.user.id, session.token, request.query.page, request.query.limit, filters);
  });
  app.get('/api/crm/opportunities/:id', { schema: { params: object({ id }) } }, async (request, reply) => {
    const session = await team(request, reply); if (!session) return;
    return await repository.findOpportunity(session.user.id, session.token, request.params.id) || missing(reply);
  });
  app.get('/api/crm/opportunities/:id/events', { preValidation: strictQuery, schema: { params: object({ id }), querystring: object(pagination, []) } }, async (request, reply) => {
    const session = await team(request, reply); if (!session) return;
    return await repository.listOpportunityEvents(session.user.id, session.token, request.params.id, request.query.page, request.query.limit) || missing(reply);
  });
  app.post('/api/crm/opportunities', {
    preValidation: strictBody({ contactId: 'number', title: 'string', amountCents: 'number', clientKey: 'string' }),
    schema: { body: object({ contactId: id, title, amountCents: amount, clientKey: { type: 'string', pattern: '^[a-f0-9]{32}$' } }, ['contactId', 'title', 'clientKey']) }
  }, async (request, reply) => {
    const session = await team(request, reply, true); if (!session) return;
    const input = normalizeTitle({ amountCents: 0, ...request.body }, reply); if (!input) return;
    const result = await repository.createOpportunity(session.user.id, session.token, input);
    return reply.code(result.created ? 201 : 200).send({ opportunity: result.opportunity });
  });
  app.patch('/api/crm/opportunities/:id', {
    preValidation: strictBody({ version: 'number', title: 'string', amountCents: 'number', stage: 'string' }),
    schema: { params: object({ id }), body: { ...object({ version: id, title, amountCents: amount, stage: { type: 'string', enum: stages } }, ['version']), minProperties: 2 } }
  }, async (request, reply) => {
    const session = await team(request, reply, true); if (!session) return;
    const patch = normalizeTitle(request.body, reply); if (!patch) return;
    return await repository.updateOpportunity(session.user.id, session.token, request.params.id, patch) || missing(reply);
  });
}
module.exports = { registerOpportunities };
