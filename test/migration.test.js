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
const chatTables = ['cl_visitors', 'cl_chat_conversations', 'cl_chat_messages', 'cl_chat_limits'];
const publicColumn = { Field: 'public_chat', Type: 'tinyint', Null: 'NO', Extra: '', Default: '0' };
const field = (Field, Type, extra = {}) => ({ Field, Type, Null: 'NO', Extra: '', ...extra });
const identity = () => field('id', 'int unsigned', { Extra: 'auto_increment' });
const dated = Field => field(Field, 'datetime', { Default: 'CURRENT_TIMESTAMP' });
const ascii = (Field, length) => field(Field, `char(${length})`, { Collation: 'ascii_bin' });
const chatColumns = {
  cl_visitors: [identity(), field('name', 'varchar(100)', { Collation: 'utf8mb4_unicode_ci' }), ascii('token_hash', 64), field('expires_at', 'datetime'), dated('created_at')],
  cl_chat_conversations: [identity(), field('visitor_id', 'int unsigned'), field('department_id', 'int unsigned'), field('assigned_to', 'int unsigned', { Null: 'YES' }), field('status', "enum('waiting','open','closed')", { Default: 'waiting' }), field('last_sequence', 'int unsigned', { Default: '0' }), dated('updated_at'), dated('created_at')],
  cl_chat_messages: [field('conversation_id', 'int unsigned'), field('sequence', 'int unsigned'), field('sender', "enum('visitor','team')"), field('author_id', 'int unsigned'), ascii('client_key', 32), field('text', 'varchar(2000)', { Collation: 'utf8mb4_unicode_ci' }), dated('created_at')],
  cl_chat_limits: [ascii('key_hash', 64), field('window_start', 'bigint unsigned', { Default: '0' }), field('count', 'int unsigned', { Default: '0' }), field('expires_at', 'datetime')]
};
const chatIndexes = {
  cl_visitors: [...index('PRIMARY', ['id']), ...index('token', ['token_hash']), ...index('expiry', ['expires_at'], 1)],
  cl_chat_conversations: [...index('PRIMARY', ['id']), ...index('visitor', ['visitor_id', 'status', 'id'], 1), ...index('department', ['department_id', 'updated_at', 'id'], 1)],
  cl_chat_messages: [...index('PRIMARY', ['conversation_id', 'sequence']), ...index('idempotency', ['conversation_id', 'sender', 'author_id', 'client_key'])],
  cl_chat_limits: [...index('PRIMARY', ['key_hash']), ...index('expiry', ['expires_at'], 1)]
};
const chatForeignKeys = [
  ['cl_chat_conversations', 'visitor_id', 'cl_visitors'], ['cl_chat_conversations', 'department_id', 'cl_departments'],
  ['cl_chat_conversations', 'assigned_to', 'cl_users'], ['cl_chat_messages', 'conversation_id', 'cl_chat_conversations']
].map(([tableName, columnName, referencedTable]) => ({ tableName, columnName, referencedTable, referencedColumn: 'id' }));

const contactColumns = [
  identity(), field('department_id', 'int unsigned'), field('name', 'varchar(100)', { Collation: 'utf8mb4_unicode_ci' }),
  field('email', 'varchar(254)', { Default: '', Collation: 'utf8mb4_unicode_ci' }), field('phone', 'varchar(40)', { Default: '', Collation: 'utf8mb4_unicode_ci' }),
  field('company', 'varchar(100)', { Default: '', Collation: 'utf8mb4_unicode_ci' }), field('kind', "enum('lead','contact','customer')", { Default: 'lead', Collation: 'utf8mb4_unicode_ci' }),
  field('version', 'int unsigned', { Default: '1' }), field('created_by', 'int unsigned'), ascii('client_key', 32), ascii('request_hash', 64),
  field('created_at', 'datetime'), field('updated_at', 'datetime')
].map(row => ({ Default: null, ...row }));
const contactIndexes = [...index('PRIMARY', ['id']), ...index('idempotency', ['created_by', 'client_key']), ...index('queue', ['department_id', 'kind', 'updated_at', 'id'], 1)];
const contactForeignKeys = [['department_id', 'cl_departments'], ['created_by', 'cl_users']].map(([columnName, referencedTable]) => ({ columnName, referencedTable, referencedColumn: 'id', deleteRule: 'RESTRICT', updateRule: 'RESTRICT' }));
const schema3Tables = [...baseTables, 'cl_departments', 'cl_department_members', ...chatTables];

