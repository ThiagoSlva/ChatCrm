'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate, verifyConversationContactSchema, verifyPortalSchema } = require('../scripts/migrate-database');
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
const contactForeignKeys = [['department_id', 'cl_departments'], ['created_by', 'cl_users']].map(([columnName, referencedTable]) => ({ columnName, referencedTable, referencedColumn: 'id', localSchema: 1, deleteRule: 'RESTRICT', updateRule: 'RESTRICT' }));
const schema3Tables = [...baseTables, 'cl_departments', 'cl_department_members', ...chatTables];

const opportunityTables = ['cl_opportunities', 'cl_opportunity_events'];
const schema4Tables = [...schema3Tables, 'cl_contacts'];
const opportunityColumns = {
  cl_opportunities: [identity(), field('contact_id', 'int unsigned'), field('title', 'varchar(150)', { Collation: 'utf8mb4_unicode_ci' }), field('amount_cents', 'int unsigned', { Default: '0' }), field('stage', "enum('new','qualified','proposal','won','lost')", { Default: 'new', Collation: 'utf8mb4_unicode_ci' }), field('version', 'int unsigned', { Default: '1' }), field('created_by', 'int unsigned'), ascii('client_key', 32), ascii('request_hash', 64), field('created_at', 'datetime'), field('updated_at', 'datetime')],
  cl_opportunity_events: [field('opportunity_id', 'int unsigned'), field('version', 'int unsigned'), field('actor_id', 'int unsigned'), field('title', 'varchar(150)', { Collation: 'utf8mb4_unicode_ci' }), field('amount_cents', 'int unsigned', { Default: '0' }), field('stage', "enum('new','qualified','proposal','won','lost')", { Collation: 'utf8mb4_unicode_ci' }), field('created_at', 'datetime')]
};
for (const table of opportunityTables) opportunityColumns[table] = opportunityColumns[table].map(row => ({ Default: null, ...row }));
const opportunityIndexes = {
  cl_opportunities: [...index('PRIMARY', ['id']), ...index('idempotency', ['created_by', 'client_key']), ...index('queue', ['contact_id', 'stage', 'updated_at', 'id'], 1)],
  cl_opportunity_events: [...index('PRIMARY', ['opportunity_id', 'version']), ...index('actor_lookup', ['actor_id'], 1)]
};
const opportunityForeignKeys = [['cl_opportunities', 'contact_id', 'cl_contacts'], ['cl_opportunities', 'created_by', 'cl_users'], ['cl_opportunity_events', 'opportunity_id', 'cl_opportunities'], ['cl_opportunity_events', 'actor_id', 'cl_users']].map(([tableName, columnName, referencedTable]) => ({ tableName, columnName, referencedTable, referencedColumn: 'id', localSchema: 1, deleteRule: 'RESTRICT', updateRule: 'RESTRICT' }));

const conversationContactTables = ['cl_conversation_contacts', 'cl_conversation_contact_events'];
const schema5Tables = [...schema4Tables, ...opportunityTables];
const conversationContactColumns = {
  cl_conversation_contacts: [field('conversation_id', 'int unsigned'), field('contact_id', 'int unsigned', { Null: 'YES' }), field('version', 'int unsigned', { Default: '1' }), field('updated_by', 'int unsigned'), field('updated_at', 'datetime')],
  cl_conversation_contact_events: [field('conversation_id', 'int unsigned'), field('version', 'int unsigned'), field('contact_id', 'int unsigned', { Null: 'YES' }), field('actor_id', 'int unsigned'), field('created_at', 'datetime')]
};
for (const table of conversationContactTables) conversationContactColumns[table] = conversationContactColumns[table].map(row => ({ Default: null, ...row }));
const conversationContactIndexes = {
  cl_conversation_contacts: [...index('PRIMARY', ['conversation_id']), ...index('contact_lookup', ['contact_id', 'conversation_id'], 1), ...index('actor_lookup', ['updated_by'], 1)],
  cl_conversation_contact_events: [...index('PRIMARY', ['conversation_id', 'version']), ...index('contact_lookup', ['contact_id'], 1), ...index('actor_lookup', ['actor_id'], 1)]
};
const conversationContactForeignKeys = [
  ['cl_conversation_contacts', 'conversation_id', 'cl_chat_conversations', 'id'], ['cl_conversation_contacts', 'contact_id', 'cl_contacts', 'id'], ['cl_conversation_contacts', 'updated_by', 'cl_users', 'id'],
  ['cl_conversation_contact_events', 'conversation_id', 'cl_conversation_contacts', 'conversation_id'], ['cl_conversation_contact_events', 'contact_id', 'cl_contacts', 'id'], ['cl_conversation_contact_events', 'actor_id', 'cl_users', 'id']
].map(([tableName, columnName, referencedTable, referencedColumn]) => ({ tableName, columnName, referencedTable, referencedColumn, localSchema: 1, deleteRule: 'RESTRICT', updateRule: 'RESTRICT' }));


const portalTables = ['cl_portal_accounts', 'cl_portal_sessions'];
const schema6Tables = [...schema5Tables, ...conversationContactTables];
const portalColumns = {
  cl_portal_accounts: [identity(), field('visitor_id','int unsigned'), ascii('access_id',24), field('password_hash','varchar(200)',{Collation:'ascii_bin'}), ascii('recovery_hash',64), field('version','int unsigned',{Default:'1'}), field('active','tinyint',{Default:'1'}), field('created_at','datetime')],
  cl_portal_sessions: [ascii('token_hash',64), field('account_id','int unsigned'), field('expires_at','datetime')]
};
for(const table of portalTables) portalColumns[table]=portalColumns[table].map(row=>({Default:null,...row}));
const portalIndexes = {
  cl_portal_accounts: [...index('PRIMARY',['id']),...index('cl_portal_accounts_visitor',['visitor_id']),...index('cl_portal_accounts_access',['access_id'])],
  cl_portal_sessions: [...index('PRIMARY',['token_hash']),...index('cl_portal_sessions_account',['account_id'],1),...index('cl_portal_sessions_expiry',['expires_at'],1)]
};
const portalForeignKeys=[['cl_portal_accounts','visitor_id','cl_visitors'],['cl_portal_sessions','account_id','cl_portal_accounts']].map(([tableName,columnName,referencedTable])=>({tableName,columnName,referencedTable,referencedColumn:'id',localSchema:1,deleteRule:'RESTRICT',updateRule:'RESTRICT'}));

