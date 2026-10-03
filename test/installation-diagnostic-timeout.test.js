'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const mysql=require('mysql2');
const {inspectInstallation,readOnly}=require('../scripts/check-installation');

async function protocolFixture(t, mode) {
  const server=mysql.createServer(), peers=new Set(), seen=[];
  server.on('connection', peer=>{
    peers.add(peer);peer.on('error',()=>{});
    // This tiny test server resets command sequence numbers; product code never touches protocol internals.
    const handle=peer.handlePacket.bind(peer);
    peer.handlePacket=packet=>{if(packet?.sequenceId===0)peer.sequenceId=0;return handle(packet);};
    peer.on('query',sql=>{
      seen.push({kind:'query',sql});
      if(mode==='prepare-stall' && sql==='SHOW TABLES'){
        peer.writeColumns([{catalog:'def',schema:'',table:'',orgTable:'',name:'Tables_in_synthetic',orgName:'',characterSet:45,columnLength:100,columnType:mysql.Types.VAR_STRING,flags:0,decimals:0}]);
        for(const name of ['cl_schema','cl_company','cl_users','cl_sessions'])peer.writeTextRow([name]);
        peer.writeEof();
      }
      // Other queries intentionally receive no response.
    });
    peer.on('stmt_prepare',sql=>seen.push({kind:'prepare',sql}));
    peer.serverHandshake({protocolVersion:10,serverVersion:'8.0.0-synthetic',
      capabilityFlags:0x00000200|0x00008000|0x00080000,connectionId:1,statusFlags:2,
      characterSet:45,authPluginName:'mysql_native_password'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server._server.address().port;let connection;let destroyed=0;
  t.after(async()=>{
    if(connection)connection.destroy();
    for(const peer of peers)peer.destroy();
    await new Promise(resolve=>server.close(resolve));
  });
  const connect=async options=>{
    assert.equal(options.host,'127.0.0.1');assert.equal(options.port,port);
    connection=await mysql.createConnectionPromise(options);connection.on('error',()=>{});
    const destroy=connection.destroy.bind(connection);
    connection.destroy=()=>{destroyed++;destroy();};
    return connection;
  };
  return {connect,seen,destroyed:()=>destroyed,env:{APP_URL:'https://support.example.test',
    NODE_ENV:'production',DB_HOST:'127.0.0.1',DB_PORT:String(port),DB_NAME:'synthetic',
    DB_USER:'synthetic',DB_PASSWORD:'synthetic-only'}};
}

for(const mode of ['query-stall','prepare-stall']){
  test('actual mysql2 driver abandons '+mode+' on its own connection', {timeout:5000}, async t=>{
    const fixture=await protocolFixture(t,mode);
    const start=performance.now();
    const result=await inspectInstallation({env:fixture.env,nodeVersion:'24.0.0',
      connect:fixture.connect,timeoutMs:100});
    assert.deepEqual(result,{ok:false,code:'database-timeout'});
    assert.ok(performance.now()-start<2000);assert.equal(fixture.destroyed(),1);
    assert.ok(fixture.seen.some(event=>event.kind==='query'&&event.sql==='SHOW TABLES'));
    if(mode==='prepare-stall')assert.ok(fixture.seen.some(event=>event.kind==='prepare'));
  });
}

test('native driver timeout destroys the owned connection before graceful close can wait', async()=>{
  let destroyed=0,closed=0;
  const error=Object.assign(new Error('synthetic-private-driver-detail'),{code:'PROTOCOL_SEQUENCE_TIMEOUT'});
  const connection={query:async()=>{throw error;},destroy:()=>{destroyed++;},end:async()=>{closed++;}};
  const result=await inspectInstallation({env:{APP_URL:'https://support.example.test',
    DB_HOST:'synthetic',DB_USER:'synthetic',DB_NAME:'synthetic',DB_PASSWORD:'synthetic'},
    nodeVersion:'24.0.0',connect:async()=>connection});
  assert.deepEqual(result,{ok:false,code:'database-timeout'});
  assert.equal(destroyed,1);assert.equal(closed,0);
});

test('a stalled graceful close is bounded and does not return installation success', async()=>{
  let destroyed=0;
  const connection={query:async()=>[[]],destroy:()=>{destroyed++;},end:()=>new Promise(()=>{})};
  const result=await inspectInstallation({env:{APP_URL:'https://support.example.test',
    DB_HOST:'synthetic',DB_USER:'synthetic',DB_NAME:'synthetic',DB_PASSWORD:'synthetic'},
    nodeVersion:'24.0.0',connect:async()=>connection,timeoutMs:20});
  assert.deepEqual(result,{ok:false,code:'database-timeout'});assert.equal(destroyed,1);
});

test('late completion after the deadline is consumed and cannot overwrite the timeout', async()=>{
  let complete;let destroyed=0;
  const connection={query:()=>new Promise(resolve=>{complete=resolve;}),destroy:()=>{destroyed++;}};
  const read=readOnly(connection,{timeoutMs:20});
  await assert.rejects(read.query('SHOW TABLES'),{code:'DIAGNOSTIC_TIMEOUT'});
  complete([[]]);await new Promise(resolve=>setImmediate(resolve));assert.equal(destroyed,1);
});

test('manual CLI exits after a real default timeout and emits only its safe JSON report', {timeout:15000}, async t=>{
  const {spawn}=require('node:child_process');
  const path=require('node:path');
  const fixture=await protocolFixture(t,'query-stall');
  const child=spawn(process.execPath,[path.resolve(__dirname,'../scripts/check-installation.js'),'--json'],{
    env:{...process.env,...fixture.env},stdio:['ignore','pipe','pipe']
  });
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill();});
  let stdout='',stderr='';
  child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  assert.deepEqual(result,{code:1,signal:null});
  assert.deepEqual(JSON.parse(stdout),{ok:false,code:'database-timeout'});
  assert.equal(stderr,'');assert.ok(fixture.seen.some(event=>event.kind==='query'));
});
