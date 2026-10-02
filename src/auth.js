'use strict';

const { equal, digest, secret, hashPassword, verifyPassword } = require('./security');

function registerAuth(app, repository, env = process.env) {
  let origin = null;
  try {
    const parsed = new URL(env.APP_URL);
    if (parsed.pathname === '/' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      (parsed.protocol === 'https:' || (env.NODE_ENV !== 'production' && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))) origin = parsed.origin;
  } catch { /* Installation stays locked until its public URL is configured. */ }
  const secure = origin?.startsWith('https:');
  const cookieName = secure ? '__Host-cl_session' : 'cl_session';
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const readToken = request => {
    const raw = (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='));
    const value = raw?.slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
  };
  const attempts = new Map();
  let activeHashes = 0;
  function deny(reply, code, error) { return reply.code(code).send({ error }); }
  function allowed(request, reply) {
    if (!origin || !repository) { deny(reply, 503, 'Configure a URL, o banco privado e execute a migracao.'); return false; }
    if (request.headers.origin !== origin) { deny(reply, 403, 'Origem nao autorizada.'); return false; }
    return true;
  }
  function throttle(request, reply) {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
    // Bound memory even if many addresses are supplied; request.ip never trusts proxy headers.
    if (!attempts.has(request.ip) && attempts.size >= 1000) { deny(reply, 429, 'Tente novamente mais tarde.'); return false; }
    const entry = attempts.get(request.ip) || { count: 0, until: now + 15 * 60 * 1000 };
    attempts.set(request.ip, entry);
    if (++entry.count > 10 || activeHashes >= 2) { deny(reply, 429, 'Muitas tentativas. Aguarde e tente novamente.'); return false; }
    return true;
  }
  async function authorize(request, reply, { admin = false, write = false } = {}) {
    if (write && !allowed(request, reply)) return null;
    const token = readToken(request);
    const user = repository && token && await repository.session(token);
    if (!user) { deny(reply, 401, 'Entre para acessar o painel.'); return null; }
    if (admin && user.role !== 'admin') { deny(reply, 403, 'Somente administradores podem gerenciar a equipe.'); return null; }
    if (write && !equal(request.headers['x-csrf-token'], digest('csrf:' + token))) { deny(reply, 403, 'Sessao invalida.'); return null; }
    return user;
  }
  async function hashWork(work) {
    activeHashes++;
    try { return await work(); } finally { activeHashes--; }
  }
  const schema = { body: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: {
    email: { type: 'string', minLength: 3, maxLength: 254, pattern: '^[A-Za-z0-9.!#$%&\u0027*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$' },
    password: { type: 'string', minLength: 15, maxLength: 256 }
  } } };
  const setupSchema = { body: { ...schema.body, required: ['email', 'password', 'name', 'company', 'setupToken'], properties: { ...schema.body.properties,
    name: { type: 'string', minLength: 2, maxLength: 100, pattern: '\\S' }, company: { type: 'string', minLength: 2, maxLength: 120, pattern: '\\S' }, setupToken: { type: 'string', minLength: 32, maxLength: 256 } } } };

  app.get('/api/installation', async (request, reply) => {
    if (!repository || !origin) return { state: 'configuration-required' };
    try { const state = await repository.status(); return { state: state === 'setup' && (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 32) ? 'configuration-required' : state }; }
    catch { return reply.code(503).send({ state: 'database-unavailable' }); }
  });
  app.post('/api/install', { schema: setupSchema }, async (request, reply) => {
    if (!allowed(request, reply) || !throttle(request, reply)) return;
    if (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 32 || !equal(request.body.setupToken, env.SETUP_TOKEN)) return deny(reply, 403, 'Segredo de instalacao invalido.');
    if (await repository.status() !== 'setup') return deny(reply, 409, 'Instalacao ja concluida.');
    activeHashes++;
    try {
      const passwordHash = await hashPassword(request.body.password);
      await repository.install({ company: request.body.company.trim(), name: request.body.name.trim(), email: request.body.email.toLowerCase(), passwordHash });
      return reply.code(201).send({ installed: true });
    } finally { activeHashes--; }
  });
  app.post('/api/auth/login', { schema }, async (request, reply) => {
    if (!allowed(request, reply) || !throttle(request, reply)) return;
    activeHashes++;
    try {
      const user = await repository.findUser(request.body.email.toLowerCase());
      const verifiedHash = user?.passwordHash;
      // Unknown accounts still incur password hashing work, and return the same message.
      const valid = user ? await verifyPassword(request.body.password, verifiedHash) : (await hashPassword(request.body.password), false);
      if (!valid) return deny(reply, 401, 'E-mail ou senha incorretos.');
      const token = secret();
      if (await repository.createSession(token, user.id, verifiedHash) === false) return deny(reply, 401, 'E-mail ou senha incorretos.');
      reply.header('Set-Cookie', cookie(token, 28800));
      return { authenticated: true };
    } finally { activeHashes--; }
  });
  app.get('/api/auth/me', async (request, reply) => {
    const token = readToken(request);
    const user = repository && token && await repository.session(token);
    if (!user) return deny(reply, 401, 'Entre para acessar o painel.');
    return { user, company: await repository.company(), csrfToken: digest('csrf:' + token),
      capabilities: repository.capabilities ? await repository.capabilities() : { departments: false } };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    if (!allowed(request, reply)) return;
    const token = readToken(request);
    if (!token || !equal(request.headers['x-csrf-token'], digest('csrf:' + token))) return deny(reply, 403, 'Sessao invalida.');
    await repository.revoke(token);
    reply.header('Set-Cookie', cookie('', 0));
    return { authenticated: false };
  });
  app.post('/api/auth/password', { schema: { body: { type: 'object', additionalProperties: false,
    required: ['currentPassword', 'newPassword', 'confirmation'], properties: {
      currentPassword: schema.body.properties.password, newPassword: schema.body.properties.password, confirmation: schema.body.properties.password
    } } } }, async (request, reply) => {
    const user = await authorize(request, reply, { write: true });
    if (!user || !throttle(request, reply)) return;
    const { currentPassword, newPassword, confirmation } = request.body;
    if (newPassword !== confirmation) return deny(reply, 400, 'A confirmacao deve ser igual a nova senha.');
    if (newPassword === currentPassword) return deny(reply, 400, 'Escolha uma senha diferente da atual.');
    return hashWork(async () => {
      const identity = await repository.findUser(user.email);
      const verifiedHash = identity?.passwordHash;
      if (!identity || identity.id !== user.id || !await verifyPassword(currentPassword, verifiedHash)) return deny(reply, 400, 'Senha atual incorreta.');
      const passwordHash = await hashPassword(newPassword);
      if (!await repository.changePassword(user.id, verifiedHash, passwordHash, readToken(request))) return deny(reply, 409, 'O acesso mudou durante a operacao. Entre novamente.');
      reply.header('Set-Cookie', cookie('', 0));
      return { passwordChanged: true, authenticated: false };
    });
  });
  return { authorize, throttle, hashWork, identityProperties: schema.body.properties };
}

module.exports = { registerAuth };
