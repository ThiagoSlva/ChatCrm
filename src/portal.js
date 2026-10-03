'use strict';

const { digest, equal, secret, hashPassword, verifyPassword } = require('./security');

function registerPortal(app, repository, auth, visitorAuth) {
  const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const accessId = { type: 'string', pattern: '^[a-f0-9]{24}$' };
  const code = { type: 'string', pattern: '^[a-f0-9]{64}$' };
  const password = { type: 'string', minLength: 15, maxLength: 128 };
  const id = { type: 'integer', minimum: 1, maximum: 4294967295 };
  const empty = object({});
  const params = object({ id });
  const cookieName = auth.secure ? '__Host-cl_portal' : 'cl_portal';
  const cookie = (value, age) => cookieName + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + age + (auth.secure ? '; Secure' : '');
  const deny = (reply, status, error) => reply.code(status).send({ error });
  const token = request => {
    const raw = (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='));
    const value = raw?.slice(cookieName.length + 1);
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
  };
  const strict = properties => async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(properties).some(key => Object.hasOwn(body, key) && typeof body[key] !== properties[key])) return deny(reply, 400, 'Dados invalidos.');
  };
  const bodyRoute = properties => ({ preValidation: strict(Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value.type === 'integer' ? 'number' : value.type]))), schema: { body: object(properties), querystring: empty } });
  async function ready(reply) {
    if (!auth.origin || !repository?.capabilities || (await repository.capabilities()).portal !== true) { deny(reply, 503, 'O portal aguarda preparacao da instalacao.'); return false; }
    return true;
  }
  function origin(request, reply) {
    if (request.headers.origin !== auth.origin || !auth.origin) { deny(reply, 403, 'Origem nao autorizada.'); return false; }
    return true;
  }
  async function authorize(request, reply, write = false) {
    if (!await ready(reply) || (write && !origin(request, reply))) return null;
    const value = token(request);
    const account = value && await repository.portalSession(value);
    if (!account) { deny(reply, 401, 'Entre no portal para continuar.'); return null; }
    if (write && !equal(request.headers['x-csrf-token'], digest('portal-csrf:' + value))) { deny(reply, 403, 'Sessao invalida.'); return null; }
    return { token: value, account };
  }
  async function attempt(request, reply) {
    if (!auth.throttle(request, reply)) return false;
    if (!await repository.portalAttempt(digest('portal-auth:' + request.ip), request.body.accessId)) { deny(reply, 429, 'Muitas tentativas. Aguarde antes de tentar novamente.'); return false; }
    return true;
  }
  const failedAccess = reply => deny(reply, 401, 'Acesso ou credencial invalidos.');

  app.get('/api/portal/me', { schema: { querystring: empty } }, async (request, reply) => {
    const session = await authorize(request, reply); if (!session) return;
    return { account: session.account, csrfToken: digest('portal-csrf:' + session.token) };
  });
  app.post('/api/portal/register', bodyRoute({ accessId, password, confirmation: password, recoveryCode: code }), async (request, reply) => {
    if (!await ready(reply) || !origin(request, reply)) return;
    const existing = token(request);
    if (existing && await repository.portalSession(existing)) return deny(reply, 409, 'Saia do portal antes de criar outro acesso.');
    const visitor = await visitorAuth.visitor(request, reply, true); if (!visitor) return;
    if (request.body.password !== request.body.confirmation) return deny(reply, 400, 'As senhas devem ser iguais.');
    if (!await attempt(request, reply)) return;
    return auth.hashWork(async () => {
      const passwordHash = await hashPassword(request.body.password);
      const result = await repository.createPortalAccount(visitor.token, { accessId: request.body.accessId, passwordHash, recoveryHash: digest(request.body.recoveryCode) });
      reply.header('Set-Cookie', visitorAuth.visitorCookie('', 0));
      return reply.code(201).send(result);
    });
  });
  app.post('/api/portal/login', bodyRoute({ accessId, password }), async (request, reply) => {
    if (!await ready(reply) || !origin(request, reply)) return;
    const existing = token(request);
    if (existing && await repository.portalSession(existing)) return deny(reply, 409, 'Sua sessao do portal ja esta aberta.');
    if (!await attempt(request, reply)) return;
    return auth.hashWork(async () => {
      const account = await repository.findPortalAccount(request.body.accessId);
      const valid = account ? await verifyPassword(request.body.password, account.passwordHash) : (await hashPassword(request.body.password), false);
      if (!valid) return failedAccess(reply);
      const value = secret();
      if (!await repository.createPortalSession(value, account.id, account.passwordHash, account.version)) return failedAccess(reply);
      reply.header('Set-Cookie', cookie(value, 28800));
      return { authenticated: true };
    });
  });
  app.post('/api/portal/recover', bodyRoute({ accessId, recoveryCode: code, newPassword: password, confirmation: password, newRecoveryCode: code }), async (request, reply) => {
    if (!await ready(reply) || !origin(request, reply)) return;
    if (request.body.newPassword !== request.body.confirmation || request.body.recoveryCode === request.body.newRecoveryCode) return deny(reply, 400, 'Confirme a nova senha e prepare um novo codigo de recuperacao.');
    if (!await attempt(request, reply)) return;
    return auth.hashWork(async () => {
      const account = await repository.findPortalAccount(request.body.accessId);
      // Both known and unknown accounts incur bounded hashing work. No secret is returned.
      const passwordHash = await hashPassword(request.body.newPassword);
      const recoveryHash = digest(request.body.recoveryCode);
      if (!account || !equal(account.recoveryHash, recoveryHash)) return failedAccess(reply);
      if (await verifyPassword(request.body.newPassword, account.passwordHash)) return deny(reply, 400, 'Escolha uma senha diferente da atual.');
      if (!await repository.recoverPortalAccount(request.body.accessId, recoveryHash, account.version, passwordHash, digest(request.body.newRecoveryCode))) return failedAccess(reply);
      reply.header('Set-Cookie', [cookie('', 0), visitorAuth.visitorCookie('', 0)]);
      return { recovered: true, authenticated: false };
    });
  });
  app.post('/api/portal/logout', bodyRoute({}), async (request, reply) => {
    const session = await authorize(request, reply, true); if (!session) return;
    await repository.revokePortalSession(session.token);
    reply.header('Set-Cookie', cookie('', 0));
    return { authenticated: false };
  });
  app.get('/api/portal/conversations', { schema: { querystring: empty } }, async (request, reply) => {
    const session = await authorize(request, reply); if (!session) return;
    return repository.listPortalConversations(session.token);
  });
  app.post('/api/portal/conversations', bodyRoute({ departmentId: id }), async (request, reply) => {
    const session = await authorize(request, reply, true); if (!session) return;
    const result = await repository.createPortalConversation(session.token, request.body.departmentId);
    return reply.code(result.created ? 201 : 200).send({ conversation: result.conversation });
  });
  const historyQuery = { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0, maximum: 4294967295, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 } } };
  app.get('/api/portal/conversations/:id/messages', { preValidation: async (request, reply) => {
    if (['after', 'limit'].some(key => Object.hasOwn(request.query, key) && typeof request.query[key] !== 'string')) return deny(reply, 400, 'Paginacao invalida.');
  }, schema: { params, querystring: historyQuery } }, async (request, reply) => {
    const session = await authorize(request, reply); if (!session) return;
    return await repository.portalMessages(session.token, request.params.id, request.query.after, request.query.limit) || deny(reply, 404, 'Atendimento indisponivel.');
  });
  const messageRoute = bodyRoute({ text: { type: 'string', minLength: 1, maxLength: 4000, pattern: '^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+$' }, clientKey: { type: 'string', pattern: '^[a-f0-9]{32}$' } });
  app.post('/api/portal/conversations/:id/messages', { ...messageRoute, schema: { ...messageRoute.schema, params } }, async (request, reply) => {
    const session = await authorize(request, reply, true); if (!session) return;
    const text = request.body.text.trim();
    if (!text || text.length > 2000) return deny(reply, 400, 'Escreva uma mensagem com 1 a 2000 caracteres.');
    const result = await repository.sendPortalMessage(session.token, request.params.id, { text, clientKey: request.body.clientKey });
    if (!result) return deny(reply, 404, 'Atendimento indisponivel.');
    return reply.code(result.created ? 201 : 200).send({ message: result.message });
  });
  return { authorize };
}

module.exports = { registerPortal };
