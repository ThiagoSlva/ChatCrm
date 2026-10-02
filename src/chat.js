'use strict';

const { digest, equal, secret } = require('./security');

function registerChat(app, repository, auth) {
  const id = { type: 'integer', minimum: 1, maximum: 4294967295 };
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  const idParams = { params: object({ id }) };
  const historyQuery = object({ after: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 } }, []);
  const pageQuery = object({ page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, []);
  const emptyBody = object({});
  const messageBody = object({ text: { type: 'string', minLength: 1, maxLength: 4000, pattern: '^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+$' }, clientKey: { type: 'string', pattern: '^[a-f0-9]{32}$' } });
  const cookieName = auth.secure ? '__Host-cl_visitor' : 'cl_visitor';
  const visitorCookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${auth.secure ? '; Secure' : ''}`;
  const readVisitorToken = request => {
    const raw = (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='));
    const value = raw?.slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
  };
  const strictBody = types => async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.entries(types).some(([key, type]) => Object.hasOwn(body, key) && typeof body[key] !== type)) {
      return reply.code(400).send({ error: 'Dados invalidos.' });
    }
  };
  const deny = (reply, code, error) => reply.code(code).send({ error });
  const missing = reply => deny(reply, 404, 'Atendimento ou departamento nao disponivel.');
  async function ready(reply) {
    if (!auth.origin || !repository?.capabilities || !(await repository.capabilities()).chat) {
      deny(reply, 503, 'Atendimento aguarda preparacao da instalacao.'); return false;
    }
    return true;
  }
  function originAllowed(request, reply) {
    if (!auth.origin || !repository) { deny(reply, 503, 'Atendimento aguarda preparacao da instalacao.'); return false; }
    if (request.headers.origin !== auth.origin) { deny(reply, 403, 'Origem nao autorizada.'); return false; }
    return true;
  }
  async function visitor(request, reply, write = false) {
    if (write && !originAllowed(request, reply)) return null;
    if (!await ready(reply)) return null;
    const token = readVisitorToken(request);
    const identity = token && await repository.visitorSession(token);
    if (!identity) { deny(reply, 401, 'Inicie sua sessao de visitante.'); return null; }
    if (write && !equal(request.headers['x-csrf-token'], digest('visitor-csrf:' + token))) {
      deny(reply, 403, 'Sessao invalida.'); return null;
    }
    return { token, identity };
  }
  async function team(request, reply, { write = false, admin = false } = {}) {
    const user = await auth.authorize(request, reply, { write, admin });
    if (!user || !await ready(reply)) return null;
    return { user, token: auth.readToken(request) };
  }
  function messageInput(body, reply) {
    const text = body.text.trim();
    if (!text || text.length > 2000) { deny(reply, 400, 'Escreva uma mensagem com 1 a 2000 caracteres.'); return null; }
    return { text, clientKey: body.clientKey };
  }

  app.get('/api/chat/public/departments', async (request, reply) => {
    if (!await ready(reply)) return;
    return repository.listPublicChatDepartments();
  });
  app.post('/api/chat/visitor/session', { preValidation: strictBody({ name: 'string' }), schema: {
    body: object({ name: { type: 'string', minLength: 2, maxLength: 100, pattern: '^[^\\u0000-\\u001f\\u007f]+$' } })
  } }, async (request, reply) => {
    if (!originAllowed(request, reply) || !await ready(reply)) return;
    if (await repository.status() !== 'installed') return deny(reply, 503, 'Conclua a instalacao antes de iniciar atendimentos.');
    const existing = readVisitorToken(request);
    if (existing && await repository.visitorSession(existing)) return deny(reply, 409, 'Sua sessao de visitante ja esta aberta.');
    const name = request.body.name.trim().normalize('NFC');
    if (name.length < 2 || name.length > 100) return deny(reply, 400, 'Informe seu nome com 2 a 100 caracteres.');
    const token = secret();
    const identity = await repository.createVisitor(token, name, digest('visitor-open:' + request.ip));
    reply.header('Set-Cookie', visitorCookie(token, 28800));
    return reply.code(201).send({ visitor: identity, csrfToken: digest('visitor-csrf:' + token) });
  });
  app.get('/api/chat/visitor/me', async (request, reply) => {
    const session = await visitor(request, reply);
    if (!session) return;
    return { visitor: session.identity, csrfToken: digest('visitor-csrf:' + session.token) };
  });
  app.post('/api/chat/visitor/logout', { preValidation: strictBody({}), schema: { body: emptyBody } }, async (request, reply) => {
    const session = await visitor(request, reply, true);
    if (!session) return;
    await repository.revokeVisitor(session.token);
    reply.header('Set-Cookie', visitorCookie('', 0));
    return { authenticated: false };
  });
  app.get('/api/chat/visitor/conversations', async (request, reply) => {
    const session = await visitor(request, reply);
    if (!session) return;
    return repository.listVisitorConversations(session.token);
  });
  app.post('/api/chat/visitor/conversations', { preValidation: strictBody({ departmentId: 'number' }), schema: { body: object({ departmentId: id }) } }, async (request, reply) => {
    const session = await visitor(request, reply, true);
    if (!session) return;
    const result = await repository.createVisitorConversation(session.token, request.body.departmentId);
    return reply.code(result.created ? 201 : 200).send({ conversation: result.conversation });
  });
  app.get('/api/chat/visitor/conversations/:id/messages', { schema: { ...idParams, querystring: historyQuery } }, async (request, reply) => {
    const session = await visitor(request, reply);
    if (!session) return;
    return await repository.visitorMessages(session.token, request.params.id, request.query.after, request.query.limit) || missing(reply);
  });
  app.post('/api/chat/visitor/conversations/:id/messages', { preValidation: strictBody({ text: 'string', clientKey: 'string' }), schema: { ...idParams, body: messageBody } }, async (request, reply) => {
    const session = await visitor(request, reply, true);
    if (!session) return;
    const input = messageInput(request.body, reply); if (!input) return;
    const result = await repository.sendVisitorMessage(session.token, request.params.id, input);
    if (!result) return missing(reply);
    return reply.code(result.created ? 201 : 200).send({ message: result.message });
  });
  app.get('/api/chat/team/channels/:id', { schema: idParams }, async (request, reply) => {
    const session = await team(request, reply, { admin: true }); if (!session) return;
    return await repository.chatChannel(session.user.id, session.token, request.params.id) || missing(reply);
  });
  app.put('/api/chat/team/channels/:id', { preValidation: strictBody({ enabled: 'boolean' }), schema: { ...idParams, body: object({ enabled: { type: 'boolean' } }) } }, async (request, reply) => {
    const session = await team(request, reply, { admin: true, write: true }); if (!session) return;
    return await repository.setChatChannel(session.user.id, session.token, request.params.id, request.body.enabled) || missing(reply);
  });
  app.get('/api/chat/team/conversations', { schema: { querystring: pageQuery } }, async (request, reply) => {
    const session = await team(request, reply); if (!session) return;
    return repository.listChatConversations(session.user.id, session.token, request.query.page, request.query.limit);
  });
  app.get('/api/chat/team/conversations/:id/messages', { schema: { ...idParams, querystring: historyQuery } }, async (request, reply) => {
    const session = await team(request, reply); if (!session) return;
    return await repository.teamMessages(session.user.id, session.token, request.params.id, request.query.after, request.query.limit) || missing(reply);
  });
  app.post('/api/chat/team/conversations/:id/messages', { preValidation: strictBody({ text: 'string', clientKey: 'string' }), schema: { ...idParams, body: messageBody } }, async (request, reply) => {
    const session = await team(request, reply, { write: true }); if (!session) return;
    const input = messageInput(request.body, reply); if (!input) return;
    const result = await repository.sendTeamMessage(session.user.id, session.token, request.params.id, input);
    if (!result) return missing(reply);
    return reply.code(result.created ? 201 : 200).send({ message: result.message });
  });
  for (const action of ['claim', 'release', 'close']) {
    app.post(`/api/chat/team/conversations/:id/${action}`, { preValidation: strictBody({}), schema: { ...idParams, body: emptyBody } }, async (request, reply) => {
      const session = await team(request, reply, { write: true }); if (!session) return;
      return await repository.changeChatConversation(session.user.id, session.token, request.params.id, action) || missing(reply);
    });
  }
}

module.exports = { registerChat };