function migrationConnection({ tables = [], version = null } = {}) {
  const state = { tables: new Set(tables), version, failTable: null, departmentIndexes: [...index('PRIMARY', ['id']), ...index('name_unique', ['name'])],
    memberIndexes: [...index('PRIMARY', ['department_id', 'user_id']), ...index('user_lookup', ['user_id', 'department_id'], 1)], foreignKeys: [...foreignKeys], acquired: 1,
    departmentColumns: departmentColumns.map(row => ({ ...row })), engines: ['cl_departments', 'cl_department_members'].map(tableName => ({ tableName, engine: 'InnoDB' })),
    chatColumns: structuredClone(chatColumns), chatIndexes: structuredClone(chatIndexes), chatForeignKeys: structuredClone(chatForeignKeys), chatEngines: chatTables.map(tableName => ({ tableName, engine: 'InnoDB' })), coreEngines: ['cl_schema', 'cl_users', 'cl_sessions'].map(tableName => ({ tableName, engine: 'InnoDB' })),
    contactColumns: structuredClone(contactColumns), contactIndexes: structuredClone(contactIndexes), contactForeignKeys: structuredClone(contactForeignKeys),
    contactTables: [{ tableName: 'cl_contacts', engine: 'InnoDB', tableCollation: 'utf8mb4_unicode_ci' }] };
  const statements = [];
  const connection = {
    execute: async sql => {
      statements.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: state.acquired }]];
      if (sql.startsWith('SELECT version')) return [state.version === null ? [] : [{ version: state.version }]];
      if (sql.startsWith('INSERT IGNORE INTO cl_schema')) { if (state.version === null) state.version = 0; }
      if (sql.startsWith('UPDATE cl_schema')) state.version = Number(sql.match(/version = (\d+)/)[1]);
      if (sql.includes('KEY_COLUMN_USAGE') && sql.includes("TABLE_NAME = 'cl_contacts'")) return [state.contactForeignKeys];
      if (sql.includes('information_schema.TABLES') && sql.includes("TABLE_NAME = 'cl_contacts'")) return [state.contactTables];
      if (sql.includes('KEY_COLUMN_USAGE')) return [sql.includes("TABLE_NAME IN ('cl_chat_") ? state.chatForeignKeys : state.foreignKeys];
      if (sql.includes('information_schema.TABLES')) return [sql.includes("TABLE_NAME IN ('cl_visitors'") ? state.chatEngines : sql.includes("TABLE_NAME IN ('cl_schema'") ? state.coreEngines : state.engines];
      return [[]];
    },
    query: async sql => {
      statements.push(sql);
      if (sql === 'SHOW TABLES') return [[...state.tables].map(table => ({ table }))];
      if (sql.startsWith('ALTER TABLE cl_departments ADD COLUMN public_chat')) state.departmentColumns.push({ ...publicColumn });
      if (sql.startsWith('CREATE TABLE')) {
        const name = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1];
        if (name === state.failTable) throw new Error('Interrupcao simulada de DDL.');
        state.tables.add(name);
      }
      if (sql === 'SHOW FULL COLUMNS FROM cl_contacts') return [state.contactColumns];
      if (sql === 'SHOW INDEX FROM cl_contacts') return [state.contactIndexes];
      if (sql === 'SHOW FULL COLUMNS FROM cl_departments') return [state.departmentColumns];
      if (sql === 'SHOW COLUMNS FROM cl_department_members') return [memberColumns];
      if (sql === 'SHOW INDEX FROM cl_departments') return [state.departmentIndexes];
      if (sql === 'SHOW INDEX FROM cl_department_members') return [state.memberIndexes];
      if (sql.startsWith('SHOW FULL COLUMNS FROM cl_')) {
        const table = sql.slice('SHOW FULL COLUMNS FROM '.length);
        if (state.chatColumns[table]) return [state.chatColumns[table]];
      }
      if (sql.startsWith('SHOW INDEX FROM cl_')) {
        const table = sql.slice('SHOW INDEX FROM '.length);
        if (state.chatIndexes[table]) return [state.chatIndexes[table]];
      }
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
    assert.deepEqual(await migrate(connection, { targetVersion: 2 }), { schemaVersion: 2 });
    assert.equal(state.version, 2);
    assert.equal(state.tables.size, 6);
    assert.equal(statements.some(sql => /INSERT INTO cl_users|UPDATE cl_users|DELETE FROM cl_users/.test(sql)), false);
    assert.ok(statements.indexOf('UPDATE cl_schema SET version = 1 WHERE id = 1') < statements.indexOf('UPDATE cl_schema SET version = 2 WHERE id = 1'));
  }
});