function migrationConnection({ tables = [], version = null } = {}) {
  const state = { tables: new Set(tables), version, failTable: null, departmentIndexes: [...index('PRIMARY', ['id']), ...index('name_unique', ['name'])],
    memberIndexes: [...index('PRIMARY', ['department_id', 'user_id']), ...index('user_lookup', ['user_id', 'department_id'], 1)], foreignKeys: [...foreignKeys], acquired: 1,
    departmentColumns: departmentColumns.map(row => ({ ...row })), engines: ['cl_departments', 'cl_department_members'].map(tableName => ({ tableName, engine: 'InnoDB' })),
    chatColumns: structuredClone(chatColumns), chatIndexes: structuredClone(chatIndexes), chatForeignKeys: structuredClone(chatForeignKeys), chatEngines: chatTables.map(tableName => ({ tableName, engine: 'InnoDB' })), coreEngines: ['cl_schema', 'cl_users', 'cl_sessions'].map(tableName => ({ tableName, engine: 'InnoDB' })),
    contactColumns: structuredClone(contactColumns), contactIndexes: structuredClone(contactIndexes), contactForeignKeys: structuredClone(contactForeignKeys),
    contactTables: [{ tableName: 'cl_contacts', engine: 'InnoDB', tableCollation: 'utf8mb4_unicode_ci' }], opportunityColumns: structuredClone(opportunityColumns), opportunityIndexes: structuredClone(opportunityIndexes), opportunityForeignKeys: structuredClone(opportunityForeignKeys), opportunityEngines: opportunityTables.map(tableName => ({ tableName, engine: 'InnoDB', tableCollation: 'utf8mb4_unicode_ci' })),
    conversationContactColumns: structuredClone(conversationContactColumns), conversationContactIndexes: structuredClone(conversationContactIndexes), conversationContactForeignKeys: structuredClone(conversationContactForeignKeys), conversationContactEngines: conversationContactTables.map(tableName => ({ tableName, engine: 'InnoDB', tableCollation: 'utf8mb4_unicode_ci' })), portalColumns: structuredClone(portalColumns), portalIndexes: structuredClone(portalIndexes), portalForeignKeys: structuredClone(portalForeignKeys), portalEngines: portalTables.map(tableName=>({tableName,engine:'InnoDB',tableCollation:'utf8mb4_unicode_ci'})) };
  const statements = [];
  const connection = {
    execute: async sql => {
      statements.push(sql);
      if (sql.includes('GET_LOCK')) return [[{ acquired: state.acquired }]];
      if (sql.startsWith('SELECT version')) return [state.version === null ? [] : [{ version: state.version }]];
      if (sql.startsWith('INSERT IGNORE INTO cl_schema')) { if (state.version === null) state.version = 0; }
      if (sql.startsWith('UPDATE cl_schema')) state.version = Number(sql.match(/version = (\d+)/)[1]);
      if (sql.includes('KEY_COLUMN_USAGE') && sql.includes("TABLE_NAME IN ('cl_portal_accounts'")) return [state.portalForeignKeys];
      if (sql.includes('information_schema.TABLES') && sql.includes("TABLE_NAME IN ('cl_portal_accounts'")) return [state.portalEngines];
      if (sql.includes('KEY_COLUMN_USAGE') && sql.includes("TABLE_NAME IN ('cl_conversation_contacts'")) return [state.conversationContactForeignKeys];
      if (sql.includes('information_schema.TABLES') && sql.includes("TABLE_NAME IN ('cl_conversation_contacts'")) return [state.conversationContactEngines];
      if (sql.includes('KEY_COLUMN_USAGE') && sql.includes("TABLE_NAME IN ('cl_opportunities'")) return [state.opportunityForeignKeys];
      if (sql.includes('information_schema.TABLES') && sql.includes("TABLE_NAME IN ('cl_opportunities'")) return [state.opportunityEngines];
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
      if (sql.startsWith('SHOW FULL COLUMNS FROM ') && state.portalColumns[sql.slice(23)]) return [state.portalColumns[sql.slice(23)]];
      if (sql.startsWith('SHOW INDEX FROM ') && state.portalIndexes[sql.slice(16)]) return [state.portalIndexes[sql.slice(16)]];
      if (sql === 'SHOW FULL COLUMNS FROM cl_contacts') return [state.contactColumns];
      if (sql === 'SHOW INDEX FROM cl_contacts') return [state.contactIndexes];
      if (sql === 'SHOW FULL COLUMNS FROM cl_departments') return [state.departmentColumns];
      if (sql === 'SHOW COLUMNS FROM cl_department_members') return [memberColumns];
      if (sql === 'SHOW INDEX FROM cl_departments') return [state.departmentIndexes];
      if (sql === 'SHOW INDEX FROM cl_department_members') return [state.memberIndexes];
      if (sql.startsWith('SHOW FULL COLUMNS FROM cl_') && state.conversationContactColumns[sql.slice('SHOW FULL COLUMNS FROM '.length)]) return [state.conversationContactColumns[sql.slice('SHOW FULL COLUMNS FROM '.length)]];
      if (sql.startsWith('SHOW INDEX FROM cl_') && state.conversationContactIndexes[sql.slice('SHOW INDEX FROM '.length)]) return [state.conversationContactIndexes[sql.slice('SHOW INDEX FROM '.length)]];
      if (sql.startsWith('SHOW FULL COLUMNS FROM cl_') && state.opportunityColumns[sql.slice('SHOW FULL COLUMNS FROM '.length)]) return [state.opportunityColumns[sql.slice('SHOW FULL COLUMNS FROM '.length)]];
      if (sql.startsWith('SHOW INDEX FROM cl_') && state.opportunityIndexes[sql.slice('SHOW INDEX FROM '.length)]) return [state.opportunityIndexes[sql.slice('SHOW INDEX FROM '.length)]];
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
  await assert.rejects(migrate(connection, { targetVersion: 4 }), /exclusivo/);
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

test('migracao padrao instala v7 sem publicar canais nem criar identidades', async () => {
  const { connection, statements, state } = migrationConnection();
  assert.deepEqual(await migrate(connection, { targetVersion: 7 }), { schemaVersion: 7 });
  assert.equal(state.version, 7);
  assert.equal(state.tables.size, 17);
  assert.deepEqual(state.departmentColumns.find(row => row.Field === 'public_chat'), publicColumn);
  assert.equal(statements.some(sql => /^(?:INSERT(?: IGNORE)? INTO|UPDATE|DELETE FROM) cl_(?:users|sessions|visitors|company)\b/.test(sql)), false);
  const mark = statements.indexOf('UPDATE cl_schema SET version = 3 WHERE id = 1');
  assert.ok(statements.findIndex(sql => sql.includes("TABLE_NAME IN ('cl_chat_")) < mark);
  const contactMark = statements.indexOf('UPDATE cl_schema SET version = 4 WHERE id = 1');
  assert.ok(mark < contactMark);
  assert.ok(statements.findIndex(sql => sql.includes('REFERENTIAL_CONSTRAINTS')) < contactMark);
  const opportunityMark = statements.indexOf('UPDATE cl_schema SET version = 5 WHERE id = 1');
  assert.ok(contactMark < opportunityMark);
  assert.ok(statements.findIndex(sql => sql.includes("k.TABLE_NAME IN ('cl_opportunities'")) < opportunityMark);
  const bindingMark = statements.indexOf('UPDATE cl_schema SET version = 6 WHERE id = 1');
  assert.ok(opportunityMark < bindingMark);
  const portalMark = statements.indexOf('UPDATE cl_schema SET version = 7 WHERE id = 1');
  assert.ok(bindingMark < portalMark);
  assert.ok(statements.findIndex(sql => sql.includes("k.TABLE_NAME IN ('cl_conversation_contacts'")) < bindingMark);
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
  await assert.rejects(migrate(connection, { targetVersion: 4 }), /Interrupcao/);
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
    await assert.rejects(migrate(connection, { targetVersion: 4 }), /incompativ/, defect);
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
    await assert.rejects(migrate(connection, { targetVersion: 4 }), /incompleta|concluidos/);
    assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT)/.test(sql)), false);
  }
});

test('base marcada incompleta, versao futura e trava ocupada nao executam DDL', async () => {
  for (const options of [{ tables: ['cl_schema'], version: 1 }, { tables: baseTables, version: 7 }]) {
    const { connection, statements } = migrationConnection(options);
    await assert.rejects(migrate(connection, { targetVersion: 4 }));
    assert.equal(statements.some(sql => sql.startsWith('CREATE')), false);
  }
  const { connection, statements, state } = migrationConnection();
  state.acquired = 0;
  await assert.rejects(migrate(connection, { targetVersion: 4 }), /andamento/);
  assert.equal(statements.length, 1);
});

test('upgrade v3 cria somente contatos e marca v4 apos verificar toda a estrutura', async () => {
  const { connection, statements, state } = migrationConnection({ tables: schema3Tables, version: 3 });
  state.departmentColumns.push({ ...publicColumn });
  assert.deepEqual(await migrate(connection, { targetVersion: 4 }), { schemaVersion: 4 });
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
  await assert.rejects(migrate(connection, { targetVersion: 4 }), /Interrupcao/);
  assert.equal(state.version, 3); assert.equal(state.tables.has('cl_contacts'), false);
  assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 4 WHERE id = 1'), false);
  // A table created before process interruption stays private until validated.
  state.failTable = null; state.tables.add('cl_contacts');
  const checkpoint = statements.length;
  assert.deepEqual(await migrate(connection, { targetVersion: 3 }), { schemaVersion: 3 });
  assert.equal(statements.slice(checkpoint).some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  assert.deepEqual(await migrate(connection, { targetVersion: 4 }), { schemaVersion: 4 });
  assert.equal(state.version, 4);
});

test('contatos defeituosos nao sao marcados v4 nem reparados de forma destrutiva', async () => {
  const defects = ['column-missing', 'column-extra', 'unsigned', 'auto-increment', 'nullable', 'name-length', 'email-default', 'company-default', 'kind-enum', 'kind-enum-case', 'kind-default', 'version-default', 'created-default', 'updated-default', 'generated', 'hash-collation', 'text-collation', 'engine', 'table-collation', 'primary', 'idempotency', 'queue-order', 'queue-unique', 'index-prefix', 'extra-unique-email', 'extra-unique-phone', 'foreign', 'foreign-schema', 'delete-rule', 'update-rule'];
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
    if (defect === 'foreign-schema') state.contactForeignKeys[0].localSchema = 0;
    if (defect === 'delete-rule') state.contactForeignKeys[0].deleteRule = 'CASCADE';
    if (defect === 'update-rule') state.contactForeignKeys[1].updateRule = 'CASCADE';
    await assert.rejects(migrate(connection, { targetVersion: 4 }), /incompativ/, defect);
    assert.equal(state.version, 3, defect);
    assert.equal(statements.some(sql => /^(ALTER|DELETE|DROP)/.test(sql) || sql === 'UPDATE cl_schema SET version = 4 WHERE id = 1'), false, defect);
    assert.match(statements.at(-1), /RELEASE_LOCK/);
  }
});

