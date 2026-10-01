'use strict';

// Explicit SQL integration check. All users and sessions are rolled back, never published.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { databaseOptions, repositoryForPool } = require('../src/database');
const { loadEnvironment, buildServer } = require('../src/server');
const { secret, digest, hashPassword } = require('../src/security');

async function verifyTeamDatabase(connection, origin) {
  const checks = [];
  const suffix = secret().slice(0, 16);
  const email = `operator-${suffix}@example.test`;
  const password = secret();
  let app;
  await connection.beginTransaction();
  try {
    // Nested repository transactions are savepoints within the outer rollback-only transaction.
    const nested = {
      execute: (sql, values) => connection.execute(sql, values),
      beginTransaction: () => connection.query('SAVEPOINT cl_team_verification'),
      commit: () => connection.query('RELEASE SAVEPOINT cl_team_verification'),
      rollback: () => connection.query('ROLLBACK TO SAVEPOINT cl_team_verification'),
      release: () => {}
    };
    const repository = repositoryForPool({ execute: nested.execute, getConnection: async () => nested, end: async () => {} });
    assert.equal(await repository.status(), 'installed');
    const [admin] = await connection.execute("INSERT INTO cl_users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')", ['Administrador isolado', `admin-${suffix}@example.test`, await hashPassword(secret())]);
    const token = secret();
    assert.equal(await repository.createSession(token, admin.insertId), true);
    const headers = { origin, cookie: '__Host-cl_session=' + token, 'x-csrf-token': digest('csrf:' + token) };
    app = buildServer({ repository, env: { APP_URL: origin, NODE_ENV: 'production' } });
    const create = changes => app.inject({ method: 'POST', url: '/api/team/operators', headers, payload: { name: 'Operador isolado', email, password, ...changes } });
    const result = await create();
    assert.equal(result.statusCode, 201);
    const user = result.json().user;
    assert.equal(user.role, 'operator'); assert.equal(user.passwordHash, undefined);
    checks.push('sql-operator-created');
    assert.equal((await create()).statusCode, 409);
    checks.push('unique-email-enforced');
    const list = (await app.inject({ url: '/api/team/operators?limit=50', headers })).json();
    assert.equal(list.users.some(u => u.id === user.id && u.active && !u.password_hash && !u.passwordHash), true);
    checks.push('sql-pagination-safe-fields');
    const login = () => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { email, password } });
    const session = await login(); assert.equal(session.statusCode, 200);
    const operatorCookie = session.headers['set-cookie'].split(';')[0];
    assert.equal((await app.inject({ url: '/api/team/operators', headers: { cookie: operatorCookie } })).statusCode, 403);
    checks.push('operator-management-denied');
    const patch = (id, active) => app.inject({ method: 'PATCH', url: '/api/team/operators/' + id, headers, payload: { active } });
    assert.equal((await patch(admin.insertId, false)).statusCode, 404);
    checks.push('admin-protected');
    assert.equal((await patch(user.id, false)).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie: operatorCookie } })).statusCode, 401);
    assert.equal((await login()).statusCode, 401);
    const [sessions] = await connection.execute('SELECT COUNT(*) AS total FROM cl_sessions WHERE user_id = ?', [user.id]);
    assert.equal(Number(sessions[0].total), 0);
    assert.equal(await repository.createSession(secret(), user.id), false);
    checks.push('deactivation-revokes-and-blocks-login');
    assert.equal((await patch(user.id, true)).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { cookie: operatorCookie } })).statusCode, 401);
    assert.equal((await login()).statusCode, 200);
    checks.push('reactivation-requires-new-login');
  } finally {
    try { if (app) await app.close(); }
    finally { await connection.rollback(); }
  }
  const [remaining] = await connection.execute('SELECT COUNT(*) AS total FROM cl_users WHERE email IN (?, ?)', [email, `admin-${suffix}@example.test`]);
  assert.equal(Number(remaining[0].total), 0);
  checks.push('no-test-accounts-persisted');
  return { verifiedAt: new Date().toISOString(), checks };
}

async function main() {
  loadEnvironment();
  const options = databaseOptions();
  if (!options) throw new Error('Configure o banco privado.');
  const url = new URL(process.env.APP_URL);
  if (url.protocol !== 'https:' || url.href !== url.origin + '/') throw new Error('Configure a origem HTTPS.');
  const connection = await mysql.createConnection(options);
  try { process.stdout.write('Equipe verificada em transacao revertida: ' + JSON.stringify(await verifyTeamDatabase(connection, url.origin)) + '\n'); }
  finally { await connection.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Verificacao SQL da equipe falhou. Nenhuma credencial foi exibida.\n'); process.exitCode = 1; });
module.exports = { verifyTeamDatabase };
