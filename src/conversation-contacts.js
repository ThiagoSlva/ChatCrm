'use strict';

function registerConversationContacts(app, repository, auth) {
  const id = { type: 'integer', minimum: 1, maximum: 4294967295 };
  const version = { type: 'integer', minimum: 0, maximum: 4294967295 };
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  const pagination = { page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } };
  const base = '/api/crm/conversations/:id/contact';
  const fail = (reply, code, message) => reply.code(code).send({ error: message });
  const missing = reply => fail(reply, 404, 'Atendimento ou contato nao disponivel.');
  const integer = (value, minimum) => Number.isInteger(value) && value >= minimum && value <= 4294967295;
  async function strictPatch(request, reply) {
    const input = request.body;
    // AJV may coerce 0/false/empty strings to null in a nullable union. Reject
    // these before schema validation so they can never remove a relationship.
    if (!input || typeof input !== 'object' || Array.isArray(input) || !integer(input.version, 0) ||
      !Object.hasOwn(input, 'contactId') || (input.contactId !== null && !integer(input.contactId, 1))) {
      return fail(reply, 400, 'Dados invalidos para o vinculo.');
    }
  }
  async function strictQuery(request, reply) {
    for (const key of ['page', 'limit']) {
      if (Object.hasOwn(request.query, key) && typeof request.query[key] !== 'string') return fail(reply, 400, 'Pagina invalida.');
    }
  }
  async function team(request, reply, write = false) {
    const user = await auth.authorize(request, reply, { write });
    if (!user) return null;
    if (!repository?.capabilities || (await repository.capabilities()).conversationContacts !== true) {
      fail(reply, 503, 'Vinculos do atendimento aguardam preparacao da instalacao.'); return null;
    }
    return { user, token: auth.readToken(request) };
  }
  app.get(base, { schema: { params: object({ id }), querystring: object({}) } }, async (request, reply) => {
    const session = await team(request, reply); if (!session) return;
    return await repository.getConversationContact(session.user.id, session.token, request.params.id) || missing(reply);
  });
  app.get(base + '/events', { preValidation: strictQuery, schema: { params: object({ id }), querystring: object(pagination, []) } }, async (request, reply) => {
    const session = await team(request, reply); if (!session) return;
    return await repository.listConversationContactEvents(session.user.id, session.token, request.params.id, request.query.page, request.query.limit) || missing(reply);
  });
  app.patch(base, { preValidation: strictPatch, schema: { params: object({ id }), querystring: object({}),
    body: object({ version, contactId: { anyOf: [id, { type: 'null' }] } }) } }, async (request, reply) => {
    const session = await team(request, reply, true); if (!session) return;
    return await repository.setConversationContact(session.user.id, session.token, request.params.id, request.body) || missing(reply);
  });
}
module.exports = { registerConversationContacts };