test('v4 concluido e idempotente, preserva v1-v3 explicitos e recusa downgrade', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...schema3Tables, 'cl_contacts'], version: 4 });
  state.departmentColumns.push({ ...publicColumn });
  state.contactIndexes.push(...index('email_lookup', ['email'], 1));
  assert.deepEqual(await migrate(connection, { targetVersion: 4 }), { schemaVersion: 4 });
  assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  for (const targetVersion of [1, 2, 3]) await assert.rejects(migrate(connection, { targetVersion }), /Downgrade/);
  assert.equal(state.version, 4);
});

test('marcador v4 incompleto ou contatos antes do chat recusam DDL', async () => {
  for (const options of [{ tables: schema3Tables, version: 4 }, { tables: [...baseTables, 'cl_departments', 'cl_department_members', 'cl_contacts'], version: 2 }]) {
    const { connection, statements, state } = migrationConnection(options);
    state.departmentColumns.push({ ...publicColumn });
    await assert.rejects(migrate(connection, { targetVersion: 4 }), /incompleta|concluido/);
    assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
    assert.match(statements.at(-1), /RELEASE_LOCK/);
  }
});

test('upgrade v4 prepara apenas oportunidade e historico antes de marcar v5', async () => {
  const { connection, statements, state } = migrationConnection({ tables: schema4Tables, version: 4 });
  state.departmentColumns.push({ ...publicColumn });
  assert.deepEqual(await migrate(connection, { targetVersion: 5 }), { schemaVersion: 5 });
  assert.equal(state.version, 5); assert.equal(state.tables.size, 13);
  const ddl = statements.filter(sql => /^(CREATE|ALTER|DROP)/.test(sql));
  assert.equal(ddl.length, 2);
  assert.match(ddl[0], /^CREATE TABLE IF NOT EXISTS cl_opportunities /); assert.match(ddl[1], /^CREATE TABLE IF NOT EXISTS cl_opportunity_events /);
  assert.match(ddl[0], /INDEX cl_opportunities_queue \(contact_id, stage, updated_at, id\)/);
  assert.match(ddl[1], /PRIMARY KEY \(opportunity_id, version\)/);
  assert.match(ddl[1], /stage ENUM\('new','qualified','proposal','won','lost'\) NOT NULL, created_at DATETIME NOT NULL/);
  const marked = statements.indexOf('UPDATE cl_schema SET version = 5 WHERE id = 1');
  assert.ok(statements.indexOf('SHOW FULL COLUMNS FROM cl_contacts') < statements.indexOf(ddl[0]));
  assert.ok(statements.indexOf('SHOW INDEX FROM cl_opportunity_events') < marked);
  assert.ok(statements.findIndex(sql => sql.includes("k.TABLE_NAME IN ('cl_opportunities'")) < marked);
  assert.equal(statements.some(sql => /^(ALTER|DROP|DELETE)|^UPDATE cl_(?!schema\b)|^INSERT(?: IGNORE)? INTO cl_(?!schema\b)/.test(sql)), false);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});

test('v5 interrompido preserva v4 e historico ausente e retomado sem downgrade', async () => {
  const { connection, statements, state } = migrationConnection({ tables: schema4Tables, version: 4 });
  state.departmentColumns.push({ ...publicColumn }); state.failTable = 'cl_opportunity_events';
  await assert.rejects(migrate(connection, { targetVersion: 5 }), /Interrupcao/);
  assert.equal(state.version, 4); assert.equal(state.tables.has('cl_opportunities'), true); assert.equal(state.tables.has('cl_opportunity_events'), false);
  assert.equal(statements.some(sql => sql === 'UPDATE cl_schema SET version = 5 WHERE id = 1'), false);
  const checkpoint = statements.length;
  assert.deepEqual(await migrate(connection, { targetVersion: 4 }), { schemaVersion: 4 });
  assert.equal(statements.slice(checkpoint).some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  state.failTable = null;
  assert.deepEqual(await migrate(connection, { targetVersion: 5 }), { schemaVersion: 5 });
  assert.equal(state.tables.size, 13);
});

test('schemas parciais de oportunidade e evento nunca sao marcados v5', async () => {
  const defects = ['column', 'extra-column', 'unsigned', 'title', 'nullable', 'amount-default', 'stage-enum', 'stage-case', 'stage-default', 'version-default', 'created-default', 'updated-extra', 'auto-increment', 'hash-collation', 'title-collation', 'event-stage-default', 'event-version-default', 'event-amount-default', 'event-created-default', 'event-null', 'event-title', 'engine', 'event-engine', 'table-collation', 'primary', 'idempotency', 'queue-order', 'queue-unique', 'index-prefix', 'extra-unique-contact', 'event-primary', 'event-key-order', 'event-extra-unique', 'foreign', 'foreign-schema', 'delete-rule', 'update-rule', 'referenced-table'];
  for (const defect of defects) {
    const { connection, statements, state } = migrationConnection({ tables: [...schema4Tables, ...opportunityTables], version: 4 });
    state.departmentColumns.push({ ...publicColumn });
    const opp = name => state.opportunityColumns.cl_opportunities.find(row => row.Field === name);
    const event = name => state.opportunityColumns.cl_opportunity_events.find(row => row.Field === name);
    if (defect === 'column') state.opportunityColumns.cl_opportunities.pop();
    if (defect === 'extra-column') state.opportunityColumns.cl_opportunity_events.push(field('hidden', 'int unsigned', { Default: null }));
    if (defect === 'unsigned') opp('contact_id').Type = 'int';
    if (defect === 'title') opp('title').Type = 'varchar(151)';
    if (defect === 'nullable') opp('amount_cents').Null = 'YES';
    if (defect === 'amount-default') opp('amount_cents').Default = '1';
    if (defect === 'stage-enum') opp('stage').Type = "enum('new','qualified','proposal','won')";
    if (defect === 'stage-case') opp('stage').Type = "enum('NEW','qualified','proposal','won','lost')";
    if (defect === 'stage-default') opp('stage').Default = 'won';
    if (defect === 'version-default') opp('version').Default = '0';
    if (defect === 'created-default') opp('created_at').Default = 'CURRENT_TIMESTAMP';
    if (defect === 'updated-extra') opp('updated_at').Extra = 'on update CURRENT_TIMESTAMP';
    if (defect === 'auto-increment') opp('id').Extra = '';
    if (defect === 'hash-collation') opp('client_key').Collation = 'ascii_general_ci';
    if (defect === 'title-collation') opp('title').Collation = 'utf8mb4_general_ci';
    if (defect === 'event-stage-default') event('stage').Default = 'new';
    if (defect === 'event-version-default') event('version').Default = '1';
    if (defect === 'event-amount-default') event('amount_cents').Default = null;
    if (defect === 'event-created-default') event('created_at').Default = 'CURRENT_TIMESTAMP';
    if (defect === 'event-null') event('actor_id').Null = 'YES';
    if (defect === 'event-title') event('title').Type = 'varchar(100)';
    if (defect === 'engine') state.opportunityEngines[0].engine = 'MyISAM';
    if (defect === 'event-engine') state.opportunityEngines[1].engine = 'MyISAM';
    if (defect === 'table-collation') state.opportunityEngines[1].tableCollation = 'utf8mb4_bin';
    if (defect === 'primary') state.opportunityIndexes.cl_opportunities = state.opportunityIndexes.cl_opportunities.filter(row => row.Key_name !== 'PRIMARY');
    if (defect === 'idempotency') state.opportunityIndexes.cl_opportunities = state.opportunityIndexes.cl_opportunities.filter(row => row.Key_name !== 'idempotency');
    if (defect === 'queue-order') state.opportunityIndexes.cl_opportunities = [...index('PRIMARY', ['id']), ...index('idempotency', ['created_by', 'client_key']), ...index('queue', ['contact_id', 'updated_at', 'stage', 'id'], 1)];
    if (defect === 'queue-unique') state.opportunityIndexes.cl_opportunities.filter(row => row.Key_name === 'queue').forEach(row => { row.Non_unique = 0; });
    if (defect === 'index-prefix') state.opportunityIndexes.cl_opportunities.find(row => row.Column_name === 'client_key').Sub_part = 16;
    if (defect === 'extra-unique-contact') state.opportunityIndexes.cl_opportunities.push(...index('one_per_contact', ['contact_id']));
    if (defect === 'event-primary') state.opportunityIndexes.cl_opportunity_events = index('actor_lookup', ['actor_id'], 1);
    if (defect === 'event-key-order') state.opportunityIndexes.cl_opportunity_events = index('PRIMARY', ['version', 'opportunity_id']);
    if (defect === 'event-extra-unique') state.opportunityIndexes.cl_opportunity_events.push(...index('single_version', ['version']));
    if (defect === 'foreign') state.opportunityForeignKeys.pop();
    if (defect === 'foreign-schema') state.opportunityForeignKeys[3].localSchema = 0;
    if (defect === 'delete-rule') state.opportunityForeignKeys[0].deleteRule = 'CASCADE';
    if (defect === 'update-rule') state.opportunityForeignKeys[3].updateRule = 'CASCADE';
    if (defect === 'referenced-table') state.opportunityForeignKeys[0].referencedTable = 'cl_users';
    await assert.rejects(migrate(connection, { targetVersion: 5 }), /incompativ/, defect);
    assert.equal(state.version, 4, defect);
    assert.equal(statements.some(sql => /^(ALTER|DROP|DELETE)/.test(sql) || sql === 'UPDATE cl_schema SET version = 5 WHERE id = 1'), false, defect);
    assert.match(statements.at(-1), /RELEASE_LOCK/);
  }
});

test('v5 valida contatos anteriores antes de preparar novas tabelas', async () => {
  const { connection, statements, state } = migrationConnection({ tables: schema4Tables, version: 4 });
  state.departmentColumns.push({ ...publicColumn }); state.contactColumns.find(row => row.Field === 'request_hash').Collation = 'ascii_general_ci';
  await assert.rejects(migrate(connection, { targetVersion: 5 }), /incompativ/);
  assert.equal(state.version, 4); assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
});

test('v5 completo e idempotente e recusa downgrade para todos targets anteriores', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...schema4Tables, ...opportunityTables], version: 5 });
  state.departmentColumns.push({ ...publicColumn }); state.opportunityIndexes.cl_opportunity_events.push(...index('title_lookup', ['title'], 1));
  assert.deepEqual(await migrate(connection, { targetVersion: 5 }), { schemaVersion: 5 });
  assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  for (const targetVersion of [1, 2, 3, 4]) await assert.rejects(migrate(connection, { targetVersion }), /Downgrade/);
  assert.equal(state.version, 5);
});

