'use strict';

const { digest } = require('./security');
const { portalIdentity } = require('./portal-database');
const { NOTICE_VERSION } = require('./subscriptions-database');
const fail = code => { throw Object.assign(Error(), { statusCode: code }); };
const uint = x => Number.isInteger(x) && x > 0 && x <= 4294967295;
const hex = (x, n) => typeof x === 'string' && new RegExp('^[a-f0-9]{'+n+'}$').test(x);
const exact = (x, keys) => {
  if (!x || typeof x !== 'object' || Array.isArray(x) || ![Object.prototype,null].includes(Object.getPrototypeOf(x)) || Object.keys(x).sort().join(',') !== [...keys].sort().join(',')) fail(400);
};
function content(input) {
  if (typeof input.title !== 'string' || typeof input.text !== 'string' || input.title.length > 120 || input.text.length > 4000 || /[\u0000-\u001f\u007f]/.test(input.title) || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(input.text)) fail(400);
  const title = input.title.trim().normalize('NFC'), text = input.text.trim().normalize('NFC');
  if (title.length < 2 || title.length > 120 || !text.length || text.length > 4000) fail(400);
  return {title,text};
}
function campaignRepository({ transaction, capabilities }) {
  async function coordinated(work) {
    return transaction(async c => {
      await c.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
      if ((await capabilities(c)).campaigns !== true) fail(503);
      return work(c);
    });
  }
  async function admin(c, actorId, token) {
    if (!uint(actorId) || !hex(token,64)) fail(401);
    const [rows] = await c.execute('SELECT u.role, u.active FROM cl_sessions s JOIN cl_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > UTC_TIMESTAMP() FOR UPDATE',[digest(token),actorId]);
    if (!rows.length) fail(401);
    if (rows[0].role !== 'admin' || Number(rows[0].active) !== 1) fail(403);
  }
  const team = (actorId,token,work) => coordinated(async c => { await admin(c,actorId,token);return work(c); });
  const eligible = async c => (await c.execute('SELECT a.id AS accountId, s.version AS consentVersion FROM cl_portal_accounts a JOIN cl_portal_subscription_events s ON s.account_id = a.id WHERE a.active = 1 AND s.subscribed = 1 AND s.notice_version = ? AND NOT EXISTS (SELECT 1 FROM cl_portal_subscription_events newer WHERE newer.account_id = s.account_id AND newer.version > s.version) ORDER BY a.id FOR UPDATE',[NOTICE_VERSION]))[0].map(r=>({accountId:Number(r.accountId),consentVersion:Number(r.consentVersion)}));
  const audienceHash = rows => digest(JSON.stringify([NOTICE_VERSION,rows]));
  async function record(c,id) {
    if (!uint(id)) fail(400);
    return (await c.execute('SELECT id, title, text, state, notice_version AS noticeVersion, created_at AS createdAt FROM cl_campaigns WHERE id = ? FOR UPDATE',[id]))[0][0] || null;
  }
  async function summary(c,row,detail=false) {
    const [states] = await c.execute('SELECT state, COUNT(*) AS total FROM cl_campaign_recipients WHERE campaign_id = ? GROUP BY state',[row.id]);
    const counts={pending:0,delivered:0,skipped:0,cancelled:0};
    for(const r of states) counts[r.state]=Number(r.total);
    return {id:Number(row.id),title:row.title,...(detail?{text:row.text}:{}),state:row.state,createdAt:row.createdAt,counts,total:Object.values(counts).reduce((a,b)=>a+b,0)};
  }
  async function findByKey(c,actorId,key) {
    return (await c.execute('SELECT id, request_hash AS requestHash FROM cl_campaigns WHERE created_by = ? AND client_key = ? FOR UPDATE',[actorId,key]))[0][0] || null;
  }
  function page(p,l) { if (!Number.isInteger(p)||p<1||p>10000||!Number.isInteger(l)||l<1||l>50) fail(400); }
  return {
    previewCampaign(actorId,token,input) {
      exact(input,['title','text']);const normalized=content(input);
      return team(actorId,token,async c=>{const rows=await eligible(c);return {...normalized,recipientCount:rows.length,audienceHash:audienceHash(rows),noticeVersion:NOTICE_VERSION};});
    },
    createCampaign(actorId,token,input) {
      exact(input,['title','text','audienceHash','clientKey']);const normalized=content(input);
      if(!hex(input.audienceHash,64)||!hex(input.clientKey,32))fail(400);
      const requestHash=digest(JSON.stringify([normalized.title,normalized.text,input.audienceHash]));
      return team(actorId,token,async c=>{
        const replay=await findByKey(c,actorId,input.clientKey);
        if(replay){if(replay.requestHash!==requestHash)fail(409);return{campaign:await summary(c,await record(c,Number(replay.id)),true),created:false};}
        const recipients=await eligible(c);
        if(!recipients.length||recipients.length>5000||audienceHash(recipients)!==input.audienceHash)fail(409);
        if(Number((await c.execute('SELECT COUNT(*) AS total FROM cl_campaigns'))[0][0].total)>=500)fail(429);
        const [result]=await c.execute("INSERT INTO cl_campaigns (title,text,created_by,client_key,request_hash,audience_hash,notice_version,state,created_at) VALUES (?,?,?,?,?,?,?,'queued',UTC_TIMESTAMP())",[normalized.title,normalized.text,actorId,input.clientKey,requestHash,input.audienceHash,NOTICE_VERSION]);
        const id=Number(result.insertId);
        // A bounded audience and one commit: interruption cannot leave a partial queue.
        for(let start=0;start<recipients.length;start+=100){
          const rows=recipients.slice(start,start+100);
          await c.execute('INSERT INTO cl_campaign_recipients (campaign_id,account_id,consent_version,state) VALUES '+rows.map(()=>"(?,?,?,'pending')").join(','),rows.flatMap(r=>[id,r.accountId,r.consentVersion]));
        }
        return {campaign:await summary(c,await record(c,id),true),created:true};
      });
    },
    campaignByRequest(actorId,token,key) {
      if(!hex(key,32))fail(400);
      return team(actorId,token,async c=>{const found=await findByKey(c,actorId,key);return found?summary(c,await record(c,Number(found.id)),true):null;});
    },
    listCampaigns(actorId,token,p=1,l=20) {
      page(p,l);
      return team(actorId,token,async c=>{
        const total=Number((await c.execute('SELECT COUNT(*) AS total FROM cl_campaigns'))[0][0].total);
        const [rows]=await c.execute('SELECT id, title, state, created_at AS createdAt FROM cl_campaigns ORDER BY id DESC LIMIT '+l+' OFFSET '+((p-1)*l));
        const campaigns=[];for(const row of rows)campaigns.push(await summary(c,row));
        return {campaigns,total,page:p,limit:l};
      });
    },
    findCampaign(actorId,token,id) {
      return team(actorId,token,async c=>{const row=await record(c,id);return row?summary(c,row,true):null;});
    },
    cancelCampaign(actorId,token,id) {
      return team(actorId,token,async c=>{
        const row=await record(c,id);if(!row)return null;
        await c.execute("UPDATE cl_campaigns SET state = 'cancelled' WHERE id = ?",[id]);
        await c.execute("UPDATE cl_campaign_recipients SET state = 'cancelled' WHERE campaign_id = ? AND state = 'pending'",[id]);
        row.state='cancelled';return summary(c,row,true);
      });
    },
    processCampaign(actorId,token,id,key) {
      if(!hex(key,32))fail(400);
      return team(actorId,token,async c=>{
        const row=await record(c,id);if(!row)return null;
        const [replays]=await c.execute('SELECT delivered, skipped, remaining, created_at AS createdAt FROM cl_campaign_batches WHERE campaign_id = ? AND client_key = ? FOR UPDATE',[id,key]);
        if(replays.length)return{campaign:await summary(c,row,true),batch:replays[0],replayed:true};
        if(row.state!=='queued')fail(409);
        const [pending]=await c.execute("SELECT account_id AS accountId, consent_version AS consentVersion FROM cl_campaign_recipients WHERE campaign_id = ? AND state = 'pending' ORDER BY account_id LIMIT 50 FOR UPDATE",[id]);
        let delivered=0,skipped=0;
        for(const recipient of pending){
          const [choice]=await c.execute('SELECT s.version, s.subscribed, s.notice_version AS noticeVersion, a.active FROM cl_portal_accounts a JOIN cl_portal_subscription_events s ON s.account_id = a.id WHERE a.id = ? ORDER BY s.version DESC LIMIT 1 FOR UPDATE',[recipient.accountId]);
          const valid=choice.length && Number(choice[0].active)===1 && Number(choice[0].subscribed)===1 && choice[0].noticeVersion===NOTICE_VERSION && row.noticeVersion===NOTICE_VERSION && Number(choice[0].version)===Number(recipient.consentVersion);
          await c.execute("UPDATE cl_campaign_recipients SET state = ?, delivered_at = "+(valid?'UTC_TIMESTAMP()':'NULL')+" WHERE campaign_id = ? AND account_id = ? AND state = 'pending'",[valid?'delivered':'skipped',id,recipient.accountId]);
          if(valid)delivered++;else skipped++;
        }
        const remaining=Number((await c.execute("SELECT COUNT(*) AS total FROM cl_campaign_recipients WHERE campaign_id = ? AND state = 'pending'",[id]))[0][0].total);
        // No empty batch record: an empty queue always has the same harmless result.
        if(pending.length)await c.execute('INSERT INTO cl_campaign_batches (campaign_id,client_key,delivered,skipped,remaining,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())',[id,key,delivered,skipped,remaining]);
        return {campaign:await summary(c,row,true),batch:{delivered,skipped,remaining},replayed:false};
      });
    },
    portalNews(token,p=1,l=20) {
      page(p,l);
      return coordinated(async c=>{
        const identity=await portalIdentity(c,token);
        const total=Number((await c.execute("SELECT COUNT(*) AS total FROM cl_campaign_recipients WHERE account_id = ? AND state = 'delivered'",[identity.accountId]))[0][0].total);
        const [news]=await c.execute("SELECT c.id, c.title, c.text, r.delivered_at AS deliveredAt, r.read_at AS readAt FROM cl_campaign_recipients r JOIN cl_campaigns c ON c.id = r.campaign_id WHERE r.account_id = ? AND r.state = 'delivered' ORDER BY r.campaign_id DESC LIMIT "+l+' OFFSET '+((p-1)*l),[identity.accountId]);
        return {news,total,page:p,limit:l};
      });
    },
    readPortalNews(token,id) {
      if(!uint(id))fail(400);
      return coordinated(async c=>{
        const identity=await portalIdentity(c,token);
        const [rows]=await c.execute("SELECT campaign_id FROM cl_campaign_recipients WHERE campaign_id = ? AND account_id = ? AND state = 'delivered' FOR UPDATE",[id,identity.accountId]);
        if(!rows.length)return null;
        await c.execute('UPDATE cl_campaign_recipients SET read_at = COALESCE(read_at, UTC_TIMESTAMP()) WHERE campaign_id = ? AND account_id = ?',[id,identity.accountId]);
        return {read:true};
      });
    }
  };
}
module.exports={campaignRepository,content};
