'use strict';

// Explicit integration check: data mutations are contained in one rollback-only transaction.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { databaseOptions, repositoryForPool } = require('../src/database');
const { loadEnvironment, buildServer } = require('../src/server');
const { secret, digest, hashPassword } = require('../src/security');

async function verifyDepartmentsDatabase(connection, origin) {
  const checks = [];
  const suffix = secret().slice(0, 16);
  const emails = ['admin', 'first', 'second'].map(value => `${value}-${suffix}@example.test`);
  const names = [`Vendas ${suffix}`, `Suporte ${suffix}`];
  const passwordHash = await hashPassword(secret());
  let app;
  await connection.beginTransaction();
  try {
    const nested = {
      execute: (sql, values) => connection.execute(sql, values),
      beginTransaction: () => connection.query('SAVEPOINT cl_department_verification'),
      commit: () => connection.query('RELEASE SAVEPOINT cl_department_verification'),
      rollback: () => connection.query('ROLLBACK TO SAVEPOINT cl_department_verification'),
      release: () => {}
    };
    const repository = repositoryForPool({ execute: nested.execute, getConnection: async () => nested, end: async () => {} });
    assert.equal((await repository.capabilities()).departments, true);
    checks.push('schema-v2-ready');
    const ids = [];
    for (let i = 0; i < emails.length; i++) {
      const [result] = await connection.execute('INSERT INTO cl_users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [`Pessoa isolada ${i}`, emails[i], passwordHash, i === 0 ? 'admin' : 'operator']);
      ids.push(result.insertId);
    }
    const tokens = [secret(), secret(), secret()];
    for (let i = 0; i < ids.length; i++) assert.equal(await repository.createSession(tokens[i], ids[i], passwordHash), true);
    const headers = (index = 0) => ({ origin, cookie: '__Host-cl_session=' + tokens[index], 'x-csrf-token': digest('csrf:' + tokens[index]) });
    app = buildServer({ repository, env: { APP_URL: origin, NODE_ENV: 'production' } });
    const request = (method, url, payload, index = 0, overrides = {}) => app.inject({ method, url, payload, headers: { ...headers(index), ...overrides } });
    const first = await request('POST', '/api/team/departments', { name: ' ' + names[0] + ' ' });
    const second = await request('POST', '/api/team/departments', { name: names[1] });
    assert.equal(first.statusCode, 201); assert.equal(second.statusCode, 201);
    const departments = [first.json().department, second.json().department];
    assert.equal(departments[0].name, names[0]);
    assert.equal((await request('POST', '/api/team/departments', { name: names[0].toUpperCase() })).statusCode, 409);
    checks.push('department-created-name-unique');
    assert.equal((await request('PATCH', `/api/team/departments/${departments[0].id}`, { active: false }, 0, { 'x-csrf-token': '' })).statusCode, 403);
    assert.equal((await request('PATCH', `/api/team/departments/${departments[0].id}`, { active: false }, 0, { origin: 'https://foreign.example.test' })).statusCode, 403);
    assert.equal((await request('POST', '/api/team/departments', { name: 'Nao autorizado' }, 1)).statusCode, 403);
    checks.push('department-write-origin-csrf-admin-required');
    const membership = (department, user, member) => request('PUT', `/api/team/departments/${department.id}/members/${user}`, { member });
    for (let i = 0; i < departments.length; i++) assert.equal((await membership(departments[i], ids[i + 1], true)).statusCode, 200);
    assert.equal((await membership(departments[0], ids[1], true)).statusCode, 200);
    const members = await request('GET', `/api/team/departments/${departments[0].id}/members`);
    assert.equal(members.statusCode, 200); assert.equal(members.json().total, 1);
    assert.equal(members.json().users[0].id, ids[1]);
    assert.equal(members.json().users[0].passwordHash, undefined); assert.equal(members.json().users[0].password_hash, undefined);
    assert.equal((await membership(departments[0], ids[0], true)).statusCode, 404);
    checks.push('membership-idempotent-safe-operator-only');
    for (let i = 0; i < departments.length; i++) {
      const list = await request('GET', '/api/team/departments', undefined, i + 1);
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json().departments.map(value => value.id), [departments[i].id]);
      assert.equal((await request('GET', `/api/team/departments/${departments[1 - i].id}`, undefined, i + 1)).statusCode, 404);
      assert.equal((await request('GET', `/api/team/departments/${departments[i].id}/members`, undefined, i + 1)).statusCode, 403);
    }
    checks.push('operators-isolated-by-department');
    assert.equal((await membership(departments[0], ids[1], false)).statusCode, 200);
    assert.equal((await membership(departments[0], ids[1], false)).statusCode, 200);
    assert.equal((await request('GET', `/api/team/departments/${departments[0].id}`, undefined, 1)).statusCode, 404);
    assert.equal((await request('GET', '/api/auth/me', undefined, 1)).statusCode, 200);
    checks.push('membership-removal-denies-existing-session');
    assert.equal((await membership(departments[0], ids[1], true)).statusCode, 200);
    assert.equal((await request('PATCH', `/api/team/departments/${departments[0].id}`, { active: false })).statusCode, 200);
    assert.equal((await request('GET', `/api/team/departments/${departments[0].id}`, undefined, 1)).statusCode, 404);
    assert.equal((await request('PATCH', `/api/team/departments/${departments[0].id}`, { active: true })).statusCode, 200);
    assert.equal((await request('GET', `/api/team/departments/${departments[0].id}`, undefined, 1)).statusCode, 200);
    checks.push('department-deactivation-preserves-membership');
    assert.equal((await request('PATCH', `/api/team/departments/${departments[0].id}`, { name: ' ' + names[0] + ' ' })).statusCode, 200);
    assert.equal((await request('PATCH', `/api/team/departments/${departments[0].id}`, { name: names[1] })).statusCode, 409);
    checks.push('rename-preserves-access-rejects-duplicate');
  } finally {
    try { if (app) await app.close(); }
    finally { await connection.rollback(); }
  }
  const [users] = await connection.execute('SELECT COUNT(*) AS total FROM cl_users WHERE email IN (?, ?, ?)', emails);
  const [departments] = await connection.execute('SELECT COUNT(*) AS total FROM cl_departments WHERE name IN (?, ?)', names);
  assert.equal(Number(users[0].total), 0); assert.equal(Number(departments[0].total), 0);
  checks.push('no-test-users-departments-persisted');
  return { verifiedAt: new Date().toISOString(), checks };
}

async function main() {
  loadEnvironment();
  const options = databaseOptions();
  if (!options) throw new Error('Configure o banco privado.');
  const url = new URL(process.env.APP_URL);
  if (url.protocol !== 'https:' || url.href !== url.origin + '/') throw new Error('Configure a origem HTTPS.');
  const connection = await mysql.createConnection(options);
  try { process.stdout.write('Departamentos verificados em transacao revertida: ' + JSON.stringify(await verifyDepartmentsDatabase(connection, url.origin)) + '\n'); }
  finally { await connection.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('Verificacao SQL de departamentos falhou. Nenhuma credencial foi exibida.\n'); process.exitCode = 1; });
module.exports = { verifyDepartmentsDatabase };
