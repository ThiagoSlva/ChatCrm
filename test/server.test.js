'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServer } = require('../src/server');

test('health distingue servidor operacional de CRM ainda nao implementado', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  const response = await app.inject('/health');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'ok');
  assert.equal(response.json().crmImplemented, false);
  assert.equal(response.json().chatImplemented, true);
  assert.equal(response.json().contactsImplemented, true);
  assert.equal(response.json().opportunitiesImplemented, true);
  assert.equal(response.json().version, '0.15.4');
  assert.equal(response.json().conversationContactsImplemented, true);
  assert.equal(response.json().portalImplemented, true);
});

test('health usa a identidade do ambiente desta instância e conserva prioridade do deploy', async t => {
  const commit = 'd'.repeat(40), app = buildServer({ env: { APP_COMMIT: commit }, repository: null });
  t.after(() => app.close());
  const body = (await app.inject('/health')).json();
  assert.equal(body.commit, commit); assert.equal(body.releaseIdentitySource, 'environment');
});

test('paginas identificam a release do processo sem fase ou numero de modulo obsoleto', async t => {
  const app = buildServer({ repository: null }); t.after(() => app.close());
  const version = (await app.inject('/health')).json().version;
  assert.equal(version, require('../package.json').version);
  for (const url of ['/acesso','/chat','/atendimento','/contatos','/vendas']) {
    const response = await app.inject(url), badge = response.body.match(/<span class="version">([^<]+)<\/span>/)?.[1];
    assert.equal(response.statusCode, 200); assert.equal(badge, 'v' + version, url);
    assert(!response.body.includes('{{APP_VERSION}}')); assert(!badge.includes('Fase'));
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('parametros e cabecalhos do visitante nao alteram a versao renderizada', async t => {
  const app = buildServer({ repository: null }); t.after(() => app.close());
  const version = (await app.inject('/health')).json().version;
  const marker = '<img src=x onerror=alert(1)>';
  const response = await app.inject({ url:'/chat?version='+encodeURIComponent(marker), headers:{'x-app-version':marker} });
  assert.equal(response.statusCode,200); assert(response.body.includes('<span class="version">v'+version+'</span>'));
  assert(!response.body.includes(marker)); assert.match(response.headers['content-security-policy'],/script-src 'self'/);
});

test('arquivos privados e caminhos arbitrarios nao sao publicados', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  for (const url of ['/.env', '/.release.json', '/package.json', '/src/server.js', '/src/auth.js', '/.deployed.json', '/deploy.log', '/storage/config.json', '/docs/PLANO-IMPLEMENTACAO.md', '/%2e%2e/.env']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404, url);
  }
});

test('pagina e assets publicos sao servidos com politica restrita', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  for (const url of ['/', '/styles.css', '/status.js', '/acesso', '/access.js', '/chat', '/chat.js', '/atendimento', '/inbox.js', '/inbox-crm.js', '/quick-replies.js', '/inbox-replies.js', '/respostas', '/reply-catalog.js', '/widget.js', '/contatos', '/contacts.js', '/vendas', '/opportunities.js', '/portal', '/portal.js', '/portal-chat.js', '/portal-subscription.js']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
});

test('HTML usa assets identificados pelo conteudo para evitar cache ou arquivos antigos no Passenger', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  for (const url of ['/', '/acesso', '/chat', '/atendimento', '/contatos', '/vendas', '/portal', '/campanhas', '/respostas']) {
    const html = (await app.inject(url)).body;
    const urls = [...html.matchAll(/(?:href|src)="(\/assets\/[a-f0-9]{16}\/[^"]+)"/g)].map(match => match[1]);
    assert.equal(urls.length, url === '/portal' || url === '/atendimento' ? 6 : url === '/chat' ? 3 : 2);
    for (const asset of urls) {
      const response = await app.inject(asset);
      assert.equal(response.statusCode, 200);
      const { createHash } = require('node:crypto');
      assert.equal(createHash('sha256').update(response.body).digest('hex').slice(0, 16), asset.split('/')[2]);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
  }
  assert.equal((await app.inject('/assets/0000000000000000/styles.css')).statusCode, 404);
});
