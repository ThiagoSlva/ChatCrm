'use strict';

// Explicit HTTPS integration check; never included in npm test or deployment cron.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { loadEnvironment } = require('../src/server');

async function verifyAccess(origin, credentials) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin + '/' !== url.href || url.username || url.password) throw new Error('Configure a origem HTTPS exata.');
  if (typeof credentials.email !== 'string' || typeof credentials.password !== 'string' || credentials.password.length < 15) throw new Error('Credencial privada invalida.');
  const checks = [];
  async function request(route, method = 'GET', body, headers = {}) {
    const response = await fetch(new URL(route, url), { method, redirect: 'error', headers: {
      ...(method === 'POST' ? { Origin: url.origin, 'Content-Type': 'application/json' } : {}), ...headers
    }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    return { response, data: await response.json() };
  }
  const installation = await request('/api/installation');
  assert.equal(installation.response.status, 200);
  assert.equal(installation.data.state, 'installed');
  checks.push('installation-complete');
  assert.equal((await request('/api/auth/me')).response.status, 401);
  checks.push('anonymous-denied');
  const payload = { email: credentials.email, password: credentials.password };
  assert.equal((await request('/api/auth/login', 'POST', payload, { Origin: 'https://unauthorized.example.test' })).response.status, 403);
  checks.push('foreign-origin-denied');
  const wrongPassword = credentials.password === 'incorrect-test-password-for-verification' ? 'another-incorrect-test-password' : 'incorrect-test-password-for-verification';
  assert.equal((await request('/api/auth/login', 'POST', { ...payload, password: wrongPassword })).response.status, 401);
  checks.push('incorrect-password-denied');
  const login = await request('/api/auth/login', 'POST', payload);
  assert.equal(login.response.status, 200);
  const setCookie = login.response.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-cl_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  checks.push('https-login', 'secure-cookie');
  const cookie = setCookie.split(';')[0];
  let csrfToken;
  let revoked = false;
  try {
    const profile = await request('/api/auth/me', 'GET', null, { Cookie: cookie });
    csrfToken = profile.data.csrfToken;
    assert.equal(profile.response.status, 200);
    assert.equal(profile.data.user.email, credentials.email.toLowerCase());
    assert.equal(profile.data.user.passwordHash, undefined);
    assert.equal(profile.data.user.password_hash, undefined);
    checks.push('authenticated-profile');
    assert.equal((await request('/api/auth/logout', 'POST', {}, { Cookie: cookie })).response.status, 403);
    checks.push('csrf-required');
    const logout = await request('/api/auth/logout', 'POST', {}, { Cookie: cookie, 'X-CSRF-Token': csrfToken });
    assert.equal(logout.response.status, 200);
    revoked = true;
    assert.match(logout.response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request('/api/auth/me', 'GET', null, { Cookie: cookie })).response.status, 401);
    checks.push('logout-revokes-session');
    return { origin: url.origin, verifiedAt: new Date().toISOString(), checks };
  } finally {
    if (!revoked && csrfToken) await request('/api/auth/logout', 'POST', {}, { Cookie: cookie, 'X-CSRF-Token': csrfToken }).catch(() => {});
  }
}

async function main() {
  loadEnvironment();
  if (!process.argv[2]) throw new Error('Informe o arquivo privado de credenciais.');
  const credentials = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const result = await verifyAccess(process.env.APP_URL, credentials);
  process.stdout.write('Acesso HTTPS verificado: ' + JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch(() => { process.stderr.write('Verificacao HTTPS do acesso falhou. Confira instalacao, URL e arquivo privado, sem divulgar credenciais.\n'); process.exitCode = 1; });
module.exports = { verifyAccess };
