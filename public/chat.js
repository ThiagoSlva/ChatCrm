'use strict';

const visitorElement = id => document.getElementById(id);
let visitorIdentity = null;
let visitorCsrf = null;
let visitorDepartments = [];
let visitorConversations = [];
let visitorSelected = null;
let visitorBusy = false;
let visitorGeneration = 0;
let visitorTimer = null;
let visitorRequestController = null;
let visitorPolling = false;
let visitorDisposed = false;
let visitorSuspended = false;
const visitorHistories = new Map();
const visitorDrafts = new Map();
let visitorMessageNodes = new Map();
const visitorStates = { waiting: 'Na fila · aguarde uma resposta da equipe.', open: 'Em atendimento.', closed: 'Atendimento encerrado. Seu histórico permanece disponível.' };

function visitorError(status) {
  if (status === 413) return 'A mensagem ficou maior que o limite desta instalação. Edite o texto e tente novamente.';
  return ({ 400: 'Confira os dados. Use até 2.000 caracteres na mensagem, sem caracteres de controle além de quebra de linha e tabulação.', 401: 'Sua sessão expirou. Permita cookies neste site e apresente-se novamente.', 403: 'Não foi possível autorizar esta ação. Verifique seu acesso.', 404: 'Esta área ou atendimento está indisponível. O texto foi preservado; tente novamente mais tarde.', 409: 'O atendimento foi encerrado ou já existe outra conversa aberta. Confira seus atendimentos.', 429: 'O limite de solicitações foi atingido. Aguarde antes de tentar novamente.', 503: 'O atendimento ainda precisa ser preparado pela empresa.' })[status] || 'Não foi possível confirmar a operação. O texto foi preservado. Tente novamente.';
}
async function visitorApi(url, options = {}) {
  const generation = visitorGeneration; const controller = visitorRequestController;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal });
  const data = await response.json().catch(() => ({}));
  if (generation !== visitorGeneration || controller !== visitorRequestController || controller.signal.aborted || visitorDisposed) { const error = new Error('Request superseded.'); error.name = 'AbortError'; throw error; }
  if (!response.ok) { const error = new Error(visitorError(response.status)); error.status = response.status; throw error; }
  return data;
}
const visitorHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': visitorCsrf });
function visitorDraft(id = visitorSelected?.id) {
  if (!visitorDrafts.has(id)) visitorDrafts.set(id, { text: '', pending: null });
  return visitorDrafts.get(id);
}
function visitorHistory(id) {
  if (!visitorHistories.has(id)) visitorHistories.set(id, { cursor: 0, messages: new Map() });
  return visitorHistories.get(id);
}
function visitorSetControls() {
  for (const id of ['visitor-start', 'visitor-department-form']) visitorElement(id).querySelectorAll('input, select, button').forEach(element => { element.disabled = visitorBusy; });
  for (const id of ['visitor-logout', 'visitor-retry']) visitorElement(id).disabled = visitorBusy;
  visitorElement('visitor-conversation-list').querySelectorAll('button').forEach(button => { button.disabled = visitorBusy; });
  visitorElement('visitor-department').disabled = visitorBusy || visitorDepartments.length === 0;
  visitorElement('visitor-open').disabled = visitorBusy || visitorDepartments.length === 0 || visitorConversations.some(conversation => conversation.status !== 'closed');
  const closed = !visitorSelected || visitorSelected.status === 'closed';
  const draft = visitorSelected && visitorDraft();
  visitorElement('visitor-text').readOnly = closed || Boolean(draft?.pending);
  visitorElement('visitor-send').disabled = visitorBusy || (closed && !draft?.pending);
  visitorElement('visitor-send').textContent = draft?.pending ? 'Reenviar mesma mensagem' : 'Enviar mensagem';
  visitorElement('visitor-space').setAttribute('aria-busy', String(visitorBusy));
}
function visitorClearIdentityData() {
  visitorIdentity = null; visitorCsrf = null; visitorSelected = null; visitorConversations = [];
  visitorHistories.clear(); visitorDrafts.clear(); visitorMessageNodes.clear();
  visitorElement('visitor-conversation-list').replaceChildren(); visitorElement('visitor-messages').replaceChildren();
  visitorElement('visitor-text').value = ''; visitorElement('visitor-identity').textContent = '';
  visitorElement('visitor-conversation-title').textContent = ''; visitorElement('visitor-conversation-state').textContent = ''; visitorElement('visitor-message-feedback').textContent = '';
  visitorElement('visitor-space').hidden = true; visitorElement('visitor-conversation').hidden = true;
}
function visitorForget() {
  visitorGeneration++; visitorSuspended = false;
  visitorClearIdentityData();
  visitorBusy = false; clearTimeout(visitorTimer); visitorRequestController?.abort();
  visitorSetControls();
}
function visitorSchedule(delay = 3000) {
  clearTimeout(visitorTimer);
  if (!visitorIdentity || visitorSuspended || document.hidden || visitorDisposed || visitorBusy) return;
  visitorTimer = setTimeout(() => visitorRun(async () => { await visitorLoadConversations(); if (!document.hidden && visitorSelected) await visitorLoadMessages(); }, true), delay);
}
async function visitorRun(work, automatic = false, focusId = null) {
  if (visitorBusy || visitorDisposed || (automatic && document.hidden)) return;
  clearTimeout(visitorTimer);
  const generation = visitorGeneration;
  const focusedId = document.activeElement?.id;
  visitorBusy = true; visitorPolling = automatic; visitorRequestController = new AbortController(); visitorSetControls();
  try { await work(); }
  catch (error) {
    if (generation !== visitorGeneration || visitorDisposed || (automatic && error.name === 'AbortError')) return;
    if (error.status === 401) {
      visitorForget(); visitorElement('visitor-start').hidden = false;
      visitorElement('visitor-feedback').textContent = error.message; visitorElement('visitor-name').focus();
    } else if (error.status === 503) visitorShowUnavailable(error.message);
    else if (visitorElement('visitor-space').hidden && visitorElement('visitor-start').hidden) {
      visitorShowUnavailable(error.status ? error.message : 'Não foi possível conectar ao atendimento. Use Verificar novamente para tentar outra vez.');
    }
    else {
      if (visitorElement('visitor-feedback').textContent === 'Verificando o atendimento…') visitorElement('visitor-feedback').textContent = '';
      const feedback = visitorSelected ? 'visitor-message-feedback' : 'visitor-feedback';
      visitorElement(feedback).textContent = error.status ? error.message : 'A conexão falhou. O texto foi preservado; reenviar a mesma mensagem evita duplicação.';
    }
  } finally {
    if (generation === visitorGeneration) {
      visitorBusy = false; visitorPolling = false; visitorSetControls();
      if (!automatic && (focusId || focusedId)) { const target = visitorElement(focusId || focusedId); if (target && !target.disabled && !target.closest('[hidden]')) target.focus(); }
      visitorSchedule();
    }
  }
}
function visitorShowUnavailable(message) {
  visitorSuspended = true;
  visitorElement('visitor-feedback').textContent = '';
  visitorElement('visitor-start').hidden = true;
  visitorElement('visitor-space').hidden = true;
  visitorElement('visitor-unavailable').hidden = false;
  visitorElement('visitor-unavailable-description').textContent = message;
}
async function visitorLoadDepartments() {
  const generation = visitorGeneration;
  const data = await visitorApi('/api/chat/public/departments');
  if (generation !== visitorGeneration) return;
  visitorDepartments = data.departments;
  const previous = visitorElement('visitor-department').value;
  visitorElement('visitor-department').replaceChildren();
  for (const department of visitorDepartments) { const option = document.createElement('option'); option.value = String(department.id); option.textContent = department.name; visitorElement('visitor-department').append(option); }
  if (visitorDepartments.some(department => String(department.id) === previous)) visitorElement('visitor-department').value = previous;
  visitorElement('visitor-departments-empty').hidden = visitorDepartments.length !== 0;
}
function visitorShowIdentity(profile) {
  visitorSuspended = false;
  visitorIdentity = profile.visitor; visitorCsrf = profile.csrfToken;
  visitorElement('visitor-start').hidden = true; visitorElement('visitor-unavailable').hidden = true; visitorElement('visitor-space').hidden = false;
  visitorElement('visitor-identity').textContent = visitorIdentity.name;
}
async function visitorInitialize({ preserve = Boolean(visitorIdentity) } = {}) {
  if (visitorBusy) return;
  const previousId = preserve ? visitorIdentity?.id : null;
  const previousConversationId = preserve ? visitorSelected?.id : null;
  if (preserve) { visitorGeneration++; clearTimeout(visitorTimer); visitorRequestController?.abort(); }
  else visitorForget();
  visitorElement('visitor-space').hidden = true; visitorElement('visitor-start').hidden = true; visitorElement('visitor-unavailable').hidden = true; visitorElement('visitor-feedback').textContent = 'Verificando o atendimento…';
  await visitorRun(async () => {
    await visitorLoadDepartments();
    try {
      const profile = await visitorApi('/api/chat/visitor/me');
      if (previousId !== profile.visitor.id) visitorClearIdentityData();
      visitorShowIdentity(profile);
      await visitorLoadConversations();
      if (visitorConversations.length) await visitorSelect(visitorConversations.find(conversation => conversation.id === previousConversationId) || visitorConversations.find(conversation => conversation.status !== 'closed') || visitorConversations[0]);
      visitorElement('visitor-feedback').textContent = 'Seu histórico neste navegador foi recuperado.';
    } catch (error) {
      if (error.status !== 401) throw error;
      visitorClearIdentityData(); visitorSuspended = false;
      if (visitorDepartments.length) { visitorElement('visitor-start').hidden = false; visitorElement('visitor-feedback').textContent = ''; }
      else visitorShowUnavailable('Nenhuma área está recebendo novos atendimentos no momento. Tente novamente mais tarde.');
    }
  });
}
async function visitorLoadConversations() {
  const generation = visitorGeneration;
  const data = await visitorApi('/api/chat/visitor/conversations');
  if (generation !== visitorGeneration) return;
  visitorConversations = data.conversations;
  visitorElement('visitor-conversation-list').replaceChildren(); visitorElement('visitor-conversations-empty').hidden = visitorConversations.length !== 0;
  for (const conversation of visitorConversations) {
    const item = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button'; button.id = `visitor-conversation-${conversation.id}`; button.className = 'conversation-select';
    const name = document.createElement('strong'); name.textContent = conversation.departmentName;
    const state = document.createElement('span'); state.textContent = visitorStates[conversation.status];
    button.append(name, state); button.setAttribute('aria-pressed', String(conversation.id === visitorSelected?.id));
    button.addEventListener('click', () => visitorRun(async () => { await visitorSelect(conversation); }, false, 'visitor-conversation-title'));
    item.append(button); visitorElement('visitor-conversation-list').append(item);
  }
  if (visitorSelected) {
    const current = visitorConversations.find(conversation => conversation.id === visitorSelected.id);
    if (current) { visitorSelected = current; visitorRenderConversation(); }
    else { visitorSelected = null; visitorElement('visitor-conversation').hidden = true; visitorElement('visitor-messages').replaceChildren(); }
  }
  visitorSetControls();
}
async function visitorSelect(conversation) {
  if (visitorSelected) visitorDraft().text = visitorElement('visitor-text').value;
  visitorSelected = conversation; visitorMessageNodes = new Map(); visitorElement('visitor-messages').replaceChildren();
  visitorElement('visitor-text').value = visitorDraft().text;
  visitorElement('visitor-message-feedback').textContent = visitorDraft().pending ? 'Há uma mensagem aguardando confirmação. Reenvie o mesmo texto para confirmar sem duplicar.' : '';
  visitorElement('visitor-messages').setAttribute('aria-live', 'off'); visitorRenderConversation(); visitorRenderMessages(true);
  try { await visitorLoadMessages(); } finally { visitorElement('visitor-messages').setAttribute('aria-live', 'polite'); }
}
function visitorRenderConversation() {
  if (!visitorSelected) return;
  visitorElement('visitor-conversation').hidden = false;
  visitorElement('visitor-conversation-title').textContent = visitorSelected.departmentName;
  visitorElement('visitor-conversation-state').textContent = visitorStates[visitorSelected.status];
  visitorSetControls();
}
async function visitorLoadMessages() {
  const generation = visitorGeneration; const id = visitorSelected.id; const history = visitorHistory(id);
  // A conversation is bounded at 500 messages: no unbounded catch-up loop.
  for (let page = 0; page < 10; page++) {
    const data = await visitorApi(`/api/chat/visitor/conversations/${id}/messages?after=${history.cursor}&limit=50`);
    if (generation !== visitorGeneration || visitorSelected?.id !== id) return;
    for (const message of data.messages) history.messages.set(message.sequence, message);
    const previous = history.cursor; history.cursor = Math.max(history.cursor, data.cursor); visitorRenderMessages();
    if (!data.hasMore || history.cursor <= previous || (visitorPolling && document.hidden)) break;
  }
}
function visitorRenderMessages(forceScroll = false) {
  if (!visitorSelected) return;
  const log = visitorElement('visitor-messages'); const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const ordered = [...visitorHistory(visitorSelected.id).messages.values()].sort((a, b) => a.sequence - b.sequence);
  ordered.forEach((message, index) => {
    let item = visitorMessageNodes.get(message.sequence);
    if (!item) {
      item = document.createElement('div'); item.className = `chat-message ${message.sender === 'visitor' ? 'message-own' : 'message-other'}`;
      const author = document.createElement('strong'); author.textContent = message.sender === 'visitor' ? 'Você' : 'Equipe';
      const text = document.createElement('p'); text.textContent = message.text;
      const time = document.createElement('time'); const date = new Date(message.createdAt); time.textContent = Number.isNaN(date.getTime()) ? 'Horário indisponível' : date.toLocaleString('pt-BR');
      if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
      item.append(author, text, time); visitorMessageNodes.set(message.sequence, item);
    }
    if (log.children[index] !== item) log.insertBefore(item, log.children[index] || null);
  });
  if (forceScroll || nearEnd) log.scrollTop = log.scrollHeight;
}
visitorElement('visitor-start').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form));
  visitorRun(async () => {
    let profile;
    try { profile = await visitorApi('/api/chat/visitor/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (error) {
      if (error.status !== 409) throw error;
      // The server may have committed a session/cookie before its first response was lost.
      profile = await visitorApi('/api/chat/visitor/me');
    }
    visitorShowIdentity(profile); form.reset(); await visitorLoadConversations(); visitorElement('visitor-feedback').textContent = 'Escolha uma área para iniciar seu atendimento.'; visitorElement('visitor-department').focus();
  }, false, 'visitor-department');
});
visitorElement('visitor-department-form').addEventListener('submit', event => {
  event.preventDefault(); const data = new FormData(event.currentTarget); const departmentId = Number(data.get('departmentId'));
  visitorRun(async () => {
    const result = await visitorApi('/api/chat/visitor/conversations', { method: 'POST', headers: visitorHeaders(), body: JSON.stringify({ departmentId }) });
    await visitorLoadConversations(); await visitorSelect(result.conversation); visitorElement('visitor-feedback').textContent = 'Atendimento iniciado. Envie sua mensagem abaixo.'; visitorElement('visitor-text').focus();
  }, false, 'visitor-text');
});
visitorElement('visitor-compose').addEventListener('submit', event => {
  event.preventDefault(); if (!visitorSelected || visitorBusy || (visitorSelected.status === 'closed' && !visitorDraft().pending)) return;
  const id = visitorSelected.id; const data = new FormData(event.currentTarget); const draft = visitorDraft(id); const text = String(data.get('text') || '').trim();
  if (!draft.pending && !text) { visitorElement('visitor-message-feedback').textContent = 'Escreva uma mensagem antes de enviar.'; return; }
  if (!draft.pending) { const bytes = crypto.getRandomValues(new Uint8Array(16)); draft.pending = { text, clientKey: [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('') }; draft.text = text; visitorElement('visitor-text').value = text; }
  const payload = { ...draft.pending };
  visitorRun(async () => {
    visitorElement('visitor-message-feedback').textContent = 'Confirmando envio…';
    let result;
    try { result = await visitorApi(`/api/chat/visitor/conversations/${id}/messages`, { method: 'POST', headers: visitorHeaders(), body: JSON.stringify(payload) }); }
    catch (error) { if (error.status === 400 || error.status === 413) draft.pending = null; throw error; }
    visitorHistory(id).messages.set(result.message.sequence, result.message); draft.pending = null; draft.text = ''; visitorElement('visitor-text').value = '';
    visitorRenderMessages(); visitorElement('visitor-message-feedback').textContent = 'Mensagem enviada.';
    await visitorLoadConversations(); if (visitorSelected?.id === id) await visitorLoadMessages();
  });
});
visitorElement('visitor-text').addEventListener('input', () => { if (visitorSelected && !visitorDraft().pending) visitorDraft().text = visitorElement('visitor-text').value; });
visitorElement('visitor-logout').addEventListener('click', () => visitorRun(async () => {
  await visitorApi('/api/chat/visitor/logout', { method: 'POST', headers: visitorHeaders(), body: '{}' });
  visitorForget(); visitorElement('visitor-start').hidden = false; visitorElement('visitor-feedback').textContent = 'Sessão encerrada. Para começar outra, apresente-se novamente.'; visitorElement('visitor-name').focus(); visitorSetControls();
}));
visitorElement('visitor-departments-reload').addEventListener('click', () => visitorRun(async () => { await visitorLoadDepartments(); visitorElement('visitor-feedback').textContent = 'Áreas atualizadas.'; }));
visitorElement('visitor-retry').addEventListener('click', visitorInitialize);
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(visitorTimer); if (visitorPolling) visitorRequestController?.abort(); } else visitorSchedule(0); });
window.addEventListener('pagehide', () => { visitorDisposed = true; visitorGeneration++; clearTimeout(visitorTimer); visitorRequestController?.abort(); visitorBusy = false; });
window.addEventListener('pageshow', event => { if (event.persisted) { visitorDisposed = false; visitorInitialize({ preserve: true }); } });
visitorInitialize();
