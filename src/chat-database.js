'use strict';

const { digest } = require('./security');

function chatRepository(pool, { transaction, capabilities }) {
  const fail = code => { const error = new Error(); error.statusCode = code; return error; };
  const timestamp = value => value instanceof Date ? value.toISOString() : value;
  const conversationFields = 'c.id, c.department_id AS departmentId, d.name AS departmentName, v.name AS visitorName, c.status, c.assigned_to AS assignedTo, c.updated_at AS updatedAt';
  const conversationFrom = 'FROM cl_chat_conversations c JOIN cl_departments d ON d.id = c.department_id JOIN cl_visitors v ON v.id = c.visitor_id';
  const messageFields = '`sequence`, text, sender, created_at AS createdAt';
  const safeConversation = row => ({ id: Number(row.id), departmentId: Number(row.departmentId), departmentName: row.departmentName,
    visitorName: row.visitorName, status: row.status, assignedTo: row.assignedTo === null ? null : Number(row.assignedTo), updatedAt: timestamp(row.updatedAt) });
  const safeMessage = row => ({ sequence: Number(row.sequence), text: row.text, sender: row.sender, createdAt: timestamp(row.createdAt) });
  function tokenHash(token) { if (!/^[a-f0-9]{64}$/.test(token || '')) throw fail(401); return digest(token); }
  function validatePage(page, limit) { if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw fail(400); }
  function validateHistory(after, limit) { if (!Number.isInteger(after) || after < 0 || after > 4294967295) throw fail(400); validatePage(1, limit); }
  function content({ text, clientKey }) {
    if (typeof text !== 'string' || !/^[a-f0-9]{32}$/.test(clientKey || '')) throw fail(400);
    const trimmed = text.trim();
    if (!trimmed.length || trimmed.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) throw fail(400);
    return { text: trimmed, clientKey };
  }
  async function ready(connection = pool) { if (!(await capabilities(connection)).chat) throw fail(503); }
  async function coordinated(work) {
    return transaction(async connection => {
      // Global serialization keeps authorization, idempotency, sequence and budgets atomic.
      // It must precede every consistent read under REPEATABLE READ.
      await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
      await ready(connection);
      return work(connection);
    });
  }
  async function visitor(connection, token, lock = true) {
    const [rows] = await connection.execute(`SELECT id, name FROM cl_visitors WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP()${lock ? ' FOR UPDATE' : ''}`, [tokenHash(token)]);
    if (!rows.length) throw fail(401);
    return { id: Number(rows[0].id), name: rows[0].name };
  }
  async function actor(connection, id, token) {
    const [users] = await connection.execute('SELECT id, role FROM cl_users WHERE id = ? AND active = 1 FOR UPDATE', [id]);
    if (!users.length || !['admin', 'operator'].includes(users[0].role)) throw fail(401);
    const [sessions] = await connection.execute('SELECT user_id FROM cl_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP() FOR UPDATE', [tokenHash(token), id]);
    if (!sessions.length) throw fail(401);
    return { id: Number(users[0].id), role: users[0].role };
  }
  async function department(connection, id) {
    const [rows] = await connection.execute('SELECT id, name, active, public_chat FROM cl_departments WHERE id = ? FOR UPDATE', [id]);
    return rows[0] || null;
  }
  async function allowedDepartment(connection, user, id) {
    const row = await department(connection, id);
    if (!row || Number(row.active) !== 1) return false;
    if (user.role === 'admin') return true;
    if (user.role !== 'operator') return false;
    const [members] = await connection.execute('SELECT user_id FROM cl_department_members WHERE department_id = ? AND user_id = ? FOR UPDATE', [id, user.id]);
    return members.length > 0;
  }
  async function conversation(connection, id) {
    const [rows] = await connection.execute('SELECT id, visitor_id AS visitorId, department_id AS departmentId, assigned_to AS assignedTo, status, last_sequence AS lastSequence FROM cl_chat_conversations WHERE id = ? FOR UPDATE', [id]);
    return rows[0] || null;
  }
  async function safeConversationById(connection, id) {
    const [rows] = await connection.execute(`SELECT ${conversationFields} ${conversationFrom} WHERE c.id = ?`, [id]);
    return safeConversation(rows[0]);
  }
  async function quota(connection, table, maximum) {
    const [rows] = await connection.execute(`SELECT COUNT(*) AS total FROM ${table}`);
    if (Number(rows[0].total) >= maximum) throw fail(429);
  }
  async function rate(connection, scope, seconds, maximum) {
    await connection.execute('DELETE FROM cl_chat_limits WHERE expires_at <= UTC_TIMESTAMP() LIMIT 100');
    const [clock] = await connection.execute('SELECT UNIX_TIMESTAMP() AS now');
    const now = Number(clock[0].now);
    const windowStart = Math.floor(now / seconds) * seconds;
    const key = digest(scope);
    const [rows] = await connection.execute('SELECT window_start AS windowStart, count FROM cl_chat_limits WHERE key_hash = ? FOR UPDATE', [key]);
    const count = rows[0] && Number(rows[0].windowStart) === windowStart ? Number(rows[0].count) : 0;
    if (count >= maximum) throw fail(429);
    const expiry = windowStart + seconds - now;
    await connection.execute(`INSERT INTO cl_chat_limits (key_hash, window_start, count, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${expiry} SECOND)) ON DUPLICATE KEY UPDATE window_start = VALUES(window_start), count = VALUES(count), expires_at = VALUES(expires_at)`, [key, windowStart, count + 1]);
  }
  async function history(connection, id, after, limit) {
    const [rows] = await connection.execute(`SELECT ${messageFields} FROM cl_chat_messages WHERE conversation_id = ? AND \`sequence\` > ? ORDER BY \`sequence\` LIMIT ${limit + 1}`, [id, after]);
    const messages = rows.slice(0, limit).map(safeMessage);
    return { messages, cursor: messages.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
  }
  async function send(connection, row, user, input) {
    const { text, clientKey } = content(input);
    const [existing] = await connection.execute(`SELECT ${messageFields} FROM cl_chat_messages WHERE conversation_id = ? AND sender = ? AND author_id = ? AND client_key = ?`, [row.id, user.sender, user.id, clientKey]);
    if (existing.length) {
      if (existing[0].text !== text) throw fail(409);
      return { message: safeMessage(existing[0]), created: false };
    }
    if (row.status === 'closed' || (user.sender === 'team' && Number(row.assignedTo) !== user.id)) throw fail(409);
    if (Number(row.lastSequence) >= 500) throw fail(429);
    await quota(connection, 'cl_chat_messages', 50000);
    await rate(connection, `message:${user.sender}:${user.id}`, 60, user.sender === 'visitor' ? 10 : 30);
    const sequence = Number(row.lastSequence) + 1;
    await connection.execute('INSERT INTO cl_chat_messages (conversation_id, `sequence`, sender, author_id, client_key, text, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())', [row.id, sequence, user.sender, user.id, clientKey, text]);
    await connection.execute('UPDATE cl_chat_conversations SET last_sequence = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [sequence, row.id]);
    const [messages] = await connection.execute(`SELECT ${messageFields} FROM cl_chat_messages WHERE conversation_id = ? AND \`sequence\` = ?`, [row.id, sequence]);
    return { message: safeMessage(messages[0]), created: true };
  }
  return {
    async listPublicChatDepartments() {
      await ready();
      const [rows] = await pool.execute('SELECT id, name FROM cl_departments WHERE active = 1 AND public_chat = 1 ORDER BY id LIMIT 50');
      return { departments: rows.map(row => ({ id: Number(row.id), name: row.name })) };
    },
    async chatChannel(actorId, teamToken, departmentId) {
      return coordinated(async connection => {
        const user = await actor(connection, actorId, teamToken);
        if (user.role !== 'admin') throw fail(403);
        const row = await department(connection, departmentId);
        return row ? { enabled: Number(row.public_chat) === 1 } : null;
      });
    },
    async setChatChannel(actorId, teamToken, departmentId, enabled) {
      if (typeof enabled !== 'boolean') throw fail(400);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, teamToken);
        if (user.role !== 'admin') throw fail(403);
        const row = await department(connection, departmentId);
        if (!row) return null;
        await connection.execute('UPDATE cl_departments SET public_chat = ? WHERE id = ?', [enabled ? 1 : 0, departmentId]);
        return { enabled };
      });
    },
    async createVisitor(token, name, ipDigest) {
      if (typeof name !== 'string' || !/^[a-f0-9]{64}$/.test(ipDigest || '')) throw fail(400);
      const normalized = name.trim().normalize('NFC');
      if (normalized.length < 2 || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) throw fail(400);
      const hash = tokenHash(token);
      return coordinated(async connection => {
        await quota(connection, 'cl_visitors', 10000);
        await rate(connection, 'visitor-session:' + ipDigest, 900, 5);
        const [result] = await connection.execute('INSERT INTO cl_visitors (name, token_hash, expires_at, created_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR), UTC_TIMESTAMP())', [normalized, hash]);
        return { id: result.insertId, name: normalized };
      });
    },
    async visitorSession(token) {
      await ready();
      try { return await visitor(pool, token, false); }
      catch (error) { if (error.statusCode === 401) return null; throw error; }
    },
    async revokeVisitor(token) {
      return coordinated(async connection => { await connection.execute('UPDATE cl_visitors SET expires_at = UTC_TIMESTAMP() WHERE token_hash = ?', [tokenHash(token)]); });
    },
    async listVisitorConversations(token) {
      return coordinated(async connection => {
        const user = await visitor(connection, token);
        const [rows] = await connection.execute(`SELECT ${conversationFields} ${conversationFrom} WHERE c.visitor_id = ? ORDER BY c.id DESC LIMIT 20`, [user.id]);
        return { conversations: rows.map(safeConversation) };
      });
    },
    async createVisitorConversation(token, departmentId) {
      return coordinated(async connection => {
        const user = await visitor(connection, token);
        const [open] = await connection.execute("SELECT id, department_id AS departmentId FROM cl_chat_conversations WHERE visitor_id = ? AND status <> 'closed' ORDER BY id LIMIT 1 FOR UPDATE", [user.id]);
        if (open.length) {
          if (Number(open[0].departmentId) !== departmentId) throw fail(409);
          return { conversation: await safeConversationById(connection, open[0].id), created: false };
        }
        const row = await department(connection, departmentId);
        if (!row || Number(row.active) !== 1 || Number(row.public_chat) !== 1) throw fail(404);
        const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_chat_conversations WHERE visitor_id = ?', [user.id]);
        if (Number(counts[0].total) >= 20) throw fail(429);
        await quota(connection, 'cl_chat_conversations', 5000);
        const [result] = await connection.execute('INSERT INTO cl_chat_conversations (visitor_id, department_id, updated_at, created_at) VALUES (?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())', [user.id, departmentId]);
        return { conversation: await safeConversationById(connection, result.insertId), created: true };
      });
    },
    async visitorMessages(token, conversationId, after, limit) {
      validateHistory(after, limit);
      return coordinated(async connection => {
        const user = await visitor(connection, token);
        const row = await conversation(connection, conversationId);
        if (!row || Number(row.visitorId) !== user.id) return null;
        return history(connection, conversationId, after, limit);
      });
    },
    async sendVisitorMessage(token, conversationId, input) {
      content(input);
      return coordinated(async connection => {
        const user = await visitor(connection, token);
        const row = await conversation(connection, conversationId);
        if (!row || Number(row.visitorId) !== user.id) throw fail(404);
        const area = await department(connection, row.departmentId);
        if (!area || Number(area.active) !== 1) throw fail(404);
        return send(connection, row, { ...user, sender: 'visitor' }, input);
      });
    },
    async listChatConversations(actorId, teamToken, page, limit) {
      validatePage(page, limit);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, teamToken);
        const scope = `${conversationFrom} WHERE d.active = 1 AND (? = 'admin' OR EXISTS (SELECT 1 FROM cl_department_members m WHERE m.department_id = c.department_id AND m.user_id = ?))`;
        const [counts] = await connection.execute(`SELECT COUNT(*) AS total ${scope}`, [user.role, user.id]);
        const [rows] = await connection.execute(`SELECT ${conversationFields} ${scope} ORDER BY c.updated_at DESC, c.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, [user.role, user.id]);
        return { conversations: rows.map(safeConversation), total: Number(counts[0].total), page, limit };
      });
    },
    async teamMessages(actorId, teamToken, conversationId, after, limit) {
      validateHistory(after, limit);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, teamToken);
        const row = await conversation(connection, conversationId);
        if (!row || !await allowedDepartment(connection, user, row.departmentId)) return null;
        return history(connection, conversationId, after, limit);
      });
    },
    async sendTeamMessage(actorId, teamToken, conversationId, input) {
      content(input);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, teamToken);
        const row = await conversation(connection, conversationId);
        if (!row || !await allowedDepartment(connection, user, row.departmentId)) throw fail(404);
        return send(connection, row, { ...user, sender: 'team' }, input);
      });
    },
    async changeChatConversation(actorId, teamToken, conversationId, action) {
      if (!['claim', 'release', 'close'].includes(action)) throw fail(400);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, teamToken);
        const row = await conversation(connection, conversationId);
        if (!row || !await allowedDepartment(connection, user, row.departmentId)) return null;
        if (row.status === 'closed') throw fail(409);
        if (action === 'claim') {
          if (row.assignedTo !== null && Number(row.assignedTo) !== user.id) throw fail(409);
          if (Number(row.assignedTo) !== user.id) await connection.execute("UPDATE cl_chat_conversations SET status = 'open', assigned_to = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [user.id, conversationId]);
        } else {
          if (user.role !== 'admin' && Number(row.assignedTo) !== user.id) throw fail(409);
          if (action === 'release') await connection.execute("UPDATE cl_chat_conversations SET status = 'waiting', assigned_to = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?", [conversationId]);
          else await connection.execute("UPDATE cl_chat_conversations SET status = 'closed', updated_at = UTC_TIMESTAMP() WHERE id = ?", [conversationId]);
        }
        return { conversation: await safeConversationById(connection, conversationId) };
      });
    }
  };
}

module.exports = { chatRepository };
