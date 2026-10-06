'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { verifyAccess } = require('../scripts/verify-access');
const origin = 'https://recovery.example.test', token = 'a'.repeat(64), password = 'synthetic-access-verification-password';
function fixture(t, version, change = () => {}) {
  let active = false, logoutCount = 0;
  const calls = [], capabilities = { schemaVersion: version, departments: version >= 2,
    chat: version >= 3, contacts: version >= 4, opportunities: version >= 5,
    conversationContacts: version >= 6, portal: version >= 7, subscriptions: version >= 8, campaigns: version >= 9 };
  change(capabilities);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url), route = u.pathname, method = options.method, headers = options.headers;
    assert.equal(u.origin, origin); calls.push({ route, method });
    const reply = (status, data = {}, extra = {}) => ({ status, json: async () => data, headers: new Headers(extra) });
    const authenticated = active && headers.Cookie === '__Host-cl_session=' + token;
    if (route === '/api/installation') return reply(200, { state: 'installed' });
    if (route === '/api/auth/password') return reply(401);
    if (route === '/api/auth/login') {
      if (headers.Origin !== origin) return reply(403);
      if (JSON.parse(options.body).password !== password) return reply(401);
      active = true;
      return reply(200, {}, { 'set-cookie': '__Host-cl_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure' });
    }
    if (route === '/api/auth/me') return authenticated ? reply(200, { user: { id: 1, role: 'operator', email: 'operator@example.test' }, csrfToken: 'csrf-fixture', capabilities }) : reply(401);
    if (route === '/api/auth/logout') {
      if (!authenticated || headers['X-CSRF-Token'] !== 'csrf-fixture') return reply(403);
      active = false; logoutCount++; return reply(200, {}, { 'set-cookie': '__Host-cl_session=; Max-Age=0' });
    }
    if (route === '/api/team/operators') return reply(403);
    if (route === '/api/campaigns') return reply(authenticated ? 403 : 401);
    if (route === '/api/portal/subscription') return reply(version >= 8 ? 401 : 503);
    if (route.startsWith('/api/portal/')) return reply(version >= 7 ? 401 : 503);
    throw Error('Unexpected verification route');
  });
  return { calls, active: () => active, logoutCount: () => logoutCount };
}
test('manual access verification accepts current schema9, reads role restrictions and always logs out', async t => {
  const f = fixture(t, 9);
  const result = await verifyAccess(origin + '/', { email: 'operator@example.test', password });
  assert(result.checks.includes('campaigns-current-role-read'));
  assert(result.checks.includes('subscriptions-and-news-anonymous-or-unprepared-denied'));
  assert(result.checks.includes('logout-revokes-session'));
  assert.equal(f.active(), false); assert.equal(f.logoutCount(), 1);
  assert(f.calls.some(c => c.route === '/api/campaigns' && c.method === 'GET'));
  assert(f.calls.every(c => c.method === 'GET' || ['/api/auth/login','/api/auth/password','/api/auth/logout'].includes(c.route)));
});
test('legacy schemas still verify while newer modules report preparation pending', async t => {
  for (const version of [1, 6, 7, 8]) {
    const f = fixture(t, version);
    const result = await verifyAccess(origin + '/', { email: 'operator@example.test', password });
    assert(result.checks.includes('capabilities')); assert.equal(f.logoutCount(), 1);
    assert(!f.calls.some(c => c.route === '/api/campaigns'));
    t.mock.restoreAll();
  }
});
test('unknown schemas and inconsistent module flags fail and revoke the temporary login', async t => {
  for (const change of [c => c.schemaVersion = 10, c => c.schemaVersion = '9', c => c.campaigns = false,
    c => c.subscriptions = false, c => c.portal = false, c => c.conversationContacts = false]) {
    const f = fixture(t, 9, change);
    await assert.rejects(verifyAccess(origin + '/', { email: 'operator@example.test', password }));
    assert.equal(f.active(), false); assert.equal(f.logoutCount(), 1);
    assert(!f.calls.some(c => c.route === '/api/campaigns'));
    t.mock.restoreAll();
  }
});
