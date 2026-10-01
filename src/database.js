'use strict';

const mysql = require('mysql2/promise');
const { digest } = require('./security');

function databaseOptions(env = process.env) {
  if (!env.DB_HOST || !env.DB_NAME || !env.DB_USER || !env.DB_PASSWORD) return null;
  const port = Number(env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DB_PORT invalida.');
  return { host: env.DB_HOST, port, database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD,
    charset: 'utf8mb4', timezone: 'Z', connectionLimit: 3, waitForConnections: true,
    queueLimit: 20, connectTimeout: 5000, multipleStatements: false };
}

function createRepository(env = process.env) {
  const options = databaseOptions(env);
  if (!options) return null;
  const pool = mysql.createPool(options);
  return {
    async status() {
      const [schema] = await pool.execute('SELECT version FROM cl_schema WHERE id = 1');
      if (schema[0]?.version !== 1) throw new Error('Schema incompativel.');
      const [rows] = await pool.execute('SELECT id FROM cl_users LIMIT 1');
      return rows.length ? 'installed' : 'setup';
    },
    async install({ company, name, email, passwordHash }) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        // This permanent singleton row serializes first-admin creation across processes.
        await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
        const [users] = await connection.execute('SELECT id FROM cl_users LIMIT 1');
        if (users.length) { const error = new Error('Instalacao concluida.'); error.statusCode = 409; throw error; }
        await connection.execute('INSERT INTO cl_company (id, name) VALUES (1, ?)', [company]);
        await connection.execute('INSERT INTO cl_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [name, email, passwordHash, 'admin']);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
    async findUser(email) {
      const [rows] = await pool.execute('SELECT id, name, email, role, password_hash AS passwordHash FROM cl_users WHERE email = ? AND active = 1', [email]);
      return rows[0] || null;
    },
    async createSession(token, userId) {
      await pool.execute('DELETE FROM cl_sessions WHERE expires_at <= UTC_TIMESTAMP()');
      await pool.execute('INSERT INTO cl_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))', [digest(token), userId]);
    },
    async session(token) {
      const [rows] = await pool.execute('SELECT u.id, u.name, u.email, u.role FROM cl_sessions s JOIN cl_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.active = 1', [digest(token)]);
      return rows[0] || null;
    },
    async revoke(token) { await pool.execute('DELETE FROM cl_sessions WHERE token_hash = ?', [digest(token)]); },
    async company() { const [rows] = await pool.execute('SELECT name FROM cl_company WHERE id = 1'); return rows[0]?.name || ''; },
    async close() { await pool.end(); }
  };
}

module.exports = { databaseOptions, createRepository };
