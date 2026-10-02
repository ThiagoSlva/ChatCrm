'use strict';

function registerDepartments(app, repository, auth) {
  const id = { type: 'integer', minimum: 1, maximum: 4294967295 };
  const name = { type: 'string', minLength: 2, maxLength: 100, pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
  const pagination = { type: 'object', additionalProperties: false, properties: {
    page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
  } };
  const params = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  // Query/route parameters arrive as text; JSON mutation fields must keep their original types.
  const strictBody = types => async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.entries(types).some(([key, type]) => Object.hasOwn(body, key) && typeof body[key] !== type)) {
      return reply.code(400).send({ error: 'Dados invalidos.' });
    }
  };
  async function ready(reply) {
    if (!repository?.capabilities || !(await repository.capabilities()).departments) {
      reply.code(503).send({ error: 'Departamentos aguardam preparacao da instalacao.' });
      return false;
    }
    return true;
  }
  function missing(reply) { return reply.code(404).send({ error: 'Departamento ou operador nao encontrado.' }); }
  function normalizedName(value, reply) {
    const normalized = value.trim();
    if (normalized.length < 2) { reply.code(400).send({ error: 'Informe um nome com pelo menos dois caracteres.' }); return null; }
    return normalized;
  }
  app.get('/api/team/departments', { schema: { querystring: pagination } }, async (request, reply) => {
    const user = await auth.authorize(request, reply);
    if (!user || !await ready(reply)) return;
    return repository.listDepartments(user.id, request.query.page, request.query.limit);
  });
  app.get('/api/team/departments/:id', { schema: { params: params({ id }) } }, async (request, reply) => {
    const user = await auth.authorize(request, reply);
    if (!user || !await ready(reply)) return;
    const department = await repository.findDepartment(user.id, request.params.id);
    return department ? { department } : missing(reply);
  });
  app.post('/api/team/departments', { preValidation: strictBody({ name: 'string' }), schema: {
    body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name } }
  } }, async (request, reply) => {
    const user = await auth.authorize(request, reply, { admin: true, write: true });
    if (!user || !await ready(reply)) return;
    const normalized = normalizedName(request.body.name, reply);
    if (normalized === null) return;
    const department = await repository.createDepartment(user.id, { name: normalized });
    return reply.code(201).send({ department });
  });
  app.patch('/api/team/departments/:id', { preValidation: strictBody({ name: 'string', active: 'boolean' }), schema: {
    params: params({ id }), body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name, active: { type: 'boolean' } } }
  } }, async (request, reply) => {
    const user = await auth.authorize(request, reply, { admin: true, write: true });
    if (!user || !await ready(reply)) return;
    const patch = { ...request.body };
    if (Object.hasOwn(patch, 'name')) {
      patch.name = normalizedName(patch.name, reply);
      if (patch.name === null) return;
    }
    const department = await repository.updateDepartment(user.id, request.params.id, patch);
    return department ? { department } : missing(reply);
  });
  app.get('/api/team/departments/:id/members', { schema: { params: params({ id }), querystring: pagination } }, async (request, reply) => {
    const user = await auth.authorize(request, reply, { admin: true });
    if (!user || !await ready(reply)) return;
    const members = await repository.listDepartmentMembers(user.id, request.params.id, request.query.page, request.query.limit);
    return members || missing(reply);
  });
  app.put('/api/team/departments/:id/members/:userId', { preValidation: strictBody({ member: 'boolean' }), schema: {
    params: params({ id, userId: id }), body: { type: 'object', additionalProperties: false, required: ['member'], properties: { member: { type: 'boolean' } } }
  } }, async (request, reply) => {
    const user = await auth.authorize(request, reply, { admin: true, write: true });
    if (!user || !await ready(reply)) return;
    const membership = await repository.setDepartmentMember(user.id, request.params.id, request.params.userId, request.body.member);
    return membership || missing(reply);
  });
}

module.exports = { registerDepartments };
