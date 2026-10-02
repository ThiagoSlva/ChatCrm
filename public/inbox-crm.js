'use strict';

// Contexto privado e manual: todas as requisições usam o scheduler do atendimento.
inboxCrm = (() => {
  const elements = suffix => inboxElement('inbox-crm-' + suffix);
  const drafts = new Map();
  let selectedId = null;
  let expanded = false;
  const kinds = { lead: 'Lead', contact: 'Contato', customer: 'Cliente' };
  const uint = value => Number.isSafeInteger(value) && value > 0 && value <= 4294967295;
  const version = value => Number.isSafeInteger(value) && value >= 0 && value <= 4294967295;
  const contactName = link => link.contactId === null ? 'Sem contato vinculado' : link.contactName + ' · ' + kinds[link.contactKind];
  const dateText = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('pt-BR') : 'Sem alteração registrada';
  function state(id = selectedId) {
    if (!drafts.has(id)) drafts.set(id, { link: null, confirmed: false, proposal: null, prepared: false, pending: null, review: false, current: null, q: '', queryDraft: '', page: 1, total: 0, contacts: [], contactsLoaded: false, eventPage: 1, eventTotal: 0, events: [], eventsLoaded: false, feedback: '' });
    return drafts.get(id);
  }
  function live(id, generation) { return generation === inboxGeneration && selectedId === id && inboxSelected?.id === id && !inboxDisposed; }
  function validLink(data) {
    const link = data?.link;
    return link && uint(link.conversationId) && link.conversationId === inboxSelected?.id && uint(link.departmentId) && link.departmentId === inboxSelected?.departmentId && version(link.version) && typeof link.canEdit === 'boolean' &&
      (link.updatedAt === null || typeof link.updatedAt === 'string') &&
      (link.contactId === null ? link.contactName === null && link.contactKind === null : uint(link.contactId) && typeof link.contactName === 'string' && Object.hasOwn(kinds, link.contactKind));
  }
  const validPage = data => data && Number.isSafeInteger(data.total) && data.total >= 0 && uint(data.page) && Number.isSafeInteger(data.limit) && data.limit > 0 && data.limit <= 50;
  function validContacts(data) {
    return validPage(data) && Array.isArray(data.contacts) && data.contacts.length <= data.limit && data.contacts.every(contact => uint(contact.id) && contact.departmentId === inboxSelected?.departmentId && typeof contact.name === 'string' && Object.hasOwn(kinds, contact.kind));
  }
  function validEvents(data) {
    return validPage(data) && Array.isArray(data.events) && data.events.length <= data.limit && data.events.every(event => uint(event.version) && typeof event.actorName === 'string' && typeof event.createdAt === 'string' && (event.contactId === null ? event.contactName === null : uint(event.contactId) && typeof event.contactName === 'string'));
  }
  async function api(url, options, validator) {
    const data = await inboxApi(url, options);
    if (!validator(data)) throw new Error('Não foi possível confirmar os dados recebidos. Consulte o estado atual antes de alterar novamente.');
    return data;
  }
  function editable(st = state()) {
    return expanded && !inboxBusy && inboxMetadataConfirmed && inboxOwnsConversation() && st.confirmed && st.link?.canEdit === true && !st.pending && !st.review;
  }
  function clearVisible() {
    for (const suffix of ['feedback', 'current', 'permission', 'comparison', 'proposal', 'contact-page', 'event-page']) elements(suffix).textContent = '';
    for (const suffix of ['contacts', 'events']) elements(suffix).replaceChildren();
    elements('query').value = ''; elements('confirm').checked = false;
    elements('review').hidden = true; elements('contact-empty').hidden = true; elements('event-empty').hidden = true;
  }
  function controls() {
    const st = selectedId === null ? null : state();
    const canEdit = st && editable(st);
    elements('toggle').disabled = inboxBusy || !inboxSelected;
    elements('toggle').setAttribute('aria-expanded', String(expanded));
    elements('toggle').textContent = expanded ? 'Recolher contexto' : 'Abrir contexto';
    elements('panel').hidden = !expanded;
    elements('panel').setAttribute('aria-busy', String(inboxBusy && expanded));
    elements('reload').disabled = inboxBusy || !inboxSelected;
    for (const suffix of ['query', 'search-submit', 'remove', 'confirm']) elements(suffix).disabled = !canEdit;
    elements('contacts').querySelectorAll('button').forEach(button => { button.disabled = !canEdit; });
    elements('contact-previous').disabled = !canEdit || !st.contactsLoaded || st.page <= 1;
    elements('contact-next').disabled = !canEdit || !st.contactsLoaded || st.page * 20 >= st.total;
    elements('cancel').disabled = !canEdit || !st.prepared;
    elements('save').disabled = !canEdit || !st.prepared || !elements('confirm').checked;
    elements('adopt').disabled = inboxBusy || !inboxMetadataConfirmed || !st?.confirmed || !st?.current;
    elements('history-load').disabled = inboxBusy || !inboxMetadataConfirmed || !st?.confirmed;
    elements('event-previous').disabled = inboxBusy || !inboxMetadataConfirmed || !st?.confirmed || !st?.eventsLoaded || st.eventPage <= 1;
    elements('event-next').disabled = inboxBusy || !inboxMetadataConfirmed || !st?.confirmed || !st?.eventsLoaded || st.eventPage * 20 >= st.eventTotal;
  }
  function renderContacts(st) {
    elements('contacts').replaceChildren();
    if (!st.confirmed) return;
    for (const contact of st.contacts) {
      const li = document.createElement('li'); const button = document.createElement('button');
      button.type = 'button'; button.className = 'conversation-select'; button.id = 'inbox-crm-contact-' + contact.id;
      const name = document.createElement('strong'); name.textContent = contact.name;
      const kind = document.createElement('span'); kind.textContent = kinds[contact.kind] + ' · ' + inboxSelected.departmentName;
      button.append(name, kind); button.setAttribute('aria-pressed', String(st.prepared && st.proposal?.id === contact.id));
      button.addEventListener('click', () => {
        if (!editable(st)) return;
        st.proposal = { id: contact.id, name: contact.name, kind: contact.kind }; st.prepared = true; elements('confirm').checked = false;
        st.feedback = 'Contato preparado. Confira a pessoa ou organização e confirme a alteração abaixo.'; render(); elements('confirm').focus();
      });
      li.append(button); elements('contacts').append(li);
    }
    elements('contact-empty').hidden = !st.contactsLoaded || st.total !== 0;
    elements('contact-page').textContent = st.contactsLoaded ? 'Página ' + st.page + ' de ' + Math.max(1, Math.ceil(st.total / 20)) + ' · ' + st.total + ' ' + (st.total === 1 ? 'contato' : 'contatos') + ' nesta busca' : '';
  }
  function renderEvents(st) {
    elements('events').replaceChildren();
    if (!st.confirmed) return;
    for (const event of st.events) {
      const li = document.createElement('li'); const title = document.createElement('strong'); const time = document.createElement('time');
      title.textContent = 'Versão ' + event.version + ' · ' + (event.contactId === null ? 'Vínculo removido' : 'Vinculado a ' + event.contactName);
      const actor = document.createElement('p'); actor.textContent = 'Por ' + event.actorName;
      time.textContent = dateText(event.createdAt); if (!Number.isNaN(Date.parse(event.createdAt))) time.dateTime = new Date(event.createdAt).toISOString();
      li.append(title, actor, time); elements('events').append(li);
    }
    elements('event-empty').hidden = !st.eventsLoaded || st.eventTotal !== 0;
    elements('event-page').textContent = st.eventsLoaded ? 'Página ' + st.eventPage + ' de ' + Math.max(1, Math.ceil(st.eventTotal / 20)) + ' · ' + st.eventTotal + ' ' + (st.eventTotal === 1 ? 'alteração' : 'alterações') : '';
  }
  function render() {
    if (!expanded || selectedId === null) { controls(); return; }
    const st = state(); const shown = st.current || st.link;
    elements('feedback').textContent = st.feedback;
    elements('current').textContent = st.confirmed && shown ? 'Vínculo consultado: ' + contactName(shown) + ' · versão ' + shown.version + ' · ' + dateText(shown.updatedAt) : 'Vínculo ainda não confirmado. Consulte o estado atual.';
    elements('permission').textContent = !st.confirmed ? 'Alterações pausadas até consultar o vínculo.' : inboxOwnsConversation() && shown?.canEdit ? 'Somente você, responsável por este atendimento aberto, pode alterar o vínculo.' : 'Consulta disponível. Somente o responsável por um atendimento aberto pode alterar o vínculo, inclusive para administradores.';
    elements('proposal').textContent = !st.confirmed ? 'A alteração preparada foi preservada nesta aba, mas ainda precisa ser revalidada.' : st.prepared ? st.proposal ? 'Alteração preparada: vincular a ' + st.proposal.name + ' · ' + kinds[st.proposal.kind] + '.' : 'Alteração preparada: remover o vínculo atual.' : 'Selecione um contato para preparar o vínculo.';
    elements('query').value = st.queryDraft;
    elements('review').hidden = !st.review;
    elements('comparison').textContent = st.current && st.confirmed ? 'Estado atual: ' + contactName(st.current) + ' (versão ' + st.current.version + '). Seu pedido usa a versão ' + (st.pending?.version ?? st.link?.version) + '. Revise o vínculo e a alteração preparada. Adotar a versão atual não salva nem reaplica a alteração.' : 'Seu pedido e sua versão foram preservados. Consulte o estado atual para comparar antes de preparar outra alteração.';
    renderContacts(st); renderEvents(st); controls();
  }
  async function loadCurrent(st = state()) {
    const id = selectedId; const generation = inboxGeneration;
    st.confirmed = false; st.feedback = 'Consultando o vínculo atual…'; render();
    await inboxLoadMetadata();
    if (!live(id, generation)) return;
    const data = await api('/api/crm/conversations/' + id + '/contact', {}, validLink);
    if (!live(id, generation)) return;
    st.confirmed = true;
    if (st.pending || st.review || (st.prepared && st.link && st.link.version !== data.link.version)) {
      st.current = data.link; st.review = true; st.feedback = 'Estado atual consultado. Compare e adote a versão somente após revisar.';
    } else { st.link = data.link; st.current = null; st.feedback = 'Vínculo consultado. Nenhuma alteração foi enviada.'; }
    render();
  }
  async function run(work, focusId = null) {
    if (inboxBusy || !inboxSelected || selectedId !== inboxSelected.id) return;
    const id = selectedId; const generation = inboxGeneration;
    await inboxRun(async () => {
      try { await work(state(id)); }
      catch (error) {
        if (generation !== inboxGeneration || inboxDisposed) return;
        if (error.status === 401) throw error;
        if (!live(id, generation)) {
          if ((error.status === 403 || error.status === 404) && !inboxSelected) inboxElement('inbox-feedback').textContent = 'O atendimento ou sua área ficou inacessível. O contexto e o histórico foram ocultados.';
          return;
        }
        if (error.status === 403 || error.status === 404) {
          // A candidate contact can return404 while the conversation remains accessible.
          // Clear only CRM data, then let authoritative conversation metadata decide.
          drafts.delete(id); clearVisible();
          const clean = state(id); clean.feedback = 'O contato ou contexto ficou indisponível. Revalidando o acesso ao atendimento…'; render();
          try { await inboxLoadMetadata(); }
          catch (metadataError) {
            if (generation !== inboxGeneration || inboxDisposed) return;
            if (metadataError.status === 401) throw metadataError;
            if (!inboxSelected) { inboxElement('inbox-feedback').textContent = 'O atendimento ou sua área ficou inacessível. O contexto e o histórico foram ocultados.'; return; }
            clean.feedback = 'Não foi possível confirmar o acesso ao atendimento. A seleção e a resposta foram preservadas; consulte o estado atual para revalidar. Os dados do contexto foram ocultados.'; render(); return;
          }
          if (!live(id, generation)) return;
          clean.feedback = 'O contato ou contexto está indisponível. O atendimento e sua resposta foram preservados. Consulte o estado atual e busque um contato autorizado nesta área.'; render(); return;
        }
        const st = state(id);
        st.feedback = error.status === 503 ? 'O vínculo com contatos aguarda preparação na hospedagem. O atendimento continua disponível.' :
          error.status === 429 ? 'O limite de histórico de vínculos desta instalação foi atingido. Consulte o administrador.' :
          error.status === 409 ? 'O vínculo ou o responsável mudou. Consulte o estado atual e revise antes de alterar novamente.' :
          error.status === 400 || error.status === 413 ? 'A alteração não foi aceita. Confira o contato e o vínculo antes de tentar novamente.' :
          'Não foi possível confirmar a operação. O pedido preparado foi preservado; consulte o estado atual antes de alterar novamente.';
        render();
      }
    }, false, focusId);
  }

  async function loadContacts(st = state()) {
    if (!st.confirmed || !inboxOwnsConversation() || !st.link?.canEdit || st.pending || st.review) return;
    const id = selectedId; const generation = inboxGeneration;
    st.contacts = []; st.contactsLoaded = false; st.total = 0;
    st.feedback = 'Buscando contatos desta área…'; render();
    const query = new URLSearchParams({ departmentId: String(inboxSelected.departmentId), kind: 'all', q: st.q, page: String(st.page), limit: '20' });
    let data = await api('/api/crm/contacts?' + query.toString(), {}, validContacts);
    if (!live(id, generation)) return;
    const last = Math.max(1, Math.ceil(data.total / 20));
    if (data.page > last) { st.page = last; query.set('page', String(last)); data = await api('/api/crm/contacts?' + query.toString(), {}, validContacts); if (!live(id, generation)) return; }
    st.contacts = data.contacts.map(contact => ({ id: contact.id, departmentId: contact.departmentId, name: contact.name, kind: contact.kind }));
    st.page = data.page; st.total = data.total; st.contactsLoaded = true; st.feedback = 'Busca concluída. Selecione um contato da mesma área e confirme o vínculo.'; render();
  }
  async function loadEvents(st = state()) {
    if (!st.confirmed || !inboxMetadataConfirmed) return;
    const id = selectedId; const generation = inboxGeneration;
    st.events = []; st.eventsLoaded = false; st.eventTotal = 0;
    st.feedback = 'Consultando o histórico de vínculos…'; render();
    const query = new URLSearchParams({ page: String(st.eventPage), limit: '20' });
    let data = await api('/api/crm/conversations/' + id + '/contact/events?' + query.toString(), {}, validEvents);
    if (!live(id, generation)) return;
    const last = Math.max(1, Math.ceil(data.total / 20));
    if (data.page > last) { st.eventPage = last; query.set('page', String(last)); data = await api('/api/crm/conversations/' + id + '/contact/events?' + query.toString(), {}, validEvents); if (!live(id, generation)) return; }
    st.events = data.events.map(event => ({ version: event.version, contactId: event.contactId, contactName: event.contactName, actorName: event.actorName, createdAt: event.createdAt }));
    st.eventPage = data.page; st.eventTotal = data.total; st.eventsLoaded = true; st.feedback = 'Histórico consultado.'; render();
  }
  function clear() { drafts.clear(); selectedId = null; expanded = false; clearVisible(); controls(); }
  function select(id) {
    if (selectedId === id) return;
    selectedId = id; expanded = false; state(id).confirmed = false; clearVisible(); controls();
  }
  function revoke(id) {
    drafts.delete(id);
    if (selectedId === id) { selectedId = null; expanded = false; clearVisible(); controls(); }
  }
  function unconfirmed() { controls(); }
  elements('toggle').addEventListener('click', () => {
    if (inboxBusy || !inboxSelected) return;
    if (selectedId !== inboxSelected.id) select(inboxSelected.id);
    expanded = !expanded; clearVisible(); state().confirmed = false; controls();
    if (expanded) run(loadCurrent, 'inbox-crm-toggle');
  });
  elements('reload').addEventListener('click', () => run(loadCurrent, 'inbox-crm-reload'));
  elements('adopt').addEventListener('click', () => {
    const st = state();
    if (inboxBusy || !inboxMetadataConfirmed || !st.confirmed || !st.current || !expanded) return;
    st.link = st.current; st.current = null; st.pending = null; st.review = false; elements('confirm').checked = false;
    st.feedback = 'Versão atual adotada após sua revisão. Nada foi enviado. Confira a alteração preparada e confirme novamente para salvar.'; render(); elements('confirm').focus();
  });
  elements('search').addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (!editable()) return;
    const q = String(data.get('q') || '').normalize('NFC').trim();
    if (q.length > 100 || /[\u0000-\u001f\u007f]/u.test(q)) { state().feedback = 'Use até 100 caracteres na busca, sem caracteres de controle.'; render(); elements('query').focus(); return; }
    state().q = q; state().queryDraft = q; state().page = 1; run(loadContacts, 'inbox-crm-query');
  });
  elements('query').addEventListener('input', () => { if (selectedId !== null && editable()) state().queryDraft = elements('query').value; });
  for (const [suffix, direction] of [['contact-previous', -1], ['contact-next', 1]]) elements(suffix).addEventListener('click', () => {
    if (elements(suffix).disabled || !editable()) return;
    state().page += direction; run(loadContacts, 'inbox-crm-' + suffix);
  });
  elements('remove').addEventListener('click', () => {
    if (!editable()) return;
    const st = state(); st.proposal = null; st.prepared = true; elements('confirm').checked = false;
    st.feedback = 'Remoção preparada. Confirme abaixo para desvincular o cadastro; mensagens e contato permanecem preservados.'; render(); elements('confirm').focus();
  });
  elements('cancel').addEventListener('click', () => {
    if (!editable() || !state().prepared) return;
    const st = state(); st.proposal = null; st.prepared = false; elements('confirm').checked = false; st.feedback = 'Alteração preparada cancelada. Nenhum vínculo foi modificado.'; render();
  });
  elements('confirm').addEventListener('change', controls);
  elements('form').addEventListener('submit', event => {
    event.preventDefault();
    if (!editable() || !state().prepared || !elements('confirm').checked) return;
    const id = selectedId; const generation = inboxGeneration; const st = state(id);
    const payload = Object.freeze({ version: st.link.version, contactId: st.proposal?.id ?? null });
    st.pending = payload; st.current = null; elements('confirm').checked = false;
    run(async () => {
      st.feedback = 'Confirmando a alteração do vínculo…'; render();
      let data;
      try {
        const expected = payload.version + (st.link.contactId === payload.contactId ? 0 : 1);
        data = await api('/api/crm/conversations/' + id + '/contact', { method: 'PATCH', headers: inboxHeaders(), body: JSON.stringify(payload) }, value => validLink(value) && value.link.contactId === payload.contactId && value.link.version === expected);
      } catch (error) {
        if (live(id, generation)) {
          if (error.status === 400 || error.status === 413) { st.pending = null; st.review = false; }
          else if (error.status !== 401 && error.status !== 403 && error.status !== 404 && error.status !== 503) { st.review = true; st.confirmed = false; }
        }
        throw error;
      }
      if (!live(id, generation)) return;
      st.link = data.link; st.confirmed = true; st.pending = null; st.review = false; st.current = null; st.proposal = null; st.prepared = false;
      st.events = []; st.eventsLoaded = false; st.eventPage = 1; st.eventTotal = 0;
      st.feedback = 'Vínculo confirmado. Mensagens e cadastro do contato foram preservados.'; render();
    }, 'inbox-crm-reload');
  });
  elements('history-load').addEventListener('click', () => { if (elements('history-load').disabled) return; state().eventPage = 1; run(loadEvents, 'inbox-crm-history-load'); });
  for (const [suffix, direction] of [['event-previous', -1], ['event-next', 1]]) elements(suffix).addEventListener('click', () => {
    if (elements(suffix).disabled) return;
    state().eventPage += direction; run(loadEvents, 'inbox-crm-' + suffix);
  });
  window.addEventListener('pagehide', () => {
    if (selectedId !== null) state().confirmed = false;
    clearVisible(); controls();
  });
  window.addEventListener('pageshow', event => { if (event.persisted && expanded) { if (selectedId !== null) state().feedback = 'Contexto preservado nesta aba. Consulte o estado atual para revalidar o vínculo.'; render(); } });
  clearVisible(); controls();
  return { clear, select, revoke, unconfirmed, controls };
})();