test('upgrade v1 preserva a base e marca v2 somente apos verificar indices e FKs', async () => {
  const { connection, statements, state } = migrationConnection({ tables: baseTables, version: 1 });
  await migrate(connection, { targetVersion: 2 });
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
  await assert.rejects(migrate(connection, { targetVersion: 2 }), /Interrupcao/);
  assert.equal(state.version, 1);
  assert.equal(state.tables.has('cl_departments'), true);
  assert.equal(state.tables.has('cl_department_members'), false);
  assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 2 WHERE id = 1'), false);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
  state.failTable = null;
  await migrate(connection, { targetVersion: 2 });
  assert.equal(state.version, 2);
  assert.equal(state.tables.size, 6);
});

test('v2 existente e idempotente e nao pode sofrer downgrade', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...baseTables, 'cl_departments', 'cl_department_members'], version: 2 });
  await migrate(connection, { targetVersion: 2 });
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
    await assert.rejects(migrate(connection, { targetVersion: 2 }), /incompativ/);
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
    await assert.rejects(migrate(connection, { targetVersion: 2 }), /incompativ/);
    assert.equal(state.version, 1);
    assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 2 WHERE id = 1'), false);
  }
  const { connection, state } = migrationConnection({ tables: baseTables, version: 1 });
  state.departmentColumns.find(row => row.Field === 'created_at').Default = 'CURRENT_TIMESTAMP';
  await migrate(connection, { targetVersion: 2 });
  assert.equal(state.version, 2);
});

test('migracao padrao instala v4 sem publicar canais nem criar identidades', async () => {
  const { connection, statements, state } = migrationConnection();
  assert.deepEqual(await migrate(connection), { schemaVersion: 4 });
  assert.equal(state.version, 4);
  assert.equal(state.tables.size, 11);
  assert.deepEqual(state.departmentColumns.find(row => row.Field === 'public_chat'), publicColumn);
  assert.equal(statements.some(sql => /^(?:INSERT(?: IGNORE)? INTO|UPDATE|DELETE FROM) cl_(?:users|sessions|visitors|company)\b/.test(sql)), false);
  const mark = statements.indexOf('UPDATE cl_schema SET version = 3 WHERE id = 1');
  assert.ok(statements.findIndex(sql => sql.includes("TABLE_NAME IN ('cl_chat_")) < mark);
  const contactMark = statements.indexOf('UPDATE cl_schema SET version = 4 WHERE id = 1');
  assert.ok(mark < contactMark);
  assert.ok(statements.findIndex(sql => sql.includes('REFERENTIAL_CONSTRAINTS')) < contactMark);
  assert.ok(statements.filter(sql => sql.startsWith('CREATE TABLE')).every(sql => /ENGINE=InnoDB/.test(sql)));
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});

test('upgrade v2 adiciona somente entrada privada e quatro tabelas de chat', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...baseTables, 'cl_departments', 'cl_department_members'], version: 2 });
  await migrate(connection, { targetVersion: 3 });
  assert.equal(state.version, 3);
  assert.equal(statements.filter(sql => sql.startsWith('CREATE TABLE')).length, 4);
  assert.deepEqual(statements.filter(sql => sql.startsWith('ALTER')), ['ALTER TABLE cl_departments ADD COLUMN public_chat TINYINT NOT NULL DEFAULT 0']);
  assert.equal(statements.some(sql => /^(?:DROP|DELETE)|^UPDATE cl_(?:users|sessions|company|departments)\b|^INSERT INTO cl_(?:users|sessions|company)\b/.test(sql)), false);
  assert.deepEqual(state.departmentColumns.slice(0, 4), departmentColumns);
});

