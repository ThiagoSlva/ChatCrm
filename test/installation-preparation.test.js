'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareInstallation, formatPreparation, parseArguments } = require('../scripts/prepare-installation');
const { migrate } = require('../scripts/migrate-database');

const env = { APP_URL: 'https://support.example.test', NODE_ENV: 'production',
  DB_HOST: 'private-host', DB_NAME: 'private-database', DB_USER: 'private-user',
  DB_PASSWORD: 'private-password', SETUP_TOKEN: 'private-setup-secret-' + 's'.repeat(32) };
const empty = { ok: false, code: 'database-unprepared' };
const ready = { ok: true, code: 'setup-ready', schemaVersion: 9, modulesPending: [] };
function fixture(options = {}) {
  const calls = []; let reads = 0;
  const connection = {
    query: async (...args) => { calls.push(['query', ...args]); return [[]]; },
    execute: async (...args) => { calls.push(['execute', ...args]); return [[]]; },
    end: async () => { calls.push(['end']); },
    destroy: () => { calls.push(['destroy']); }
  };
  const configuration = { env, nodeVersion: '22.0.0', timeoutMs: 25,
    inspect: async () => { calls.push(['inspect']); return reads++ ? ready : empty; },
    connect: async options => { calls.push(['connect', options]); return connection; },
    migrateDatabase: async (bounded, options) => {
      calls.push(['migrate', options]); await bounded.query('SHOW TABLES');
      await bounded.execute('SELECT 1'); return { schemaVersion: 9 };
    }, ...options };
  return { calls, connection, run: changes => prepareInstallation({ ...configuration, ...changes }) };
}

test('default installer only diagnoses; explicit preparation passes guarded migration and final inspection', async () => {
  const f = fixture(); assert.deepEqual(await f.run(), { ...empty, mode: 'check' });
  assert.deepEqual(f.calls.map(call => call[0]), ['inspect']);
  const g = fixture(); const result = await g.run({ prepare: true });
  assert.deepEqual(result, { ...ready, mode: 'prepare-empty', preparation: 'completed' });
  assert.deepEqual(g.calls.map(call => call[0]), ['inspect', 'connect', 'migrate', 'query', 'execute', 'end', 'inspect']);
  assert.deepEqual(g.calls.find(call => call[0] === 'migrate')[1], { requireEmpty: true });
  assert.deepEqual(g.calls.find(call => call[0] === 'query')[1], { sql: 'SHOW TABLES', timeout: 25 });
});

test('existing, incomplete and inconsistent installations never call the migrator', async () => {
  for (const code of ['installed', 'setup-ready', 'setup-secret-required', 'schema-incomplete',
    'migration-incomplete', 'schema-invalid', 'installation-inconsistent', 'schema-incompatible', 'schema-changed']) {
    const f = fixture({ inspect: async () => ({ ok: false, code }) });
    assert.equal((await f.run({ prepare: true })).code, 'database-not-empty');
    assert.equal(f.calls.length, 0);
  }
});

test('unsupported runtime, URL, unavailable database and unrelated tables cannot authorize preparation', async () => {
  for (const code of ['runtime-unsupported', 'url-invalid', 'database-config-invalid',
    'database-config-missing', 'database-not-exclusive', 'database-unreachable', 'database-timeout']) {
    const f = fixture({ inspect: async () => ({ ok: false, code }) });
    assert.equal((await f.run({ prepare: true })).code, code); assert.equal(f.calls.length, 0);
  }
});

test('fresh preparation requires a setup secret accepted by the first-access form', async () => {
  for (const SETUP_TOKEN of ['', 's'.repeat(31), 's'.repeat(257)]) {
    const f = fixture(); assert.equal((await f.run({ prepare: true, env: { ...env, SETUP_TOKEN } })).code, 'setup-secret-required');
    assert.deepEqual(f.calls.map(call => call[0]), ['inspect']);
  }
});

test('migration checks emptiness under the established lock before any DDL or account query', async () => {
  for (const names of [['wordpress'], ['cl_schema'], ['cl_schema', 'cl_company', 'cl_users'], ['cl_campaigns']]) {
    const seen = [];
    const connection = {
      query: async sql => { seen.push(sql); return [names.map(name => ({ name }))]; },
      execute: async sql => { seen.push(sql); return [[{ acquired: 1 }]]; }
    };
    await assert.rejects(migrate(connection, { requireEmpty: true }), { code: 'DATABASE_NOT_EMPTY' });
    assert.deepEqual(seen, ["SELECT GET_LOCK('conversa-livre-schema-v1', 10) AS acquired", 'SHOW TABLES', "SELECT RELEASE_LOCK('conversa-livre-schema-v1')"]);
  }
});

test('a racing migrator changing the preflight empty database is refused', async () => {
  const f = fixture({ migrateDatabase: migrate });
  f.connection.query = async sql => { assert.equal(sql.sql, 'SHOW TABLES'); return [[{ name: 'cl_schema' }]]; };
  f.connection.execute = async sql => [[{ acquired: sql.sql.includes('GET_LOCK') ? 1 : null }]];
  assert.equal((await f.run({ prepare: true })).code, 'database-not-empty');
  assert.equal(f.calls.at(-1)[0], 'end');
});

