'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Fastify = require('fastify');

const projectRoot = path.resolve(__dirname, '..');

function loadEnvironment() {
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

function buildServer(options = {}) {
  const app = Fastify({ logger: options.logger || false });
  const assets = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/status.js', 'status.js', 'application/javascript; charset=utf-8']
  ];

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    return payload;
  });

  for (const [route, fileName, contentType] of assets) {
    const content = fs.readFileSync(path.join(projectRoot, 'public', fileName));
    app.get(route, async (request, reply) => reply.type(contentType).send(content));
  }

  app.get('/health', async () => ({
    status: 'ok',
    application: 'conversa-livre',
    version: '0.0.1',
    phase: 'hosting-validation',
    crmImplemented: false,
    chatImplemented: false
  }));

  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404).send({ error: 'Rota nao encontrada.' });
  });

  app.setErrorHandler(async (error, request, reply) => {
    reply.code(error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500);
    reply.send({ error: 'Nao foi possivel concluir a requisicao.' });
  });

  return app;
}

module.exports = { loadEnvironment, buildServer };