test('marker5 incompleto e oportunidade antes de contatos recusam DDL', async () => {
  for (const options of [{ tables: [...schema4Tables, 'cl_opportunities'], version: 5 }, { tables: [...schema3Tables, ...opportunityTables], version: 3 }]) {
    const { connection, statements, state } = migrationConnection(options);
    state.departmentColumns.push({ ...publicColumn });
    await assert.rejects(migrate(connection, { targetVersion: 5 }), /incompleta|concluidos/);
    assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
    assert.match(statements.at(-1), /RELEASE_LOCK/);
  }
});

test('status e capacidades preservam v1-v5 e habilitam associacoes em v6', async () => {
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
  version = 5;
  assert.equal(await repository.status(), 'installed');
  assert.deepEqual(await repository.capabilities(), { schemaVersion: 5, departments: true, chat: true, contacts: true, opportunities: true });
  version = 6;
  assert.equal(await repository.status(), 'installed');
  assert.deepEqual(await repository.capabilities(), { schemaVersion: 6, departments: true, chat: true, contacts: true, opportunities: true, conversationContacts: true });
  version = 7;
  assert.deepEqual(await repository.capabilities(), { schemaVersion: 7, departments: true, chat: true, contacts: true, opportunities: true, conversationContacts: true, portal: true });
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


test('upgrade v5 acrescenta somente associacao e historico antes de marcar v6', async () => {
  const { connection, statements, state } = migrationConnection({ tables: schema5Tables, version: 5 });
  state.departmentColumns.push({ ...publicColumn });
  assert.deepEqual(await migrate(connection, { targetVersion: 6 }), { schemaVersion: 6 });
  assert.equal(state.version, 6); assert.equal(state.tables.size, 15);
  const ddl = statements.filter(sql => /^(CREATE|ALTER|DROP)/.test(sql));
  assert.equal(ddl.length, 2);
  assert.match(ddl[0], /^CREATE TABLE IF NOT EXISTS cl_conversation_contacts /);
  assert.match(ddl[1], /^CREATE TABLE IF NOT EXISTS cl_conversation_contact_events /);
  assert.match(ddl[0], /contact_id INT UNSIGNED NULL, version INT UNSIGNED NOT NULL DEFAULT 1/);
  assert.match(ddl[0], /updated_at DATETIME NOT NULL, INDEX cl_conversation_contacts_contact \(contact_id, conversation_id\)/);
  assert.match(ddl[1], /created_at DATETIME NOT NULL, PRIMARY KEY \(conversation_id, version\)/);
  assert.match(ddl[1], /REFERENCES cl_conversation_contacts\(conversation_id\) ON DELETE RESTRICT ON UPDATE RESTRICT/);
  const marker = statements.indexOf('UPDATE cl_schema SET version = 6 WHERE id = 1');
  assert.ok(statements.indexOf('SHOW INDEX FROM cl_opportunity_events') < statements.indexOf(ddl[0]));
  assert.ok(statements.indexOf('SHOW INDEX FROM cl_conversation_contact_events') < marker);
  assert.ok(statements.findIndex(sql => sql.includes("k.TABLE_NAME IN ('cl_conversation_contacts'")) < marker);
  assert.equal(statements.some(sql => /^(ALTER|DROP|DELETE)|^UPDATE cl_(?!schema\b)|^INSERT(?: IGNORE)? INTO cl_(?!schema\b)/.test(sql)), false);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});

test('v6 interrompido retoma tabela parcial mantendo v5 e target5 somente leitura', async () => {
  const { connection, statements, state } = migrationConnection({ tables: schema5Tables, version: 5 });
  state.departmentColumns.push({ ...publicColumn }); state.failTable = 'cl_conversation_contact_events';
  await assert.rejects(migrate(connection, { targetVersion: 6 }), /Interrupcao/);
  assert.equal(state.version, 5); assert.equal(state.tables.has('cl_conversation_contacts'), true); assert.equal(state.tables.has('cl_conversation_contact_events'), false);
  assert.equal(statements.includes('UPDATE cl_schema SET version = 6 WHERE id = 1'), false);
  const checkpoint = statements.length;
  assert.deepEqual(await migrate(connection, { targetVersion: 5 }), { schemaVersion: 5 });
  assert.equal(statements.slice(checkpoint).some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  state.failTable = null;
  assert.deepEqual(await migrate(connection, { targetVersion: 6 }), { schemaVersion: 6 });
  assert.equal(state.tables.size, 15); assert.equal(state.version, 6);
});

test('preparacao parcial valida v6 retoma sem apagar registros ou alterar tabelas', async () => {
  for (const partial of [[conversationContactTables[0]], [conversationContactTables[1]], conversationContactTables]) {
    const { connection, statements, state } = migrationConnection({ tables: [...schema5Tables, ...partial], version: 5 });
    state.departmentColumns.push({ ...publicColumn });
    assert.deepEqual(await migrate(connection, { targetVersion: 6 }), { schemaVersion: 6 });
    assert.equal(state.tables.size, 15); assert.equal(state.version, 6);
    assert.equal(statements.some(sql => /^(ALTER|DROP|DELETE)|^UPDATE cl_(?!schema\b)|^INSERT(?: IGNORE)? INTO cl_(?!schema\b)/.test(sql)), false);
  }
});

test('instalacao interrompida no ultimo historico preserva fases anteriores concluidas', async () => {
  const { connection, statements, state } = migrationConnection(); state.failTable = 'cl_conversation_contact_events';
  await assert.rejects(migrate(connection, { targetVersion: 6 }), /Interrupcao/);
  assert.equal(state.version, 5); assert.equal(state.tables.size, 14);
  assert.ok([1, 2, 3, 4, 5].every(version => statements.includes('UPDATE cl_schema SET version = ' + version + ' WHERE id = 1')));
  assert.equal(statements.includes('UPDATE cl_schema SET version = 6 WHERE id = 1'), false);
  state.failTable = null;
  assert.deepEqual(await migrate(connection, { targetVersion: 6 }), { schemaVersion: 6 });
  assert.equal(state.tables.size, 15);
});

test('estruturas parciais defeituosas de associacao nao recebem marcador v6', async () => {
  const defects = ['column-missing', 'extra-column', 'conversation-signed', 'contact-signed', 'version-signed', 'actor-signed', 'contact-not-null', 'conversation-null', 'actor-null', 'version-default', 'contact-default', 'updated-default', 'updated-extra', 'updated-precision', 'auto-increment', 'event-column', 'event-contact-not-null', 'event-conversation-null', 'event-actor-null', 'event-version-default', 'event-contact-default', 'event-created-default', 'event-extra', 'engine', 'event-engine', 'table-collation', 'event-collation', 'primary', 'contact-index', 'contact-order', 'contact-unique', 'actor-index', 'index-prefix', 'index-sequence', 'event-primary', 'event-primary-order', 'event-contact-index', 'event-actor-index', 'extra-unique-contact', 'extra-unique-version', 'event-extra-unique-actor', 'event-extra-unique-conversation', 'foreign', 'extra-foreign', 'foreign-schema', 'event-foreign-schema', 'delete-rule', 'update-rule', 'referenced-table', 'event-parent-column'];
  for (const defect of defects) {
    const { connection, statements, state } = migrationConnection({ tables: [...schema5Tables, ...conversationContactTables], version: 5 });
    state.departmentColumns.push({ ...publicColumn });
    const current = name => state.conversationContactColumns.cl_conversation_contacts.find(row => row.Field === name);
    const event = name => state.conversationContactColumns.cl_conversation_contact_events.find(row => row.Field === name);
    const removeIndex = (table, name) => { state.conversationContactIndexes[table] = state.conversationContactIndexes[table].filter(row => row.Key_name !== name); };
    if (defect === 'column-missing') state.conversationContactColumns.cl_conversation_contacts.pop();
    if (defect === 'extra-column') state.conversationContactColumns.cl_conversation_contact_events.push(field('hidden', 'int unsigned', { Default: null }));
    if (defect === 'conversation-signed') current('conversation_id').Type = 'int';
    if (defect === 'contact-signed') current('contact_id').Type = 'int';
    if (defect === 'version-signed') current('version').Type = 'int';
    if (defect === 'actor-signed') current('updated_by').Type = 'int';
    if (defect === 'contact-not-null') current('contact_id').Null = 'NO';
    if (defect === 'conversation-null') current('conversation_id').Null = 'YES';
    if (defect === 'actor-null') current('updated_by').Null = 'YES';
    if (defect === 'version-default') current('version').Default = '0';
    if (defect === 'contact-default') current('contact_id').Default = '0';
    if (defect === 'updated-default') current('updated_at').Default = 'CURRENT_TIMESTAMP';
    if (defect === 'updated-extra') current('updated_at').Extra = 'on update CURRENT_TIMESTAMP';
    if (defect === 'updated-precision') current('updated_at').Type = 'datetime(6)';
    if (defect === 'auto-increment') current('conversation_id').Extra = 'auto_increment';
    if (defect === 'event-column') event('contact_id').Type = 'bigint unsigned';
    if (defect === 'event-contact-not-null') event('contact_id').Null = 'NO';
    if (defect === 'event-conversation-null') event('conversation_id').Null = 'YES';
    if (defect === 'event-actor-null') event('actor_id').Null = 'YES';
    if (defect === 'event-version-default') event('version').Default = '1';
    if (defect === 'event-contact-default') event('contact_id').Default = '0';
    if (defect === 'event-created-default') event('created_at').Default = 'CURRENT_TIMESTAMP';
    if (defect === 'event-extra') event('created_at').Extra = 'STORED GENERATED';
    if (defect === 'engine') state.conversationContactEngines[0].engine = 'MyISAM';
    if (defect === 'event-engine') state.conversationContactEngines[1].engine = 'MyISAM';
    if (defect === 'table-collation') state.conversationContactEngines[0].tableCollation = 'utf8mb4_general_ci';
    if (defect === 'event-collation') state.conversationContactEngines[1].tableCollation = 'utf8mb4_bin';
    if (defect === 'primary') removeIndex('cl_conversation_contacts', 'PRIMARY');
    if (defect === 'contact-index') removeIndex('cl_conversation_contacts', 'contact_lookup');
    if (defect === 'contact-order') state.conversationContactIndexes.cl_conversation_contacts.filter(row => row.Key_name === 'contact_lookup').forEach((row, i) => { row.Column_name = ['conversation_id', 'contact_id'][i]; });
    if (defect === 'contact-unique') state.conversationContactIndexes.cl_conversation_contacts.filter(row => row.Key_name === 'contact_lookup').forEach(row => { row.Non_unique = 0; });
    if (defect === 'actor-index') removeIndex('cl_conversation_contacts', 'actor_lookup');
    if (defect === 'index-prefix') state.conversationContactIndexes.cl_conversation_contacts.find(row => row.Key_name === 'contact_lookup').Sub_part = 1;
    if (defect === 'index-sequence') state.conversationContactIndexes.cl_conversation_contact_events.find(row => row.Key_name === 'PRIMARY' && row.Column_name === 'version').Seq_in_index = 3;
    if (defect === 'event-primary') removeIndex('cl_conversation_contact_events', 'PRIMARY');
    if (defect === 'event-primary-order') state.conversationContactIndexes.cl_conversation_contact_events.filter(row => row.Key_name === 'PRIMARY').forEach((row, i) => { row.Column_name = ['version', 'conversation_id'][i]; });
    if (defect === 'event-contact-index') removeIndex('cl_conversation_contact_events', 'contact_lookup');
    if (defect === 'event-actor-index') removeIndex('cl_conversation_contact_events', 'actor_lookup');
    if (defect === 'extra-unique-contact') state.conversationContactIndexes.cl_conversation_contacts.push(...index('one_contact_only', ['contact_id']));
    if (defect === 'extra-unique-version') state.conversationContactIndexes.cl_conversation_contacts.push(...index('single_version', ['version']));
    if (defect === 'event-extra-unique-actor') state.conversationContactIndexes.cl_conversation_contact_events.push(...index('single_actor', ['actor_id']));
    if (defect === 'event-extra-unique-conversation') state.conversationContactIndexes.cl_conversation_contact_events.push(...index('single_event', ['conversation_id']));
    if (defect === 'foreign') state.conversationContactForeignKeys.pop();
    if (defect === 'extra-foreign') state.conversationContactForeignKeys.push({ ...state.conversationContactForeignKeys[0], localSchema: 0 });
    if (defect === 'foreign-schema') state.conversationContactForeignKeys[0].localSchema = 0;
    if (defect === 'event-foreign-schema') state.conversationContactForeignKeys[5].localSchema = 0;
    if (defect === 'delete-rule') state.conversationContactForeignKeys[1].deleteRule = 'CASCADE';
    if (defect === 'update-rule') state.conversationContactForeignKeys[4].updateRule = 'CASCADE';
    if (defect === 'referenced-table') state.conversationContactForeignKeys[0].referencedTable = 'cl_users';
    if (defect === 'event-parent-column') state.conversationContactForeignKeys[3].referencedColumn = 'id';
    await assert.rejects(migrate(connection, { targetVersion: 6 }), /incompativ/, defect);
    assert.equal(state.version, 5, defect);
    assert.equal(statements.some(sql => /^(ALTER|DELETE|DROP)/.test(sql) || sql === 'UPDATE cl_schema SET version = 6 WHERE id = 1'), false, defect);
    assert.match(statements.at(-1), /RELEASE_LOCK/);
  }
});

test('v6 verifica schema anterior antes de qualquer nova DDL', async () => {
  for (const defect of ['contact-hash', 'opportunity-stage']) {
    const { connection, statements, state } = migrationConnection({ tables: schema5Tables, version: 5 });
    state.departmentColumns.push({ ...publicColumn });
    if (defect === 'contact-hash') state.contactColumns.find(row => row.Field === 'request_hash').Collation = 'ascii_general_ci';
    else state.opportunityColumns.cl_opportunities.find(row => row.Field === 'stage').Default = 'won';
    await assert.rejects(migrate(connection, { targetVersion: 6 }), /incompativ/);
    assert.equal(state.version, 5);
    assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  }
});

test('schema6 completo e idempotente aceita indices extras nao unicos e recusa downgrade', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...schema5Tables, ...conversationContactTables], version: 6 });
  state.departmentColumns.push({ ...publicColumn });
  state.conversationContactIndexes.cl_conversation_contacts.push(...index('updated_lookup', ['updated_at'], 1));
  state.conversationContactIndexes.cl_conversation_contact_events.push(...index('created_lookup', ['created_at'], 1));
  assert.deepEqual(await migrate(connection, { targetVersion: 6 }), { schemaVersion: 6 });
  assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  for (const targetVersion of [1, 2, 3, 4, 5]) await assert.rejects(migrate(connection, { targetVersion }), /Downgrade/);
  assert.equal(state.version, 6);
});

