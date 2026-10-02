'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../scripts/migrate-database');
const { databaseOptions, repositoryForPool } = require('../src/database');

const baseTables = ['cl_schema', 'cl_company', 'cl_users', 'cl_sessions'];
const departmentColumns = [
  { Field: 'id', Type: 'int unsigned', Null: 'NO', Extra: 'auto_increment' },
  { Field: 'name', Type: 'varchar(100)', Null: 'NO', Extra: '', Collation: 'utf8mb4_unicode_ci' },
  { Field: 'active', Type: 'tinyint', Null: 'NO', Extra: '', Default: '1' },
  { Field: 'created_at', Type: 'timestamp', Null: 'NO', Extra: '', Default: 'current_timestamp()' }
];
const memberColumns = ['department_id', 'user_id'].map(Field => ({ Field, Type: 'int unsigned', Null: 'NO', Extra: '' }));
const index = (Key_name, columns, Non_unique = 0) => columns.map((Column_name, i) => ({ Key_name, Column_name, Seq_in_index: i + 1, Non_unique, Sub_part: null }));
const foreignKeys = [
  { columnName: 'department_id', referencedTable: 'cl_departments', referencedColumn: 'id' },
  { columnName: 'user_id', referencedTable: 'cl_users', referencedColumn: 'id' }
];

function migrationConnection({ tables = [], version = null } = {}) {
  const state = { tables: new Set(tables), version, failTable: null, departmentIndexes: [...index('PRIMARY', ['id']), ...index('name_unique', ['name'])],
    memberIndexes: [...index('PRIMARY', ['department_id', 'user_id']), ...index('user_lookup', ['user_id', 'department_id'], 1)], foreignKeys: [...foreignKeys], acquired: 1,
    departmentColumns: departmentColumns.map(row => ({ ...row })), engines: ['cl_departments', 'cl_department_members'].map(tableName => ({ tableName, engine: 'InnoDB' })) };
  const statements = [];
  const connection = {
    execute: async sql => {
      statements.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: state.acquired }]];
      if (sql.startsWith('SELECT version')) return [state.version === null ? [] : [{ version: state.version }]];
      if (sql.startsWith('INSERT IGNORE INTO cl_schema')) { if (state.version === null) state.version = 0; }
      if (sql.startsWith('UPDATE cl_schema')) state.version = Number(sql.match(/version = (\d+)/)[1]);
      if (sql.includes('KEY_COLUMN_USAGE')) return [state.foreignKeys];
      if (sql.includes('information_schema.TABLES')) return [state.engines];
      return [[]];
    },
    query: async sql => {
      statements.push(sql);
      if (sql === 'SHOW TABLES') return [[...state.tables].map(table => ({ table }))];
      if (sql.startsWith('CREATE TABLE')) {
        const name = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1];
        if (name === state.failTable) throw new Error('Interrupcao simulada de DDL.');
        state.tables.add(name);
      }
      if (sql === 'SHOW FULL COLUMNS FROM cl_departments') return [state.departmentColumns];
      if (sql === 'SHOW COLUMNS FROM cl_department_members') return [memberColumns];
      if (sql === 'SHOW INDEX FROM cl_departments') return [state.departmentIndexes];
      if (sql === 'SHOW INDEX FROM cl_department_members') return [state.memberIndexes];
      if (sql.endsWith('LIMIT 0') && !state.tables.has(sql.match(/FROM (\w+)/)[1])) throw new Error('Tabela base ausente.');
      return [[]];
    }
  };
  return { connection, statements, state };
}

test('migracao recusa banco de outro site antes de executar DDL e libera trava', async () => {
  const { connection, statements } = migrationConnection({ tables: ['wordpress_posts'] });
  await assert.rejects(migrate(connection), /exclusivo/);
  assert.equal(statements.some(sql => sql.startsWith('CREATE')), false);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});

test('migracao v1 continua explicita e retoma v0 sem criar departamentos', async () => {
  const { connection, statements, state } = migrationConnection({ tables: ['cl_schema'], version: 0 });
  assert.deepEqual(await migrate(connection, { targetVersion: 1 }), { schemaVersion: 1 });
  assert.equal(statements.filter(sql => sql.startsWith('CREATE TABLE')).length, 4);
  assert.match(statements.at(-2), /UPDATE cl_schema SET version = 1/);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
  assert.equal(state.version, 1);
  assert.equal(state.tables.has('cl_departments'), false);
});

