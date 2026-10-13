'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('public/widget.js', 'utf8');

function fixture({ src = 'https://chat.suaempresa.example/widget.js', label, position, loading = false, noBody = false } = {}) {
  const hosts = [], events = [], options = { label, position };
  const body = { append(host) { hosts.push(host); } };
  const script = { src, getAttribute(name) { return options[name === 'data-label' ? 'label' : 'position'] ?? null; } };
  function element(tag) { return { tag, children: [], attributes: {}, textContent: '',
    append(...children) { this.children.push(...children); },
    attachShadow(options) { assert.equal(options.mode, 'open'); this.shadowRoot = element('shadow'); return this.shadowRoot; },
    setAttribute(name, value) { this.attributes[name] = value; }
  }; }
  const document = { currentScript: script, body: noBody ? null : body, readyState: loading ? 'loading' : 'complete',
    createElement: element, getElementById: id => hosts.find(host => host.id === id),
    addEventListener(name, handler, options) { events.push({ name, handler, options }); }
  };
  const context = vm.createContext({ document, URL });
  return { hosts, events, document, options,
    run() { vm.runInContext(source, context); },
    ready() { document.currentScript = null; document.body = body; document.readyState = 'complete'; events.forEach(e => e.handler()); },
    link: () => hosts[0]?.shadowRoot.children.find(e => e.tag === 'a'),
    style: () => hosts[0]?.shadowRoot.children.find(e => e.tag === 'style').textContent
  };
}

test('widget preserves the simple default link, isolates its contents and avoids duplicate embeds', () => {
  const f = fixture(); f.run(); f.run();
  assert.equal(f.hosts.length, 1); assert.equal(f.link().textContent, 'Abrir atendimento');
  assert.equal(f.link().href, 'https://chat.suaempresa.example/chat');
  assert.equal(f.link().target, '_blank'); assert.equal(f.link().rel, 'noopener noreferrer');
  assert.match(f.link().attributes['aria-label'], /em nova aba/);
});

test('label and side are captured before deferred mounting and cannot change the chat origin', () => {
  const f = fixture({ src: 'https://chat.suaempresa.example/assets/widget.js?ignored=1', label: '  Fale com nossa equipe  ', position: ' LEFT ', loading: true });
  f.run(); assert.equal(f.hosts.length, 0); assert.equal(f.events[0].options.once, true);
  f.options.label = 'Alterado depois'; f.options.position = 'right'; f.ready();
  assert.equal(f.link().textContent, 'Fale com nossa equipe');
  assert.match(f.style(), /left:max\(20px,env\(safe-area-inset-left\)\)/);
  assert.equal(f.link().href, 'https://chat.suaempresa.example/chat');
});

test('widget treats markup as literal text instead of creating nodes or executing it', () => {
  const label = '<img src=x onerror=alert(1)>'; const f = fixture({ label }); f.run();
  assert.equal(f.link().textContent, label); assert.equal(f.link().children.length, 0);
  assert.equal(f.link().attributes['aria-label'], label + ' — atendimento da empresa em nova aba');
  assert.deepEqual(f.hosts[0].shadowRoot.children.map(e => e.tag), ['style', 'a']);
});

test('invalid or oversized labels use the default instead of leaking controls or breaking layout', () => {
  for (const label of ['', '   ', 'x'.repeat(81), 'Nome\nOutra linha', '\nNome', 'Texto\tOutro', 'Controle\u0000', 'Controle\u0085']) {
    const f = fixture({ label }); f.run(); assert.equal(f.link().textContent, 'Abrir atendimento');
  }
  const f = fixture({ label: 'x'.repeat(80) }); f.run(); assert.equal(f.link().textContent.length, 80);
});

test('unrecognized positions cannot inject CSS and retain the right-side default', () => {
  const baseline = fixture(); baseline.run();
  for (const position of [undefined, 'bottom', 'left;display:none', 'https://other.example']) {
    const f = fixture({ position }); f.run(); assert.match(f.style(), /right:max\(20px,env\(safe-area-inset-right\)\)/);
    assert.equal(f.style(), baseline.style());
  }
});

test('only HTTPS or a local HTTP origin can supply the chat destination; malformed sources mount nothing', () => {
  for (const src of ['http://chat.suaempresa.example/widget.js','http://localhost.evil.example/widget.js','javascript:alert(1)','data:text/javascript,alert(1)','bad-url', '']) {
    const f = fixture({ src }); f.run(); assert.equal(f.hosts.length, 0);
  }
  for (const host of ['localhost','127.0.0.1']) {
    const f = fixture({ src: 'http://' + host + ':3264/widget.js' }); f.run(); assert.equal(f.link().href, 'http://' + host + ':3264/chat');
  }
  const f = fixture(); f.document.currentScript = null; f.run(); assert.equal(f.hosts.length, 0);
});

test('deferred duplicate includes mount at most once and recover when body becomes available', () => {
  const f = fixture({ loading: true, noBody: true }); f.run(); f.run(); assert.equal(f.hosts.length, 0);
  f.ready(); assert.equal(f.hosts.length, 1);
  const empty = fixture({ noBody: true }); empty.run(); assert.equal(empty.hosts.length, 0);
});