test('validador exportado schema6 aceita tipos numericos equivalentes sem executar DDL', async () => {
  const { connection, statements, state } = migrationConnection({ tables: [...schema5Tables, ...conversationContactTables], version: 6 });
  for (const table of conversationContactTables) for (const column of state.conversationContactColumns[table]) {
    if (column.Type === 'int unsigned') column.Type = 'int(10) unsigned';
    if (column.Type === 'datetime') column.Type = 'datetime(0)';
  }
  state.conversationContactColumns.cl_conversation_contacts.find(row => row.Field === 'version').Default = 1;
  await verifyConversationContactSchema(connection);
  assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
});

test('marker6 incompleto ou tabelas novas antes de oportunidades concluidas recusam DDL', async () => {
  const states = [
    ...conversationContactTables.map(missing => ({ tables: [...schema5Tables, ...conversationContactTables].filter(table => table !== missing), version: 6 })),
    { tables: [...schema4Tables, ...conversationContactTables], version: 6 },
    ...[0, 1, 2, 3, 4].map(version => ({ tables: version < 2 ? baseTables : version === 2 ? [...baseTables, 'cl_departments', 'cl_department_members'] : version === 3 ? schema3Tables : schema4Tables, version })).flatMap(state => conversationContactTables.map(table => ({ ...state, tables: [...state.tables, table] })))
  ];
  for (const options of states) {
    const { connection, statements } = migrationConnection(options);
    await assert.rejects(migrate(connection, { targetVersion: 6 }), /incompleta|concluidas/);
    assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
    assert.match(statements.at(-1), /RELEASE_LOCK/);
  }
});

