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
  assert.equal(response.json().chatImplemented, false);
});

test('arquivos privados e caminhos arbitrarios nao sao publicados', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  for (const url of ['/.env', '/package.json', '/src/server.js', '/docs/PLANO-IMPLEMENTACAO.md', '/%2e%2e/.env']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404, url);
  }
});

test('pagina e assets publicos sao servidos com politica restrita', async (t) => {
  const app = buildServer();
  t.after(() => app.close());
  for (const url of ['/', '/styles.css', '/status.js']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
});
