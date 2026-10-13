'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const elements = new Map(), events = {}, calls = [];
  const health = { status: 'ok', application: 'conversa-livre', version: '0.15.2', crmImplemented: false };
  let server = () => ({ status: 200, data: health });
  let installation = () => ({ status: 200, data: { state: 'installed' } });
  const document = { body: {}, activeElement: null, getElementById(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', _disabled: false, attributes: {}, handlers: {},
      get disabled() { return this._disabled; },
      set disabled(value) { this._disabled = value; if (value && document.activeElement === this) document.activeElement = document.body; },
      focus() { document.activeElement = this; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; }
    });
    return elements.get(id);
  } };
  const context = vm.createContext({ document, AbortSignal, window: { addEventListener(name, handler) { events[name] = handler; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const result = await (url === '/health' ? server() : installation());
      return { status: result.status, ok: result.status === 200, json: async () => result.data };
    }
  });
  // Prevent only the initial asynchronous call, so each test controls the actual refresh.
  const source = fs.readFileSync('public/status.js', 'utf8').replace(/refreshStatus\(\);\s*$/, '');
  vm.runInContext(source, context);
  return { calls, document, el: id => document.getElementById(id), health,
    server: handler => { server = handler; }, installation: handler => { installation = handler; },
    refresh: () => vm.runInContext('refreshStatus()', context), fire: (name, event = {}) => events[name](event) };
}

test('overview uses the served version, reads public diagnostics and does not infer installed modules from health flags', async () => {
  const f = fixture(); await f.refresh();
  assert.equal(f.el('release-version').textContent, 'v0.15.2');
  assert.equal(f.el('server-status').textContent, 'Servidor conectado');
  assert.equal(f.el('installation-status').textContent, 'Administrador criado');
  assert.match(f.el('installation-detail').textContent, /recursos habilitados para sua conta/);
  assert.deepEqual(f.calls.map(call => call.url), ['/health', '/api/installation']);
  for (const { options } of f.calls) {
    assert.equal(options.cache, 'no-store'); assert.equal(options.method, undefined); assert(options.signal instanceof AbortSignal);
  }
  assert.equal(f.el('status-cards').attributes['aria-busy'], 'false'); assert.equal(f.el('refresh').disabled, false);
});

test('refresh clears previous success immediately, blocks duplicate checks and removes stale installation detail after network failure', async () => {
  const f = fixture(); await f.refresh();
  let finish; f.server(() => new Promise(resolve => { finish = resolve; }));
  f.installation(() => { throw Error('Controlled network failure'); });
  const refreshing = f.refresh();
  assert.equal(f.el('release-version').textContent, 'Versão a verificar');
  assert.equal(f.el('installation-status').textContent, 'Verificando…');
  assert.doesNotMatch(f.el('installation-detail').textContent, /recursos habilitados/);
  assert.equal(f.el('status-cards').attributes['aria-busy'], 'true');
  assert.equal(f.el('refresh').disabled, true);
  const count = f.calls.length; await f.refresh(); assert.equal(f.calls.length, count);
  finish({ status: 503, data: f.health }); await refreshing;
  assert.equal(f.el('release-version').textContent, 'Versão indisponível');
  assert.equal(f.el('server-status').textContent, 'Não foi possível verificar');
  assert.match(f.el('installation-detail').textContent, /não foi confirmada/);
});

test('healthy process and unavailable database remain distinct; retry recovers both diagnostics', async () => {
  const f = fixture(); f.installation(() => ({ status: 503, data: { state: 'database-unavailable' } })); await f.refresh();
  assert.equal(f.el('server-status').textContent, 'Servidor conectado');
  assert.equal(f.el('installation-status').textContent, 'Banco indisponível');
  f.installation(() => ({ status: 200, data: { state: 'installed' } })); await f.el('refresh').handlers.click();
  assert.equal(f.el('installation-status').textContent, 'Administrador criado');
});

test('installation result is independent when health cannot be confirmed', async () => {
  const f = fixture(); f.server(() => { throw Error('Controlled timeout'); }); await f.refresh();
  assert.equal(f.el('server-status').textContent, 'Não foi possível verificar');
  assert.equal(f.el('installation-status').textContent, 'Administrador criado');
});

test('installation distinguishes preparation from first administrator creation', async () => {
  const f = fixture();
  for (const [state, heading] of [['configuration-required', 'Configuração pendente'], ['setup', 'Primeiro acesso pendente']]) {
    f.installation(() => ({ status: 200, data: { state } })); await f.refresh();
    assert.equal(f.el('installation-status').textContent, heading);
  }
});

test('unexpected installation HTTP statuses, unknown states and malformed data cannot confirm installation', async () => {
  const f = fixture();
  for (const result of [
    { status: 500, data: { state: 'installed' } }, { status: 503, data: { state: 'installed' } },
    { status: 200, data: { state: 'database-unavailable' } }, { status: 200, data: { state: '__proto__' } },
    { status: 200, data: null }
  ]) {
    f.installation(() => result); await f.refresh();
    assert.equal(f.el('installation-status').textContent, 'Verificação indisponível');
    assert.match(f.el('installation-detail').textContent, /não foi confirmada/);
  }
});

test('invalid health data cannot confirm the process or retain a previously displayed version', async () => {
  const f = fixture(); await f.refresh();
  for (const data of [null, { ...f.health, status: 'error' }, { ...f.health, application: 'other-app' }]) {
    f.server(() => ({ status: 200, data })); await f.refresh();
    assert.equal(f.el('server-status').textContent, 'Não foi possível verificar');
    assert.equal(f.el('release-version').textContent, 'Versão indisponível');
  }
});

test('version display rejects arbitrary markup, objects and oversized values while retaining independent health status', async () => {
  const f = fixture();
  for (const version of ['<img src=x onerror=alert(1)>', {}, '1'.repeat(65), undefined]) {
    f.server(() => ({ status: 200, data: { ...f.health, version } })); await f.refresh();
    assert.equal(f.el('server-status').textContent, 'Servidor conectado');
    assert.equal(f.el('release-version').textContent, 'Versão indisponível');
  }
  f.server(() => ({ status: 200, data: { ...f.health, version: '1.0.0-rc.1+build.2' } })); await f.refresh();
  assert.equal(f.el('release-version').textContent, 'v1.0.0-rc.1+build.2');
});

test('cached navigation rechecks public state and ignores late responses from the departed page', async () => {
  const f = fixture(); let finish;
  f.server(() => new Promise(resolve => { finish = resolve; })); const previous = f.refresh();
  f.fire('pagehide', { persisted: true });
  assert.equal(f.el('release-version').textContent, 'Versão a verificar');
  f.server(() => ({ status: 200, data: { ...f.health, version: '0.16.0' } }));
  f.fire('pageshow', { persisted: true }); await new Promise(setImmediate);
  finish({ status: 200, data: f.health }); await previous;
  assert.equal(f.el('release-version').textContent, 'v0.16.0');
  assert.equal(f.el('refresh').disabled, false);
  const count = f.calls.length; f.fire('pageshow', { persisted: false }); assert.equal(f.calls.length, count);
});

test('keyboard refresh restores its focus after completion without taking focus from another control', async () => {
  const f = fixture(); f.el('refresh').focus(); await f.refresh();
  assert.equal(f.document.activeElement, f.el('refresh'));
  let finish; f.server(() => new Promise(resolve => { finish = resolve; }));
  const refreshing = f.refresh(); f.el('other-control').focus();
  finish({ status: 200, data: f.health }); await refreshing;
  assert.equal(f.document.activeElement, f.el('other-control'));
});
