'use strict';
// Shared by the opt-in hosted verifier and route-level regression tests.
const assert = require('node:assert/strict');
const { digest, secret } = require('../src/security');
const { NOTICE_VERSION } = require('../src/subscriptions-database');

function httpsClient(origin, transport = fetch) {
  const base = new URL(origin);
  assert.equal(base.protocol, 'https:'); assert.equal(base.origin, origin);
  return async (route, { token, portal = false, method = 'GET', body, headers = {} } = {}) => {
    const url = new URL(route, origin);
    assert.equal(url.origin, origin); assert(route.startsWith('/api/') || route === '/health');
    assert(['GET', 'POST'].includes(method));
    const requestHeaders = { ...headers };
    if (token) {
      assert.match(token, /^[a-f0-9]{64}$/);
      requestHeaders.cookie = (portal ? '__Host-cl_portal=' : '__Host-cl_session=') + token;
      if (method === 'POST') requestHeaders['x-csrf-token'] = digest((portal ? 'portal-csrf:' : 'csrf:') + token);
    }
    if (method === 'POST') { requestHeaders.origin = origin; requestHeaders['content-type'] = 'application/json'; }
    Object.assign(requestHeaders, headers);
    const response = await transport(url.href, { method, headers: requestHeaders, redirect: 'error',
      signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // Stream with a hard cap; Content-Length is not trusted.
    const reader = response.body.getReader(); let length = 0; const chunks = [];
    try {
      for (;;) { const item = await reader.read(); if (item.done) break;
        length += item.value.length; assert(length <= 32768); chunks.push(Buffer.from(item.value)); }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return { status: response.status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  };
}

async function verifyFlow({ request, staff, portal, suffix, record, ownQueue, disableAccount }) {
  assert.equal(staff.length, 2); assert.equal(portal.length, 53); assert.match(suffix, /^[a-f0-9]{32}$/);
  const checks = [], key = () => secret().slice(0, 32);
  const call = async (route, options, status = 200) => {
    const result = await request(route, options); assert.equal(result.status, status, 'Unexpected status for ' + route); return result.data;
  };
  const admin = { token: staff[0] }, operator = { token: staff[1] };
  const customer = i => ({ token: portal[i], portal: true });
  const post = (options, body) => ({ ...options, method: 'POST', body });
  const choice = async (i, subscribed, version) => {
    const body = { subscribed, version, noticeVersion: NOTICE_VERSION, clientKey: key() };
    await record({ kind: 'choice', index: i, body });
    const result = await call('/api/portal/subscription', post(customer(i), body));
    assert.equal(result.preference.version, version + 1); assert.equal(result.preference.subscribed, subscribed);
    return body;
  };
  await call('/api/campaigns', {}, 401); await call('/api/campaigns', operator, 403);
  const content = { title: 'Ensaio HTTPS ' + suffix, text: 'Somente dados ficticios. Texto literal <b>teste</b>.' };
  await call('/api/campaigns/preview', post(operator, content), 403);
  await call('/api/campaigns/preview', { ...post(admin, content), headers: { origin: 'https://foreign.example.test' } }, 403);
  await call('/api/campaigns/preview', { ...post(admin, content), headers: { 'x-csrf-token': 'invalid' } }, 403);
  await call('/api/campaigns/preview', post(admin, { ...content, recipients: [1] }), 400);
  assert.equal((await call('/api/portal/subscription', customer(0))).preference.subscribed, false);
  for (let i = 0; i < portal.length; i++) await choice(i, true, 0);
  checks.push('authenticated-admin-operator-origin-csrf-explicit-consent');
  const create = async (title, count) => {
    const preview = await call('/api/campaigns/preview', post(admin, { ...content, title }));
    assert.equal(preview.recipientCount, count);
    const body = { title: preview.title, text: preview.text, audienceHash: preview.audienceHash, clientKey: key() };
    // Persist intent before POST: a lost response can still be identified safely.
    await record({ kind: 'campaign', body });
    const result = await call('/api/campaigns', post(admin, body), 201);
    assert.equal(result.created, true); assert.equal(result.campaign.total, count);
    await ownQueue(result.campaign.id);
    assert.equal((await call('/api/campaigns/request/' + body.clientKey, admin)).campaign.id, result.campaign.id);
    const replay = await call('/api/campaigns', post(admin, body));
    assert.equal(replay.created, false); assert.equal(replay.campaign.id, result.campaign.id);
    await call('/api/campaigns', post(admin, { ...body, text: body.text + ' alterado' }), 409);
    return result.campaign.id;
  };
  const first = await create(content.title, 53);
  await choice(0, false, 1); await choice(0, true, 2); await disableAccount(1);
  await call('/api/portal/news', customer(1), 401);
  const batchKey = key(); await record({ kind: 'batch', campaignId: first, key: batchKey });
  await ownQueue(first);
  const batch = await call('/api/campaigns/' + first + '/process', post(admin, { clientKey: batchKey }));
  assert.deepEqual([batch.batch.delivered, batch.batch.skipped, batch.batch.remaining], [48, 2, 3]);
  const replay = await call('/api/campaigns/' + first + '/process', post(admin, { clientKey: batchKey }));
  assert.equal(replay.replayed, true); assert.equal(replay.campaign.counts.delivered, 48); assert.equal(replay.campaign.counts.pending, 3);
  checks.push('immutable-consent-recheck-revoked-account-batch50-exact-replay');
  assert.equal((await call('/api/portal/news', customer(0))).news.length, 0);
  assert.equal((await call('/api/portal/news', customer(52))).news.length, 0);
  await call('/api/portal/news/' + first + '/read', post(customer(52), {}), 404);
  await call('/api/portal/news/' + first + '/read', post(customer(0), {}), 404);
  await call('/api/portal/news', {}, 401);
  await call('/api/portal/news/' + first + '/read', { ...post(customer(2), {}), headers: { origin: 'https://foreign.example.test' } }, 403);
  await call('/api/portal/news/' + first + '/read', { ...post(customer(2), {}), headers: { 'x-csrf-token': 'invalid' } }, 403);
  const news = await call('/api/portal/news', customer(2)); assert.equal(news.news.length, 1); assert.equal(news.news[0].text, content.text);
  await call('/api/portal/news/' + first + '/read', post(customer(2), {}));
  const readAt = (await call('/api/portal/news', customer(2))).news[0].readAt; assert(readAt);
  await call('/api/portal/news/' + first + '/read', post(customer(2), {}));
  assert.equal((await call('/api/portal/news', customer(2))).news[0].readAt, readAt);
  await choice(2, false, 1); assert.equal((await call('/api/portal/news', customer(2))).news.length, 1);
  const cancelled = await call('/api/campaigns/' + first + '/cancel', post(admin, {}));
  assert.equal(cancelled.campaign.counts.cancelled, 3); assert.equal(cancelled.campaign.counts.delivered, 48);
  assert.equal((await call('/api/campaigns/' + first + '/process', post(admin, { clientKey: batchKey }))).replayed, true);
  await call('/api/campaigns/' + first + '/process', post(admin, { clientKey: key() }), 409);
  const second = await create('Cancelamento HTTPS ' + suffix, 51);
  const secondCancelled = await call('/api/campaigns/' + second + '/cancel', post(admin, {}));
  assert.equal(secondCancelled.campaign.counts.cancelled, 51); assert.equal(secondCancelled.campaign.counts.delivered, 0);
  await call('/api/portal/news/' + second + '/read', post(customer(2), {}), 404);
  assert.equal((await call('/api/portal/news', customer(2))).news.length, 1);
  const list = await call('/api/campaigns', admin); assert.equal(list.total, 2); assert(list.campaigns.every(c => !Object.hasOwn(c, 'text')));
  await call('/api/auth/logout', post(admin, {})); await call('/api/campaigns', admin, 401);
  checks.push('own-news-idempotent-read-withdrawal-preserves-history-cancel-session-revocation');
  return checks;
}
module.exports = { httpsClient, verifyFlow };