test('targets invalidos e marker futuro recusam antes de mutacao', async () => {
  for (const targetVersion of [0, 11, '7', null, false]) {
    const { connection, statements } = migrationConnection();
    await assert.rejects(migrate(connection, { targetVersion }), /alvo/);
    assert.equal(statements.length, 0);
  }
  const { connection, statements } = migrationConnection({ tables: [...schema5Tables, ...conversationContactTables], version: 11 });
  await assert.rejects(migrate(connection, { targetVersion: 6 }), /nao reconhecida/);
  assert.equal(statements.some(sql => /^(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)/.test(sql)), false);
  assert.match(statements.at(-1), /RELEASE_LOCK/);
});


function portalMigrationConnection(options) { const result=migrationConnection(options); result.state.departmentColumns.push({...publicColumn}); return result; }

test('upgrade6 cria apenas duas tabelas portal e marca7 depois de validar',async()=>{
 const {connection,statements,state}=portalMigrationConnection({tables:schema6Tables,version:6});
 assert.deepEqual(await migrate(connection, { targetVersion: 7 }),{schemaVersion:7}); assert.equal(state.version,7); assert.equal(state.tables.size,17);
 const ddl=statements.filter(x=>x.startsWith('CREATE TABLE')); assert.equal(ddl.length,2);
 assert.match(ddl[0],/UNIQUE KEY cl_portal_accounts_visitor \(visitor_id\)/); assert.match(ddl[0],/access_id CHAR\(24\) CHARACTER SET ascii COLLATE ascii_bin/);
 assert.match(ddl[0],/created_at DATETIME NOT NULL, UNIQUE/); assert.match(ddl[1],/expires_at DATETIME NOT NULL, INDEX/);
 const marker=statements.indexOf('UPDATE cl_schema SET version = 7 WHERE id = 1');
 assert.ok(marker>statements.findIndex(x=>x.includes("k.TABLE_NAME IN ('cl_portal_accounts'")));
 assert.equal(statements.some(x=>/^(ALTER|DROP|DELETE)/.test(x)),false);
});

test('portal parcial retoma7 e target6 permanece somente leitura',async()=>{
 const {connection,statements,state}=portalMigrationConnection({tables:schema6Tables,version:6}); state.failTable='cl_portal_sessions';
 await assert.rejects(migrate(connection, { targetVersion: 7 }),/Interrupcao/); assert.equal(state.version,6); assert.equal(state.tables.size,16);
 assert.equal(statements.includes('UPDATE cl_schema SET version = 7 WHERE id = 1'),false);
 statements.length=0; assert.deepEqual(await migrate(connection,{targetVersion:6}),{schemaVersion:6}); assert.equal(statements.some(x=>/^(CREATE|UPDATE|INSERT|ALTER|DELETE|DROP)/.test(x)),false);
 state.failTable=null; assert.deepEqual(await migrate(connection, { targetVersion: 7 }),{schemaVersion:7}); assert.equal(state.tables.size,17);
});

test('portal7 recusa estruturas parciais incompatíveis sem DDL nem marcador',async()=>{
 const defects=['missing','extra','signed','nullable','access-length','hash-type','collation','version-default','active-default','date-default','date-extra','auto-increment','session-null','session-type','session-date','engine','table-collation','primary','visitor-unique','access-unique','account-index','expiry-index','prefix','index-order','extra-unique','foreign','foreign-schema','delete-rule','update-rule','target'];
 for(const defect of defects){
  const {connection,statements,state}=portalMigrationConnection({tables:[...schema6Tables,...portalTables],version:6});
  const col=f=>state.portalColumns.cl_portal_accounts.find(x=>x.Field===f); const sess=f=>state.portalColumns.cl_portal_sessions.find(x=>x.Field===f);
  if(defect==='missing') state.portalColumns.cl_portal_accounts.pop();
  if(defect==='extra') state.portalColumns.cl_portal_accounts.push(field('extra','int'));
  if(defect==='signed') col('visitor_id').Type='int';
  if(defect==='nullable') col('recovery_hash').Null='YES';
  if(defect==='access-length') col('access_id').Type='char(25)';
  if(defect==='hash-type') col('password_hash').Type='varchar(201)';
  if(defect==='collation') col('password_hash').Collation='ascii_general_ci';
  if(defect==='version-default') col('version').Default='0';
  if(defect==='active-default') col('active').Default='0';
  if(defect==='date-default') col('created_at').Default='CURRENT_TIMESTAMP';
  if(defect==='date-extra') col('created_at').Extra='on update current_timestamp()';
  if(defect==='auto-increment') col('id').Extra='';
  if(defect==='session-null') sess('account_id').Null='YES';
  if(defect==='session-type') sess('token_hash').Type='char(63)';
  if(defect==='session-date') sess('expires_at').Default='CURRENT_TIMESTAMP';
  if(defect==='engine') state.portalEngines[1].engine='MyISAM';
  if(defect==='table-collation') state.portalEngines[0].tableCollation='utf8mb4_bin';
  if(defect==='primary') state.portalIndexes.cl_portal_accounts=state.portalIndexes.cl_portal_accounts.filter(x=>x.Key_name!=='PRIMARY');
  if(defect==='visitor-unique') state.portalIndexes.cl_portal_accounts.find(x=>x.Column_name==='visitor_id').Non_unique=1;
  if(defect==='access-unique') state.portalIndexes.cl_portal_accounts.find(x=>x.Column_name==='access_id').Non_unique=1;
  if(defect==='account-index') state.portalIndexes.cl_portal_sessions=state.portalIndexes.cl_portal_sessions.filter(x=>x.Column_name!=='account_id');
  if(defect==='expiry-index') state.portalIndexes.cl_portal_sessions.find(x=>x.Column_name==='expires_at').Non_unique=0;
  if(defect==='prefix') state.portalIndexes.cl_portal_accounts.find(x=>x.Column_name==='access_id').Sub_part=12;
  if(defect==='index-order') state.portalIndexes.cl_portal_sessions.find(x=>x.Column_name==='expires_at').Seq_in_index=2;
  if(defect==='extra-unique') state.portalIndexes.cl_portal_accounts.push(...index('hash_unique',['recovery_hash']));
  if(defect==='foreign') state.portalForeignKeys.pop();
  if(defect==='foreign-schema') state.portalForeignKeys[0].localSchema=0;
  if(defect==='delete-rule') state.portalForeignKeys[0].deleteRule='CASCADE';
  if(defect==='update-rule') state.portalForeignKeys[1].updateRule='CASCADE';
  if(defect==='target') state.portalForeignKeys[0].referencedTable='cl_users';
  await assert.rejects(migrate(connection, { targetVersion: 7 }),/incompativ/,defect); assert.equal(state.version,6,defect); assert.equal(statements.some(x=>/^(UPDATE|INSERT|ALTER|DELETE|DROP)/.test(x)),false,defect);
 }
});

test('portal7 completo idempotente aceita índice extra não único e impede downgrade',async()=>{
 const {connection,statements,state}=portalMigrationConnection({tables:[...schema6Tables,...portalTables],version:7});
 state.portalIndexes.cl_portal_accounts.push(...index('extra_version',['version'],1));
 assert.deepEqual(await migrate(connection, { targetVersion: 7 }),{schemaVersion:7}); assert.equal(statements.some(x=>/^(CREATE|UPDATE|INSERT|ALTER|DELETE|DROP)/.test(x)),false);
 await verifyPortalSchema(connection);
 for(const targetVersion of [1,2,3,4,5,6]) await assert.rejects(migrate(connection,{targetVersion}),/Downgrade/);
});

test('marcador7 incompleto e tabelas portal antes6 recusam mutação',async()=>{
 for(const options of [
  ...portalTables.map(missing=>({tables:[...schema6Tables,...portalTables].filter(x=>x!==missing),version:7})),
  ...portalTables.map(table=>({tables:[...schema5Tables,table],version:5}))
 ]){
  const {connection,statements}=portalMigrationConnection(options); await assert.rejects(migrate(connection, { targetVersion: 7 }),/incompleta|concluidos/); assert.equal(statements.some(x=>/^(CREATE|UPDATE|INSERT|ALTER|DELETE|DROP)/.test(x)),false);
 }
});

