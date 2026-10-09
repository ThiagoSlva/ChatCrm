'use strict';
inboxReplies = (() => {
  const element = suffix => inboxElement('inbox-replies-' + suffix);
  let expanded = false;
  let templates = [], page = 1, total = 0, loadedScope = null;
  const team = () => element('source').value === 'team';
  const scope = () => [inboxProfile?.user.id,inboxSelected?.id,inboxSelected?.departmentId].join(':');
  const available = () => inboxProfile?.capabilities?.replies === true;
  const valid = t => t && Number.isInteger(t.id) && Number.isInteger(t.version) && typeof t.title === 'string' && typeof t.text === 'string' && t.active === true;
  function forgetTeam() { templates = []; total = 0; page = 1; loadedScope = null; }
  function editable() {
    return !inboxBusy && !inboxDisposed && inboxMetadataConfirmed && inboxOwnsConversation() && !inboxDraft().pending;
  }
  function preview() {
    const context = {
      visitorName: inboxSelected?.visitorName, operatorName: inboxProfile?.user.name, departmentName: inboxSelected?.departmentName
    };
    if (team()) {
      const t = templates.find(t => String(t.id) === element('model').value);
      return t ? window.ClQuickReplies.renderText(t.text, context) : null;
    }
    return window.ClQuickReplies.render(element('model').value, context);
  }
  function controls() {
    if (loadedScope && (loadedScope !== scope() || (inboxMetadataConfirmed && !inboxOwnsConversation()) || !available())) {
      forgetTeam(); if (team()) { element('model').replaceChildren(); element('feedback').textContent = ''; }
    }
    const canEdit = editable();
    element('toggle').disabled = !canEdit;
    element('toggle').setAttribute('aria-expanded', String(expanded));
    element('panel').hidden = !expanded;
    element('query').disabled = !canEdit; element('model').disabled = !canEdit;
    element('source').disabled = !canEdit;
    element('load').hidden = !team(); element('load').disabled = !canEdit || !available();
    element('previous').hidden = element('next').hidden = !team();
    element('previous').disabled = !canEdit || page === 1;
    element('next').disabled = !canEdit || page * 20 >= total;
    const text = preview();
    element('preview').textContent = text || 'Selecione um modelo para conferir o texto.';
    element('insert').disabled = !canEdit || !text || (team() && (!available() || loadedScope !== scope()));
  }
  function list() {
    const previous = element('model').value, choices = team() ? templates : window.ClQuickReplies.search(element('query').value);
    element('model').replaceChildren();
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Selecione um modelo'; element('model').append(empty);
    for (const template of choices) {
      const option = document.createElement('option'); option.value = String(template.id); option.textContent = template.title; element('model').append(option);
    }
    element('model').value = choices.some(template => String(template.id) === previous) ? previous : '';
    element('count').textContent = team() && !loadedScope ? (available() ? 'Use Buscar na equipe para consultar os modelos deste atendimento.' : 'O catálogo da equipe aguarda preparação da instalação.') : choices.length ? choices.length + (choices.length === 1 ? ' modelo encontrado.' : ' modelos encontrados.') + (team() ? ' Página '+page+' · '+total+' no total.' : '') : 'Nenhum modelo encontrado. Tente outra busca.';
    controls();
  }
  function clear() {
    forgetTeam(); element('source').value = 'builtin'; expanded = false; element('query').value = ''; element('model').value = ''; element('feedback').textContent = ''; list();
  }
  function load(targetPage = 1) {
    if (!editable() || !team() || !available() || targetPage < 1) return;
    const currentScope = scope(), id = inboxSelected.id, q = element('query').value;
    return inboxRun(async () => {
      try {
        const d = await inboxApi('/api/chat/team/conversations/'+id+'/replies?page='+targetPage+'&limit=20&q='+encodeURIComponent(q));
        if (currentScope !== scope() || !team() || inboxDraft().pending) return;
        if (!Array.isArray(d.templates) || !Number.isInteger(d.total) || d.templates.some(t=>!valid(t))) throw Error('Catálogo não confirmado.');
        templates = d.templates; total = d.total; page = targetPage; loadedScope = currentScope; element('model').value = ''; list();
      } catch (e) { forgetTeam(); list(); throw e; }
    });
  }
  element('toggle').addEventListener('click', () => {
    if (!editable()) return;
    expanded = !expanded; controls();
    if (expanded) element('query').focus();
  });
  element('query').addEventListener('input', () => { if (team()) { forgetTeam(); list(); } else list(); });
  element('source').addEventListener('change', () => { forgetTeam(); element('model').value = ''; element('feedback').textContent = ''; list(); });
  element('load').addEventListener('click', () => load());
  element('previous').addEventListener('click', () => { if (page > 1) load(page-1); });
  element('next').addEventListener('click', () => { if (page*20 < total) load(page+1); });
  element('model').addEventListener('change', () => { element('feedback').textContent = ''; controls(); });
  element('panel').addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault(); expanded = false; controls();
    if (!element('toggle').disabled) element('toggle').focus();
  });
  function insert() {
    const text = window.ClQuickReplies.append(inboxElement('inbox-text').value, preview());
    if (text === null) {
      element('feedback').textContent = 'O modelo ultrapassaria 2.000 caracteres junto com seu rascunho. Edite o rascunho antes de inserir; nenhum texto foi alterado.'; return;
    }
    inboxElement('inbox-text').value = text; inboxDraft().text = text;
    element('feedback').textContent = 'Modelo acrescentado ao rascunho. Revise o texto antes de enviar.';
    expanded = false; controls(); inboxElement('inbox-text').focus();
    inboxElement('inbox-text').setSelectionRange(text.length, text.length);
  }
  element('insert').addEventListener('click', () => {
    if (!editable()) return;
    if (!team()) { insert(); return; }
    if (!available() || loadedScope !== scope()) return;
    const currentScope = scope(), id = inboxSelected.id, selected = templates.find(t=>String(t.id)===element('model').value);
    if (!selected) return;
    return inboxRun(async () => {
      try {
        const d = await inboxApi('/api/chat/team/conversations/'+id+'/replies/'+selected.id);
        if (currentScope !== scope() || !team() || inboxDraft().pending || !inboxOwnsConversation()) return;
        if (!valid(d.template)) throw Error('Modelo não confirmado.');
        if (d.template.version !== selected.version || d.template.text !== selected.text || d.template.title !== selected.title || d.template.departmentId !== selected.departmentId) {
          templates = templates.map(t=>t.id===selected.id?d.template:t); controls();
          element('feedback').textContent = 'O modelo mudou. Confira a nova prévia e clique novamente para acrescentar. Seu rascunho foi preservado.'; return;
        }
        insert();
      } catch (e) { forgetTeam(); list(); throw e; }
    }, false, 'inbox-text');
  });
  list();
  return { controls, clear };
})();