test('DDL v3 interrompido preserva marcador v2 e retoma sem repetir coluna publica', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...baseTables, 'cl_departments', 'cl_department_members'], version: 2 });
  state.failTable = 'cl_chat_messages';
  await assert.rejects(migrate(connection), /Interrupcao/);
  assert.equal(state.version, 2);
  assert.equal(state.tables.has('cl_visitors'), true);
  assert.equal(state.tables.has('cl_chat_conversations'), true);
  assert.equal(state.tables.has('cl_chat_messages'), false);
  assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 3 WHERE id = 1'), false);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
  const attempts = statements.length;
  // v2 remains usable during partial v3 preparation; it must not mark v3.
  assert.deepEqual(await migrate(connection, { targetVersion: 2 }), { schemaVersion: 2 });
  assert.equal(state.version, 2);
  state.failTable = null;
  await migrate(connection, { targetVersion: 3 });
  assert.equal(state.version, 3);
  assert.equal(state.tables.size, 10);
  assert.equal(statements.slice(attempts).some(sql => sql.startsWith('ALTER')), false);
  assert.equal(state.departmentColumns.filter(row => row.Field === 'public_chat').length, 1);
});

test('estrutura v3 parcial defeituosa nunca e marcada pronta', async () => {
  const defects = ['public-default', 'public-null', 'column', 'idempotency', 'sequence-key', 'visitor-key', 'unique-expiry', 'foreign', 'engine', 'schema-engine', 'hash-collation', 'text-collation', 'created-default', 'sequence-default', 'status-default'];
  for (const defect of defects) {
    const { connection, statements, state } = migrationConnection({ tables: [...baseTables, 'cl_departments', 'cl_department_members', ...chatTables], version: 2 });
    state.departmentColumns.push({ ...publicColumn });
    if (defect === 'public-default') state.departmentColumns.at(-1).Default = '1';
    if (defect === 'public-null') state.departmentColumns.at(-1).Null = 'YES';
    if (defect === 'column') state.chatColumns.cl_chat_messages.pop();
    if (defect === 'idempotency') state.chatIndexes.cl_chat_messages = index('PRIMARY', ['conversation_id', 'sequence']);
    if (defect === 'sequence-key') state.chatIndexes.cl_chat_messages = index('key', ['conversation_id', 'sender', 'author_id', 'client_key']);
    if (defect === 'visitor-key') state.chatIndexes.cl_visitors = [...index('PRIMARY', ['id']), ...index('expiry', ['expires_at'], 1)];
    if (defect === 'unique-expiry') state.chatIndexes.cl_chat_limits = [...index('PRIMARY', ['key_hash']), ...index('expiry', ['expires_at'])];
    if (defect === 'foreign') state.chatForeignKeys.pop();
    if (defect === 'engine') state.chatEngines[2].engine = 'MyISAM';
    if (defect === 'schema-engine') state.coreEngines[0].engine = 'MyISAM';
    if (defect === 'hash-collation') state.chatColumns.cl_visitors.find(row => row.Field === 'token_hash').Collation = 'ascii_general_ci';
    if (defect === 'text-collation') state.chatColumns.cl_chat_messages.find(row => row.Field === 'text').Collation = 'latin1_swedish_ci';
    if (defect === 'created-default') state.chatColumns.cl_visitors.find(row => row.Field === 'created_at').Default = null;
    if (defect === 'sequence-default') state.chatColumns.cl_chat_conversations.find(row => row.Field === 'last_sequence').Default = '1';
    if (defect === 'status-default') state.chatColumns.cl_chat_conversations.find(row => row.Field === 'status').Default = 'open';
    await assert.rejects(migrate(connection), /incompativ/, defect);
    assert.equal(state.version, 2, defect);
    assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 3 WHERE id = 1'), false, defect);
    assert.match(statements.at(-1), /RELEASE_LOCK/);
  }
});

test('schema v3 verificado e idempotente e nao aceita downgrade', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...baseTables, 'cl_departments', 'cl_department_members', ...chatTables], version: 3 });
  state.departmentColumns.push({ ...publicColumn });
  assert.deepEqual(await migrate(connection, { targetVersion: 3 }), { schemaVersion: 3 });
  assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  await assert.rejects(migrate(connection, { targetVersion: 2 }), /Downgrade/);
  await assert.rejects(migrate(connection, { targetVersion: 1 }), /Downgrade/);
  assert.equal(state.version, 3);
});

test('marcador v3 incompleto e chat antes de v2 falham antes de DDL', async () => {
  for (const options of [
    { tables: [...baseTables, 'cl_departments', 'cl_department_members', 'cl_visitors'], version: 3 },
    { tables: [...baseTables, 'cl_departments', 'cl_visitors'], version: 1 }
  ]) {
    const { connection, statements } = migrationConnection(options);
    await assert.rejects(migrate(connection), /incompleta|concluidos/);
    assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT)/.test(sql)), false);
  }
});

