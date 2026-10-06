'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function fixture() {
  const elements = new Map(); let calls = 0;
  const document = { hidden: false, activeElement: null, addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', children: [], handlers: {}, attributes: {}, disabled: false, hidden: false,
        addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; },
        querySelectorAll() { return []; }, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
        focus() { document.activeElement = this; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } });
      return elements.get(id);
    }, createElement() { return { value: '', textContent: '' }; }
  };
  const context = vm.createContext({ window: { addEventListener() {} }, document, Map, AbortController, AbortSignal,
    setTimeout() {}, clearTimeout() {}, fetch() { calls++; throw Error('No network expected'); } });
  vm.runInContext(fs.readFileSync('public/quick-replies.js','utf8'), context);
  vm.runInContext(fs.readFileSync('public/inbox.js','utf8').replace(/inboxInitialize\(\);\s*$/, ''), context);
  const run = code => vm.runInContext(code, context);
  run('inboxProfile={user:{id:2,name:"Equipe fictícia"}};inboxSelected={id:101,status:"open",assignedTo:2,visitorName:"Pessoa fictícia",departmentName:"Suporte"};inboxMetadataConfirmed=true;');
  vm.runInContext(fs.readFileSync('public/inbox-replies.js','utf8'), context);
  return { run, element: id => document.getElementById(id), document, calls: () => calls };
}
test('biblioteca é original, limitada e busca sem depender de acentos; variáveis são texto literal', () => {
  const f=fixture(); assert.equal(f.run('window.ClQuickReplies.search().length'),6);
  assert.equal(f.run('window.ClQuickReplies.search("SOLUCAO")[0].id'),'resolved');
  assert.equal(f.run('window.ClQuickReplies.search("inexistente").length'),0);
  assert.equal(f.run('window.ClQuickReplies.render("unknown")'),null);
  const text=f.run('window.ClQuickReplies.render("welcome",{visitorName:"<img onerror=attack()> {{operador}}",operatorName:"Equipe\\n\\u202e teste",departmentName:"S".repeat(1000)})');
  assert.match(text,/<img onerror=attack\(\)> \{\{operador\}\}/);assert.doesNotMatch(text,/[\u202e\n]/);
  assert(text.length<400);assert.equal(f.calls(),0);
});
test('modelo acrescenta sem substituir rascunho, move foco e não envia requisições', () => {
  const f=fixture();f.element('inbox-text').value='Rascunho já escrito';
  f.element('inbox-replies-toggle').handlers.click();assert.equal(f.element('inbox-replies-panel').hidden,false);
  f.element('inbox-replies-model').value='welcome';f.element('inbox-replies-model').handlers.change();
  const reply=f.element('inbox-replies-preview').textContent;f.element('inbox-replies-insert').handlers.click();
  assert.equal(f.element('inbox-text').value,'Rascunho já escrito\n\n'+reply);
  assert.equal(f.run('inboxDraft().text'),f.element('inbox-text').value);assert.equal(f.run('inboxDraft().pending'),null);
  assert.equal(f.document.activeElement.id,'inbox-text');assert.equal(f.element('inbox-replies-panel').hidden,true);assert.equal(f.calls(),0);
});
test('rascunho acima do limite é preservado, sem corte silencioso ou mudança da chave pendente', () => {
  const f=fixture();f.element('inbox-text').value='X'.repeat(1999);f.element('inbox-replies-model').value='details';
  f.element('inbox-replies-insert').handlers.click();assert.equal(f.element('inbox-text').value,'X'.repeat(1999));
  assert.match(f.element('inbox-replies-feedback').textContent,/nenhum texto foi alterado/);
  f.run('inboxDraft().pending={text:"Texto não confirmado",clientKey:"a".repeat(32)};inboxReplies.controls();');
  const before=f.run('JSON.stringify(inboxDraft().pending)');f.element('inbox-replies-insert').handlers.click();
  assert.equal(f.run('JSON.stringify(inboxDraft().pending)'),before);assert.equal(f.element('inbox-replies-toggle').disabled,true);
  assert.equal(f.calls(),0);
});
test('permissão, metadados, envio em curso e página encerrada bloqueiam inserção mesmo com evento forjado', () => {
  for(const state of ['inboxMetadataConfirmed=false','inboxSelected.assignedTo=3','inboxSelected.status="closed"','inboxBusy=true','inboxDisposed=true']) {
    const f=fixture();f.element('inbox-text').value='Preservar';f.element('inbox-replies-model').value='thanks';
    f.run(state+';inboxReplies.controls();');assert.equal(f.element('inbox-replies-insert').disabled,true);
    f.element('inbox-replies-insert').handlers.click();assert.equal(f.element('inbox-text').value,'Preservar');assert.equal(f.calls(),0);
  }
});
test('busca vazia e Escape são acessíveis; limpar identidade remove prévia e pesquisa', () => {
  const f=fixture();f.element('inbox-replies-toggle').handlers.click();
  f.element('inbox-replies-query').value='nada-encontrado';f.element('inbox-replies-query').handlers.input();
  assert.match(f.element('inbox-replies-count').textContent,/Nenhum modelo/);assert.equal(f.element('inbox-replies-insert').disabled,true);
  let prevented=false;f.element('inbox-replies-panel').handlers.keydown({key:'Escape',preventDefault(){prevented=true;}});
  assert(prevented);assert.equal(f.document.activeElement.id,'inbox-replies-toggle');assert.equal(f.element('inbox-replies-toggle').attributes['aria-expanded'],'false');
  f.element('inbox-replies-model').value='welcome';f.element('inbox-replies-model').handlers.change();f.run('inboxReplies.clear();');
  assert.equal(f.element('inbox-replies-query').value,'');assert.equal(f.element('inbox-replies-model').value,'');assert.doesNotMatch(f.element('inbox-replies-preview').textContent,/Pessoa fictícia/);
});
test('atualizar metadados conserva busca/modelo e rascunho, mas prévia usa nomes atuais', () => {
  const f=fixture();f.element('inbox-text').value='Texto preservado';f.element('inbox-replies-query').value='boas';f.element('inbox-replies-query').handlers.input();
  f.element('inbox-replies-model').value='welcome';f.run('inboxBusy=true;inboxReplies.controls();inboxBusy=false;inboxSelected.visitorName="Nome atualizado";inboxReplies.controls();');
  assert.equal(f.element('inbox-replies-query').value,'boas');assert.equal(f.element('inbox-replies-model').value,'welcome');
  assert.match(f.element('inbox-replies-preview').textContent,/Nome atualizado/);assert.equal(f.element('inbox-text').value,'Texto preservado');assert.equal(f.calls(),0);
});
test('biblioteca fica fora do formulário de envio e scripts são externos, sem armazenamento local', () => {
  const html=fs.readFileSync('public/inbox.html','utf8');
  assert(html.indexOf('id="inbox-replies-query"')<html.indexOf('<form id="inbox-compose"'));
  for(const name of ['quick-replies','inbox-replies']) {
    assert(html.includes(`<script src="/${name}.js" defer></script>`));
    assert.doesNotMatch(fs.readFileSync('public/'+name+'.js','utf8'),/localStorage|sessionStorage|innerHTML|fetch\(/);
  }
});
