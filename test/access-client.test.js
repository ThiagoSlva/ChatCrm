'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(source = fs.readFileSync('public/access.js', 'utf8')) {
  const elements = new Map(), events = {}, calls = [];
  const doc = { body: {}, activeElement: null };
  function node(tag = 'div', id = '') {
    const element = { id, tagName: tag.toUpperCase(), type: '', name: '', value: '', textContent: '', hidden: false, disabled: false, checked: false, children: [], handlers: {}, fields: [],
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {},
      replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); },
      querySelectorAll() { return this.fields; }, querySelector() { return this.fields.find(e => e.tagName === 'BUTTON'); },
      reset() { this.fields.forEach(e => { e.value = ''; e.checked = false; }); },
      focus() { doc.activeElement = this; }, closest() { return null; }, select() {} };
    if (id) elements.set(id, element);
    return element;
  }
  const html = fs.readFileSync('public/access.html', 'utf8');
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = node(match[1], match[3]);
    element.type = /\btype="([^"]+)"/.exec(match[2])?.[1] || '';
    element.name = /\bname="([^"]+)"/.exec(match[2])?.[1] || '';
  }
  for (const match of html.matchAll(/<form\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    const form = elements.get(match[1]);
    form.fields = [...match[2].matchAll(/<(input|button|textarea)\b([^>]*)>/g)].map(m => {
      const id = /\bid="([^"]+)"/.exec(m[2])?.[1];
      return id ? elements.get(id) : node(m[1]);
    });
  }
  for (const [container, forms] of [['team', ['operator-create']], ['departments', ['department-create', 'department-edit', 'department-channel-form']]]) {
    elements.get(container).fields = forms.flatMap(id => elements.get(id).fields);
  }
  doc.getElementById = id => { assert(elements.has(id), `Missing fixture element: ${id}`); return elements.get(id); };
  doc.createElement = tag => node(tag);
  doc.querySelectorAll = () => [...elements.values()].filter(e => ['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.tagName)).concat(...[...elements.values()].filter(e => e.tagName === 'FORM').map(e => e.fields.filter(f => !f.id)));
  let role = 'admin', anonymous = false, intercept = null;
  const context = vm.createContext({ document: doc, window: { addEventListener(n, fn) { (events[n] ||= []).push(fn); } },
    AbortController, AbortSignal, DOMException, URL, location: { origin: 'http://localhost' },
    FormData: class { constructor(form) { this.entries = form.fields.filter(e => e.name).map(e => [e.name, e.value]); } [Symbol.iterator]() { return this.entries[Symbol.iterator](); } has(name) { return this.entries.some(e => e[0] === name); } },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      let result = intercept ? await intercept(url, options) : null;
      if (!result) {
        let data = {}, status = 200;
        if (url === '/api/installation') data = { state: 'installed' };
        else if (url === '/api/auth/me') { status = anonymous ? 401 : 200; data = { company: 'Empresa fictícia', user: { name: 'Pessoa fictícia', email: 'admin@example.test', role }, csrfToken: 'a'.repeat(64), capabilities: { departments: true, chat: true } }; }
        else if (url.startsWith('/api/team/operators?')) data = { users: [{ id: 2, name: 'Operador fictício', email: 'operator@example.test', active: true }], total: 1, page: 1, limit: 20 };
        else if (url.startsWith('/api/team/departments?')) data = { departments: [{ id: 3, name: 'Área fictícia', active: true }], total: 1, page: 1, limit: 20 };
        else if (url === '/api/chat/public/departments') data = { departments: [] };
        result = { status, data };
      }
      return { status: result.status, ok: result.status === 200, json: async () => result.data };
    } });
  // Run the actual checklist too: its navigation listener must cooperate with access.js.
  vm.runInContext(fs.readFileSync('public/setup-checklist.js', 'utf8'), context);
  vm.runInContext(source, context);
  return { calls, doc, el: id => doc.getElementById(id), run: script => vm.runInContext(script, context),
    role: value => { role = value; }, anonymous: () => { anonymous = true; }, intercept: fn => { intercept = fn; },
    fire: async (name, event = {}) => { const results = (events[name] || []).map(fn => fn(event)); await Promise.all(results); },
    ready: async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); } };
}

test('departure erases identity, operator data, drafts and credential values before cached restoration', async () => {
  const f = fixture(); await f.ready(); assert(!f.el('account').hidden); assert.equal(f.el('operator-list').children.length, 1);
  for (const id of ['current-password', 'operator-password', 'setup-token', 'password', 'operator-name', 'department-name', 'widget-code']) f.el(id).value = 'Private draft';
  f.el('department-public').checked = true;
  await f.fire('pagehide', { persisted: true });
  assert(f.el('account').hidden); assert.equal(f.el('operator-list').children.length, 0); assert.equal(f.el('department-list').children.length, 0);
  for (const id of ['user-name', 'user-detail', 'role-description']) assert.equal(f.el(id).textContent, '');
  for (const id of ['current-password', 'operator-password', 'setup-token', 'password', 'operator-name', 'department-name', 'widget-code']) assert.equal(f.el(id).value, '');
  assert(!f.el('department-public').checked); assert.equal(f.run('csrfToken'), null);
  const count = f.calls.length; await f.run('refresh()'); assert.equal(f.calls.length, count);
});

