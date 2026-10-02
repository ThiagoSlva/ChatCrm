'use strict';

const mysql = require('mysql2/promise');
const { databaseOptions } = require('../src/database');
const { loadEnvironment } = require('../src/server');

const statements = [
  `CREATE TABLE IF NOT EXISTS cl_schema (id TINYINT UNSIGNED PRIMARY KEY, version INT UNSIGNED NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS cl_company (id TINYINT UNSIGNED PRIMARY KEY, name VARCHAR(120) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cl_users (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL UNIQUE, password_hash VARCHAR(200) CHARACTER SET ascii NOT NULL, role ENUM('admin','operator') NOT NULL, active TINYINT NOT NULL DEFAULT 1, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS cl_sessions (token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, user_id INT UNSIGNED NOT NULL, expires_at DATETIME NOT NULL, INDEX(expires_at), FOREIGN KEY (user_id) REFERENCES cl_users(id) ON DELETE CASCADE) ENGINE=InnoDB`
];

const departmentStatements = [
  `CREATE TABLE IF NOT EXISTS cl_departments (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, active TINYINT NOT NULL DEFAULT 1, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY cl_departments_name (name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS cl_department_members (department_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, PRIMARY KEY (department_id, user_id), INDEX cl_department_members_user (user_id, department_id), FOREIGN KEY (department_id) REFERENCES cl_departments(id) ON DELETE RESTRICT, FOREIGN KEY (user_id) REFERENCES cl_users(id) ON DELETE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

const chatStatements = [
  `CREATE TABLE IF NOT EXISTS cl_visitors (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX(expires_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS cl_chat_conversations (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, visitor_id INT UNSIGNED NOT NULL, department_id INT UNSIGNED NOT NULL, assigned_to INT UNSIGNED NULL, status ENUM('waiting','open','closed') NOT NULL DEFAULT 'waiting', last_sequence INT UNSIGNED NOT NULL DEFAULT 0, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX(visitor_id, status, id), INDEX(department_id, updated_at, id), FOREIGN KEY (visitor_id) REFERENCES cl_visitors(id) ON DELETE RESTRICT, FOREIGN KEY (department_id) REFERENCES cl_departments(id) ON DELETE RESTRICT, FOREIGN KEY (assigned_to) REFERENCES cl_users(id) ON DELETE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  'CREATE TABLE IF NOT EXISTS cl_chat_messages (conversation_id INT UNSIGNED NOT NULL, `sequence` INT UNSIGNED NOT NULL, sender ENUM(\'visitor\',\'team\') NOT NULL, author_id INT UNSIGNED NOT NULL, client_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, text VARCHAR(2000) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (conversation_id, `sequence`), UNIQUE KEY cl_chat_message_key (conversation_id, sender, author_id, client_key), FOREIGN KEY (conversation_id) REFERENCES cl_chat_conversations(id) ON DELETE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  `CREATE TABLE IF NOT EXISTS cl_chat_limits (key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, window_start BIGINT UNSIGNED NOT NULL DEFAULT 0, count INT UNSIGNED NOT NULL DEFAULT 0, expires_at DATETIME NOT NULL, INDEX(expires_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];
const contactStatement = "CREATE TABLE IF NOT EXISTS cl_contacts (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, department_id INT UNSIGNED NOT NULL, name VARCHAR(100) NOT NULL, email VARCHAR(254) NOT NULL DEFAULT '', phone VARCHAR(40) NOT NULL DEFAULT '', company VARCHAR(100) NOT NULL DEFAULT '', kind ENUM('lead','contact','customer') NOT NULL DEFAULT 'lead', version INT UNSIGNED NOT NULL DEFAULT 1, created_by INT UNSIGNED NOT NULL, client_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, UNIQUE KEY cl_contacts_request (created_by, client_key), INDEX cl_contacts_queue (department_id, kind, updated_at, id), FOREIGN KEY (department_id) REFERENCES cl_departments(id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY (created_by) REFERENCES cl_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
const chatTables = ['cl_visitors', 'cl_chat_conversations', 'cl_chat_messages', 'cl_chat_limits'];
const unsignedInt = /^int(?:\(\d+\))? unsigned$/;
const dateType = /^datetime(?:\(\d+\))?$/;

async function verifyBaseSchema(connection) {
  // These empty reads validate expected columns without reading identities or password hashes.
  await connection.query('SELECT id, name FROM cl_company LIMIT 0');
  await connection.query('SELECT id, name, email, password_hash, role, active, created_at FROM cl_users LIMIT 0');
  await connection.query('SELECT token_hash, user_id, expires_at FROM cl_sessions LIMIT 0');
}

function hasIndex(rows, columns, unique) {
  const indexes = new Map();
  for (const row of rows) {
    const key = row.Key_name;
    if (!indexes.has(key)) indexes.set(key, []);
    indexes.get(key).push(row);
  }
  return [...indexes.values()].some(index => {
    const sorted = index.sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
    return sorted.length === columns.length && sorted.every((row, i) => row.Column_name === columns[i] && !row.Sub_part && Number(row.Non_unique) === (unique ? 0 : 1));
  });
}

async function verifyDepartmentSchema(connection) {
  const [departments] = await connection.query('SHOW FULL COLUMNS FROM cl_departments');
  const [members] = await connection.query('SHOW COLUMNS FROM cl_department_members');
  const columnsMatch = (rows, expected) => rows.length === expected.length && expected.every(([name, type]) => rows.some(row => row.Field === name && type.test(row.Type.toLowerCase()) && row.Null === 'NO'));
  const publicColumn = departments.find(row => row.Field === 'public_chat');
  if (publicColumn && (!/^tinyint(?:\(\d+\))?$/.test(publicColumn.Type.toLowerCase()) || publicColumn.Null !== 'NO' || String(publicColumn.Default) !== '0')) throw new Error('Entrada publica incompativel.');
  if (!columnsMatch(departments.filter(row => row.Field !== 'public_chat'), [['id', /^int(?:\(\d+\))? unsigned$/], ['name', /^varchar\(100\)$/], ['active', /^tinyint(?:\(\d+\))?$/], ['created_at', /^timestamp(?:\(\d+\))?$/]]) ||
    !departments.some(row => row.Field === 'id' && row.Extra.includes('auto_increment')) ||
    !columnsMatch(members, [['department_id', /^int(?:\(\d+\))? unsigned$/], ['user_id', /^int(?:\(\d+\))? unsigned$/]])) throw new Error('Estrutura de departamentos incompativel.');
  const active = departments.find(row => row.Field === 'active');
  const created = departments.find(row => row.Field === 'created_at');
  const name = departments.find(row => row.Field === 'name');
  if (String(active.Default) !== '1' || !/^current_timestamp(?:\(\))?$/i.test(String(created.Default)) || !/^utf8mb4_.+_ci$/i.test(name.Collation || '')) throw new Error('Valores padrao de departamentos incompativeis.');
  const [engines] = await connection.execute("SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('cl_departments', 'cl_department_members')");
  if (engines.length !== 2 || !engines.some(row => row.tableName === 'cl_departments' && row.engine?.toLowerCase() === 'innodb') ||
    !engines.some(row => row.tableName === 'cl_department_members' && row.engine?.toLowerCase() === 'innodb')) throw new Error('Engine de departamentos incompativel.');
  const [departmentIndexes] = await connection.query('SHOW INDEX FROM cl_departments');
  const [memberIndexes] = await connection.query('SHOW INDEX FROM cl_department_members');
  if (!hasIndex(departmentIndexes.filter(row => row.Key_name === 'PRIMARY'), ['id'], true) || !hasIndex(departmentIndexes, ['name'], true) ||
    !hasIndex(memberIndexes.filter(row => row.Key_name === 'PRIMARY'), ['department_id', 'user_id'], true) || !hasIndex(memberIndexes, ['user_id', 'department_id'], false)) throw new Error('Indices de departamentos incompativeis.');
  const [foreignKeys] = await connection.execute("SELECT COLUMN_NAME AS columnName, REFERENCED_TABLE_NAME AS referencedTable, REFERENCED_COLUMN_NAME AS referencedColumn FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cl_department_members' AND REFERENCED_TABLE_NAME IS NOT NULL");
  if (foreignKeys.length !== 2 || !foreignKeys.some(row => row.columnName === 'department_id' && row.referencedTable === 'cl_departments' && row.referencedColumn === 'id') ||
    !foreignKeys.some(row => row.columnName === 'user_id' && row.referencedTable === 'cl_users' && row.referencedColumn === 'id')) throw new Error('Vinculos de departamentos incompativeis.');
}

async function verifyChatSchema(connection) {
  // Chat authorization relies on transactional schema/user/session locks as well.
  const [coreEngines] = await connection.execute("SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('cl_schema', 'cl_users', 'cl_sessions')");
  if (coreEngines.length !== 3 || ['cl_schema', 'cl_users', 'cl_sessions'].some(table => !coreEngines.some(row => row.tableName === table && row.engine?.toLowerCase() === 'innodb'))) throw new Error('Engine de autorizacao do chat incompativel.');
  const [departments] = await connection.query('SHOW FULL COLUMNS FROM cl_departments');
  const published = departments.find(row => row.Field === 'public_chat');
  if (!published || !/^tinyint(?:\(\d+\))?$/.test(published.Type.toLowerCase()) || published.Null !== 'NO' || String(published.Default) !== '0') throw new Error('Entrada publica incompativel.');
  const expected = {
    cl_visitors: [['id', unsignedInt], ['name', /^varchar\(100\)$/], ['token_hash', /^char\(64\)$/], ['expires_at', dateType], ['created_at', dateType]],
    cl_chat_conversations: [['id', unsignedInt], ['visitor_id', unsignedInt], ['department_id', unsignedInt], ['assigned_to', unsignedInt, true], ['status', /^enum\('waiting','open','closed'\)$/], ['last_sequence', unsignedInt], ['updated_at', dateType], ['created_at', dateType]],
    cl_chat_messages: [['conversation_id', unsignedInt], ['sequence', unsignedInt], ['sender', /^enum\('visitor','team'\)$/], ['author_id', unsignedInt], ['client_key', /^char\(32\)$/], ['text', /^varchar\(2000\)$/], ['created_at', dateType]],
    cl_chat_limits: [['key_hash', /^char\(64\)$/], ['window_start', /^bigint(?:\(\d+\))? unsigned$/], ['count', unsignedInt], ['expires_at', dateType]]
  };
  const indexes = {};
  for (const table of chatTables) {
    const [columns] = await connection.query(`SHOW FULL COLUMNS FROM ${table}`);
    if (columns.length !== expected[table].length || !expected[table].every(([field, type, nullable]) => columns.some(row => row.Field === field && type.test(row.Type.toLowerCase()) && row.Null === (nullable ? 'YES' : 'NO')))) throw new Error('Estrutura do chat incompativel.');
    if (columns.some(row => ['token_hash', 'client_key', 'key_hash'].includes(row.Field) && row.Collation !== 'ascii_bin') ||
      columns.some(row => ['name', 'text'].includes(row.Field) && !/^utf8mb4_.+_ci$/i.test(row.Collation || '')) ||
      columns.some(row => ['created_at', 'updated_at'].includes(row.Field) && !/^current_timestamp(?:\(\))?$/i.test(String(row.Default))) ||
      columns.some(row => ['last_sequence', 'window_start', 'count'].includes(row.Field) && String(row.Default) !== '0') ||
      columns.some(row => row.Field === 'status' && row.Default !== 'waiting') ||
      columns.some(row => row.Field === 'id' && !row.Extra.includes('auto_increment'))) throw new Error('Valores padrao do chat incompativeis.');
    [indexes[table]] = await connection.query(`SHOW INDEX FROM ${table}`);
  }
  const [engines] = await connection.execute("SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('cl_visitors', 'cl_chat_conversations', 'cl_chat_messages', 'cl_chat_limits')");
  if (engines.length !== 4 || chatTables.some(table => !engines.some(row => row.tableName === table && row.engine?.toLowerCase() === 'innodb'))) throw new Error('Engine do chat incompativel.');
  if (!hasIndex(indexes.cl_visitors.filter(row => row.Key_name === 'PRIMARY'), ['id'], true) || !hasIndex(indexes.cl_visitors, ['token_hash'], true) || !hasIndex(indexes.cl_visitors, ['expires_at'], false) ||
    !hasIndex(indexes.cl_chat_conversations.filter(row => row.Key_name === 'PRIMARY'), ['id'], true) || !hasIndex(indexes.cl_chat_conversations, ['visitor_id', 'status', 'id'], false) || !hasIndex(indexes.cl_chat_conversations, ['department_id', 'updated_at', 'id'], false) ||
    !hasIndex(indexes.cl_chat_messages.filter(row => row.Key_name === 'PRIMARY'), ['conversation_id', 'sequence'], true) || !hasIndex(indexes.cl_chat_messages, ['conversation_id', 'sender', 'author_id', 'client_key'], true) ||
    !hasIndex(indexes.cl_chat_limits.filter(row => row.Key_name === 'PRIMARY'), ['key_hash'], true) || !hasIndex(indexes.cl_chat_limits, ['expires_at'], false)) throw new Error('Indices do chat incompativeis.');
  const [foreignKeys] = await connection.execute("SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, REFERENCED_TABLE_NAME AS referencedTable, REFERENCED_COLUMN_NAME AS referencedColumn FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('cl_chat_conversations', 'cl_chat_messages') AND REFERENCED_TABLE_NAME IS NOT NULL");
  const expectedKeys = [['cl_chat_conversations', 'visitor_id', 'cl_visitors'], ['cl_chat_conversations', 'department_id', 'cl_departments'], ['cl_chat_conversations', 'assigned_to', 'cl_users'], ['cl_chat_messages', 'conversation_id', 'cl_chat_conversations']];
  if (foreignKeys.length !== expectedKeys.length || expectedKeys.some(([table, column, referenced]) => !foreignKeys.some(row => row.tableName === table && row.columnName === column && row.referencedTable === referenced && row.referencedColumn === 'id'))) throw new Error('Vinculos do chat incompativeis.');
}

async function verifyContactSchema(connection) {
  const [columns] = await connection.query('SHOW FULL COLUMNS FROM cl_contacts');
  const expected = [
    ['id', unsignedInt, null, 'auto_increment'], ['department_id', unsignedInt, null], ['name', /^varchar\(100\)$/, null],
    ['email', /^varchar\(254\)$/, ''], ['phone', /^varchar\(40\)$/, ''], ['company', /^varchar\(100\)$/, ''],
    ['kind', /^enum\('lead','contact','customer'\)$/, 'lead'], ['version', unsignedInt, '1'], ['created_by', unsignedInt, null],
    ['client_key', /^char\(32\)$/, null], ['request_hash', /^char\(64\)$/, null],
    ['created_at', /^datetime(?:\(0\))?$/, null], ['updated_at', /^datetime(?:\(0\))?$/, null]
  ];
  if (columns.length !== expected.length || !expected.every(([field, type, defaultValue, extra = '']) => columns.some(row =>
    row.Field === field && type.test(field === 'kind' ? row.Type : row.Type.toLowerCase()) && row.Null === 'NO' &&
    (defaultValue === null ? row.Default === null : String(row.Default) === defaultValue) && (row.Extra || '').toLowerCase() === extra))) throw new Error('Estrutura de contatos incompativel.');
  if (columns.some(row => ['client_key', 'request_hash'].includes(row.Field) && row.Collation !== 'ascii_bin') ||
    columns.some(row => ['name', 'email', 'phone', 'company', 'kind'].includes(row.Field) && row.Collation !== 'utf8mb4_unicode_ci')) throw new Error('Collation de contatos incompativel.');
  const [tables] = await connection.execute("SELECT TABLE_NAME AS tableName, ENGINE AS engine, TABLE_COLLATION AS tableCollation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cl_contacts'");
  if (tables.length !== 1 || tables[0].tableName !== 'cl_contacts' || tables[0].engine?.toLowerCase() !== 'innodb' || tables[0].tableCollation !== 'utf8mb4_unicode_ci') throw new Error('Engine ou collation de contatos incompativel.');
  const [indexes] = await connection.query('SHOW INDEX FROM cl_contacts');
  if (!hasIndex(indexes.filter(row => row.Key_name === 'PRIMARY'), ['id'], true) ||
    !hasIndex(indexes, ['created_by', 'client_key'], true) || !hasIndex(indexes, ['department_id', 'kind', 'updated_at', 'id'], false)) throw new Error('Indices de contatos incompativeis.');
  const uniqueNames = new Set(indexes.filter(row => Number(row.Non_unique) === 0).map(row => row.Key_name));
  if ([...uniqueNames].some(key => !hasIndex(indexes.filter(row => row.Key_name === key), key === 'PRIMARY' ? ['id'] : ['created_by', 'client_key'], true))) throw new Error('Unicidade de contatos incompativel.');
  const [foreignKeys] = await connection.execute("SELECT k.COLUMN_NAME AS columnName, k.REFERENCED_TABLE_NAME AS referencedTable, k.REFERENCED_COLUMN_NAME AS referencedColumn, r.DELETE_RULE AS deleteRule, r.UPDATE_RULE AS updateRule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'cl_contacts' AND k.REFERENCED_TABLE_NAME IS NOT NULL");
  const keys = [['department_id', 'cl_departments'], ['created_by', 'cl_users']];
  if (foreignKeys.length !== keys.length || keys.some(([column, table]) => !foreignKeys.some(row => row.columnName === column && row.referencedTable === table && row.referencedColumn === 'id' && row.deleteRule === 'RESTRICT' && row.updateRule === 'RESTRICT'))) throw new Error('Vinculos de contatos incompativeis.');
}

async function migrate(connection, { targetVersion = 4 } = {}) {
  if (![1, 2, 3, 4].includes(targetVersion)) throw new Error('Versao alvo nao reconhecida.');
  // Keep the established lock so an older explicit v1 migrator cannot race this one.
  const [lock] = await connection.execute("SELECT GET_LOCK('conversa-livre-schema-v1', 10) AS acquired");
  if (Number(lock[0]?.acquired) !== 1) throw new Error('Outra migracao em andamento.');
  try {
    const [tables] = await connection.query('SHOW TABLES');
    const names = tables.map(row => Object.values(row)[0]);
    const baseTables = ['cl_schema', 'cl_company', 'cl_users', 'cl_sessions'];
    const allowed = [...baseTables, 'cl_departments', 'cl_department_members', ...chatTables, 'cl_contacts'];
    if (names.some(name => !allowed.includes(name))) throw new Error('Use um banco exclusivo e vazio para o projeto.');
    if (names.length && !names.includes('cl_schema')) throw new Error('Banco sem identificacao do projeto.');
    let version = 0;
    if (names.includes('cl_schema')) {
      const [rows] = await connection.execute('SELECT version FROM cl_schema WHERE id = 1');
      // A crash between creating the marker table and inserting its row is resumable.
      if (!rows.length && names.length !== 1) throw new Error('Banco sem identificacao do projeto.');
      version = rows.length ? Number(rows[0].version) : 0;
      if (![0, 1, 2, 3, 4].includes(version)) throw new Error('Versao nao reconhecida; verifique a migracao anterior.');
    }
    if (version > targetVersion) throw new Error('Downgrade de schema nao permitido.');
    if (version >= 1 && baseTables.some(name => !names.includes(name))) throw new Error('Estrutura base incompleta.');
    if (version === 0 && names.some(name => name.startsWith('cl_department'))) throw new Error('Estrutura sem versao base concluida.');
    if (version < 2 && names.some(name => chatTables.includes(name))) throw new Error('Estrutura sem departamentos concluidos.');
    if (version >= 2 && ['cl_departments', 'cl_department_members'].some(name => !names.includes(name))) throw new Error('Estrutura de departamentos incompleta.');
    if (version >= 3 && chatTables.some(name => !names.includes(name))) throw new Error('Estrutura do chat incompleta.');
    if (version < 3 && names.includes('cl_contacts')) throw new Error('Estrutura sem chat concluido.');
    if (version === 4 && !names.includes('cl_contacts')) throw new Error('Estrutura de contatos incompleta.');
    // MySQL DDL commits implicitly. Keep v1 intact while v2 is partial, and resume by table.
    if (version === 0) {
      await connection.query(statements[0]);
      await connection.execute('INSERT IGNORE INTO cl_schema (id, version) VALUES (1, 0)');
      for (const statement of statements.slice(1)) await connection.query(statement);
      await verifyBaseSchema(connection);
      await connection.execute('UPDATE cl_schema SET version = 1 WHERE id = 1');
      version = 1;
    } else await verifyBaseSchema(connection);
    if (targetVersion >= 2) {
      if (version === 1) for (const statement of departmentStatements) await connection.query(statement);
      await verifyDepartmentSchema(connection);
      if (version === 1) { await connection.execute('UPDATE cl_schema SET version = 2 WHERE id = 1'); version = 2; }
    }
    if (targetVersion >= 3) {
      if (version === 2) {
        const [columns] = await connection.query('SHOW FULL COLUMNS FROM cl_departments');
        if (!columns.some(row => row.Field === 'public_chat')) await connection.query('ALTER TABLE cl_departments ADD COLUMN public_chat TINYINT NOT NULL DEFAULT 0');
        for (const statement of chatStatements) await connection.query(statement);
      }
      await verifyChatSchema(connection);
      if (version === 2) { await connection.execute('UPDATE cl_schema SET version = 3 WHERE id = 1'); version = 3; }
    }
    if (targetVersion === 4) {
      if (version === 3) await connection.query(contactStatement);
      await verifyContactSchema(connection);
      if (version === 3) await connection.execute('UPDATE cl_schema SET version = 4 WHERE id = 1');
    }
    return { schemaVersion: targetVersion };
  } finally { await connection.execute("SELECT RELEASE_LOCK('conversa-livre-schema-v1')"); }
}

async function main() {
  loadEnvironment();
  const options = databaseOptions();
  if (!options) throw new Error('Configure o banco privado antes de migrar.');
  let connection;
  try { connection = await mysql.createConnection(options); const result = await migrate(connection); process.stdout.write(`Estrutura v${result.schemaVersion} preparada. Nenhum administrador foi criado ou senha alterada.\n`); }
  finally { if (connection) await connection.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Migracao interrompida. Confira configuracao, banco exclusivo e acesso MySQL.\n'); process.exitCode = 1; });
module.exports = { migrate, verifyDepartmentSchema, verifyChatSchema, verifyContactSchema };
