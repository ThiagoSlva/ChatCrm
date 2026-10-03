'use strict';

const { digest, equal } = require('./security');
const fail = statusCode => { const error = new Error(); error.statusCode = statusCode; return error; };
const hex = (value, size) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + size + '}$').test(value);
const uint = value => Number.isInteger(value) && value >= 1 && value <= 4294967295;
const passwordHash = value => typeof value === 'string' && /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value);
function tokenHash(token) { if (!hex(token, 64)) throw fail(401); return digest(token); }
function accessId(value) { if (!hex(value, 24)) throw fail(400); return value; }

// Caller holds cl_schema before any consistent read and has checked schema capability.
// A portal session owns the original visitor identity, independently of its expired cookie.
async function portalIdentity(connection, token) {
  const [rows] = await connection.execute('SELECT a.id AS accountId, a.visitor_id AS visitorId, a.access_id AS accessId, v.name FROM cl_portal_sessions s JOIN cl_portal_accounts a ON a.id = s.account_id JOIN cl_visitors v ON v.id = a.visitor_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND a.active = 1 FOR UPDATE', [tokenHash(token)]);
  if (!rows.length) throw fail(401);
  return { accountId: Number(rows[0].accountId), visitorId: Number(rows[0].visitorId), accessId: rows[0].accessId, name: rows[0].name };
}