function subscriptionMigration(options){
 const f=portalMigrationConnection(options),query=f.connection.query,execute=f.connection.execute;
 f.state.subscriptionColumns=[field('account_id','int unsigned',{Default:null}),field('version','int unsigned',{Default:null}),field('subscribed','tinyint',{Default:null}),field('notice_version','varchar(40)',{Default:null,Collation:'ascii_bin'}),ascii('client_key',32),ascii('request_hash',64),field('created_at','datetime',{Default:null})].map(c=>({...c,Default:null}));
 f.state.subscriptionIndexes=[...index('PRIMARY',['account_id','version']),...index('cl_subscription_request',['account_id','client_key']),...index('cl_subscription_created',['account_id','created_at'],1)];
 f.state.subscriptionEngine={engine:'InnoDB',tableCollation:'utf8mb4_unicode_ci'};
 f.state.subscriptionKeys=[{columnName:'account_id',referencedTable:'cl_portal_accounts',referencedColumn:'id',localSchema:1,deleteRule:'RESTRICT',updateRule:'RESTRICT'}];
 f.connection.query=async(sql,args)=>{
  if(sql.startsWith('CREATE TABLE IF NOT EXISTS cl_portal_subscription_events')){
   f.statements.push(sql);if(f.state.failTable==='cl_portal_subscription_events')throw Error('Interrupcao');
   f.state.tables.add('cl_portal_subscription_events');return[[]];
  }
  if(sql==='SHOW FULL COLUMNS FROM cl_portal_subscription_events'){f.statements.push(sql);return[f.state.subscriptionColumns];}
  if(sql==='SHOW INDEX FROM cl_portal_subscription_events'){f.statements.push(sql);return[f.state.subscriptionIndexes];}
  return query(sql,args);
 };
 f.connection.execute=async(sql,args)=>{
  if(sql.includes("TABLE_NAME = 'cl_portal_subscription_events'")){f.statements.push(sql);return[[f.state.subscriptionEngine]];}
  if(sql.includes("k.TABLE_NAME='cl_portal_subscription_events'")){f.statements.push(sql);return[f.state.subscriptionKeys];}
  if(sql==='UPDATE cl_schema SET version = 8 WHERE id = 1'){f.statements.push(sql);f.state.version=8;return[{affectedRows:1}];}
  return execute(sql,args);
 };return f;
}
test('default upgrade7 adds only immutable subscription history, verifies structure before marker8 and is idempotent',async()=>{
 const f=subscriptionMigration({tables:[...schema6Tables,...portalTables],version:7});
 assert.deepEqual(await migrate(f.connection,{targetVersion:8}),{schemaVersion:8});assert.equal(f.state.tables.size,18);
 assert.equal(f.statements.filter(s=>s.startsWith('CREATE TABLE')).length,1);
 assert(f.statements.indexOf('UPDATE cl_schema SET version = 8 WHERE id = 1')>f.statements.indexOf('SHOW INDEX FROM cl_portal_subscription_events'));
 f.statements.length=0;assert.deepEqual(await migrate(f.connection,{targetVersion:8}),{schemaVersion:8});assert(!f.statements.some(s=>/^(CREATE|ALTER|UPDATE|DELETE|INSERT|DROP)/.test(s)));
 await assert.rejects(migrate(f.connection,{targetVersion:7}),/Downgrade/);
});
test('subscription invalid columns, indexes, FK and engine keep marker7; interrupted creation can resume8',async()=>{
 for(const mutate of[
  s=>s.subscriptionColumns[0].Type='int',s=>s.subscriptionColumns[2].Default='1',s=>s.subscriptionColumns[3].Collation='ascii_general_ci',s=>s.subscriptionColumns[6].Extra='on update current_timestamp()',
  s=>s.subscriptionIndexes[0].Seq_in_index=2,s=>s.subscriptionIndexes.find(r=>r.Key_name==='cl_subscription_request').Sub_part=8,
  s=>s.subscriptionEngine.engine='MyISAM',s=>s.subscriptionKeys[0].localSchema=0,s=>s.subscriptionKeys[0].deleteRule='CASCADE'
 ]){
  const f=subscriptionMigration({tables:[...schema6Tables,...portalTables,'cl_portal_subscription_events'],version:7});mutate(f.state);
  await assert.rejects(migrate(f.connection,{targetVersion:8}),/incompat/);assert.equal(f.state.version,7);assert(!f.statements.includes('UPDATE cl_schema SET version = 8 WHERE id = 1'));
 }
 const f=subscriptionMigration({tables:[...schema6Tables,...portalTables],version:7});f.state.failTable='cl_portal_subscription_events';
 await assert.rejects(migrate(f.connection,{targetVersion:8}),/Interrupcao/);assert.equal(f.state.version,7);f.state.failTable=null;await migrate(f.connection,{targetVersion:8});assert.equal(f.state.version,8);
});
test('schema8 missing history and subscription table before portal conclusion refuse any DDL',async()=>{
 for(const options of[{tables:[...schema6Tables,...portalTables],version:8},{tables:[...schema6Tables,'cl_portal_subscription_events'],version:6}]){
  const f=subscriptionMigration(options);await assert.rejects(migrate(f.connection,{targetVersion:8}),/incompleta|concluido/);assert(!f.statements.some(s=>/^(CREATE|ALTER|UPDATE|DELETE|INSERT|DROP)/.test(s)));
 }
});

 test('fresh default install prepares schema8 without opting in any account',async()=>{const f=subscriptionMigration({tables:[],version:0});assert.deepEqual(await migrate(f.connection,{targetVersion:8}),{schemaVersion:8});assert.equal(f.state.tables.size,18);assert(!f.statements.some(s=>s.startsWith('INSERT INTO cl_portal_subscription_events')));});