test('base marcada incompleta, versao futura e trava ocupada nao executam DDL', async () => {
  for (const options of [{ tables: ['cl_schema'], version: 1 }, { tables: baseTables, version: 5 }]) {
    const { connection, statements } = migrationConnection(options);
    await assert.rejects(migrate(connection));
    assert.equal(statements.some(sql => sql.startsWith('CREATE')), false);
  }
  const { connection, statements, state } = migrationConnection();
  state.acquired = 0;
  await assert.rejects(migrate(connection), /andamento/);
  assert.equal(statements.length, 1);
});

test('upgrade v3 cria somente contatos e marca v4 apos verificar toda a estrutura', async () => {
  const { connection, statements, state } = migrationConnection({ tables: schema3Tables, version: 3 });
  state.departmentColumns.push({ ...publicColumn });
  assert.deepEqual(await migrate(connection), { schemaVersion: 4 });
  assert.equal(state.version, 4); assert.equal(state.tables.size, 11);
  const ddl = statements.filter(sql => /^(CREATE|ALTER|DROP)/.test(sql));
  assert.equal(ddl.length, 1); assert.match(ddl[0], /^CREATE TABLE IF NOT EXISTS cl_contacts /);
  assert.match(ddl[0], /UNIQUE KEY cl_contacts_request \(created_by, client_key\)/);
  assert.match(ddl[0], /INDEX cl_contacts_queue \(department_id, kind, updated_at, id\)/);
  assert.match(ddl[0], /created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL/);
  assert.equal(statements.some(sql => /^(?:INSERT(?: IGNORE)? INTO|UPDATE|DELETE FROM) cl_(?:users|sessions|visitors|company|departments|chat_)\b/.test(sql)), false);
  const marked = statements.indexOf('UPDATE cl_schema SET version = 4 WHERE id = 1');
  for (const verification of ['SHOW FULL COLUMNS FROM cl_contacts', 'SHOW INDEX FROM cl_contacts']) assert.ok(statements.indexOf(verification) < marked);
  assert.ok(statements.findIndex(sql => sql.includes('REFERENTIAL_CONSTRAINTS')) < marked);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});