test('instalacao vazia e marcador sem linha retomam ate v2 sem criar usuarios', async () => {
  for (const tables of [[], ['cl_schema']]) {
    const { connection, statements, state } = migrationConnection({ tables });
    assert.deepEqual(await migrate(connection), { schemaVersion: 2 });
    assert.equal(state.version, 2);
    assert.equal(state.tables.size, 6);
    assert.equal(statements.some(sql => /INSERT INTO cl_users|UPDATE cl_users|DELETE FROM cl_users/.test(sql)), false);
    assert.ok(statements.indexOf('UPDATE cl_schema SET version = 1 WHERE id = 1') < statements.indexOf('UPDATE cl_schema SET version = 2 WHERE id = 1'));
  }
});

test('upgrade v1 preserva a base e marca v2 somente apos verificar indices e FKs', async () => {
  const { connection, statements, state } = migrationConnection({ tables: baseTables, version: 1 });
  await migrate(connection);
  assert.equal(state.version, 2);
  assert.equal(statements.filter(sql => sql.startsWith('CREATE TABLE')).length, 2);
  assert.equal(statements.some(sql => /INSERT IGNORE INTO cl_schema|UPDATE cl_schema SET version = 1|UPDATE cl_users|ALTER TABLE|DROP TABLE/.test(sql)), false);
  const marked = statements.indexOf('UPDATE cl_schema SET version = 2 WHERE id = 1');
  assert.ok(statements.findIndex(sql => sql.includes('KEY_COLUMN_USAGE')) < marked);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});

test('upgrade interrompido mantem v1 e retoma tabela v2 parcial', async () => {
  const { connection, statements, state } = migrationConnection({ tables: baseTables, version: 1 });
  state.failTable = 'cl_department_members';
  await assert.rejects(migrate(connection), /Interrupcao/);
  assert.equal(state.version, 1);
  assert.equal(state.tables.has('cl_departments'), true);
  assert.equal(state.tables.has('cl_department_members'), false);
  assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 2 WHERE id = 1'), false);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
  state.failTable = null;
  await migrate(connection);
  assert.equal(state.version, 2);
  assert.equal(state.tables.size, 6);
});

test('v2 existente e idempotente e nao pode sofrer downgrade', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...baseTables, 'cl_departments', 'cl_department_members'], version: 2 });
  await migrate(connection);
  assert.equal(state.version, 2);
  assert.equal(statements.some(sql => /^(CREATE|UPDATE|INSERT|DELETE|ALTER|DROP)/.test(sql)), false);
  await assert.rejects(migrate(connection, { targetVersion: 1 }), /Downgrade/);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});

test('indice unico ou FK ausente impedem marcar estrutura parcial como v2', async () => {
  for (const broken of ['unique', 'foreign']) {
    const { connection, statements, state } = migrationConnection({ tables: baseTables, version: 1 });
    if (broken === 'unique') state.departmentIndexes = index('PRIMARY', ['id']);
    else state.foreignKeys = [];
    await assert.rejects(migrate(connection), /incompativ/);
    assert.equal(state.version, 1);
    assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 2 WHERE id = 1'), false);
  }
});

test('defaults, engine e collation defeituosos impedem concluir v2 parcial', async () => {
  for (const broken of ['active-default', 'created-default', 'engine', 'collation']) {
    const { connection, statements, state } = migrationConnection({ tables: [...baseTables, 'cl_departments'], version: 1 });
    if (broken === 'active-default') state.departmentColumns.find(row => row.Field === 'active').Default = '0';
    if (broken === 'created-default') state.departmentColumns.find(row => row.Field === 'created_at').Default = null;
    if (broken === 'engine') state.engines[0].engine = 'MyISAM';
    if (broken === 'collation') state.departmentColumns.find(row => row.Field === 'name').Collation = 'utf8mb4_bin';
    await assert.rejects(migrate(connection), /incompativ/);
    assert.equal(state.version, 1);
    assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 2 WHERE id = 1'), false);
  }
  const { connection, state } = migrationConnection({ tables: baseTables, version: 1 });
  state.departmentColumns.find(row => row.Field === 'created_at').Default = 'CURRENT_TIMESTAMP';
  await migrate(connection);
  assert.equal(state.version, 2);
});

