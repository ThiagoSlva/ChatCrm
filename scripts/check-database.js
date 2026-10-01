'use strict';

const mysql = require('mysql2/promise');
const { loadEnvironment } = require('../src/server');

loadEnvironment();

async function checkDatabase() {
  if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER) {
    process.stderr.write('Configure DB_HOST, DB_NAME e DB_USER no ambiente ou arquivo .env privado.\n');
    process.exitCode = 1;
    return;
  }

  const port = Number(process.env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write('DB_PORT deve ser uma porta valida.\n');
    process.exitCode = 1;
    return;
  }

  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME,
      connectTimeout: 5000
    });
    await connection.execute('SELECT 1');
    process.stdout.write('Conexao MySQL verificada. Nenhuma tabela ou dado foi alterado.\n');
  } catch {
    process.stderr.write('Conexao MySQL falhou. Verifique credenciais, permissoes e disponibilidade.\n');
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end();
  }
}

checkDatabase().catch(() => {
  process.stderr.write('Nao foi possivel concluir o diagnostico do banco.\n');
  process.exitCode = 1;
});
