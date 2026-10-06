'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {inspectReleases}=require('../scripts/release-inventory');
const {parseArguments}=require('../scripts/check-releases');
const now=Date.UTC(2026,9,6),DAY=86400000;
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatcrm-release-inventory-'));
  t.after(()=>{const actual=fs.realpathSync(root);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));assert.match(path.basename(actual),/^chatcrm-release-inventory-/);fs.rmSync(actual,{recursive:true,force:true});});
  const releases=path.join(root,'releases');fs.mkdirSync(releases);
  for(let i=0;i<6;i++) {
    const folder=path.join(releases,'release-'+String(i).repeat(6));fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder,'.deploy-commit'),String(i+1).repeat(40)+'\n');
    fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({name:'conversa-livre',version:'0.13.5',license:'MIT'}));
    fs.mkdirSync(path.join(folder,'node_modules'));fs.writeFileSync(path.join(folder,'node_modules','source'),'synthetic dependency');
    const time=new Date(now-(20-i*3)*DAY);fs.utimesSync(path.join(folder,'.deploy-commit'),time,time);
  }
  const current=path.join(releases,'release-000000'),previous=path.join(releases,'release-111111');
  fs.symlinkSync(current,path.join(root,'current'),process.platform==='win32'?'junction':'dir');
  fs.writeFileSync(path.join(root,'.deployed.json'),JSON.stringify({commit:'1'.repeat(40),release:current,previousRelease:previous,deployedAt:new Date(now).toISOString()}));
  fs.writeFileSync(path.join(root,'.env'),'DB_PASSWORD=synthetic-never-display');
  return {root,releases,current,previous};
}
function fingerprint(root) {
  const rows=[];
  function visit(folder) {for(const name of fs.readdirSync(folder).sort()){const p=path.join(folder,name),s=fs.lstatSync(p);rows.push([p,s.size,s.mtimeMs,s.isSymbolicLink()?fs.readlinkSync(p):s.isFile()?fs.readFileSync(p).toString('hex'):null]);if(s.isDirectory()&&!s.isSymbolicLink())visit(p);}}
  visit(root);return JSON.stringify(rows);
}
test('inventário preserva ativa/anterior, versões recentes e idade mínima, sem mutação ou configuração',t=>{
  const {root}=fixture(t),before=fingerprint(root);
  const r=inspectReleases({root,now,keep:1,minAgeDays:7});
  assert.equal(r.reviewReady,true);assert.equal(r.readOnly,true);
  assert.deepEqual(r.candidatesForReview,['release-222222','release-333333','release-444444']);
  assert.equal(r.releases[0].protection.includes('current'),true);assert.equal(r.releases[1].protection.includes('previous'),true);
  assert.equal(r.releases[5].protection.includes('recent'),true);assert.equal(r.releases[5].protection.includes('age'),true);
  assert.equal(r.measuredBytes,r.releases.reduce((n,row)=>n+row.bytes,0));assert(r.candidateBytes>0);
  assert.equal(fingerprint(root),before);assert.doesNotMatch(JSON.stringify(r),/DB_PASSWORD|synthetic-never-display|chatcrm-release-inventory-/);
});
test('recibo inconsistente ou alvo fora de releases é recusado, sem plano de revisão',t=>{
  const f=fixture(t),file=path.join(f.root,'.deployed.json'),original=JSON.parse(fs.readFileSync(file));
  for(const change of [{commit:'9'.repeat(40)},{release:f.previous},{previousRelease:f.root},{previousRelease:path.join(f.releases,'missing')}]){
    fs.writeFileSync(file,JSON.stringify({...original,...change}));assert.throws(()=>inspectReleases({root:f.root,now}),/unconfirmed/);
  }
});
test('deploy em curso, inclusive link temporário quebrado, suprime todas as sugestões',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'.deployed.json.next'),'synthetic');
  let r=inspectReleases({root:f.root,now,keep:1});assert.equal(r.reviewReady,false);assert.deepEqual(r.candidatesForReview,[]);assert(r.warnings.includes('deployment-in-progress'));
  fs.unlinkSync(path.join(f.root,'.deployed.json.next'));
  fs.symlinkSync(path.join(f.root,'absent'),path.join(f.root,'.current-next'),process.platform==='win32'?'junction':'dir');
  r=inspectReleases({root:f.root,now,keep:1});assert(r.warnings.includes('deployment-in-progress'));assert.deepEqual(r.candidatesForReview,[]);
});
test('release incompleta e entrada desconhecida são preservadas e exigem revisão manual',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.releases,'release-ABCDEF'));fs.mkdirSync(path.join(f.releases,'other-application'));
  const r=inspectReleases({root:f.root,now,keep:1});assert.equal(r.reviewReady,false);assert.deepEqual(r.candidatesForReview,[]);
  assert(r.releases.find(x=>x.name==='release-ABCDEF').protection.includes('unconfirmed'));assert(r.warnings.includes('unrecognized-entries-preserved'));
});
test('links internos não são seguidos; releases, recibo e raiz por link são recusados',t=>{
  const f=fixture(t);fs.symlinkSync(f.root,path.join(f.current,'linked'),process.platform==='win32'?'junction':'dir');
  const r=inspectReleases({root:f.root,now,keep:1});assert(r.warnings.includes('symbolic-links-not-followed'));assert.deepEqual(r.candidatesForReview,[]);
  const alias=path.join(f.root,'alias');fs.symlinkSync(f.root,alias,process.platform==='win32'?'junction':'dir');assert.throws(()=>inspectReleases({root:alias,now}));
  fs.symlinkSync(f.current,path.join(f.releases,'release-AAAAAA'),process.platform==='win32'?'junction':'dir');
  assert(inspectReleases({root:f.root,now}).warnings.includes('unrecognized-entries-preserved'));
});
test('marcador inválido, grande ou diretório e pacote inválido impedem confirmação da ativa',t=>{
  const f=fixture(t),marker=path.join(f.current,'.deploy-commit');
  for(const data of ['main',Buffer.alloc(8193)]){fs.writeFileSync(marker,data);assert.throws(()=>inspectReleases({root:f.root,now}));}
  fs.unlinkSync(marker);fs.mkdirSync(marker);assert.throws(()=>inspectReleases({root:f.root,now}));fs.rmdirSync(marker);
  fs.writeFileSync(marker,'1'.repeat(40)+'\n');fs.writeFileSync(path.join(f.current,'package.json'),'{broken');assert.throws(()=>inspectReleases({root:f.root,now}));
});
test('limites de entrada/tempo e opções inválidas falham de forma fechada',t=>{
  const f=fixture(t);
  for(const options of [{maxEntries:1},{timeoutMs:0},{keep:0},{minAgeDays:0},{root:'.'},{now:NaN}])assert.throws(()=>inspectReleases({root:f.root,now,...options}));
  assert.deepEqual(parseArguments(['--root',f.root,'--keep','2']),{root:f.root,keep:2});
  for(const args of [[],['--delete'],['--root',f.root,'--root',f.root],['--root',f.root,'--keep','2.5'],['--root']])assert.equal(parseArguments(args),null);
});
test('mudança no recibo durante a medição invalida todas as sugestões',t=>{
  const f=fixture(t),read=fs.readdirSync;let changed=false;
  fs.readdirSync=function(directory,...args){
    if(directory===f.current&&!changed){changed=true;const p=path.join(f.root,'.deployed.json');const s=JSON.parse(fs.readFileSync(p));s.deployedAt=new Date(now+1).toISOString();fs.writeFileSync(p,JSON.stringify(s));}
    return read.call(fs,directory,...args);
  };
  try{const r=inspectReleases({root:f.root,now,keep:1});assert(changed);assert.equal(r.reviewReady,false);assert(r.warnings.includes('snapshot-changed'));assert.deepEqual(r.candidatesForReview,[]);}finally{fs.readdirSync=read;}
});
test('CLI é independente do banco, retorna erro genérico e nunca imprime configuração ou caminho raiz',t=>{
  const f=fixture(t),cli=path.resolve(__dirname,'../scripts/check-releases.js');
  const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{PATH:'',DB_HOST:'private-invalid.test',DB_PASSWORD:'synthetic-never-display'}});
  let r=run(['--root',f.root,'--keep','1']);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).readOnly,true);
  r=run(['--root',f.root,'--delete']);assert.equal(r.status,2);assert.doesNotMatch(r.stdout+r.stderr,/synthetic-never-display|private-invalid|chatcrm-release-inventory-/);
  fs.writeFileSync(path.join(f.root,'.deployed.json'),'{broken private-never-print');r=run(['--root',f.root]);assert.equal(r.status,1);assert.doesNotMatch(r.stdout+r.stderr,/private-never-print|synthetic-never-display|chatcrm-release-inventory-/);
});