const {definitions:campaignDefinitions,verifyCampaignSchema}=require('../scripts/campaigns-schema');
function campaignMigration(options={}){
 const f=subscriptionMigration(options),query=f.connection.query.bind(f.connection),execute=f.connection.execute.bind(f.connection);
 f.state.campaignColumns=Object.fromEntries(campaignDefinitions.map(d=>[d.name,d.columns.map(x=>({Field:x.name,Type:x.type.source.includes('unsigned')?'int unsigned':x.type.source.includes('datetime')?'datetime':x.type.source.includes('varchar')?'varchar('+x.type.source.match(/\d+/)[0]+')':x.type.source.includes('char')?'char('+x.type.source.match(/\d+/)[0]+')':'text',Null:x.nullable?'YES':'NO',Default:null,Extra:x.auto?'auto_increment':'',Collation:x.ascii?'ascii_bin':null}))]));
 f.state.campaignIndexes=Object.fromEntries(campaignDefinitions.map(d=>[d.name,d.indexes.flatMap(([name,cols,unique])=>cols.map((col,i)=>({Key_name:name,Column_name:col,Seq_in_index:i+1,Non_unique:unique?0:1,Sub_part:null})))]));
 f.state.campaignEngines=Object.fromEntries(campaignDefinitions.map(d=>[d.name,{engine:'InnoDB',tableCollation:'utf8mb4_unicode_ci'}]));
 f.state.campaignKeys=Object.fromEntries(campaignDefinitions.map(d=>[d.name,d.keys.map(([columnName,referencedTable,referencedColumn])=>({columnName,referencedTable,referencedColumn,localSchema:1,deleteRule:'RESTRICT',updateRule:'RESTRICT'}))]));
 f.connection.query=async(sql,args=[])=>{
  const name=sql.split(' ').pop(),d=campaignDefinitions.find(x=>sql.startsWith('CREATE TABLE IF NOT EXISTS '+x.name+' '));
  if(d){f.statements.push(sql);f.state.tables.add(d.name);if(f.state.failTable===d.name)throw Error('Interrupcao controlada');return[[]];}
  if(sql.startsWith('SHOW FULL COLUMNS FROM cl_campaign')){f.statements.push(sql);return[f.state.campaignColumns[name]];}
  if(sql.startsWith('SHOW INDEX FROM cl_campaign')){f.statements.push(sql);return[f.state.campaignIndexes[name]];}
  return query(sql,args);
 };
 f.connection.execute=async(sql,args=[])=>{
  if(sql.includes('information_schema.TABLES')&&sql.includes('TABLE_NAME = ?')&&f.state.campaignEngines[args[0]]){f.statements.push(sql);return[[f.state.campaignEngines[args[0]]]];}
  if(sql.includes('information_schema.KEY_COLUMN_USAGE')&&sql.includes('TABLE_NAME=?')&&f.state.campaignKeys[args[0]]){f.statements.push(sql);return[f.state.campaignKeys[args[0]]];}
  if(sql==='UPDATE cl_schema SET version = 9 WHERE id = 1'){f.statements.push(sql);f.state.version=9;return[{affectedRows:1}];}
  return execute(sql,args);
 };return f;
}
const schema8Tables=[...schema6Tables,...portalTables,'cl_portal_subscription_events'];
test('campaign upgrade8 creates three tables, validates before marker9 and idempotent read-only recheck',async()=>{
 const f=campaignMigration({tables:schema8Tables,version:8});assert.deepEqual(await migrate(f.connection,{targetVersion:9}),{schemaVersion:9});assert.equal(f.state.tables.size,21);
 assert.equal(f.statements.filter(s=>s.startsWith('CREATE TABLE')).length,3);assert(f.statements.indexOf('UPDATE cl_schema SET version = 9 WHERE id = 1')>f.statements.indexOf('SHOW INDEX FROM cl_campaign_batches'));
 f.statements.length=0;await migrate(f.connection,{targetVersion:9});assert(!f.statements.some(s=>/^(CREATE|ALTER|UPDATE|DELETE|INSERT|DROP)/.test(s)));await assert.rejects(migrate(f.connection,{targetVersion:8}),/Downgrade/);
});
test('campaign schema refuses invalid columns, unique indexes, engine and foreign keys; marker8 survives interruptions',async()=>{
 for(const mutate of[
  s=>s.campaignColumns.cl_campaigns[0].Type='int',
  s=>s.campaignColumns.cl_campaigns[4].Collation='ascii_general_ci',
  s=>s.campaignColumns.cl_campaign_recipients[4].Null='NO',
  s=>s.campaignColumns.cl_campaign_batches[3].Default='0',
  s=>s.campaignIndexes.cl_campaign_recipients.pop(),
  s=>s.campaignIndexes.cl_campaign_batches[0].Sub_part=8,
  s=>s.campaignIndexes.cl_campaigns.push({Key_name:'unexpected_unique',Column_name:'title',Seq_in_index:1,Non_unique:0,Sub_part:null}),
  s=>s.campaignEngines.cl_campaigns.engine='MyISAM',
  s=>s.campaignKeys.cl_campaign_recipients[0].deleteRule='CASCADE',
  s=>s.campaignKeys.cl_campaign_batches[0].localSchema=0
 ]){
  const f=campaignMigration({tables:[...schema8Tables,...campaignDefinitions.map(d=>d.name)],version:8});mutate(f.state);await assert.rejects(migrate(f.connection,{targetVersion:9}),/incompat/);assert.equal(f.state.version,8);
 }
 const f=campaignMigration({tables:schema8Tables,version:8});f.state.failTable='cl_campaign_recipients';await assert.rejects(migrate(f.connection,{targetVersion:9}),/Interrupcao/);assert.equal(f.state.version,8);f.state.failTable=null;await migrate(f.connection,{targetVersion:9});assert.equal(f.state.version,9);
});
test('fresh default prepares9 without campaigns; incomplete9 and premature campaign tables refuse any DDL',async()=>{
 const f=campaignMigration({tables:[],version:0});assert.deepEqual(await migrate(f.connection,{targetVersion:9,requireEmpty:true}),{schemaVersion:9});assert.equal(f.state.tables.size,21);assert(!f.statements.some(s=>s.startsWith('INSERT INTO cl_campaign')));
 for(const options of[{tables:schema8Tables,version:9},{tables:[...schema6Tables,...portalTables,'cl_campaigns'],version:7}]){
  const g=campaignMigration(options);await assert.rejects(migrate(g.connection,{targetVersion:9}),/incompleta|concluidas/);assert(!g.statements.some(s=>/^(CREATE|ALTER|UPDATE|DELETE|INSERT|DROP)/.test(s)));
 }
});

const repliesSchema=require('../scripts/replies-schema');
function replyMigration(options={}) {
 const f=campaignMigration(options),query=f.connection.query.bind(f.connection),execute=f.connection.execute.bind(f.connection);
 f.state.replyColumns=repliesSchema.columns.map(([Field,type,Null,Extra])=>({Field,Type:type.source.includes('unsigned')?'int unsigned':type.source.includes('tinyint')?'tinyint':type.source.includes('datetime')?'datetime':type.source.includes('varchar')?'varchar('+type.source.match(/\d+/)[0]+')':'char('+type.source.match(/\d+/)[0]+')',Null,Extra,Default:null,Collation:['title','text'].includes(Field)?'utf8mb4_unicode_ci':['client_key','request_hash'].includes(Field)?'ascii_bin':null}));
 f.state.replyIndexes=repliesSchema.indexes.flatMap(([name,cols,unique])=>cols.map((col,i)=>({Key_name:name,Column_name:col,Seq_in_index:i+1,Non_unique:unique?0:1,Sub_part:null})));
 f.state.replyEngine={engine:'InnoDB',tableCollation:'utf8mb4_unicode_ci'};
 f.state.replyKeys=[['department_id','cl_departments'],['created_by','cl_users'],['updated_by','cl_users']].map(([columnName,referencedTable])=>({columnName,referencedTable,referencedColumn:'id',localSchema:1,deleteRule:'RESTRICT',updateRule:'RESTRICT'}));
 f.connection.query=async(sql,args)=>{
  if(sql===repliesSchema.statement){f.statements.push(sql);f.state.tables.add(repliesSchema.name);if(f.state.failTable===repliesSchema.name)throw Error('Interrupcao');return[[]];}
  if(sql==='SHOW FULL COLUMNS FROM '+repliesSchema.name){f.statements.push(sql);return[f.state.replyColumns];}
  if(sql==='SHOW INDEX FROM '+repliesSchema.name){f.statements.push(sql);return[f.state.replyIndexes];}
  return query(sql,args);
 };
 f.connection.execute=async(sql,args=[])=>{
  if(args[0]===repliesSchema.name&&sql.includes('information_schema.TABLES')){f.statements.push(sql);return[[f.state.replyEngine]];}
  if(args[0]===repliesSchema.name&&sql.includes('information_schema.KEY_COLUMN_USAGE')){f.statements.push(sql);return[f.state.replyKeys];}
  if(sql==='UPDATE cl_schema SET version = 10 WHERE id = 1'){f.statements.push(sql);f.state.version=10;return[{affectedRows:1}];}
  return execute(sql,args);
 };return f;
}
const schema9Tables=[...schema8Tables,...campaignDefinitions.map(d=>d.name)];
test('reply upgrade preserves legacy9, creates one table and validates before10; fresh default and recheck',async()=>{
 const f=replyMigration({tables:schema9Tables,version:9});await migrate(f.connection,{targetVersion:9});assert(!f.statements.some(s=>/^(CREATE|UPDATE|INSERT|ALTER|DROP)/.test(s)));
 f.statements.length=0;assert.deepEqual(await migrate(f.connection),{schemaVersion:10});assert.equal(f.state.tables.size,22);assert.equal(f.statements.filter(s=>s.startsWith('CREATE TABLE')).length,1);
 assert(f.statements.indexOf('UPDATE cl_schema SET version = 10 WHERE id = 1')>f.statements.indexOf('SHOW INDEX FROM cl_reply_templates'));
 f.statements.length=0;await migrate(f.connection);assert(!f.statements.some(s=>/^(CREATE|UPDATE|INSERT|ALTER|DROP)/.test(s)));
 await assert.rejects(migrate(f.connection,{targetVersion:9}),/Downgrade/);
 const fresh=replyMigration({tables:[],version:0});assert.deepEqual(await migrate(fresh.connection,{requireEmpty:true}),{schemaVersion:10});assert.equal(fresh.state.tables.size,22);
});
test('reply partial creation resumes; incompatible columns, indexes, engine and FK preserve marker9',async()=>{
 for(const mutate of [s=>s.replyColumns[0].Type='int',s=>s.replyColumns[2].Collation='ascii_bin',s=>s.replyColumns[4].Default='1',s=>s.replyIndexes.pop(),s=>s.replyEngine.engine='MyISAM',s=>s.replyKeys[0].deleteRule='CASCADE',s=>s.replyKeys[1].localSchema=0]){
  const f=replyMigration({tables:schema9Tables,version:9});mutate(f.state);await assert.rejects(migrate(f.connection),/incompat/);assert.equal(f.state.version,9);
 }
 const f=replyMigration({tables:schema9Tables,version:9});f.state.failTable=repliesSchema.name;await assert.rejects(migrate(f.connection),/Interrupcao/);assert.equal(f.state.version,9);f.state.failTable=null;await migrate(f.connection);assert.equal(f.state.version,10);
 for(const options of [{tables:schema9Tables,version:10},{tables:[...schema8Tables,repliesSchema.name],version:8}]){const g=replyMigration(options);await assert.rejects(migrate(g.connection),/incompleta|concluidas/);assert(!g.statements.some(s=>/^(CREATE|UPDATE|INSERT|ALTER|DROP)/.test(s)));}
});
