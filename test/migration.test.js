'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../scripts/migrate-database');
const { databaseOptions } = require('../src/database');

test('migracao recusa banco de outro site antes de executar DDL e libera trava', async () => {
  const statements = [];
  const connection = {
    execute: async sql => { statements.push(sql); return [[{ acquired: 1 }]]; },
    query: async sql => { statements.push(sql); return [[{ table: 'wordpress_posts' }]]; }
  };
  await assert.rejects(migrate(connection), /exclusivo/);
  assert.equal(statements.some(sql => sql.startsWith('CREATE')), false);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});

test('migracao interrompida retoma v0 e marca v1 somente depois de todo DDL', async () => {
  const statements = [];
  const connection = {
    execute: async sql => { statements.push(sql); return [[{ acquired: 1, version: 0 }]]; },
    query: async sql => { statements.push(sql); return sql === 'SHOW TABLES' ? [[{ table: 'cl_schema' }]] : [[]]; }
  };
  await migrate(connection);
  assert.equal(statements.filter(sql => sql.startsWith('CREATE TABLE')).length, 4);
  assert.match(statements.at(-2), /UPDATE cl_schema SET version = 1/);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});

test('conexao falha fechada sem senha e recusa porta fora do intervalo', () => {
  assert.equal(databaseOptions({ DB_HOST: 'localhost', DB_NAME: 'teste', DB_USER: 'teste' }), null);
  assert.throws(() => databaseOptions({ DB_HOST: 'localhost', DB_NAME: 'teste', DB_USER: 'teste', DB_PASSWORD: 'test-only', DB_PORT: '0' }), /invalida/);
});
