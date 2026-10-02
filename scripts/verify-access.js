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
  assert.equal((await request('/api/auth/password', 'POST', { currentPassword: 'anonymous-verification-password', newPassword: 'new-anonymous-verification-password', confirmation: 'new-anonymous-verification-password' })).response.status, 401);
  checks.push('anonymous-password-change-denied');
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
    const capabilities = profile.data.capabilities;
    assert.equal([1, 2, 3].includes(capabilities?.schemaVersion), true);
    assert.equal(capabilities.departments, capabilities.schemaVersion >= 2);
    if (capabilities.schemaVersion === 3) assert.equal(capabilities.chat, true);
    else assert.equal(capabilities.chat === undefined || capabilities.chat === false, true);
    checks.push('capabilities');
    const team = await request('/api/team/operators?limit=20', 'GET', null, { Cookie: cookie });
    if (profile.data.user.role === 'admin') {
      assert.equal(team.response.status, 200);
      assert.equal(Array.isArray(team.data.users), true);
      assert.equal(team.data.users.every(user => user.role === 'operator' && !user.password_hash && !user.passwordHash), true);
      checks.push('team-admin-read');
      // This route never changes administrators, even with valid CSRF.
      const protectedAdmin = await request('/api/team/operators/' + profile.data.user.id, 'PATCH', { active: false }, { Origin: url.origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken });
      assert.equal(protectedAdmin.response.status, 404);
      checks.push('team-admin-protected');
      if (capabilities.departments) {
        const departments = await request('/api/team/departments?page=1&limit=20', 'GET', null, { Cookie: cookie });
        assert.equal(departments.response.status, 200);
        assert.equal(Array.isArray(departments.data.departments), true);
        assert.equal(Number.isInteger(departments.data.total) && departments.data.total >= 0 && departments.data.total <= 50, true);
        assert.equal(departments.data.page, 1); assert.equal(departments.data.limit, 20);
        assert.equal(departments.data.departments.length <= Math.min(20, departments.data.total), true);
        const ids = new Set();
        for (const department of departments.data.departments) {
          assert.deepEqual(Object.keys(department).sort(), ['active', 'id', 'name']);
          assert.equal(Number.isInteger(department.id) && department.id >= 1 && department.id <= 4294967295, true);
          assert.equal(ids.has(department.id), false); ids.add(department.id);
          assert.equal(typeof department.name, 'string');
          assert.equal(department.name.length >= 2 && department.name.length <= 100 && department.name === department.name.trim(), true);
          assert.equal(/[\u0000-\u001f\u007f]/.test(department.name), false);
          assert.equal(typeof department.active, 'boolean');
        }
        checks.push('departments-admin-read');
      }
      if (capabilities.chat) {
        const channels = await request('/api/chat/public/departments', 'GET');
        assert.equal(channels.response.status, 200); assert.equal(Array.isArray(channels.data.departments), true);
        assert.equal(channels.data.departments.length <= 50, true);
        for (const channel of channels.data.departments) {
          assert.deepEqual(Object.keys(channel).sort(), ['id', 'name']);
          assert.equal(Number.isInteger(channel.id) && channel.id > 0 && channel.id <= 4294967295, true);
          assert.equal(typeof channel.name, 'string');
        }
        checks.push('chat-public-channels-safe');
        assert.equal((await request('/api/chat/visitor/me', 'GET')).response.status, 401);
        checks.push('chat-visitor-anonymous-denied');
        assert.equal((await request('/api/chat/visitor/session', 'POST', { name: 'Pessoa de teste' }, { Origin: 'https://foreign.example.test', 'Content-Type': 'application/json' })).response.status, 403);
        checks.push('chat-visitor-foreign-origin-denied');
        const inbox = await request('/api/chat/team/conversations?page=1&limit=20', 'GET', null, { Cookie: cookie });
        assert.equal(inbox.response.status, 200); assert.equal(Array.isArray(inbox.data.conversations), true);
        assert.equal(inbox.data.page, 1); assert.equal(inbox.data.limit, 20);
        assert.equal(Number.isInteger(inbox.data.total) && inbox.data.total >= 0 && inbox.data.total <= 5000, true);
        assert.equal(inbox.data.conversations.length <= 20, true);
        for (const conversation of inbox.data.conversations) assert.deepEqual(Object.keys(conversation).sort(), ['assignedTo', 'departmentId', 'departmentName', 'id', 'status', 'updatedAt', 'visitorName']);
        checks.push('chat-team-admin-read');
        const filtered = await request('/api/chat/team/conversations?page=1&limit=20&status=active&assignment=me&q=Verification%25_!%5C', 'GET', null, { Cookie: cookie });
        assert.equal(filtered.response.status, 200);
        assert.equal(Array.isArray(filtered.data.conversations), true);
        assert.equal(Number.isInteger(filtered.data.total) && filtered.data.total >= 0, true);
        assert.equal(filtered.data.page, 1); assert.equal(filtered.data.limit, 20);
        for (const conversation of filtered.data.conversations) {
          assert.equal(['waiting', 'open'].includes(conversation.status), true);
          assert.equal(conversation.assignedTo, profile.data.user.id);
        }
        checks.push('chat-filters-https-read');
        for (const query of ['status=invalid', 'assignment=invalid', 'status=open&status=closed', 'q=a&q=b', 'q=%00', 'extra=1']) {
          assert.equal((await request('/api/chat/team/conversations?' + query, 'GET', null, { Cookie: cookie })).response.status, 400);
        }
        checks.push('chat-filters-invalid-denied');
        assert.equal((await request('/api/chat/team/conversations/4294967295', 'GET')).response.status, 401);
        checks.push('chat-detail-anonymous-denied');
        if (inbox.data.conversations.length) {
          const detail = await request('/api/chat/team/conversations/' + inbox.data.conversations[0].id, 'GET', null, { Cookie: cookie });
          assert.equal(detail.response.status, 200);
          assert.deepEqual(Object.keys(detail.data.conversation).sort(), ['assignedTo', 'departmentId', 'departmentName', 'id', 'status', 'updatedAt', 'visitorName']);
          assert.equal(detail.data.conversation.id, inbox.data.conversations[0].id);
          checks.push('chat-detail-authorized-read');
        } else {
          assert.equal((await request('/api/chat/team/conversations/4294967295', 'GET', null, { Cookie: cookie })).response.status, 404);
          checks.push('chat-detail-absent-denied');
        }
      }
    } else { assert.equal(team.response.status, 403); checks.push('team-operator-denied'); }
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
