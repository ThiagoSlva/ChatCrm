'use strict';

// Manual HTTPS verification only. Never creates templates or sends a message.
const { normalizeReply } = require('../src/reply-input');
const fail = () => { throw new Error('A verificacao privada dos modelos nao foi confirmada.'); };
const requireCheck = value => { if (!value) fail(); };
const uint = value => Number.isInteger(value) && value >= 1 && value <= 4294967295;
const fields = ['active', 'departmentId', 'departmentName', 'id', 'text', 'title', 'version'];

function template(value) {
  requireCheck(value && typeof value === 'object' && !Array.isArray(value));
  requireCheck(Object.keys(value).sort().join(',') === fields.join(','));
  requireCheck(uint(value.id) && uint(value.version));
  requireCheck(value.departmentId === null ? value.departmentName === null :
    uint(value.departmentId) && typeof value.departmentName === 'string' &&
    value.departmentName.length >= 2 && value.departmentName.length <= 100);
  let normalized;
  try { normalized = normalizeReply({ departmentId: value.departmentId, title: value.title, text: value.text, active: value.active }); }
  catch { fail(); }
  requireCheck(['departmentId', 'title', 'text', 'active'].every(key => normalized[key] === value[key]));
}

function noStore(result) {
  const directives = (result.response.headers.get('cache-control') || '').toLowerCase().split(',').map(x => x.trim());
  requireCheck(directives.includes('no-store'));
}

function list(result, departmentId) {
  requireCheck(result.response.status === 200);
  noStore(result);
  const data = result.data;
  requireCheck(data && Object.keys(data).sort().join(',') === 'limit,page,templates,total');
  requireCheck(data.page === 1 && data.limit === 20 && Number.isInteger(data.total) && data.total >= 0 && data.total <= 500);
  requireCheck(Array.isArray(data.templates) && data.templates.length === Math.min(20, data.total));
  const ids = new Set();
  for (const row of data.templates) {
    template(row);
    requireCheck(!ids.has(row.id)); ids.add(row.id);
    if (departmentId !== undefined) requireCheck(row.active && (row.departmentId === null || row.departmentId === departmentId));
  }
  return data.templates;
}

async function verifyRepliesAccess(request, cookie, profile) {
  const checks = [], user = profile.user, enabled = profile.capabilities.replies === true;
  requireCheck(user && uint(user.id) && ['admin', 'operator'].includes(user.role));
  const read = route => request(route, 'GET', null, { Cookie: cookie });
  const anonymous = await request('/api/replies/templates');
  requireCheck(anonymous.response.status === 401); noStore(anonymous);
  checks.push('replies-anonymous-denied-no-store');

  const catalogue = await read('/api/replies/templates?page=1&limit=20');
  requireCheck(catalogue.response.status === (user.role === 'operator' ? 403 : enabled ? 200 : 503));
  noStore(catalogue);
  if (user.role === 'operator') checks.push('replies-administration-operator-denied');
  else if (!enabled) checks.push('replies-explicit-preparation-pending');
  else {
    const rows = list(catalogue);
    checks.push('replies-admin-bounded-safe-read');
    if (rows.length) {
      const detail = await read('/api/replies/templates/' + rows[0].id);
      requireCheck(detail.response.status === 200); noStore(detail);
      requireCheck(detail.data && Object.keys(detail.data).join(',') === 'template');
      template(detail.data.template); requireCheck(detail.data.template.id === rows[0].id);
      // The version/text can change between the list and detail; do not assert equality.
      checks.push('replies-admin-authorized-detail');
    }
    const filtered = await read('/api/replies/templates?page=1&limit=20&q=Verification%25_!');
    list(filtered); checks.push('replies-filtered-bounded-read');
    for (const query of ['page=0', 'limit=51', 'page=10001', 'q=a&q=b', 'extra=1']) {
      const invalid = await read('/api/replies/templates?' + query);
      requireCheck(invalid.response.status === 400); noStore(invalid);
    }
    checks.push('replies-invalid-filters-denied');
  }

  if (!enabled) return checks;
  const inbox = await read('/api/chat/team/conversations?page=1&limit=20&status=open&assignment=me');
  requireCheck(inbox.response.status === 200); noStore(inbox);
  const data = inbox.data;
  requireCheck(data && Array.isArray(data.conversations) && data.page === 1 && data.limit === 20 &&
    Number.isInteger(data.total) && data.total >= 0 && data.total <= 5000 && data.conversations.length <= 20);
  for (const row of data.conversations) requireCheck(uint(row.id) && uint(row.departmentId) && row.status === 'open' && row.assignedTo === user.id);
  const conversation = data.conversations[0];
  if (!conversation) {
    checks.push('replies-owned-conversation-check-pending-no-fixtures');
    return checks;
  }
  const route = '/api/chat/team/conversations/' + conversation.id + '/replies';
  const available = await read(route + '?page=1&limit=20');
  noStore(available);
  if (available.response.status === 404) {
    // A transfer, closure or permission revocation between reads is a valid denial.
    checks.push('replies-conversation-access-changed-denied');
    return checks;
  }
  const rows = list(available, conversation.departmentId);
  checks.push('replies-owned-conversation-active-scope-read');
  if (!rows.length) checks.push('replies-conversation-detail-check-pending-empty-catalogue');
  else {
    const detail = await read(route + '/' + rows[0].id);
    noStore(detail);
    if (detail.response.status === 404) checks.push('replies-template-or-conversation-access-changed-denied');
    else {
      requireCheck(detail.response.status === 200 && detail.data && Object.keys(detail.data).join(',') === 'template');
      template(detail.data.template);
      requireCheck(detail.data.template.id === rows[0].id && detail.data.template.active &&
        (detail.data.template.departmentId === null || detail.data.template.departmentId === conversation.departmentId));
      checks.push('replies-owned-conversation-authorized-detail');
    }
  }
  return checks;
}

module.exports = { verifyRepliesAccess };