test('upgrade v4 interrompido preserva v3 e retoma tabela de contatos parcial', async () => {
  const { connection, statements, state } = migrationConnection({ tables: schema3Tables, version: 3 });
  state.departmentColumns.push({ ...publicColumn });
  state.failTable = 'cl_contacts';
  await assert.rejects(migrate(connection), /Interrupcao/);
  assert.equal(state.version, 3); assert.equal(state.tables.has('cl_contacts'), false);
  assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 4 WHERE id = 1'), false);
  // A table created before process interruption stays private until validated.
  state.failTable = null; state.tables.add('cl_contacts');
  const checkpoint = statements.length;
  assert.deepEqual(await migrate(connection, { targetVersion: 3 }), { schemaVersion: 3 });
  assert.equal(statements.slice(checkpoint).some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  assert.deepEqual(await migrate(connection), { schemaVersion: 4 });
  assert.equal(state.version, 4);
});

test('contatos defeituosos nao sao marcados v4 nem reparados de forma destrutiva', async () => {
  const defects = ['column-missing', 'column-extra', 'unsigned', 'auto-increment', 'nullable', 'name-length', 'email-default', 'company-default', 'kind-enum', 'kind-enum-case', 'kind-default', 'version-default', 'created-default', 'updated-default', 'generated', 'hash-collation', 'text-collation', 'engine', 'table-collation', 'primary', 'idempotency', 'queue-order', 'queue-unique', 'index-prefix', 'extra-unique-email', 'extra-unique-phone', 'foreign', 'delete-rule', 'update-rule'];
  for (const defect of defects) {
    const { connection, statements, state } = migrationConnection({ tables: [...schema3Tables, 'cl_contacts'], version: 3 });
    state.departmentColumns.push({ ...publicColumn });
    const column = name => state.contactColumns.find(row => row.Field === name);
    if (defect === 'column-missing') state.contactColumns.pop();
    if (defect === 'column-extra') state.contactColumns.push(field('hidden', 'varchar(100)', { Default: null }));
    if (defect === 'unsigned') column('department_id').Type = 'int';
    if (defect === 'auto-increment') column('id').Extra = '';
    if (defect === 'nullable') column('email').Null = 'YES';
    if (defect === 'name-length') column('name').Type = 'varchar(101)';
    if (defect === 'email-default') column('email').Default = null;
    if (defect === 'company-default') column('company').Default = 'Empresa';
    if (defect === 'kind-enum') column('kind').Type = "enum('lead','contact','customer','admin')";
    if (defect === 'kind-enum-case') column('kind').Type = "enum('LEAD','contact','customer')";
    if (defect === 'kind-default') column('kind').Default = 'customer';
    if (defect === 'version-default') column('version').Default = '0';
    if (defect === 'created-default') column('created_at').Default = 'CURRENT_TIMESTAMP';
    if (defect === 'updated-default') column('updated_at').Default = 'CURRENT_TIMESTAMP';
    if (defect === 'generated') column('updated_at').Extra = 'on update CURRENT_TIMESTAMP';
    if (defect === 'hash-collation') column('request_hash').Collation = 'ascii_general_ci';
    if (defect === 'text-collation') column('name').Collation = 'utf8mb4_bin';
    if (defect === 'engine') state.contactTables[0].engine = 'MyISAM';
    if (defect === 'table-collation') state.contactTables[0].tableCollation = 'utf8mb4_general_ci';
    if (defect === 'primary') state.contactIndexes = state.contactIndexes.filter(row => row.Key_name !== 'PRIMARY');
    if (defect === 'idempotency') state.contactIndexes = state.contactIndexes.filter(row => row.Key_name !== 'idempotency');
    if (defect === 'queue-order') state.contactIndexes = [...index('PRIMARY', ['id']), ...index('idempotency', ['created_by', 'client_key']), ...index('queue', ['department_id', 'updated_at', 'kind', 'id'], 1)];
    if (defect === 'queue-unique') state.contactIndexes.filter(row => row.Key_name === 'queue').forEach(row => { row.Non_unique = 0; });
    if (defect === 'index-prefix') state.contactIndexes.find(row => row.Key_name === 'idempotency' && row.Column_name === 'client_key').Sub_part = 16;
    if (defect === 'extra-unique-email') state.contactIndexes.push(...index('email_unique', ['email']));
    if (defect === 'extra-unique-phone') state.contactIndexes.push(...index('phone_unique', ['phone']));
    if (defect === 'foreign') state.contactForeignKeys.pop();
    if (defect === 'delete-rule') state.contactForeignKeys[0].deleteRule = 'CASCADE';
    if (defect === 'update-rule') state.contactForeignKeys[1].updateRule = 'CASCADE';
    await assert.rejects(migrate(connection), /incompativ/, defect);
    assert.equal(state.version, 3, defect);
    assert.equal(statements.some(sql => /^(ALTER|DELETE|DROP)/.test(sql) || sql === 'UPDATE cl_schema SET version = 4 WHERE id = 1'), false, defect);
    assert.match(statements.at(-1), /RELEASE_LOCK/);
  }
});

test('v4 concluido e idempotente, preserva v1-v3 explicitos e recusa downgrade', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...schema3Tables, 'cl_contacts'], version: 4 });
  state.departmentColumns.push({ ...publicColumn });
  state.contactIndexes.push(...index('email_lookup', ['email'], 1));
  assert.deepEqual(await migrate(connection), { schemaVersion: 4 });
  assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  for (const targetVersion of [1, 2, 3]) await assert.rejects(migrate(connection, { targetVersion }), /Downgrade/);
  assert.equal(state.version, 4);
});

test('marcador v4 incompleto ou contatos antes do chat recusam DDL', async () => {
  for (const options of [{ tables: schema3Tables, version: 4 }, { tables: [...baseTables, 'cl_departments', 'cl_department_members', 'cl_contacts'], version: 2 }]) {
    const { connection, statements, state } = migrationConnection(options);
    state.departmentColumns.push({ ...publicColumn });
    await assert.rejects(migrate(connection), /incompleta|concluido/);
    assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
    assert.match(statements.at(-1), /RELEASE_LOCK/);
  }
});

test('status e capacidades preservam v1-v3 e habilitam contatos em v4', async () => {
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
  await assert.rejects(repository.listPublicChatDepartments(), error => error.statusCode === 503);
  version = 3;
  assert.equal(await repository.status(), 'installed');
  assert.deepEqual(await repository.capabilities(), { schemaVersion: 3, departments: true, chat: true });
  version = 4;
  assert.equal(await repository.status(), 'installed');
  assert.deepEqual(await repository.capabilities(), { schemaVersion: 4, departments: true, chat: true, contacts: true });
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