test('base marcada incompleta, versao futura e trava ocupada nao executam DDL', async () => {
  for (const options of [{ tables: ['cl_schema'], version: 1 }, { tables: baseTables, version: 3 }]) {
    const { connection, statements } = migrationConnection(options);
    await assert.rejects(migrate(connection));
    assert.equal(statements.some(sql => sql.startsWith('CREATE')), false);
  }
  const { connection, statements, state } = migrationConnection();
  state.acquired = 0;
  await assert.rejects(migrate(connection), /andamento/);
  assert.equal(statements.length, 1);
});

test('status e capacidades aceitam v1 e v2, recusando consultas dependentes em v1', async () => {
  let version = 1;
  const statements = [];
  const pool = { execute: async sql => { statements.push(sql); return sql.startsWith('SELECT version') ? [[{ version }]] : [[{ id: 1 }]]; } };
  const repository = repositoryForPool(pool);
  assert.equal(await repository.status(), 'installed');
  assert.deepEqual(await repository.capabilities(), { schemaVersion: 1, departments: false });
  await assert.rejects(repository.listDepartments(1, 1, 20), error => error.statusCode === 503);
  await assert.rejects(repository.findDepartment(1, 1), error => error.statusCode === 503);
  assert.equal(statements.some(sql => sql.includes('FROM cl_departments')), false);
  version = 2;
  assert.equal(await repository.status(), 'installed');
  assert.deepEqual(await repository.capabilities(), { schemaVersion: 2, departments: true });
  version = 0;
  await assert.rejects(repository.capabilities(), /incompativel/);
});

test('conexao falha fechada sem senha e recusa porta fora do intervalo', () => {
  assert.equal(databaseOptions({ DB_HOST: 'localhost', DB_NAME: 'teste', DB_USER: 'teste' }), null);
  assert.throws(() => databaseOptions({ DB_HOST: 'localhost', DB_NAME: 'teste', DB_USER: 'teste', DB_PASSWORD: 'test-only', DB_PORT: '0' }), /invalida/);
});

test('duas criacoes no limite nao usam snapshot anterior a espera pela trava', async () => {
  // Model InnoDB REPEATABLE READ: the first nonlocking SELECT fixes a snapshot.
  // Each connection stages its insert until commit and shares the schema-row lock.
  let total = 49;
  let owner = null;
  const waiters = [];
  function release(connection) {
    if (owner !== connection) return;
    const next = waiters.shift();
    owner = next?.connection || null;
    if (next) next.resolve();
  }
  const pool = {
    getConnection: async () => {
      let snapshot = null;
      let inserted = 0;
      const connection = {
        beginTransaction: async () => {},
        commit: async () => { total += inserted; release(connection); },
        rollback: async () => { release(connection); },
        release: () => {},
        execute: async sql => {
          if (sql === 'SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE') {
            if (!owner) owner = connection;
            else await new Promise(resolve => waiters.push({ connection, resolve }));
            return [[{ id: 1 }]];
          }
          if (sql.startsWith('SELECT') && !sql.endsWith('FOR UPDATE') && snapshot === null) snapshot = total;
          if (sql.startsWith('SELECT version')) return [[{ version: 2 }]];
          if (sql.startsWith('SELECT role, active')) return [[{ role: 'admin', active: 1 }]];
          if (sql.startsWith('SELECT COUNT(*) AS total FROM cl_departments')) return [[{ total: snapshot }]];
          if (sql.startsWith('INSERT INTO cl_departments')) { inserted++; return [{ insertId: total + inserted }]; }
          throw new Error('Consulta inesperada no modelo transacional.');
        }
      };
      return connection;
    }
  };
  const repository = repositoryForPool(pool);
  const results = await Promise.allSettled([
    repository.createDepartment(1, { name: 'Vendas' }), repository.createDepartment(1, { name: 'Suporte' })
  ]);
  assert.equal(total, 50);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.statusCode, 409);
});
