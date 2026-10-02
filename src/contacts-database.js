'use strict';

const { digest } = require('./security');

function contactsRepository(pool, { transaction, capabilities }) {
  const failure = statusCode => { const error = new Error(); error.statusCode = statusCode; return error; };
  const maximumId = 4294967295;
  const editable = ['name', 'email', 'phone', 'company', 'kind'];
  const kinds = ['lead', 'contact', 'customer'];
  const fields = 'c.id, c.department_id AS departmentId, d.name AS departmentName, c.name, c.email, c.phone, c.company, c.kind, c.version, c.created_at AS createdAt, c.updated_at AS updatedAt';
  const from = 'FROM cl_contacts c JOIN cl_departments d ON d.id = c.department_id';
  const timestamp = value => value instanceof Date ? value.toISOString() : value;
  const safeContact = row => ({
    id: Number(row.id), departmentId: Number(row.departmentId), departmentName: row.departmentName,
    name: row.name, email: row.email, phone: row.phone, company: row.company, kind: row.kind,
    version: Number(row.version), createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt)
  });

  function integer(value) {
    if (!Number.isInteger(value) || value < 1 || value > maximumId) throw failure(400);
    return value;
  }
  function object(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).some(key => !allowed.includes(key))) throw failure(400);
  }
  function rawString(value, maximum) {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw failure(400);
    return value;
  }
  function normalized(value, maximum, minimum = 0) {
    const result = rawString(value, maximum).trim().normalize('NFC');
    if (result.length < minimum || result.length > maximum) throw failure(400);
    return result;
  }
  function email(value) {
    const result = rawString(value, 254).trim().toLowerCase();
    if (!/^[\x20-\x7e]*$/.test(result) || (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))) throw failure(400);
    return result;
  }
  function phone(value) {
    const result = rawString(value, 40).trim();
    if (!/^[0-9+() -]*$/.test(result)) throw failure(400);
    return result;
  }
  function kind(value) { if (!kinds.includes(value)) throw failure(400); return value; }
  function normalizeFields(input, partial = false) {
    const result = {};
    if (!partial || Object.hasOwn(input, 'name')) result.name = normalized(input.name, 100, 2);
    if (!partial || Object.hasOwn(input, 'email')) result.email = email(Object.hasOwn(input, 'email') ? input.email : '');
    if (!partial || Object.hasOwn(input, 'phone')) result.phone = phone(Object.hasOwn(input, 'phone') ? input.phone : '');
    if (!partial || Object.hasOwn(input, 'company')) result.company = normalized(Object.hasOwn(input, 'company') ? input.company : '', 100);
    if (!partial || Object.hasOwn(input, 'kind')) result.kind = kind(input.kind);
    return result;
  }
  function createInput(input) {
    object(input, ['departmentId', ...editable, 'clientKey']);
    if (['departmentId', 'name', 'kind', 'clientKey'].some(key => !Object.hasOwn(input, key))) throw failure(400);
    if (typeof input.clientKey !== 'string' || !/^[a-f0-9]{32}$/.test(input.clientKey)) throw failure(400);
    const contact = { departmentId: integer(input.departmentId), ...normalizeFields(input) };
    return { contact, clientKey: input.clientKey, requestHash: digest(JSON.stringify(contact)) };
  }
  function patchInput(input) {
    object(input, ['version', ...editable]);
    if (!Object.hasOwn(input, 'version') || !editable.some(key => Object.hasOwn(input, key))) throw failure(400);
    return { version: integer(input.version), changes: normalizeFields(input, true) };
  }
  function filters(input) {
    object(input, ['kind', 'q', 'departmentId']);
    const selected = Object.hasOwn(input, 'kind') ? input.kind : 'all';
    if (!['all', ...kinds].includes(selected)) throw failure(400);
    const q = normalized(Object.hasOwn(input, 'q') ? input.q : '', 100);
    const departmentId = Object.hasOwn(input, 'departmentId') ? integer(input.departmentId) : undefined;
    return { kind: selected, q, departmentId };
  }
  function pagination(page, limit) {
    if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw failure(400);
  }
  function tokenHash(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw failure(401);
    return digest(token);
  }
  async function coordinated(work) {
    return transaction(async connection => {
      // Acquire before the first consistent read under REPEATABLE READ.
      await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
      if ((await capabilities(connection)).contacts !== true) throw failure(503);
      return work(connection);
    });
  }
  async function actor(connection, actorId, token) {
    integer(actorId);
    const hash = tokenHash(token);
    const [users] = await connection.execute('SELECT id, role FROM cl_users WHERE id = ? AND active = 1 FOR UPDATE', [actorId]);
    if (!users.length || !['admin', 'operator'].includes(users[0].role)) throw failure(401);
    const [sessions] = await connection.execute('SELECT user_id FROM cl_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP() FOR UPDATE', [hash, actorId]);
    if (!sessions.length) throw failure(401);
    return { id: Number(users[0].id), role: users[0].role };
  }
  async function allowedDepartment(connection, user, departmentId) {
    const [rows] = await connection.execute('SELECT id, active FROM cl_departments WHERE id = ? FOR UPDATE', [departmentId]);
    if (!rows.length || Number(rows[0].active) !== 1) return false;
    if (user.role === 'admin') return true;
    const [members] = await connection.execute('SELECT user_id FROM cl_department_members WHERE department_id = ? AND user_id = ? FOR UPDATE', [departmentId, user.id]);
    return members.length > 0;
  }
  async function contact(connection, id) {
    const [rows] = await connection.execute('SELECT id, department_id AS departmentId, name, email, phone, company, kind, version FROM cl_contacts WHERE id = ? FOR UPDATE', [id]);
    return rows[0] || null;
  }
  async function safeContactById(connection, id) {
    const [rows] = await connection.execute('SELECT ' + fields + ' ' + from + ' WHERE c.id = ?', [id]);
    if (!rows.length) throw new Error();
    return safeContact(rows[0]);
  }

  return {
    async listContacts(actorId, token, page, limit, options = {}) {
      pagination(page, limit);
      const selected = filters(options);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const conditions = ['d.active = 1', "(? = 'admin' OR EXISTS (SELECT 1 FROM cl_department_members m WHERE m.department_id = c.department_id AND m.user_id = ?))"];
        const values = [user.role, user.id];
        if (selected.kind !== 'all') { conditions.push('c.kind = ?'); values.push(selected.kind); }
        if (selected.departmentId !== undefined) { conditions.push('c.department_id = ?'); values.push(selected.departmentId); }
        if (selected.q) {
          const pattern = '%' + selected.q.replace(/[!%_]/g, character => '!' + character) + '%';
          conditions.push("(c.name LIKE ? ESCAPE '!' OR c.email LIKE ? ESCAPE '!' OR c.phone LIKE ? ESCAPE '!' OR c.company LIKE ? ESCAPE '!')");
          values.push(pattern, pattern, pattern, pattern);
        }
        const scope = from + ' WHERE ' + conditions.join(' AND ');
        const [counts] = await connection.execute('SELECT COUNT(*) AS total ' + scope, values);
        const [rows] = await connection.execute('SELECT ' + fields + ' ' + scope + ' ORDER BY c.updated_at DESC, c.id DESC LIMIT ' + limit + ' OFFSET ' + ((page - 1) * limit), values);
        return { contacts: rows.map(safeContact), total: Number(counts[0].total), page, limit };
      });
    },
    async findContact(actorId, token, id) {
      integer(id);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const row = await contact(connection, id);
        if (!row || !await allowedDepartment(connection, user, Number(row.departmentId))) return null;
        return { contact: await safeContactById(connection, id) };
      });
    },
    async createContact(actorId, token, input) {
      const normalizedInput = createInput(input);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const [existing] = await connection.execute('SELECT id, department_id AS departmentId, request_hash AS requestHash FROM cl_contacts WHERE created_by = ? AND client_key = ? FOR UPDATE', [user.id, normalizedInput.clientKey]);
        if (existing.length) {
          // Replays require current access and return current data after later edits.
          if (!await allowedDepartment(connection, user, Number(existing[0].departmentId))) throw failure(404);
          if (existing[0].requestHash !== normalizedInput.requestHash) throw failure(409);
          return { contact: await safeContactById(connection, existing[0].id), created: false };
        }
        const data = normalizedInput.contact;
        if (!await allowedDepartment(connection, user, data.departmentId)) throw failure(404);
        const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_contacts');
        if (Number(counts[0].total) >= 5000) throw failure(429);
        const [result] = await connection.execute('INSERT INTO cl_contacts (department_id, name, email, phone, company, kind, created_by, client_key, request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
          [data.departmentId, data.name, data.email, data.phone, data.company, data.kind, user.id, normalizedInput.clientKey, normalizedInput.requestHash]);
        return { contact: await safeContactById(connection, result.insertId), created: true };
      });
    },
    async updateContact(actorId, token, id, input) {
      integer(id);
      const patch = patchInput(input);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const row = await contact(connection, id);
        if (!row || !await allowedDepartment(connection, user, Number(row.departmentId))) return null;
        const version = Number(row.version);
        if (version !== patch.version) throw failure(409);
        const changed = Object.keys(patch.changes).some(field => patch.changes[field] !== row[field]);
        if (!changed) return { contact: await safeContactById(connection, id) };
        if (version >= maximumId) throw failure(409);
        const next = { ...row, ...patch.changes };
        const [result] = await connection.execute('UPDATE cl_contacts SET name = ?, email = ?, phone = ?, company = ?, kind = ?, version = version + 1, updated_at = UTC_TIMESTAMP() WHERE id = ? AND version = ?',
          [next.name, next.email, next.phone, next.company, next.kind, id, patch.version]);
        if (Number(result.affectedRows) !== 1) throw failure(409);
        return { contact: await safeContactById(connection, id) };
      });
    }
  };
}

module.exports = { contactsRepository };
