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
  assert.equal(response.json().version, '0.12.3');
  assert.equal(response.json().conversationContactsImplemented, true);
  assert.equal(response.json().portalImplemented, true);
});

test('arquivos privados e caminhos arbitrarios nao sao publicados', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  for (const url of ['/.env', '/package.json', '/src/server.js', '/src/auth.js', '/.deployed.json', '/deploy.log', '/storage/config.json', '/docs/PLANO-IMPLEMENTACAO.md', '/%2e%2e/.env']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404, url);
  }
});

test('pagina e assets publicos sao servidos com politica restrita', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  for (const url of ['/', '/styles.css', '/status.js', '/acesso', '/access.js', '/chat', '/chat.js', '/atendimento', '/inbox.js', '/inbox-crm.js', '/widget.js', '/contatos', '/contacts.js', '/vendas', '/opportunities.js', '/portal', '/portal.js', '/portal-chat.js', '/portal-subscription.js']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
});

test('HTML usa assets identificados pelo conteudo para evitar cache ou arquivos antigos no Passenger', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  for (const url of ['/', '/acesso', '/chat', '/atendimento', '/contatos', '/vendas', '/portal', '/campanhas']) {
    const html = (await app.inject(url)).body;
    const urls = [...html.matchAll(/(?:href|src)="(\/assets\/[a-f0-9]{16}\/[^"]+)"/g)].map(match => match[1]);
    assert.equal(urls.length, url === '/portal' ? 5 : url === '/atendimento' ? 3 : 2);
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