test('cached return waits for current permission and performs a single installation/profile read without replay', async () => {
  const f = fixture(); await f.ready(); await f.fire('pagehide');
  let release; f.intercept(url => url === '/api/auth/me' ? new Promise(resolve => { release = resolve; }) : null);
  const count = f.calls.length, restoring = f.fire('pageshow', { persisted: true }); await f.ready();
  assert(f.el('account').hidden); assert(!f.el('verification').hidden); assert(f.el('access-retry').disabled); assert.equal(f.doc.activeElement, f.el('title'));
  release({ status: 200, data: { company: 'Outra empresa fictícia', user: { name: 'Operador atual', email: 'now@example.test', role: 'operator' }, csrfToken: 'b'.repeat(64), capabilities: {} } }); await restoring; await f.ready();
  assert(!f.el('account').hidden); assert.equal(f.el('user-name').textContent, 'Operador atual'); assert(f.el('team').hidden); assert(f.el('departments').hidden);
  const reads = f.calls.slice(count); assert.equal(reads.filter(c => c.url === '/api/auth/me').length, 1); assert.equal(reads.filter(c => c.url === '/api/installation').length, 1); assert(reads.every(c => !c.method));
  const after = f.calls.length; await f.fire('pageshow', { persisted: false }); assert.equal(f.calls.length, after);
});

test('revoked session and offline restoration keep old private data cleared, with an explicit retry', async () => {
  const f = fixture(); await f.ready(); await f.fire('pagehide'); f.anonymous(); await f.fire('pageshow', { persisted: true });
  assert(!f.el('login').hidden); assert(f.el('account').hidden); assert.equal(f.el('user-detail').textContent, '');
  assert(!f.el('login').querySelector('button').disabled);
  await f.fire('pagehide'); f.intercept(url => { if (url === '/api/installation') throw Error('Controlled offline'); return null; });
  await f.fire('pageshow', { persisted: true }); assert(!f.el('verification').hidden); assert(f.el('account').hidden); assert(!f.el('access-retry').disabled);
  f.intercept(null); await f.el('access-retry').handlers.click(); assert(!f.el('login').hidden); assert.equal(f.doc.activeElement, f.el('title')); assert(f.calls.every(c => !c.method));
});

test('a late profile or team response cannot repopulate the departed document or new session', async () => {
  for (const held of ['/api/auth/me', '/api/team/operators?page=1&limit=20']) {
    const f = fixture(); await f.ready(); let release;
    f.intercept(url => url === held ? new Promise(resolve => { release = resolve; }) : null);
    const pending = f.run('refresh()'); await f.ready(); const request = f.calls.findLast(c => c.url === held);
    await f.fire('pagehide'); assert(request.signal.aborted); f.intercept(null); f.anonymous(); await f.fire('pageshow', { persisted: true });
    release({ status: 200, data: { user: { name: 'Late private', role: 'admin' }, csrfToken: 'c'.repeat(64), users: [{ name: 'Late private', email: 'late@example.test' }], total: 1, page: 1, limit: 20 } }); await pending;
    assert(!f.el('login').hidden); assert.equal(f.el('user-name').textContent, ''); assert.equal(f.el('operator-list').children.length, 0); assert.equal(f.el('team-message').textContent, '');
  }
});

test('late creation success or failure cannot reset a new draft, show old feedback or trigger another write', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); await f.ready(); let release;
    f.intercept((url, options) => options.method === 'POST' ? new Promise((resolve, reject) => { release = () => fail ? reject(Error('Late failure')) : resolve({ status: 200, data: {} }); }) : null);
    f.el('operator-name').value = 'Old operator';
    const pending = f.run('teamAction(async()=>{await api("/api/team/operators",{method:"POST",headers:teamHeaders(),body:"{}"});byId("operator-create").reset();byId("team-message").textContent="Old success";})'); await f.ready();
    await f.fire('pagehide'); f.intercept(null); await f.fire('pageshow', { persisted: true }); f.el('operator-name').value = 'New draft';
    release(); await pending; assert.equal(f.el('operator-name').value, 'New draft'); assert.equal(f.el('team-message').textContent, ''); assert.equal(f.run('teamBusy'), false);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  }
});

test('normal team refresh retains the current operator draft and setup/login still finish normally', async () => {
  const f = fixture(); await f.ready(); f.el('operator-name').value = 'Keep current draft'; await f.el('team-reload').handlers.click();
  assert.equal(f.el('operator-name').value, 'Keep current draft'); assert.equal(f.el('operator-list').children.length, 1);
  f.anonymous(); await f.run('refresh()'); f.el('email').value = 'fictitious@example.test'; f.el('password').value = 'fictitious-password';
  await f.el('login').handlers.submit({ preventDefault() {}, currentTarget: f.el('login') });
  assert(!f.el('login').querySelector('button').disabled); assert.equal(f.el('password').value, ''); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('departed login, logout and password requests cannot navigate or focus the restored administration', async () => {
  for (const action of ['login', 'logout', 'password-change']) {
    const f = fixture(); await f.ready(); let release;
    f.intercept((url, options) => options.method === 'POST' ? new Promise(resolve => { release = () => resolve({ status: 200, data: {} }); }) : null);
    if (action === 'password-change') { f.el('new-password').value = 'fictitious-password'; f.el('password-confirmation').value = 'fictitious-password'; }
    const pending = action === 'logout' ? f.el(action).handlers.click() : f.el(action).handlers.submit({ preventDefault() {}, currentTarget: f.el(action) }); await f.ready();
    await f.fire('pagehide'); f.intercept(null); await f.fire('pageshow', { persisted: true }); f.el('operator-name').value = 'Current draft';
    const reads = f.calls.length; release(); await pending;
    assert(!f.el('account').hidden); assert.equal(f.el('operator-name').value, 'Current draft'); assert.equal(f.el('message').textContent, ''); assert.equal(f.doc.activeElement, f.el('title'));
    assert.equal(f.calls.length, reads); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  }
});
