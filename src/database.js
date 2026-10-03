'use strict';

const mysql = require('mysql2/promise');
const { digest, equal } = require('./security');
const { chatRepository } = require('./chat-database');
const { contactsRepository } = require('./contacts-database');
const { opportunitiesRepository } = require('./opportunities-database');
const { conversationContactsRepository } = require('./conversation-contacts-database');
const { portalRepository } = require('./portal-database');

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
  return repositoryForPool(pool);
}

function repositoryForPool(pool) {
  const failure = statusCode => { const error = new Error(); error.statusCode = statusCode; return error; };
  async function capabilities(connection = pool) {
    const [schema] = await connection.execute('SELECT version FROM cl_schema WHERE id = 1');
    const schemaVersion = Number(schema[0]?.version);
    if (![1, 2, 3, 4, 5, 6, 7].includes(schemaVersion)) throw new Error('Schema incompativel.');
    return { schemaVersion, departments: schemaVersion >= 2, ...(schemaVersion >= 3 ? { chat: true } : {}), ...(schemaVersion >= 4 ? { contacts: true } : {}), ...(schemaVersion >= 5 ? { opportunities: true } : {}), ...(schemaVersion >= 6 ? { conversationContacts: true } : {}), ...(schemaVersion >= 7 ? { portal: true } : {}) };
  }
  async function requireDepartments(connection = pool) {
    if (!(await capabilities(connection)).departments) throw failure(503);
  }
  async function requireAdmin(connection, actorId, lock = false) {
    const [actors] = await connection.execute(`SELECT role, active FROM cl_users WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [actorId]);
    if (!actors[0] || actors[0].role !== 'admin' || !actors[0].active) throw failure(403);
  }
  function validatePagination(page, limit) {
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw failure(400);
  }
  function departmentName(name) {
    if (typeof name !== 'string') throw failure(400);
    const normalized = name.trim().normalize('NFC');
    if (normalized.length < 2 || normalized.length > 100) throw failure(400);
    return normalized;
  }
  const safeDepartment = row => ({ id: row.id, name: row.name, active: Boolean(row.active) });
  const departmentScope = `FROM cl_departments d
    JOIN cl_users actor ON actor.id = ? AND actor.active = 1
    LEFT JOIN cl_department_members m ON m.department_id = d.id AND m.user_id = actor.id
    WHERE (actor.role = 'admin' OR (actor.role = 'operator' AND d.active = 1 AND m.user_id IS NOT NULL))`;
  async function transaction(work) {
    const connection = await pool.getConnection();
    try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  const userFields = 'id, name, email, role, active';
  return {
    ...chatRepository(pool, { transaction, capabilities }),
    ...contactsRepository(pool, { transaction, capabilities }),
    ...opportunitiesRepository(pool, { transaction, capabilities }),
    ...conversationContactsRepository(pool, { transaction, capabilities }),
    ...portalRepository(pool, { transaction, capabilities }),
    capabilities,
    async status() {
      await capabilities();
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
    async createSession(token, userId, expectedPasswordHash) {
      await pool.execute('DELETE FROM cl_sessions WHERE expires_at <= UTC_TIMESTAMP()');
      return transaction(async connection => {
        // Serialize login with deactivation and password changes; verified credentials must still match.
        const [users] = await connection.execute('SELECT password_hash AS passwordHash FROM cl_users WHERE id = ? AND active = 1 FOR UPDATE', [userId]);
        if (!users.length || !equal(users[0].passwordHash, expectedPasswordHash)) return false;
        await connection.execute('INSERT INTO cl_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))', [digest(token), userId]);
        return true;
      });
    },
    async changePassword(userId, expectedPasswordHash, passwordHash, token) {
      return transaction(async connection => {
        const [users] = await connection.execute('SELECT password_hash AS passwordHash FROM cl_users WHERE id = ? AND active = 1 FOR UPDATE', [userId]);
        if (!users.length || !equal(users[0].passwordHash, expectedPasswordHash)) return false;
        const [sessions] = await connection.execute('SELECT user_id FROM cl_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP() FOR UPDATE', [digest(token), userId]);
        if (!sessions.length) return false;
        await connection.execute('UPDATE cl_users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
        await connection.execute('DELETE FROM cl_sessions WHERE user_id = ?', [userId]);
        return true;
      });
    },
    async session(token) {
      const [rows] = await pool.execute('SELECT u.id, u.name, u.email, u.role FROM cl_sessions s JOIN cl_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.active = 1', [digest(token)]);
      return rows[0] || null;
    },
    async revoke(token) { await pool.execute('DELETE FROM cl_sessions WHERE token_hash = ?', [digest(token)]); },
    async company() { const [rows] = await pool.execute('SELECT name FROM cl_company WHERE id = 1'); return rows[0]?.name || ''; },
    async listOperators(page, limit) {
      const [counts] = await pool.execute("SELECT COUNT(*) AS total FROM cl_users WHERE role = 'operator'");
      // Integers are validated by the route; no user strings enter this SQL fragment.
      const [rows] = await pool.execute(`SELECT ${userFields} FROM cl_users WHERE role = 'operator' ORDER BY id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`);
      return { users: rows.map(row => ({ ...row, active: Boolean(row.active) })), total: Number(counts[0].total), page, limit };
    },
    async createOperator({ name, email, passwordHash }) {
      return transaction(async connection => {
        await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
        const [counts] = await connection.execute("SELECT COUNT(*) AS total FROM cl_users WHERE role = 'operator'");
        if (Number(counts[0].total) >= 200) { const error = new Error(); error.statusCode = 409; throw error; }
        let result;
        try { [result] = await connection.execute("INSERT INTO cl_users (name, email, password_hash, role) VALUES (?, ?, ?, 'operator')", [name, email, passwordHash]); }
        catch (error) { if (error.code === 'ER_DUP_ENTRY') error.statusCode = 409; throw error; }
        const [rows] = await connection.execute(`SELECT ${userFields} FROM cl_users WHERE id = ?`, [result.insertId]);
        return { ...rows[0], active: Boolean(rows[0].active) };
      });
    },
    async setOperatorActive(id, active) {
      return transaction(async connection => {
        const [rows] = await connection.execute(`SELECT ${userFields} FROM cl_users WHERE id = ? AND role = 'operator' FOR UPDATE`, [id]);
        if (!rows.length) return null;
        await connection.execute("UPDATE cl_users SET active = ? WHERE id = ? AND role = 'operator'", [active ? 1 : 0, id]);
        // Revocation is in the same transaction, including idempotent deactivations.
        if (!active) await connection.execute('DELETE FROM cl_sessions WHERE user_id = ?', [id]);
        return { ...rows[0], active };
      });
    },
    async listDepartments(actorId, page, limit) {
      validatePagination(page, limit);
      await requireDepartments();
      const [counts] = await pool.execute(`SELECT COUNT(*) AS total ${departmentScope}`, [actorId]);
      const [rows] = await pool.execute(`SELECT d.id, d.name, d.active ${departmentScope} ORDER BY d.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, [actorId]);
      return { departments: rows.map(safeDepartment), total: Number(counts[0].total), page, limit };
    },
    async findDepartment(actorId, id) {
      await requireDepartments();
      const [rows] = await pool.execute(`SELECT d.id, d.name, d.active ${departmentScope} AND d.id = ?`, [actorId, id]);
      return rows[0] ? safeDepartment(rows[0]) : null;
    },
    async createDepartment(actorId, { name }) {
      const normalized = departmentName(name);
      return transaction(async connection => {
        // Acquire before any consistent read: REPEATABLE READ must not snapshot the
        // department count before waiting for another creation to commit.
        await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
        await requireDepartments(connection);
        await requireAdmin(connection, actorId, true);
        const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_departments');
        if (Number(counts[0].total) >= 50) throw failure(409);
        let result;
        try { [result] = await connection.execute('INSERT INTO cl_departments (name) VALUES (?)', [normalized]); }
        catch (error) { if (error.code === 'ER_DUP_ENTRY') error.statusCode = 409; throw error; }
        return { id: result.insertId, name: normalized, active: true };
      });
    },
    async updateDepartment(actorId, id, changes) {
      if (!changes || typeof changes !== 'object' || Object.keys(changes).some(key => !['name', 'active'].includes(key)) || !Object.keys(changes).length) throw failure(400);
      const name = Object.hasOwn(changes, 'name') ? departmentName(changes.name) : undefined;
      if (Object.hasOwn(changes, 'active') && typeof changes.active !== 'boolean') throw failure(400);
      return transaction(async connection => {
        await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
        await requireDepartments(connection);
        await requireAdmin(connection, actorId, true);
        const [rows] = await connection.execute('SELECT id, name, active FROM cl_departments WHERE id = ? FOR UPDATE', [id]);
        if (!rows.length) return null;
        const department = safeDepartment(rows[0]);
        if (name !== undefined) department.name = name;
        if (Object.hasOwn(changes, 'active')) department.active = changes.active;
        try { await connection.execute('UPDATE cl_departments SET name = ?, active = ? WHERE id = ?', [department.name, department.active ? 1 : 0, id]); }
        catch (error) { if (error.code === 'ER_DUP_ENTRY') error.statusCode = 409; throw error; }
        return department;
      });
    },
    async listDepartmentMembers(actorId, departmentId, page, limit) {
      validatePagination(page, limit);
      await requireDepartments();
      await requireAdmin(pool, actorId);
      const [departments] = await pool.execute('SELECT id FROM cl_departments WHERE id = ?', [departmentId]);
      if (!departments.length) return null;
      const scope = "FROM cl_department_members m JOIN cl_users u ON u.id = m.user_id WHERE m.department_id = ? AND u.role = 'operator'";
      const [counts] = await pool.execute(`SELECT COUNT(*) AS total ${scope}`, [departmentId]);
      const [rows] = await pool.execute(`SELECT u.id, u.name, u.email, u.role, u.active ${scope} ORDER BY u.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, [departmentId]);
      return { users: rows.map(row => ({ ...row, active: Boolean(row.active) })), total: Number(counts[0].total), page, limit };
    },
    async setDepartmentMember(actorId, departmentId, operatorId, member) {
      if (typeof member !== 'boolean') throw failure(400);
      return transaction(async connection => {
        await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
        await requireDepartments(connection);
        await requireAdmin(connection, actorId, true);
        const [departments] = await connection.execute('SELECT id FROM cl_departments WHERE id = ? FOR UPDATE', [departmentId]);
        if (!departments.length) return null;
        const [users] = await connection.execute("SELECT id FROM cl_users WHERE id = ? AND role = 'operator' FOR UPDATE", [operatorId]);
        if (!users.length) return null;
        if (member) await connection.execute('INSERT IGNORE INTO cl_department_members (department_id, user_id) VALUES (?, ?)', [departmentId, operatorId]);
        else await connection.execute('DELETE FROM cl_department_members WHERE department_id = ? AND user_id = ?', [departmentId, operatorId]);
        return { departmentId, userId: operatorId, member };
      });
    },
    async close() { await pool.end(); }
  };
}

module.exports = { databaseOptions, createRepository, repositoryForPool };
