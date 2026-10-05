'use strict';

const { databaseOptions } = require('../src/database');
const {
  verifyDepartmentSchema, verifyChatSchema, verifyContactSchema,
  verifyOpportunitySchema, verifyConversationContactSchema, verifyPortalSchema, verifySubscriptionSchema, verifyCampaignSchema
} = require('./migrate-database');

const groups = [
  ['cl_schema', 'cl_company', 'cl_users', 'cl_sessions'],
  ['cl_departments', 'cl_department_members'],
  ['cl_visitors', 'cl_chat_conversations', 'cl_chat_messages', 'cl_chat_limits'],
  ['cl_contacts'], ['cl_opportunities', 'cl_opportunity_events'],
  ['cl_conversation_contacts', 'cl_conversation_contact_events'],
  ['cl_portal_accounts', 'cl_portal_sessions'], ['cl_portal_subscription_events'], ['cl_campaigns','cl_campaign_recipients','cl_campaign_batches']
];
const moduleNames = ['authentication', 'departments', 'chat', 'contacts', 'opportunities', 'conversationContacts', 'portal', 'subscriptions', 'campaigns'];
const validators = [verifyDepartmentSchema, verifyChatSchema, verifyContactSchema,
  verifyOpportunitySchema, verifyConversationContactSchema, verifyPortalSchema, verifySubscriptionSchema, verifyCampaignSchema];

function validOrigin(env) {
  try {
    const url = new URL(env.APP_URL);
    return url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (env.NODE_ENV !== 'production' && url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch { return false; }
}

function withDeadline(work, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Diagnostic deadline exceeded');
      error.code = 'DIAGNOSTIC_TIMEOUT';
      try { onTimeout(); } catch { /* Closing must not hide the deadline. */ }
      reject(error);
    }, timeoutMs);
    Promise.resolve().then(work).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function readOnly(connection, { timeoutMs = 5000, onTimeout = () => connection.destroy() } = {}) {
  const read = method => (sql, values) => {
    if (typeof sql !== 'string' || !/^(SELECT|SHOW)\b/i.test(sql.trim()) ||
      /\b(FOR UPDATE|INTO OUTFILE|INTO DUMPFILE|LOCK IN SHARE MODE)\b/i.test(sql)) {
      throw new Error('Diagnostic only accepts read queries');
    }
    // Driver execute timeout begins after statement preparation. Bound the entire operation.
    return withDeadline(() => connection[method]({ sql, timeout: timeoutMs }, values), timeoutMs, onTimeout)
      .catch(error => {
        if (error.code === 'PROTOCOL_SEQUENCE_TIMEOUT') onTimeout();
        throw error;
      });
  };
  return { query: read('query'), execute: read('execute') };
}

async function validateSchema(connection, version) {
  await connection.query('SELECT id, name FROM cl_company LIMIT 0');
  await connection.query('SELECT id, name, email, password_hash, role, active, created_at FROM cl_users LIMIT 0');
  await connection.query('SELECT token_hash, user_id, expires_at FROM cl_sessions LIMIT 0');
  for (let i = 0; i < version - 1; i++) await validators[i](connection);
}

// Manual only. Never run this against the hosted database from npm test or deploy.
async function inspectInstallation({ env = process.env, nodeVersion = process.versions.node,
  connect = options => require('mysql2/promise').createConnection(options),
  validate = validateSchema, timeoutMs = 5000 } = {}) {
  const report = (code, extras = {}) => ({ ok: false, code, ...extras });
  if (!/^(22|24)\.\d+\.\d+$/.test(nodeVersion)) return report('runtime-unsupported');
  if (!validOrigin(env)) return report('url-invalid');
  let options;
  try { options = databaseOptions(env); } catch { return report('database-config-invalid'); }
  if (!options) return report('database-config-missing');

  let connection;
  let phase = 'connection';
  let destroyed = false;
  const destroy = () => { if (!destroyed && connection) { destroyed = true; connection.destroy(); } };
  try {
    connection = await connect(options);
    const read = readOnly(connection, { timeoutMs, onTimeout: destroy });
    const [tableRows] = await read.query('SHOW TABLES');
    const names = tableRows.map(row => Object.values(row)[0]);
    if (!names.length) return report('database-unprepared');
    if (names.some(name => !groups.flat().includes(name))) return report('database-not-exclusive');
    if (!names.includes('cl_schema')) return report('schema-incomplete');
    const [markers] = await read.execute('SELECT version FROM cl_schema WHERE id = 1');
    if (markers.length !== 1) return report('schema-incomplete');
    const version = Number(markers[0].version);
    if (version === 0) return report('database-unprepared');
    if (!Number.isInteger(version) || version < 1 || version > groups.length) return report('schema-incompatible');
    const required = groups.slice(0, version).flat();
    if (required.some(name => !names.includes(name))) return report('schema-incomplete', { schemaVersion: version });
    if (names.some(name => !required.includes(name))) return report('migration-incomplete', { schemaVersion: version });
    phase = 'schema';
    const [engines] = await read.execute('SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    if (engines.length !== required.length || required.some(name =>
      !engines.some(row => row.tableName === name && row.engine?.toLowerCase() === 'innodb'))) {
      return report('schema-invalid', { schemaVersion: version });
    }
    await validate(read, version);
    const [users] = await read.execute('SELECT 1 AS present FROM cl_users LIMIT 1');
    const [admins] = await read.execute("SELECT 1 AS present FROM cl_users WHERE role = 'admin' AND active = 1 LIMIT 1");
    const [company] = await read.execute('SELECT 1 AS present FROM cl_company WHERE id = 1');
    const [after] = await read.execute('SELECT version FROM cl_schema WHERE id = 1');
    if (after.length !== 1 || Number(after[0].version) !== version) return report('schema-changed');
    const setup = !users.length && !company.length;
    if ((!setup && (!users.length || !company.length || !admins.length)) || (setup && admins.length)) {
      return report('installation-inconsistent', { schemaVersion: version });
    }
    if (setup && (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 32)) {
      return report('setup-secret-required', { schemaVersion: version });
    }
    return { ok: true, code: setup ? 'setup-ready' : 'installed', schemaVersion: version,
      modulesAvailable: moduleNames.slice(0, version), modulesPending: moduleNames.slice(version),
      warnings: !setup && env.SETUP_TOKEN ? ['remove-setup-token'] : [] };
  } catch (error) {
    if (['DIAGNOSTIC_TIMEOUT', 'PROTOCOL_SEQUENCE_TIMEOUT'].includes(error.code)) return report('database-timeout');
    return report(phase === 'connection' ? 'database-unreachable' : 'schema-invalid');
  } finally {
    if (connection && !destroyed) {
      try { await withDeadline(() => connection.end(), timeoutMs, destroy); }
      catch (error) {
        destroy();
        if (error.code === 'DIAGNOSTIC_TIMEOUT') return report('database-timeout');
      }
    }
  }
}

