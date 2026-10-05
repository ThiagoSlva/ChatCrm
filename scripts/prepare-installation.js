'use strict';

const { databaseOptions } = require('../src/database');
const { inspectInstallation, formatReport, withDeadline } = require('./check-installation');
const { migrate } = require('./migrate-database');

// Explicit local command only. No web route, deploy hook, credentials arguments,
// automatic account creation, configuration writes or automatic upgrade.
async function prepareInstallation({ prepare = false, env = process.env,
  nodeVersion = process.versions.node, inspect = inspectInstallation,
  connect = options => require('mysql2/promise').createConnection(options),
  migrateDatabase = migrate, timeoutMs = 15000 } = {}) {
  const mode = prepare ? 'prepare-empty' : 'check';
  const before = await inspect({ env, nodeVersion });
  if (!prepare) return { ...before, mode };
  const failure = (code, extras = {}) => ({ ok: false, mode, code, ...extras });
  if (['installed', 'setup-ready', 'setup-secret-required', 'schema-incomplete',
    'migration-incomplete', 'schema-invalid', 'installation-inconsistent',
    'schema-incompatible', 'schema-changed'].includes(before.code)) {
    return failure('database-not-empty');
  }
  if (before.code !== 'database-unprepared') return { ...before, mode };
  if (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 32 || env.SETUP_TOKEN.length > 256) {
    return failure('setup-secret-required');
  }
  let connection, destroyed = false, timedOut = false, result;
  const closeOwned = () => {
    if (connection && !destroyed) {
      destroyed = true;
      try { connection.destroy(); } catch { /* Failure is still reported without driver detail. */ }
    }
  };
  const destroy = () => {
    timedOut = true;
    closeOwned();
  };
  try {
    // Also bound custom/connect drivers: destroy a socket arriving after timeout.
    const opening = Promise.resolve().then(() => connect(databaseOptions(env)));
    opening.then(value => { if (timedOut) { try { value.destroy(); } catch {} } }, () => {});
    connection = await withDeadline(() => opening, timeoutMs, destroy);
    const command = method => (sql, values) => withDeadline(
      () => connection[method]({ sql, timeout: timeoutMs }, values), timeoutMs, destroy
    ).catch(error => {
      if (error.code === 'PROTOCOL_SEQUENCE_TIMEOUT') destroy();
      throw error;
    });
    // The migrator owns its established named lock, validators and marker steps.
    await migrateDatabase({ query: command('query'), execute: command('execute') }, { requireEmpty: true });
    result = { ok: true };
  } catch (error) {
    result = failure(timedOut ? 'preparation-timeout' : error.code === 'DATABASE_NOT_EMPTY'
      ? 'database-not-empty' : 'preparation-interrupted');
  } finally {
    if (connection && !destroyed) {
      try { await withDeadline(() => connection.end(), timeoutMs, destroy); }
      catch { closeOwned(); result = failure(timedOut ? 'preparation-timeout' : 'preparation-unconfirmed'); }
    }
  }
  if (!result.ok) return result;
  const after = await inspect({ env, nodeVersion });
  if (after.ok && ['setup-ready', 'installed'].includes(after.code) && after.schemaVersion === 9) {
    return { ...after, mode, preparation: 'completed' };
  }
  return failure('preparation-unconfirmed');
}

function formatPreparation(result) {
  const messages = {
    'database-not-empty': 'Preparacao inicial recusada: o banco ja possui estrutura ou precisa de revisao. Nenhuma atualizacao foi autorizada. Use o diagnostico e o guia de retomada com backup.',
    'preparation-timeout': 'Preparacao sem confirmacao: uma operacao excedeu o prazo e a conexao propria foi encerrada. DDL pode ter sido aplicado. Verifique a estrutura antes de retomar.',
    'preparation-interrupted': 'Preparacao interrompida. DDL pode ter sido aplicado; preserve a estrutura e confira permissoes e o guia de retomada. Nenhuma senha ou conta foi alterada.',
    'preparation-unconfirmed': 'Preparacao nao confirmada pelo diagnostico final. Preserve a estrutura e confira o guia antes de retomar.'
  };
  const report = messages[result.code] ? messages[result.code] + '\n' : formatReport(result);
  return report + (result.mode === 'check'
    ? 'Somente leitura. Para uma instalacao NOVA com banco vazio: npm run install:prepare -- --prepare-empty\n'
    : 'Preparacao manual de estrutura; nao cria administrador, altera configuracao, reinicia aplicacao ou comprova restauracao.\n') +
    'Guia: docs/INSTALADOR-CPANEL.md\n';
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (new Set(args).size !== args.length || args.some(arg => !['--json', '--prepare-empty'].includes(arg))) return null;
  return { prepare: args.includes('--prepare-empty'), json: args.includes('--json') };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args || args.help) {
    (args ? process.stdout : process.stderr).write('Uso: npm run install:prepare -- [--prepare-empty] [--json]\nSem --prepare-empty: somente diagnostico. Configuracao apenas no ambiente privado.\n');
    process.exitCode = args ? 0 : 2; return;
  }
  require('../src/server').loadEnvironment();
  const result = await prepareInstallation(args);
  process.stdout.write(args.json ? JSON.stringify(result) + '\n' : formatPreparation(result),
    () => process.exit(result.ok ? 0 : 1));
}

module.exports = { prepareInstallation, formatPreparation, parseArguments };
if (require.main === module) main().catch(() => {
  process.stderr.write('Preparacao nao concluida. Confira configuracao privada e dependencias; preserve qualquer DDL parcial. Nenhum segredo foi exibido.\n');
  process.exitCode = 1;
});
