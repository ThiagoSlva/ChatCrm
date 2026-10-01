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

async function migrate(connection) {
  const [lock] = await connection.execute("SELECT GET_LOCK('conversa-livre-schema-v1', 10) AS acquired");
  if (Number(lock[0]?.acquired) !== 1) throw new Error('Outra migracao em andamento.');
  try {
    const [tables] = await connection.query('SHOW TABLES');
    const names = tables.map(row => Object.values(row)[0]);
    const allowed = ['cl_schema', 'cl_company', 'cl_users', 'cl_sessions'];
    if (names.some(name => !allowed.includes(name))) throw new Error('Use um banco exclusivo e vazio para o projeto.');
    if (names.length && !names.includes('cl_schema')) throw new Error('Banco sem identificacao do projeto.');
    if (names.includes('cl_schema')) {
      const [rows] = await connection.execute('SELECT version FROM cl_schema WHERE id = 1');
      if (![0, 1].includes(rows[0]?.version)) throw new Error('Versao nao reconhecida; verifique a migracao anterior.');
    }
    // DDL implicitly commits in MySQL: a marker allows an interrupted v1 to resume.
    await connection.query(statements[0]);
    await connection.execute('INSERT IGNORE INTO cl_schema (id, version) VALUES (1, 0)');
    for (const statement of statements.slice(1)) await connection.query(statement);
    await connection.execute('UPDATE cl_schema SET version = 1 WHERE id = 1');
  } finally { await connection.execute("SELECT RELEASE_LOCK('conversa-livre-schema-v1')"); }
}

async function main() {
  loadEnvironment();
  const options = databaseOptions();
  if (!options) throw new Error('Configure o banco privado antes de migrar.');
  let connection;
  try { connection = await mysql.createConnection(options); await migrate(connection); process.stdout.write('Estrutura v1 preparada. Nenhum administrador foi criado.\n'); }
  finally { if (connection) await connection.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Migracao interrompida. Confira configuracao, banco exclusivo e acesso MySQL.\n'); process.exitCode = 1; });
module.exports = { migrate };
