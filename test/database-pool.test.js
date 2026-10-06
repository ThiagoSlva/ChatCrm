'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boundedDatabasePool } = require('../src/database-pool');
const { buildServer } = require('../src/server');

test('bounded pool classifies only queue acquisition refusal, never runs or retries SQL', async () => {
  let acquisitions = 0;
  const pool = boundedDatabasePool({ async getConnection() { acquisitions++; throw new Error('Queue limit reached.'); } });
  for (const work of [() => pool.getConnection(), () => pool.query('SELECT 1'), () => pool.execute('INSERT INTO example VALUES (?)', [1])]) {
    await assert.rejects(work, error => error.statusCode === 429 && error.code === 'CL_DATABASE_BUSY');
  }
  assert.equal(acquisitions, 3);
});

test('query and execute return results, preserve arguments and release exactly once on success or failure', async () => {
  let releases = 0, calls = 0, ends = 0;
  const queryError = Object.assign(new Error('Queue limit reached.'), { code: 'ER_SIGNAL_EXCEPTION', sql: 'private statement' });
  const connection = {
    async execute(sql, values) { calls++; assert.equal(sql, 'SELECT ?'); assert.deepEqual(values, [7]); return [[{ value: 7 }]]; },
    async query(sql) { calls++; assert.equal(sql, 'UPDATE example'); throw queryError; },
    release() { releases++; }
  };
  const pool = boundedDatabasePool({ async getConnection() { return connection; }, async end() { ends++; } });
  assert.deepEqual(await pool.execute('SELECT ?', [7]), [[{ value: 7 }]]);
  await assert.rejects(() => pool.query('UPDATE example'), error => error === queryError && !error.statusCode);
  assert.equal(releases, 2); assert.equal(calls, 2);
  const leased = await pool.getConnection(); assert.equal(leased, connection); assert.equal(releases, 2);
  leased.release(); assert.equal(releases, 3);
  await pool.end(); assert.equal(ends, 1);
});

test('connection, shutdown and coded acquisition errors retain identity and remain unavailable errors', async () => {
  for (const error of [new Error('Pool is closed.'), Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }), Object.assign(new Error('Queue limit reached.'), { code: 'CUSTOM' }), Object.assign(new Error('Queue limit reached.'), { sql: 'statement' })]) {
    const pool = boundedDatabasePool({ async getConnection() { throw error; } });
    await assert.rejects(() => pool.getConnection(), actual => actual === error && !actual.statusCode);
  }
});

test('HTTP pool refusal returns private generic 429 with retry guidance and server recovers afterwards', async t => {
  let unavailable = true, acquired = 0, released = 0;
  const pool = boundedDatabasePool({ async getConnection() {
    acquired++;
    if (unavailable) throw new Error('Queue limit reached.');
    return { async execute() { return [[{ version: 9 }]]; }, release() { released++; } };
  } });
  const app = buildServer({ repository: { async capabilities() { const [[row]] = await pool.execute('SELECT version'); return { schemaVersion: row.version, chat: true }; }, async listPublicChatDepartments() { return { departments: [] }; }, async close() {} }, env: { APP_URL: 'https://example.test' } });
  t.after(() => app.close());
  const response = await app.inject('/api/chat/public/departments');
  assert.equal(response.statusCode, 429); assert.equal(response.headers['retry-after'], '1');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { error: 'Nao foi possivel concluir a requisicao.' });
  assert.equal(acquired, 1); assert.equal(released, 0);
  unavailable = false;
  const recovered = await app.inject('/api/chat/public/departments');
  assert.equal(recovered.statusCode, 200); assert.equal(recovered.headers['retry-after'], undefined);
  assert.deepEqual(recovered.json(), { departments: [] }); assert.equal(acquired, 2); assert.equal(released, 1);
});
