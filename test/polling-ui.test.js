'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

function fixture(kind,random=()=>0.5) {
  const timers=new Map(),elements=new Map(),events=new Map(); let serial=0,network=0;
  const element=id=>{if(!elements.has(id))elements.set(id,{id,textContent:'',hidden:false,value:'',addEventListener(){},querySelectorAll(){return[];},setAttribute(){}});return elements.get(id);};
  const document={hidden:false,getElementById:element,addEventListener(name,fn){events.set(name,fn);}};
  const window={addEventListener(){}};
  const math=Object.create(Math);math.random=random;
  class Clock extends Date { static now(){return 10000;} }
  const context=vm.createContext({window,document,Math:math,Date:Clock,Map,AbortController,AbortSignal,setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},fetch(){network++;throw Error('Unexpected network operation');}});
  vm.runInContext(fs.readFileSync('public/polling.js','utf8'),context);
  const script=kind==='visitor'?'chat':kind;
  const source=fs.readFileSync('public/'+script+'.js','utf8').replace(/(?:visitorInitialize|inboxInitialize)\(\);\s*$/,'');
  vm.runInContext(source,context);
  const run=code=>vm.runInContext(code,context);
  if(kind==='visitor')run('visitorIdentity={id:1}; visitorSelected={id:1,status:"open"};');
  if(kind==='inbox')run('inboxProfile={user:{id:1}}; inboxSelected={id:1}; inboxQueueAttemptAt=9000; inboxMessagesAttemptAt=9000;');
  if(kind==='portal')run('portal.account={accessId:"a".repeat(24)}; portal.ready=true;');
  return{run,timers,document,events,network:()=>network};
}

test('automatic delay never advances the base deadline and spreads thirty independent clients',()=>{
  const delays=[];
  for(let i=0;i<30;i++){const f=fixture('visitor',()=>i/30);f.run('visitorSchedule()');const delay=[...f.timers.values()][0].ms;assert(delay>=3150&&delay<=3750);delays.push(delay);}
  assert.equal(new Set(delays).size,30);
  const low=fixture('visitor',()=>0),high=fixture('visitor',()=>1-Number.EPSILON);
  assert.equal(low.run('window.ClPolling.delay(0)'),150);assert.equal(high.run('window.ClPolling.delay(5000)'),5750);
});

test('visitor, inbox and portal keep one timer and respect base cadences and slower portal retry',()=>{
  for(const [kind,schedule,expected] of [['visitor','visitorSchedule()',3450],['inbox','inboxSchedule()',2450],['portal','portal.schedule()',5450]]){
    const f=fixture(kind);f.run(schedule);f.run(schedule);assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].ms,expected);
    f.run(kind==='portal'?'portal.schedule(0)':kind+'Schedule(0)');assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].ms,450);
  }
  const f=fixture('portal');f.run('portal.schedule(15000)');assert.equal([...f.timers.values()][0].ms,15450);
});

test('hidden, busy, expired identity and disposed pages cancel the timer rather than poll',async()=>{
  for(const kind of ['visitor','inbox','portal']){
    const schedule=kind==='portal'?'portal.schedule()':kind+'Schedule()';
    for(const state of ['hidden','busy','identity','disposed']){
      const f=fixture(kind);f.run(schedule);const old=[...f.timers.values()][0];
      f.run(state==='hidden'?'document.hidden=true':kind==='portal'?({busy:'portal.busy=true',identity:'portal.account=null',disposed:'portal.disposed=true'})[state]:({busy:kind+'Busy=true',identity:kind+(kind==='visitor'?'Identity':'Profile')+'=null',disposed:kind+'Disposed=true'})[state]);
      f.run(schedule);assert.equal(f.timers.size,0);
      if(state==='hidden'||state==='busy'||state==='disposed')await old.fn();
      assert.equal(f.network(),0);
    }
  }
});

test('scheduled visitor and inbox reads preserve draft text and pending message key; no automatic writes',async()=>{
  for(const kind of ['visitor','inbox']){
    const f=fixture(kind);
    f.run(`${kind}Drafts.set(1,{text:'Rascunho não enviado',pending:{text:'Texto pendente',clientKey:'a'.repeat(32)}}); globalThis.reads=[]; ${kind}Run=async(work,automatic)=>{if(!automatic)throw Error('Not automatic');await work();};`);
    if(kind==='visitor')f.run('visitorLoadConversations=async()=>reads.push("list");visitorLoadMessages=async()=>reads.push("messages");');
    else f.run('inboxQueueAttemptAt=0;inboxMessagesAttemptAt=0;inboxLoadQueue=async()=>reads.push("queue");inboxLoadMessages=async()=>reads.push("messages");');
    const before=JSON.stringify(f.run(kind+'Drafts.get(1)'));f.run(kind+'Schedule()');await [...f.timers.values()][0].fn();
    assert.equal(JSON.stringify(f.run(kind+'Drafts.get(1)')),before);assert.equal(f.run('reads.length'),2);assert.equal(f.network(),0);
  }
});