const messages = {
  'runtime-unsupported': 'Use Node.js 22 ou 24.',
  'url-invalid': 'Configure APP_URL com a origem HTTPS, sem caminho, credenciais ou parametros. HTTP local somente fora de production.',
  'database-config-missing': 'Preencha DB_HOST, DB_NAME, DB_USER e DB_PASSWORD na configuracao privada.',
  'database-config-invalid': 'DB_PORT deve ser uma porta valida entre 1 e 65535.',
  'database-timeout': 'Uma leitura ou encerramento excedeu o tempo limite. A conexao propria foi encerrada; confira disponibilidade e repita.',
  'database-unreachable': 'Nao foi possivel ler o banco. Confira conexao, permissoes e disponibilidade.',
  'database-unprepared': 'Banco ainda nao preparado. Siga o guia de instalacao e migracao explicita.',
  'database-not-exclusive': 'O banco contem tabelas de outro projeto. Selecione um banco exclusivo; nenhum dado foi alterado.',
  'schema-incomplete': 'Estrutura ou marcador incompleto. Confira a ultima migracao antes de continuar.',
  'schema-incompatible': 'Versao de schema nao suportada. Use uma release compativel; nao diminua o marcador.',
  'migration-incomplete': 'Existem tabelas posteriores ao marcador. Confira e retome a migracao explicita, com backup.',
  'schema-invalid': 'A estrutura registrada nao passou na verificacao de leitura. Confira a migracao e permissoes; nenhuma reparacao automatica foi feita.',
  'schema-changed': 'O marcador mudou durante a leitura. Aguarde a migracao e repita o diagnostico.',
  'installation-inconsistent': 'Empresa ou administrador ativo ausente em instalacao iniciada. Confira recuperacao privada; nenhuma conta foi criada.',
  'setup-secret-required': 'Defina SETUP_TOKEN privado de pelo menos 32 caracteres antes de abrir /acesso.',
  'setup-ready': 'Estrutura preparada para criar a empresa e o primeiro administrador em /acesso.',
  'installed': 'Instalacao registrada com empresa e administrador ativo.'
};

function formatReport(result) {
  const lines = [messages[result.code] || 'Diagnostico nao concluido.'];
  if (result.schemaVersion) lines.push('Schema registrado: ' + result.schemaVersion + '.');
  if (result.modulesPending?.length) lines.push('Modulos que aguardam migracao: ' + result.modulesPending.join(', ') + '.');
  if (result.warnings?.includes('remove-setup-token')) lines.push('Remova SETUP_TOKEN apos concluir a instalacao.');
  lines.push('Diagnostico local somente de leitura. Nao comprova HTTPS, cron, carga, backup ou restauracao.');
  return lines.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json') || args.length > 1) {
    process.stderr.write('Uso: npm run check:installation -- [--json]\n');
    process.exitCode = 2; return;
  }
  require('../src/server').loadEnvironment();
  const result = await inspectInstallation();
  // The manual CLI owns its process; flush output then release any stalled driver handles.
  process.stdout.write(args.includes('--json') ? JSON.stringify(result) + '\n' : formatReport(result),
    () => process.exit(result.ok ? 0 : 1));
}
module.exports = { inspectInstallation, readOnly, formatReport };
if (require.main === module) main().catch(() => {
  process.stderr.write('Diagnostico interrompido. Confira configuracao privada e dependencias; nenhum segredo foi exibido.\n');
  process.exitCode = 1;
});
