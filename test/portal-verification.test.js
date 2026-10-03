'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { repositoryForPool } = require('../src/database');
const { verificationPool, preservationFingerprint } = require('../scripts/verify-portal-database');
const { digest, secret } = require('../src/security');
const accessId = 'a'.repeat(24);
const passwordHash = 'scrypt-v1$' + 'b'.repeat(32) + '$' + 'c'.repeat(128);

function connectionFixture() {
  let account = { id: 1, visitorId: 2, passwordHash, recoveryHash: digest('synthetic recovery'), version: 1 };
  let saved = null;
  let fault = false;
  const trace = [];
  const connection = {
    async query(sql) {
      trace.push(sql);
      if (sql === 'SAVEPOINT cl_portal_verification') {
        assert.equal(saved, null, 'an existing savepoint cannot be replaced');
        saved = structuredClone(account);
      } else if (sql === 'ROLLBACK TO SAVEPOINT cl_portal_verification') {
        assert.notEqual(saved, null); account = structuredClone(saved);
      } else if (sql === 'RELEASE SAVEPOINT cl_portal_verification') {
        assert.notEqual(saved, null); saved = null;
      } else throw Error('Unexpected transaction operation');
      return [[], []];
    },
    async execute(sql, args) {
      trace.push(sql);
      if (sql === 'SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE') return [[{ id: 1 }], []];
      if (sql === 'SELECT version FROM cl_schema WHERE id = 1') return [[{ version: 7 }], []];
      if (sql.startsWith('SELECT id, visitor_id AS visitorId,')) return [[structuredClone(account)], []];
      if (sql.startsWith('UPDATE cl_portal_accounts SET password_hash')) {
        account.passwordHash = args[0]; account.recoveryHash = args[1]; account.version++;
        return [{ affectedRows: 1 }, []];
      }
      if (sql === 'DELETE FROM cl_portal_sessions WHERE account_id = ?') {
        if (fault) { fault = false; throw Error('Synthetic session revocation failure'); }
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('UPDATE cl_visitors SET expires_at')) return [{ affectedRows: 1 }, []];
      throw Error('Unexpected verification SQL');
    }
  };
  return { connection, trace, get account() { return structuredClone(account); }, failRevocation() { fault = true; } };
}

test('homologacao em uma conexao recusa sobreposicao antes de substituir savepoint e conserva a primeira leitura', async () => {
  const f = connectionFixture();
  const repo = repositoryForPool(verificationPool(f.connection));
  const first = repo.findPortalAccount(accessId);
  const second = repo.findPortalAccount(accessId);
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[0].value.version, 1);
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /Overlapping/);
  assert.equal(f.trace.filter(sql => sql.startsWith('SAVEPOINT ')).length, 1);
  assert.equal(f.trace.filter(sql => sql.startsWith('ROLLBACK ')).length, 0);
  assert.equal((await repo.findPortalAccount(accessId)).version, 1);
  assert.equal(f.trace.filter(sql => sql.startsWith('SAVEPOINT ')).length, 2);
  assert.equal(f.trace.some(sql => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)), false);
});

test('falha de revogacao reverte somente o savepoint, libera a conexao e preserva o erro original', async () => {
  const f = connectionFixture();
  const repo = repositoryForPool(verificationPool(f.connection));
  const before = f.account;
  f.failRevocation();
  await assert.rejects(repo.recoverPortalAccount(accessId, before.recoveryHash, 1, passwordHash, digest(secret())), /Synthetic session revocation failure/);
  assert.deepEqual(f.account, before);
  assert.deepEqual(f.trace.slice(-2), ['ROLLBACK TO SAVEPOINT cl_portal_verification', 'RELEASE SAVEPOINT cl_portal_verification']);
  assert.equal((await repo.findPortalAccount(accessId)).version, 1);
  assert.equal(f.trace.some(sql => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)), false);
});

test('fingerprint de preservacao cobre dezessete tabelas e detecta dados e DDL sem confundir AUTO_INCREMENT consumido', async () => {
  let counter = 3; let rowChanged = false; let schemaChanged = false;
  const seen = [];
  const connection = { async query(sql) {
    if (sql.startsWith('SELECT SHA2(JSON_ARRAY(')) {
      const table = sql.match(/ FROM (cl_\w+) ORDER BY /)[1]; seen.push(table);
      return [[{ fingerprint: digest(table + (table === 'cl_portal_accounts' && rowChanged ? ':changed' : ':original')) }], []];
    }
    if (sql.startsWith('SHOW CREATE TABLE ')) {
      const table = sql.slice('SHOW CREATE TABLE '.length);
      return [[{ Table: table, 'Create Table': 'CREATE TABLE ' + table + ' (id int' + (table === 'cl_portal_sessions' && schemaChanged ? ', private_scope int' : '') + ') ENGINE=InnoDB AUTO_INCREMENT=' + counter + ' DEFAULT CHARSET=utf8mb4' }], []];
    }
    throw Error('Unexpected fingerprint SQL');
  } };
  const baseline = await preservationFingerprint(connection);
  assert.equal(new Set(seen).size, 17);
  assert.ok(seen.includes('cl_conversation_contact_events'));
  assert.ok(seen.includes('cl_portal_accounts'));
  assert.ok(seen.includes('cl_portal_sessions'));
  counter = 999;
  assert.equal(await preservationFingerprint(connection), baseline);
  rowChanged = true;
  assert.notEqual(await preservationFingerprint(connection), baseline);
  rowChanged = false; schemaChanged = true;
  assert.notEqual(await preservationFingerprint(connection), baseline);
});
