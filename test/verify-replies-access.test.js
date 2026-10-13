'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');
const { verifyRepliesAccess } = require('../scripts/verify-replies-access');
const token = 'c'.repeat(64), cookie = '__Host-cl_session=' + token;
const original = { id: 3, departmentId: null, departmentName: null, title: 'Orientação fictícia', text: 'Texto privado fictício {{visitante}}', active: true, version: 1 };

function fixture(t, { role = 'admin', schemaVersion = 10, owned = false, available = [original], change = x => x, denied = null } = {}) {
  const user = { id: 7, role }, capabilities = { schemaVersion, replies: schemaVersion >= 10, chat: true };
  const calls = [];
  const repo = {
    close: async () => {}, session: async x => x === token ? user : null, capabilities: async () => capabilities,
    listReplyTemplates: async (_id, _token, page, limit, q) => ({ templates: q ? [] : [original], total: q ? 0 : 1, page, limit }),
    findReplyTemplate: async () => ({ ...original, text: 'Edição fictícia posterior à lista', version: 2 }),
    listChatConversations: async () => ({ conversations: owned ? [{ id: 11, departmentId: 5, assignedTo: 7, status: 'open' }] : [], total: owned ? 1 : 0, page: 1, limit: 20 }),
    listConversationReplies: async () => {
      if (denied) throw Object.assign(Error(), { statusCode: denied });
      return { templates: available, total: available.length, page: 1, limit: 20 };
    },
    findConversationReply: async () => ({ template: available[0] })
  };
  const app = buildServer({ repository: repo, env: { APP_URL: 'https://verify.example.test', NODE_ENV: 'production' } });
  t.after(() => app.close());
  const request = async (route, method = 'GET', body, headers = {}) => {
    calls.push({ route, method, body });
    const r = await app.inject({ url: route, method, headers });
    return change({ response: { status: r.statusCode, headers: new Headers(r.headers) }, data: r.json() }, route);
  };
  return { request, profile: { user, capabilities }, calls };
}

test('manual verifier exercises real HTTP routing, newer detail versions and explicit empty coverage without writes', async t => {
  const f = fixture(t);
  const checks = await verifyRepliesAccess(f.request, cookie, f.profile);
  assert(checks.includes('replies-admin-authorized-detail'));
  assert(checks.includes('replies-invalid-filters-denied'));
  assert(checks.includes('replies-owned-conversation-check-pending-no-fixtures'));
  assert(f.calls.every(x => x.method === 'GET' && x.body == null));
  assert(!JSON.stringify(checks).includes(original.text));
});

test('schema9 preparation and operator administration denial are checked through actual endpoints', async t => {
  for (const role of ['admin', 'operator']) {
    const f = fixture(t, { role, schemaVersion: 9 });
    const checks = await verifyRepliesAccess(f.request, cookie, f.profile);
    assert(checks.includes(role === 'admin' ? 'replies-explicit-preparation-pending' : 'replies-administration-operator-denied'));
    assert(!f.calls.some(x => x.route.startsWith('/api/chat/')));
  }
});

test('operator checks active global and own-area models without administration or mutation', async t => {
  const scoped = { ...original, departmentId: 5, departmentName: 'Área fictícia' };
  const f = fixture(t, { role: 'operator', owned: true, available: [scoped] });
  const checks = await verifyRepliesAccess(f.request, cookie, f.profile);
  assert(checks.includes('replies-owned-conversation-active-scope-read'));
  assert(checks.includes('replies-owned-conversation-authorized-detail'));
  assert(f.calls.every(x => x.method === 'GET'));
});

test('scope leaks, inactive models and unexpected private fields fail with a generic error', async t => {
  for (const row of [
    { ...original, departmentId: 6, departmentName: 'Área alheia' },
    { ...original, active: false },
    { ...original, requestHash: 'do-not-report-private-field' }
  ]) {
    const f = fixture(t, { role: 'operator', owned: true, available: [row] });
    await assert.rejects(verifyRepliesAccess(f.request, cookie, f.profile), e =>
      e.message === 'A verificacao privada dos modelos nao foi confirmada.' && !e.message.includes(row.text));
    assert(f.calls.some(x => x.route === '/api/chat/team/conversations/11/replies?page=1&limit=20'));
  }
});

test('missing no-store and incoherent pagination fail instead of reporting readiness', async t => {
  for (const change of [
    (x, route) => { if (route.startsWith('/api/replies/')) x.response.headers.delete('cache-control'); return x; },
    (x, route) => { if (route.includes('templates?page=1') && x.response.status === 200) x.data.total = 2; return x; }
  ]) {
    const f = fixture(t, { change });
    await assert.rejects(verifyRepliesAccess(f.request, cookie, f.profile), /nao foi confirmada/);
  }
});

test('permission change between inbox and catalogue reads is an explicit denial, without fake records', async t => {
  const f = fixture(t, { role: 'operator', owned: true, denied: 404 });
  const checks = await verifyRepliesAccess(f.request, cookie, f.profile);
  assert(checks.includes('replies-conversation-access-changed-denied'));
  assert(!checks.includes('replies-owned-conversation-authorized-detail'));
  assert(f.calls.every(x => x.method === 'GET'));
});

test('empty owned catalogue and unavailable detail report limited coverage instead of inventing fixtures', async t => {
  const empty = fixture(t, { role: 'operator', owned: true, available: [] });
  const checks = await verifyRepliesAccess(empty.request, cookie, empty.profile);
  assert(checks.includes('replies-conversation-detail-check-pending-empty-catalogue'));
  assert(!empty.calls.some(x => x.route.endsWith('/replies/3')));
  const changed = fixture(t, { role: 'operator', owned: true, change: (x, route) => {
    if (route.endsWith('/replies/3')) x.response.status = 404;
    return x;
  } });
  assert((await verifyRepliesAccess(changed.request, cookie, changed.profile)).includes('replies-template-or-conversation-access-changed-denied'));
});