function portalRepository(pool, { transaction, capabilities }) {
  async function coordinated(work) {
    return transaction(async connection => {
      await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
      if ((await capabilities(connection)).portal !== true) throw fail(503);
      return work(connection);
    });
  }
  return {
    // This is a separate committed transaction before expensive authentication work.
    // Refused attempts still count; they must not be rolled back with a bad password.
    async portalAttempt(ipDigest, identifier) {
      if (!hex(ipDigest, 64)) throw fail(400);
      accessId(identifier);
      return coordinated(async connection => {
        await connection.execute('DELETE FROM cl_chat_limits WHERE expires_at <= UTC_TIMESTAMP() LIMIT 100');
        const [clock] = await connection.execute('SELECT UNIX_TIMESTAMP() AS now');
        const now = Number(clock[0].now);
        const start = Math.floor(now / 900) * 900;
        const keys = [digest('portal-attempt-ip:' + ipDigest), digest('portal-attempt-access:' + identifier)];
        const counters = [];
        for (const key of keys) {
          const [rows] = await connection.execute('SELECT window_start AS windowStart, count FROM cl_chat_limits WHERE key_hash = ? FOR UPDATE', [key]);
          counters.push({ key, present: rows.length > 0, count: rows.length && Number(rows[0].windowStart) === start ? Number(rows[0].count) : 0 });
        }
        const [total] = await connection.execute('SELECT COUNT(*) AS total FROM cl_chat_limits');
        if (Number(total[0].total) + counters.filter(row => !row.present).length > 10000) return false;
        for (const row of counters) await connection.execute('INSERT INTO cl_chat_limits (key_hash, window_start, count, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ' + (start + 900 - now) + ' SECOND)) ON DUPLICATE KEY UPDATE window_start = VALUES(window_start), count = VALUES(count), expires_at = VALUES(expires_at)', [row.key, start, Math.min(row.count + 1, 11)]);
        return counters.every(row => row.count < 10);
      });
    },
    async createPortalAccount(visitorToken, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.keys(input).sort().join(',') !== 'accessId,passwordHash,recoveryHash' || !passwordHash(input.passwordHash) || !hex(input.recoveryHash, 64)) throw fail(400);
      accessId(input.accessId);
      const hash = tokenHash(visitorToken);
      return coordinated(async connection => {
        const [visitors] = await connection.execute('SELECT id, name FROM cl_visitors WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP() FOR UPDATE', [hash]);
        if (!visitors.length) throw fail(401);
        const visitor = visitors[0];
        const [existing] = await connection.execute('SELECT id FROM cl_portal_accounts WHERE visitor_id = ? FOR UPDATE', [visitor.id]);
        if (existing.length) throw fail(409);
        const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_portal_accounts');
        if (Number(counts[0].total) >= 5000) throw fail(429);
        try {
          await connection.execute('INSERT INTO cl_portal_accounts (visitor_id, access_id, password_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [visitor.id, input.accessId, input.passwordHash, input.recoveryHash]);
        } catch (error) { if (error.code === 'ER_DUP_ENTRY') error.statusCode = 409; throw error; }
        const [expired] = await connection.execute('UPDATE cl_visitors SET expires_at = UTC_TIMESTAMP() WHERE id = ?', [visitor.id]);
        if (Number(expired.affectedRows) !== 1) throw new Error('Portal visitor expiration failed.');
        return { created: true, account: { accessId: input.accessId, name: visitor.name } };
      });
    },
    async findPortalAccount(identifier) {
      accessId(identifier);
      return coordinated(async connection => {
        const [rows] = await connection.execute('SELECT id, visitor_id AS visitorId, password_hash AS passwordHash, recovery_hash AS recoveryHash, version FROM cl_portal_accounts WHERE access_id = ? AND active = 1 FOR UPDATE', [identifier]);
        return rows.length ? { id: Number(rows[0].id), visitorId: Number(rows[0].visitorId), passwordHash: rows[0].passwordHash, recoveryHash: rows[0].recoveryHash, version: Number(rows[0].version) } : null;
      });
    },
    async createPortalSession(token, accountId, expectedPasswordHash, expectedVersion) {
      const hash = tokenHash(token);
      if (!uint(accountId) || !uint(expectedVersion) || !passwordHash(expectedPasswordHash)) throw fail(400);
      return coordinated(async connection => {
        const [rows] = await connection.execute('SELECT password_hash AS passwordHash, version FROM cl_portal_accounts WHERE id = ? AND active = 1 FOR UPDATE', [accountId]);
        if (!rows.length || Number(rows[0].version) !== expectedVersion || !equal(rows[0].passwordHash, expectedPasswordHash)) return false;
        await connection.execute('DELETE FROM cl_portal_sessions WHERE expires_at <= UTC_TIMESTAMP() LIMIT 100');
        const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM cl_portal_sessions WHERE account_id = ? AND expires_at > UTC_TIMESTAMP()', [accountId]);
        const [global] = await connection.execute('SELECT COUNT(*) AS total FROM cl_portal_sessions');
        if (Number(counts[0].total) >= 5 || Number(global[0].total) >= 10000) throw fail(429);
        await connection.execute('INSERT INTO cl_portal_sessions (token_hash, account_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR))', [hash, accountId]);
        return true;
      });
    },
    async portalSession(token) {
      if (!hex(token, 64)) return null;
      return coordinated(async connection => {
        try { const identity = await portalIdentity(connection, token); return { accessId: identity.accessId, name: identity.name }; }
        catch (error) { if (error.statusCode === 401) return null; throw error; }
      });
    },
    async revokePortalSession(token) {
      const hash = tokenHash(token);
      return coordinated(async connection => { await connection.execute('DELETE FROM cl_portal_sessions WHERE token_hash = ?', [hash]); });
    },
    async recoverPortalAccount(identifier, expectedRecoveryHash, expectedVersion, newPasswordHash, newRecoveryHash) {
      accessId(identifier);
      if (!hex(expectedRecoveryHash, 64) || !uint(expectedVersion) || !passwordHash(newPasswordHash) || !hex(newRecoveryHash, 64) || equal(expectedRecoveryHash, newRecoveryHash)) throw fail(400);
      return coordinated(async connection => {
        const [rows] = await connection.execute('SELECT id, visitor_id AS visitorId, recovery_hash AS recoveryHash, version FROM cl_portal_accounts WHERE access_id = ? AND active = 1 FOR UPDATE', [identifier]);
        const row = rows[0];
        if (!row || Number(row.version) !== expectedVersion || !equal(row.recoveryHash, expectedRecoveryHash)) return false;
        if (Number(row.version) >= 4294967295) throw fail(409);
        const [updated] = await connection.execute('UPDATE cl_portal_accounts SET password_hash = ?, recovery_hash = ?, version = version + 1 WHERE id = ? AND version = ? AND active = 1', [newPasswordHash, newRecoveryHash, row.id, expectedVersion]);
        if (Number(updated.affectedRows) !== 1) return false;
        await connection.execute('DELETE FROM cl_portal_sessions WHERE account_id = ?', [row.id]);
        const [expired] = await connection.execute('UPDATE cl_visitors SET expires_at = UTC_TIMESTAMP() WHERE id = ?', [row.visitorId]);
        if (Number(expired.affectedRows) !== 1) throw new Error('Portal visitor expiration failed.');
        return true;
      });
    }
  };
}

module.exports = { portalRepository, portalIdentity };
