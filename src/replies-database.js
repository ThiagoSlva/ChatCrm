'use strict';
const {digest}=require('./security');
const {normalizeReply,integer}=require('./reply-input');
function repliesRepository({transaction,capabilities}) {
  const fail=code=>{throw Object.assign(new Error(),{statusCode:code});};
  const fields='r.id,r.department_id AS departmentId,d.name AS departmentName,r.title,r.text,r.active,r.version';
  const from='FROM cl_reply_templates r LEFT JOIN cl_departments d ON d.id=r.department_id';
  const safe=r=>({id:Number(r.id),departmentId:r.departmentId===null?null:Number(r.departmentId),departmentName:r.departmentName||null,title:r.title,text:r.text,active:Number(r.active)===1,version:Number(r.version)});
  async function coordinated(actorId,token,admin,work) {
    integer(actorId);if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))fail(401);
    return transaction(async c=>{
      await c.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
      if(!(await capabilities(c)).replies)fail(503);
      const [users]=await c.execute('SELECT id, role FROM cl_users WHERE id = ? AND active = 1 FOR UPDATE',[actorId]);
      if(!users.length||!['admin','operator'].includes(users[0].role))fail(401);
      const [sessions]=await c.execute('SELECT user_id FROM cl_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP() FOR UPDATE',[digest(token),actorId]);
      if(!sessions.length)fail(401);if(admin&&users[0].role!=='admin')fail(403);
      return work(c,users[0]);
    });
  }
  async function scope(c,input) {
    if(input.departmentId===null)return;
    const [departments]=await c.execute('SELECT id, active FROM cl_departments WHERE id = ? FOR UPDATE',[input.departmentId]);
    if(!departments.length||(input.active&&Number(departments[0].active)!==1))fail(404);
  }
  async function conversation(c,user,id) {
    integer(id);
    const [rows]=await c.execute('SELECT c.department_id AS departmentId,c.assigned_to AS assignedTo,c.status,d.active FROM cl_chat_conversations c JOIN cl_departments d ON d.id=c.department_id WHERE c.id=? FOR UPDATE',[id]);
    const row=rows[0];if(!row||row.status!=='open'||Number(row.assignedTo)!==Number(user.id)||Number(row.active)!==1)fail(404);
    if(user.role!=='admin'){
      const [members]=await c.execute('SELECT user_id FROM cl_department_members WHERE department_id = ? AND user_id = ? FOR UPDATE',[row.departmentId,user.id]);if(!members.length)fail(404);
    }
    return Number(row.departmentId);
  }
  function filters(page,limit,q) {
    if(!Number.isInteger(page)||page<1||page>10000||!Number.isInteger(limit)||limit<1||limit>50||typeof q!=='string'||q.length>100||/[\u0000-\u001f\u007f]/.test(q))fail(400);
    q=q.normalize('NFC').trim();if(q.length>100)fail(400);return '%'+q.replace(/[!%_]/g,x=>'!'+x)+'%';
  }
  async function byId(c,id) {const [rows]=await c.execute('SELECT '+fields+' '+from+' WHERE r.id=?',[id]);if(!rows.length)fail(404);return safe(rows[0]);}
  async function list(c,page,limit,pattern,departmentId) {
    const conditions=["(r.title LIKE ? ESCAPE '!' OR r.text LIKE ? ESCAPE '!')"],values=[pattern,pattern];
    if(departmentId!==undefined){conditions.push('r.active=1 AND (r.department_id IS NULL OR r.department_id=?)');values.push(departmentId);}
    const where=from+' WHERE '+conditions.join(' AND ');
    const [counts]=await c.execute('SELECT COUNT(*) AS total '+where,values);
    const [rows]=await c.execute('SELECT '+fields+' '+where+' ORDER BY r.title,r.id LIMIT '+limit+' OFFSET '+((page-1)*limit),values);
    return {templates:rows.map(safe),total:Number(counts[0].total),page,limit};
  }
  return {
    async listReplyTemplates(actorId,token,page,limit,q='') {const pattern=filters(page,limit,q);return coordinated(actorId,token,true,c=>list(c,page,limit,pattern));},
    async findReplyTemplate(actorId,token,id) {integer(id);return coordinated(actorId,token,true,c=>byId(c,id));},
    async createReplyTemplate(actorId,token,input) {
      const data=normalizeReply(input);if(Object.hasOwn(input,'version')||typeof input.clientKey!=='string'||!/^[a-f0-9]{32}$/.test(input.clientKey))fail(400);
      const hash=digest(JSON.stringify(data));return coordinated(actorId,token,true,async(c,user)=>{
        const [existing]=await c.execute('SELECT id,request_hash AS requestHash FROM cl_reply_templates WHERE created_by=? AND client_key=? FOR UPDATE',[user.id,input.clientKey]);
        if(existing.length){if(existing[0].requestHash!==hash)fail(409);return {template:await byId(c,existing[0].id),created:false};}
        await scope(c,data);const [counts]=await c.execute('SELECT COUNT(*) AS total FROM cl_reply_templates');if(Number(counts[0].total)>=500)fail(429);
        const [r]=await c.execute('INSERT INTO cl_reply_templates (department_id,title,text,active,version,created_by,updated_by,client_key,request_hash,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())',[data.departmentId,data.title,data.text,Number(data.active),user.id,user.id,input.clientKey,hash]);
        return {template:await byId(c,r.insertId),created:true};
      });
    },
    async updateReplyTemplate(actorId,token,id,input) {
      integer(id);integer(input?.version);const data=normalizeReply(input);if(Object.hasOwn(input,'clientKey'))fail(400);
      return coordinated(actorId,token,true,async(c,user)=>{
        const [rows]=await c.execute('SELECT id,version FROM cl_reply_templates WHERE id=? FOR UPDATE',[id]);if(!rows.length)fail(404);
        if(Number(rows[0].version)!==input.version||input.version>=4294967295)fail(409);
        await scope(c,data);const current=await byId(c,id);
        if(['departmentId','title','text','active'].every(key=>data[key]===current[key]))return {template:current};
        const [r]=await c.execute('UPDATE cl_reply_templates SET department_id=?,title=?,text=?,active=?,version=version+1,updated_by=?,updated_at=UTC_TIMESTAMP() WHERE id=? AND version=?',[data.departmentId,data.title,data.text,Number(data.active),user.id,id,input.version]);
        if(Number(r.affectedRows)!==1)fail(409);return {template:await byId(c,id)};
      });
    },
    async listConversationReplies(actorId,token,id,page,limit,q='') {const pattern=filters(page,limit,q);return coordinated(actorId,token,false,async(c,user)=>list(c,page,limit,pattern,await conversation(c,user,id)));},
    async findConversationReply(actorId,token,id,templateId) {
      integer(templateId);return coordinated(actorId,token,false,async(c,user)=>{
        const departmentId=await conversation(c,user,id),template=await byId(c,templateId);
        if(!template.active||(template.departmentId!==null&&template.departmentId!==departmentId))fail(404);return {template};
      });
    }
  };
}
module.exports={repliesRepository};
