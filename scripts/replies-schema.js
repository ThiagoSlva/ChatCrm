'use strict';
const name='cl_reply_templates';
const columns=[['id',/^int(?:\(\d+\))? unsigned$/,'NO','auto_increment'],['department_id',/^int(?:\(\d+\))? unsigned$/,'YES',''],
  ['title',/^varchar\(100\)$/,'NO',''],['text',/^varchar\(2000\)$/,'NO',''],['active',/^tinyint(?:\(\d+\))?$/,'NO',''],
  ['version',/^int(?:\(\d+\))? unsigned$/,'NO',''],['created_by',/^int(?:\(\d+\))? unsigned$/,'NO',''],['updated_by',/^int(?:\(\d+\))? unsigned$/,'NO',''],
  ['client_key',/^char\(32\)$/,'NO',''],['request_hash',/^char\(64\)$/,'NO',''],['created_at',/^datetime(?:\(0\))?$/,'NO',''],['updated_at',/^datetime(?:\(0\))?$/,'NO','']];
const indexes=[['PRIMARY',['id'],true],['cl_reply_request',['created_by','client_key'],true],['cl_reply_scope',['department_id','active','id'],false],['cl_reply_actor',['updated_by'],false]];
const statement="CREATE TABLE IF NOT EXISTS cl_reply_templates (id INT UNSIGNED NOT NULL AUTO_INCREMENT, department_id INT UNSIGNED NULL, title VARCHAR(100) NOT NULL, text VARCHAR(2000) NOT NULL, active TINYINT NOT NULL, version INT UNSIGNED NOT NULL, created_by INT UNSIGNED NOT NULL, updated_by INT UNSIGNED NOT NULL, client_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY(id), UNIQUE KEY cl_reply_request(created_by,client_key), INDEX cl_reply_scope(department_id,active,id), INDEX cl_reply_actor(updated_by), FOREIGN KEY(department_id) REFERENCES cl_departments(id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY(created_by) REFERENCES cl_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY(updated_by) REFERENCES cl_users(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
async function verifyReplySchema(c) {
  const [cols]=await c.query('SHOW FULL COLUMNS FROM '+name);
  if(cols.length!==columns.length || columns.some(([field,type,nullable,extra])=>!cols.some(r=>r.Field===field&&type.test(r.Type.toLowerCase())&&r.Null===nullable&&r.Default===null&&r.Extra===extra&&
    (!['client_key','request_hash'].includes(field)||r.Collation==='ascii_bin')&&(!['title','text'].includes(field)||r.Collation==='utf8mb4_unicode_ci')))) throw Error('Estrutura de respostas incompativel.');
  const [rows]=await c.query('SHOW INDEX FROM '+name);
  const matches=([key,fields,unique])=>{const ordered=rows.filter(r=>r.Key_name===key).sort((a,b)=>Number(a.Seq_in_index)-Number(b.Seq_in_index));return ordered.length===fields.length&&ordered.every((r,i)=>r.Column_name===fields[i]&&Number(r.Seq_in_index)===i+1&&Number(r.Non_unique)===(unique?0:1)&&r.Sub_part===null);};
  if(indexes.some(x=>!matches(x))||rows.some(r=>Number(r.Non_unique)===0&&!indexes.some(x=>x[0]===r.Key_name&&x[2]))) throw Error('Indices de respostas incompativeis.');
  const [table]=await c.execute('SELECT ENGINE AS engine, TABLE_COLLATION AS tableCollation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',[name]);
  if(table.length!==1||table[0].engine?.toLowerCase()!=='innodb'||table[0].tableCollation!=='utf8mb4_unicode_ci') throw Error('Engine de respostas incompativel.');
  const [keys]=await c.execute("SELECT k.COLUMN_NAME AS columnName, k.REFERENCED_TABLE_NAME AS referencedTable, k.REFERENCED_COLUMN_NAME AS referencedColumn, (k.REFERENCED_TABLE_SCHEMA = DATABASE()) AS localSchema, r.DELETE_RULE AS deleteRule, r.UPDATE_RULE AS updateRule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL",[name]);
  const expected=[['department_id','cl_departments'],['created_by','cl_users'],['updated_by','cl_users']];
  if(keys.length!==3||expected.some(([col,tab])=>!keys.some(k=>k.columnName===col&&k.referencedTable===tab&&k.referencedColumn==='id'&&Number(k.localSchema)===1&&k.deleteRule==='RESTRICT'&&k.updateRule==='RESTRICT'))) throw Error('Vinculos de respostas incompativeis.');
}
module.exports={name,columns,indexes,statement,verifyReplySchema};
