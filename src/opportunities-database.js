'use strict';

const { digest } = require('./security');

function opportunitiesRepository(pool, { transaction, capabilities }) {
  const failure = statusCode => { const error = new Error(); error.statusCode = statusCode; return error; };
  const maximumId = 4294967295;
  const maximumAmount = 999999999;
  const stages = ['new', 'qualified', 'proposal', 'won', 'lost'];
  const editable = ['title', 'amountCents', 'stage'];
  const fields = 'o.id, o.contact_id AS contactId, c.name AS contactName, c.department_id AS departmentId, d.name AS departmentName, o.title, o.amount_cents AS amountCents, o.stage, o.version, o.created_at AS createdAt, o.updated_at AS updatedAt';
  const from = 'FROM cl_opportunities o JOIN cl_contacts c ON c.id = o.contact_id JOIN cl_departments d ON d.id = c.department_id';
  const timestamp = value => value instanceof Date ? value.toISOString() : value;
  const safeOpportunity = row => ({
    id: Number(row.id), contactId: Number(row.contactId), contactName: row.contactName,
    departmentId: Number(row.departmentId), departmentName: row.departmentName,
    title: row.title, amountCents: Number(row.amountCents), currency: 'BRL', stage: row.stage,
    version: Number(row.version), createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt)
  });
  const safeEvent = row => ({
    version: Number(row.version), actorName: row.actorName, title: row.title,
    amountCents: Number(row.amountCents), stage: row.stage, createdAt: timestamp(row.createdAt)
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
  function normalized(value, maximum, minimum = 0) {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw failure(400);
    const result = value.trim().normalize('NFC');
    if (result.length < minimum || result.length > maximum) throw failure(400);
    return result;
  }
  function amount(value) {
    if (!Number.isInteger(value) || value < 0 || value > maximumAmount) throw failure(400);
    return value;
  }
  function stage(value) { if (!stages.includes(value)) throw failure(400); return value; }
  function createInput(input) {
    object(input, ['contactId', 'title', 'amountCents', 'clientKey']);
    if (['contactId', 'title', 'clientKey'].some(key => !Object.hasOwn(input, key))) throw failure(400);
    if (typeof input.clientKey !== 'string' || !/^[a-f0-9]{32}$/.test(input.clientKey)) throw failure(400);
    const opportunity = {
      contactId: integer(input.contactId), title: normalized(input.title, 150, 2),
      amountCents: amount(Object.hasOwn(input, 'amountCents') ? input.amountCents : 0)
    };
    return { opportunity, clientKey: input.clientKey, requestHash: digest(JSON.stringify(opportunity)) };
  }
  function patchInput(input) {
    object(input, ['version', ...editable]);
    if (!Object.hasOwn(input, 'version') || !editable.some(key => Object.hasOwn(input, key))) throw failure(400);
    const changes = {};
    if (Object.hasOwn(input, 'title')) changes.title = normalized(input.title, 150, 2);
    if (Object.hasOwn(input, 'amountCents')) changes.amountCents = amount(input.amountCents);
    if (Object.hasOwn(input, 'stage')) changes.stage = stage(input.stage);
    return { version: integer(input.version), changes };
  }
  function filters(input) {
    object(input, ['stage', 'q', 'departmentId', 'contactId']);
    const selected = Object.hasOwn(input, 'stage') ? input.stage : 'all';
    if (!['all', ...stages].includes(selected)) throw failure(400);
    return {
      stage: selected, q: normalized(Object.hasOwn(input, 'q') ? input.q : '', 100),
      departmentId: Object.hasOwn(input, 'departmentId') ? integer(input.departmentId) : undefined,
      contactId: Object.hasOwn(input, 'contactId') ? integer(input.contactId) : undefined
    };
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
      if ((await capabilities(connection)).opportunities !== true) throw failure(503);
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
  async function allowedContact(connection, user, contactId) {
    const [rows] = await connection.execute('SELECT c.id, c.department_id AS departmentId FROM cl_contacts c JOIN cl_departments d ON d.id = c.department_id AND d.active = 1 WHERE c.id = ? FOR UPDATE', [contactId]);
    if (!rows.length) return false;
    if (user.role === 'admin') return true;
    const [members] = await connection.execute('SELECT user_id FROM cl_department_members WHERE department_id = ? AND user_id = ? FOR UPDATE', [rows[0].departmentId, user.id]);
    return members.length > 0;
  }
  async function opportunity(connection, id) {
    const [rows] = await connection.execute('SELECT id, contact_id AS contactId, title, amount_cents AS amountCents, stage, version FROM cl_opportunities WHERE id = ? FOR UPDATE', [id]);
    return rows.length ? { ...rows[0], amountCents: Number(rows[0].amountCents) } : null;
  }
  async function safeOpportunityById(connection, id) {
    const [rows] = await connection.execute('SELECT ' + fields + ' ' + from + ' WHERE o.id = ?', [id]);
    if (!rows.length) throw new Error();
    return safeOpportunity(rows[0]);
  }
  async function snapshot(connection, id, actorId) {
    // Copy the stored values/date, so opportunity and history cannot diverge.
    const [result] = await connection.execute('INSERT INTO cl_opportunity_events (opportunity_id, version, actor_id, title, amount_cents, stage, created_at) SELECT id, version, ?, title, amount_cents, stage, updated_at FROM cl_opportunities WHERE id = ?', [actorId, id]);
    if (Number(result.affectedRows) !== 1) throw new Error();
  }

  return {
    async listOpportunities(actorId, token, page, limit, options = {}) {
      pagination(page, limit);
      const selected = filters(options);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const conditions = ['d.active = 1', "(? = 'admin' OR EXISTS (SELECT 1 FROM cl_department_members m WHERE m.department_id = c.department_id AND m.user_id = ?))"];
        const values = [user.role, user.id];
        if (selected.stage !== 'all') { conditions.push('o.stage = ?'); values.push(selected.stage); }
        if (selected.departmentId !== undefined) { conditions.push('c.department_id = ?'); values.push(selected.departmentId); }
        if (selected.contactId !== undefined) { conditions.push('o.contact_id = ?'); values.push(selected.contactId); }
        if (selected.q) {
          const pattern = '%' + selected.q.replace(/[!%_]/g, character => '!' + character) + '%';
          conditions.push("(o.title LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!' OR c.company LIKE ? ESCAPE '!')");
          values.push(pattern, pattern, pattern);
        }
        const scope = from + ' WHERE ' + conditions.join(' AND ');
        const [counts] = await connection.execute('SELECT COUNT(*) AS total ' + scope, values);
        const [rows] = await connection.execute('SELECT ' + fields + ' ' + scope + ' ORDER BY o.updated_at DESC, o.id DESC LIMIT ' + limit + ' OFFSET ' + ((page - 1) * limit), values);
        return { opportunities: rows.map(safeOpportunity), total: Number(counts[0].total), page, limit };
      });
    },
    async findOpportunity(actorId, token, id) {
      integer(id);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const row = await opportunity(connection, id);
        if (!row || !await allowedContact(connection, user, Number(row.contactId))) return null;
        return { opportunity: await safeOpportunityById(connection, id) };
      });
    },
    async createOpportunity(actorId, token, input) {
      const normalizedInput = createInput(input);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const [existing] = await connection.execute('SELECT id, contact_id AS contactId, request_hash AS requestHash FROM cl_opportunities WHERE created_by = ? AND client_key = ? FOR UPDATE', [user.id, normalizedInput.clientKey]);
        if (existing.length) {
          // Replays require current contact/department access and return current data.
          if (!await allowedContact(connection, user, Number(existing[0].contactId))) throw failure(404);
          if (existing[0].requestHash !== normalizedInput.requestHash) throw failure(409);
          return { opportunity: await safeOpportunityById(connection, existing[0].id), created: false };
        }
        const data = normalizedInput.opportunity;
        if (!await allowedContact(connection, user, data.contactId)) throw failure(404);
        const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_opportunities');
        if (Number(counts[0].total) >= 5000) throw failure(429);
        const [result] = await connection.execute("INSERT INTO cl_opportunities (contact_id, title, amount_cents, stage, created_by, client_key, request_hash, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
          [data.contactId, data.title, data.amountCents, user.id, normalizedInput.clientKey, normalizedInput.requestHash]);
        await snapshot(connection, result.insertId, user.id);
        return { opportunity: await safeOpportunityById(connection, result.insertId), created: true };
      });
    },
    async updateOpportunity(actorId, token, id, input) {
      integer(id);
      const patch = patchInput(input);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const row = await opportunity(connection, id);
        if (!row || !await allowedContact(connection, user, Number(row.contactId))) return null;
        const version = Number(row.version);
        if (version !== patch.version) throw failure(409);
        const changed = Object.keys(patch.changes).some(field => patch.changes[field] !== row[field]);
        if (!changed) return { opportunity: await safeOpportunityById(connection, id) };
        if (version >= maximumId) throw failure(409);
        const next = { ...row, ...patch.changes };
        const [result] = await connection.execute('UPDATE cl_opportunities SET title = ?, amount_cents = ?, stage = ?, version = version + 1, updated_at = UTC_TIMESTAMP() WHERE id = ? AND version = ?',
          [next.title, next.amountCents, next.stage, id, patch.version]);
        if (Number(result.affectedRows) !== 1) throw failure(409);
        await snapshot(connection, id, user.id);
        return { opportunity: await safeOpportunityById(connection, id) };
      });
    },
    async listOpportunityEvents(actorId, token, id, page, limit) {
      integer(id); pagination(page, limit);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const row = await opportunity(connection, id);
        if (!row || !await allowedContact(connection, user, Number(row.contactId))) return null;
        const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_opportunity_events WHERE opportunity_id = ?', [id]);
        const [rows] = await connection.execute('SELECT e.version, u.name AS actorName, e.title, e.amount_cents AS amountCents, e.stage, e.created_at AS createdAt FROM cl_opportunity_events e JOIN cl_users u ON u.id = e.actor_id WHERE e.opportunity_id = ? ORDER BY e.version DESC LIMIT ' + limit + ' OFFSET ' + ((page - 1) * limit), [id]);
        return { events: rows.map(safeEvent), total: Number(counts[0].total), page, limit };
      });
    }
  };
}

module.exports = { opportunitiesRepository };
