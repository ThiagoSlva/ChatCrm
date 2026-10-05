'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Fastify = require('fastify');
const { createRepository } = require('./database');
const { registerAuth } = require('./auth');
const { registerTeam } = require('./team');
const { registerDepartments } = require('./departments');
const { registerChat } = require('./chat');
const { registerContacts } = require('./contacts');
const { registerOpportunities } = require('./opportunities');
const { registerConversationContacts } = require('./conversation-contacts');
const { registerCampaigns } = require('./campaigns');
const { registerSubscriptions } = require('./subscriptions');
const { registerPortal } = require('./portal');

const projectRoot = path.resolve(__dirname, '..');

function loadEnvironment() {
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
}

function buildServer(options = {}) {
  const app = Fastify({ logger: options.logger || false, bodyLimit: 8192, ajv: { customOptions: { removeAdditional: false } } });
  const env = options.env || process.env;
  const repository = Object.hasOwn(options, 'repository') ? options.repository : createRepository(env);
  if (repository) app.addHook('onClose', async () => repository.close());
  const assets = [
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/status.js', 'status.js', 'application/javascript; charset=utf-8'],
    ['/access.js', 'access.js', 'application/javascript; charset=utf-8'],
    ['/chat.js', 'chat.js', 'application/javascript; charset=utf-8'],
    ['/inbox.js', 'inbox.js', 'application/javascript; charset=utf-8'],
    ['/inbox-crm.js', 'inbox-crm.js', 'application/javascript; charset=utf-8'],
    ['/widget.js', 'widget.js', 'application/javascript; charset=utf-8'],
    ['/portal.js', 'portal.js', 'application/javascript; charset=utf-8'],
    ['/portal-chat.js', 'portal-chat.js', 'application/javascript; charset=utf-8'],
    ['/portal-subscription.js', 'portal-subscription.js', 'application/javascript; charset=utf-8'],
    ['/campaigns.js', 'campaigns.js', 'application/javascript; charset=utf-8'],
    ['/portal-news.js', 'portal-news.js', 'application/javascript; charset=utf-8'],
    ['/contacts.js', 'contacts.js', 'application/javascript; charset=utf-8'],
    ['/opportunities.js', 'opportunities.js', 'application/javascript; charset=utf-8']
  ];

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    return payload;
  });

  const assetUrls = new Map();
  for (const [route, fileName, contentType] of assets) {
    const content = fs.readFileSync(path.join(projectRoot, 'public', fileName));
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const versionedUrl = `/assets/${hash}/${fileName}`;
    assetUrls.set(fileName, versionedUrl);
    app.get(route, async (request, reply) => reply.type(contentType).send(content));
    app.get(versionedUrl, async (request, reply) => reply.type(contentType).send(content));
  }
  for (const [route, fileName] of [['/', 'index.html'], ['/acesso', 'access.html'], ['/chat', 'chat.html'], ['/atendimento', 'inbox.html'], ['/contatos', 'contacts.html'], ['/vendas', 'opportunities.html'], ['/portal', 'portal.html'], ['/campanhas','campaigns.html']]) {
    let content = fs.readFileSync(path.join(projectRoot, 'public', fileName), 'utf8');
    for (const [asset, url] of assetUrls) content = content.replaceAll(`="${asset}"`, `="${url}"`).replaceAll(`="/${asset}"`, `="${url}"`);
    app.get(route, async (request, reply) => reply.type('text/html; charset=utf-8').send(content));
  }

  app.get('/health', async () => ({
    status: 'ok',
    application: 'conversa-livre',
    version: '0.12.1',
    commit: /^[a-f0-9]{40}$/.test(process.env.APP_COMMIT || '') ? process.env.APP_COMMIT : null,
    phase: 'portal-campaigns-mvp',
    authenticationImplemented: true,
    operatorsImplemented: true,
    passwordChangeImplemented: true,
    departmentsImplemented: true,
    inboxToolsImplemented: true,
    contactsImplemented: true,
    opportunitiesImplemented: true,
    conversationContactsImplemented: true,
    portalImplemented: true,
    subscriptionsImplemented: true,
    campaignsImplemented: true,
    crmImplemented: false,
    chatImplemented: true
  }));

  const auth = registerAuth(app, repository, env);
  registerTeam(app, repository, auth);
  registerDepartments(app, repository, auth);
  const visitorAuth = registerChat(app, repository, auth);
  const portalAuth = registerPortal(app, repository, auth, visitorAuth);
  registerSubscriptions(app, repository, portalAuth.authorize);
  registerCampaigns(app, repository, auth, portalAuth.authorize);
  registerContacts(app, repository, auth);
  registerOpportunities(app, repository, auth);
  registerConversationContacts(app, repository, auth);

  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404).send({ error: 'Rota nao encontrada.' });
  });

  app.setErrorHandler(async (error, request, reply) => {
    reply.code((error.statusCode >= 400 && error.statusCode < 500) || error.statusCode === 503 ? error.statusCode : 500);
    reply.send({ error: 'Nao foi possivel concluir a requisicao.' });
  });

  return app;
}

module.exports = { loadEnvironment, buildServer };