test('fresh guarded migration reaches explicit DDL while releasing the lock after an interruption', async () => {
  // The full SQL fixture is exercised in migration.test.js. Here a locked empty
  // DB deliberately fails the first CREATE, proving it reached the explicit DDL.
  const seen = [];
  const connection = {
    query: async sql => { seen.push(sql); if (sql === 'SHOW TABLES') return [[]]; throw Error('DDL interruption'); },
    execute: async sql => { seen.push(sql); return [[{ acquired: 1 }]]; }
  };
  await assert.rejects(migrate(connection, { requireEmpty: true }), /DDL interruption/);
  assert(seen[2].startsWith('CREATE TABLE IF NOT EXISTS cl_schema'));
  assert.equal(seen.at(-1), "SELECT RELEASE_LOCK('conversa-livre-schema-v1')");
});

test('DDL and access-denied failures are reported without raw driver or configuration values', async () => {
  const f = fixture({ migrateDatabase: async () => { throw new Error(Object.values(env).join(' ')); } });
  const result = await f.run({ prepare: true }); assert.equal(result.code, 'preparation-interrupted');
  const output = JSON.stringify(result) + formatPreparation(result);
  for (const value of Object.values(env)) assert(!output.includes(value));
  assert.equal(f.calls.at(-1)[0], 'end');
});

test('prepared DDL is never reported successful when the final diagnostic fails or stays old', async () => {
  for (const after of [{ ok: false, code: 'database-unreachable' }, { ...ready, schemaVersion: 8 }]) {
    let reads = 0; const f = fixture({ inspect: async () => reads++ ? after : empty });
    assert.equal((await f.run({ prepare: true })).code, 'preparation-unconfirmed');
  }
});

test('query, prepared-statement preparation and graceful close are bounded and destroy only the owned connection', async () => {
  for (const method of ['query', 'execute', 'end']) {
    const f = fixture(); f.connection[method] = async () => new Promise(() => {});
    const result = await f.run({ prepare: true }); assert.equal(result.code, 'preparation-timeout');
    assert.equal(f.calls.filter(call => call[0] === 'destroy').length, 1);
    assert.equal(f.calls.filter(call => call[0] === 'inspect').length, 1);
  }
});

test('a socket opening after the connection deadline is closed and cannot migrate', async () => {
  const f = fixture(); let complete;
  const result = await f.run({ prepare: true, connect: () => new Promise(resolve => { complete = resolve; }) });
  assert.equal(result.code, 'preparation-timeout');
  complete(f.connection); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(call => call[0]), ['inspect', 'destroy']);
});

test('native timeout and close error never claim completion', async () => {
  const f = fixture(); f.connection.execute = async () => { const error = Error('driver secret'); error.code = 'PROTOCOL_SEQUENCE_TIMEOUT'; throw error; };
  assert.equal((await f.run({ prepare: true })).code, 'preparation-timeout');
  const g = fixture(); g.connection.end = async () => { throw Error('driver secret'); };
  assert.equal((await g.run({ prepare: true })).code, 'preparation-unconfirmed');
  assert.equal(g.calls.filter(call => call[0] === 'destroy').length, 1);
});

test('real isolated MySQL protocol stalls during query or statement preparation cannot leave an installer socket running', async t => {
  const mysql = require('mysql2');
  for (const method of ['query', 'execute']) {
    const server = mysql.createServer(), peers = new Set(), seen = [];
    let connection, destroyed = 0;
    server.on('connection', peer => {
      peers.add(peer); peer.on('error', () => {});
      peer.on('query', sql => seen.push(['query', sql]));
      peer.on('stmt_prepare', sql => seen.push(['prepare', sql]));
      peer.serverHandshake({ protocolVersion: 10, serverVersion: '8.0.0-synthetic',
        capabilityFlags: 0x00000200 | 0x00008000 | 0x00080000, connectionId: 1,
        statusFlags: 2, characterSet: 45, authPluginName: 'mysql_native_password' });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const f = fixture({ timeoutMs: 150,
        connect: async () => {
          connection = await mysql.createConnectionPromise({ host: '127.0.0.1', port: server._server.address().port });
          connection.on('error', () => {});
          const close = connection.destroy.bind(connection);
          connection.destroy = () => { destroyed++; close(); };
          return connection;
        }, migrateDatabase: bounded => bounded[method]('SELECT 1') });
      assert.equal((await f.run({ prepare: true })).code, 'preparation-timeout');
      assert.equal(destroyed, 1);
      assert.deepEqual(seen, [[method === 'query' ? 'query' : 'prepare', 'SELECT 1']]);
    } finally {
      if (connection) connection.destroy();
      for (const peer of peers) peer.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('CLI accepts only explicit flags, rejects credentials/duplicates and help never loads environment', () => {
  assert.deepEqual(parseArguments([]), { prepare: false, json: false });
  assert.deepEqual(parseArguments(['--json', '--prepare-empty']), { prepare: true, json: true });
  for (const args of [['--prepare'], ['--json', '--json'], ['--prepare-empty', '--prepare-empty'], ['DB_PASSWORD=secret'], ['--help', '--prepare-empty']]) assert.equal(parseArguments(args), null);
  for (const [args, status] of [[['--help'], 0], [['--password', 'do-not-print'], 2]]) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/prepare-installation.js'), ...args], { encoding: 'utf8', env: { ...process.env, DB_HOST: '', DB_NAME: '', DB_USER: '', DB_PASSWORD: '' }, timeout: 3000 });
    assert.equal(result.status, status); assert(!String(result.stdout + result.stderr).includes('do-not-print'));
  }
});
