'use strict';

const { hashPassword } = require('./security');

function registerTeam(app, repository, auth) {
  const userSchema = { type: 'object', additionalProperties: false, required: ['name', 'email', 'password'], properties: {
    ...auth.identityProperties, name: { type: 'string', minLength: 2, maxLength: 100, pattern: '\\S' }
  } };
  app.get('/api/team/operators', { schema: { querystring: { type: 'object', additionalProperties: false, properties: {
    page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
  } } } }, async (request, reply) => {
    if (!await auth.authorize(request, reply, { admin: true })) return;
    return repository.listOperators(request.query.page, request.query.limit);
  });
  app.post('/api/team/operators', { schema: { body: userSchema } }, async (request, reply) => {
    if (!await auth.authorize(request, reply, { admin: true, write: true }) || !auth.throttle(request, reply)) return;
    return auth.hashWork(async () => {
      const user = await repository.createOperator({ name: request.body.name.trim(), email: request.body.email.toLowerCase(), passwordHash: await hashPassword(request.body.password) });
      return reply.code(201).send({ user });
    });
  });
  app.patch('/api/team/operators/:id', { schema: {
    params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'integer', minimum: 1, maximum: 4294967295 } } },
    body: { type: 'object', additionalProperties: false, required: ['active'], properties: { active: { type: 'boolean' } } }
  } }, async (request, reply) => {
    if (!await auth.authorize(request, reply, { admin: true, write: true })) return;
    const user = await repository.setOperatorActive(request.params.id, request.body.active);
    if (!user) return reply.code(404).send({ error: 'Operador nao encontrado.' });
    return { user };
  });
}

module.exports = { registerTeam };
