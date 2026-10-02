'use strict';

const { digest } = require('./security');

function conversationContactsRepository(pool, { transaction, capabilities }) {
  const maximumId = 4294967295;
  const failure = statusCode => { const error = new Error(); error.statusCode = statusCode; return error; };
  const timestamp = value => value instanceof Date ? value.toISOString() : value;

  function integer(value, minimum = 1) {
    if (!Number.isInteger(value) || value < minimum || value > maximumId) throw failure(400);
    return value;
  }
  function patchInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).some(key => !['version', 'contactId'].includes(key)) ||
      !Object.hasOwn(input, 'version') || !Object.hasOwn(input, 'contactId')) throw failure(400);
    return { version: integer(input.version, 0), contactId: input.contactId === null ? null : integer(input.contactId) };
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
      // Lock before the first consistent read, including the capability check.
      await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
      if ((await capabilities(connection)).conversationContacts !== true) throw failure(503);
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
  async function allowedConversation(connection, user, id) {
    const [rows] = await connection.execute('SELECT c.id, c.department_id AS departmentId, c.assigned_to AS assignedTo, c.status FROM cl_chat_conversations c JOIN cl_departments d ON d.id = c.department_id AND d.active = 1 WHERE c.id = ? FOR UPDATE', [id]);
    if (!rows.length) return null;
    const row = { ...rows[0], id: Number(rows[0].id), departmentId: Number(rows[0].departmentId) };
    if (user.role === 'admin') return row;
    const [members] = await connection.execute('SELECT user_id FROM cl_department_members WHERE department_id = ? AND user_id = ? FOR UPDATE', [row.departmentId, user.id]);
    return members.length ? row : null;
  }
  const editable = (conversation, user) => conversation.status === 'open' && Number(conversation.assignedTo) === user.id;
  async function current(connection, conversation) {
    // Only join contact identities from the conversation's current department.
    const [rows] = await connection.execute('SELECT l.version, l.contact_id AS storedContactId, c.id AS contactId, c.name AS contactName, c.kind AS contactKind, l.updated_at AS updatedAt FROM cl_conversation_contacts l LEFT JOIN cl_contacts c ON c.id = l.contact_id AND c.department_id = ? WHERE l.conversation_id = ? FOR UPDATE', [conversation.departmentId, conversation.id]);
    return rows[0] || null;
  }
  function safeLink(row, conversation, user) {
    return {
      conversationId: conversation.id, departmentId: conversation.departmentId,
      version: row ? Number(row.version) : 0,
      contactId: row?.contactId == null ? null : Number(row.contactId),
      contactName: row?.contactName ?? null, contactKind: row?.contactKind ?? null,
      updatedAt: row ? timestamp(row.updatedAt) : null, canEdit: editable(conversation, user)
    };
  }
  async function snapshot(connection, conversationId) {
    // The event copies persisted identifiers, actor and UTC time in the same transaction.
    const [result] = await connection.execute('INSERT INTO cl_conversation_contact_events (conversation_id, version, contact_id, actor_id, created_at) SELECT conversation_id, version, contact_id, updated_by, updated_at FROM cl_conversation_contacts WHERE conversation_id = ?', [conversationId]);
    if (Number(result.affectedRows) !== 1) throw new Error();
  }

  return {
    async getConversationContact(actorId, token, id) {
      integer(id);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const conversation = await allowedConversation(connection, user, id);
        if (!conversation) return null;
        return { link: safeLink(await current(connection, conversation), conversation, user) };
      });
    },
    async setConversationContact(actorId, token, id, input) {
      integer(id);
      const patch = patchInput(input);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const conversation = await allowedConversation(connection, user, id);
        if (!conversation) return null;
        if (!editable(conversation, user)) throw failure(409);
        const row = await current(connection, conversation);
        const version = row ? Number(row.version) : 0;
        if (patch.version !== version) throw failure(409);
        if (patch.contactId !== null) {
          const [contacts] = await connection.execute('SELECT id FROM cl_contacts WHERE id = ? AND department_id = ? FOR UPDATE', [patch.contactId, conversation.departmentId]);
          if (!contacts.length) throw failure(404);
        }
        const previous = row?.storedContactId == null ? null : Number(row.storedContactId);
        if (patch.contactId === previous) return { link: safeLink(row, conversation, user) };
        if (version >= maximumId) throw failure(409);
        const [conversationCounts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_conversation_contact_events WHERE conversation_id = ?', [id]);
        const [globalCounts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_conversation_contact_events');
        if (Number(conversationCounts[0].total) >= 100 || Number(globalCounts[0].total) >= 50000) throw failure(429);
        if (row) {
          const [result] = await connection.execute('UPDATE cl_conversation_contacts SET contact_id = ?, version = version + 1, updated_by = ?, updated_at = UTC_TIMESTAMP() WHERE conversation_id = ? AND version = ?', [patch.contactId, user.id, id, patch.version]);
          if (Number(result.affectedRows) !== 1) throw failure(409);
        } else {
          const [result] = await connection.execute('INSERT INTO cl_conversation_contacts (conversation_id, contact_id, version, updated_by, updated_at) VALUES (?, ?, 1, ?, UTC_TIMESTAMP())', [id, patch.contactId, user.id]);
          if (Number(result.affectedRows) !== 1) throw new Error();
        }
        await snapshot(connection, id);
        return { link: safeLink(await current(connection, conversation), conversation, user) };
      });
    },
    async listConversationContactEvents(actorId, token, id, page, limit) {
      integer(id); pagination(page, limit);
      return coordinated(async connection => {
        const user = await actor(connection, actorId, token);
        const conversation = await allowedConversation(connection, user, id);
        if (!conversation) return null;
        const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_conversation_contact_events WHERE conversation_id = ?', [id]);
        const [rows] = await connection.execute('SELECT e.version, c.id AS contactId, c.name AS contactName, u.name AS actorName, e.created_at AS createdAt FROM cl_conversation_contact_events e JOIN cl_users u ON u.id = e.actor_id LEFT JOIN cl_contacts c ON c.id = e.contact_id AND c.department_id = ? WHERE e.conversation_id = ? ORDER BY e.version DESC LIMIT ' + limit + ' OFFSET ' + ((page - 1) * limit), [conversation.departmentId, id]);
        return {
          events: rows.map(row => ({ version: Number(row.version), contactId: row.contactId == null ? null : Number(row.contactId), contactName: row.contactName ?? null, actorName: row.actorName, createdAt: timestamp(row.createdAt) })),
          total: Number(counts[0].total), page, limit
        };
      });
    }
  };
}

module.exports = { conversationContactsRepository };
