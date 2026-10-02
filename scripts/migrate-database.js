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
    return sorted.length === columns.length && sorted.every((row, i) => row.Column_name === columns[i] && !row.Sub_part && (!unique || Number(row.Non_unique) === 0));
  });
}

async function verifyDepartmentSchema(connection) {
  const [departments] = await connection.query('SHOW FULL COLUMNS FROM cl_departments');
  const [members] = await connection.query('SHOW COLUMNS FROM cl_department_members');
  const columnsMatch = (rows, expected) => rows.length === expected.length && expected.every(([name, type]) => rows.some(row => row.Field === name && type.test(row.Type.toLowerCase()) && row.Null === 'NO'));
  if (!columnsMatch(departments, [['id', /^int(?:\(\d+\))? unsigned$/], ['name', /^varchar\(100\)$/], ['active', /^tinyint(?:\(\d+\))?$/], ['created_at', /^timestamp(?:\(\d+\))?$/]]) ||
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

async function migrate(connection, { targetVersion = 2 } = {}) {
  if (![1, 2].includes(targetVersion)) throw new Error('Versao alvo nao reconhecida.');
  // Keep the established lock so an older explicit v1 migrator cannot race this one.
  const [lock] = await connection.execute("SELECT GET_LOCK('conversa-livre-schema-v1', 10) AS acquired");
  if (Number(lock[0]?.acquired) !== 1) throw new Error('Outra migracao em andamento.');
  try {
    const [tables] = await connection.query('SHOW TABLES');
    const names = tables.map(row => Object.values(row)[0]);
    const baseTables = ['cl_schema', 'cl_company', 'cl_users', 'cl_sessions'];
    const allowed = [...baseTables, 'cl_departments', 'cl_department_members'];
    if (names.some(name => !allowed.includes(name))) throw new Error('Use um banco exclusivo e vazio para o projeto.');
    if (names.length && !names.includes('cl_schema')) throw new Error('Banco sem identificacao do projeto.');
    let version = 0;
    if (names.includes('cl_schema')) {
      const [rows] = await connection.execute('SELECT version FROM cl_schema WHERE id = 1');
      // A crash between creating the marker table and inserting its row is resumable.
      if (!rows.length && names.length !== 1) throw new Error('Banco sem identificacao do projeto.');
      version = rows.length ? Number(rows[0].version) : 0;
      if (![0, 1, 2].includes(version)) throw new Error('Versao nao reconhecida; verifique a migracao anterior.');
    }
    if (version > targetVersion) throw new Error('Downgrade de schema nao permitido.');
    if (version >= 1 && baseTables.some(name => !names.includes(name))) throw new Error('Estrutura base incompleta.');
    if (version === 0 && names.some(name => name.startsWith('cl_department'))) throw new Error('Estrutura sem versao base concluida.');
    // MySQL DDL commits implicitly. Keep v1 intact while v2 is partial, and resume by table.
    if (version === 0) {
      await connection.query(statements[0]);
      await connection.execute('INSERT IGNORE INTO cl_schema (id, version) VALUES (1, 0)');
      for (const statement of statements.slice(1)) await connection.query(statement);
      await verifyBaseSchema(connection);
      await connection.execute('UPDATE cl_schema SET version = 1 WHERE id = 1');
      version = 1;
    } else await verifyBaseSchema(connection);
    if (targetVersion === 2) {
      if (version === 1) for (const statement of departmentStatements) await connection.query(statement);
      await verifyDepartmentSchema(connection);
      if (version === 1) await connection.execute('UPDATE cl_schema SET version = 2 WHERE id = 1');
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
module.exports = { migrate, verifyDepartmentSchema };
