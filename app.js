'use strict';

const { loadEnvironment, buildServer } = require('./src/server');

loadEnvironment();
const app = buildServer({ logger: true });

async function start() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT deve ser uma porta valida.');
  }
  await app.listen({ port, host: process.env.HOST || '127.0.0.1' });
}

async function shutdown() {
  await app.close();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

start().catch(() => {
  process.stderr.write('Nao foi possivel iniciar. Verifique porta e configuracao do gerenciador.\n');
  process.exitCode = 1;
});
