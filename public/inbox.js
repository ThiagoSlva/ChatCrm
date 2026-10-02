'use strict';

const inboxElement = id => document.getElementById(id);
let inboxProfile = null;
let inboxCsrf = null;
let inboxSelected = null;
let inboxBusy = false;
let inboxGeneration = 0;
let inboxPage = 1;
let inboxTotal = 0;
let inboxTimer = null;
let inboxController = null;
let inboxPolling = false;
let inboxDisposed = false;
let inboxSuspended = false;
let inboxQueueAttemptAt = 0;
let inboxMessagesAttemptAt = 0;
const inboxHistories = new Map();
const inboxDrafts = new Map();
let inboxMessageNodes = new Map();

function inboxError(status) {
  if (status === 413) return 'A resposta ficou maior que o limite desta instalação. Edite o texto e tente novamente.';
  return ({ 400: 'Confira a resposta. Use até 2.000 caracteres, sem caracteres de controle além de quebra de linha e tabulação.', 401: 'Sua sessão encerrou. Entre novamente no acesso da equipe.', 403: 'Esta ação não está autorizada para sua conta.', 404: 'A área ou o atendimento está inacessível. Confira seus vínculos com o administrador.', 409: 'O atendimento foi encerrado ou o responsável mudou. Atualize a fila e confira seu estado.', 429: 'O limite de solicitações foi atingido. Aguarde antes de tentar novamente.', 503: 'O atendimento aguarda preparação na hospedagem.' })[status] || 'Não foi possível confirmar a operação. Tente novamente.';
}
async function inboxApi(url, options = {}) {
  const generation = inboxGeneration; const controller = inboxController;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal });
  const data = await response.json().catch(() => ({}));
  if (generation !== inboxGeneration || controller !== inboxController || controller.signal.aborted || inboxDisposed) { const error = new Error('Request superseded.'); error.name = 'AbortError'; throw error; }
  if (!response.ok) { const error = new Error(inboxError(response.status)); error.status = response.status; throw error; }
  return data;
}
const inboxHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': inboxCsrf });
function inboxDraft(id = inboxSelected?.id) {
  if (!inboxDrafts.has(id)) inboxDrafts.set(id, { text: '', pending: null });
  return inboxDrafts.get(id);
}
function inboxHistory(id) {
  if (!inboxHistories.has(id)) inboxHistories.set(id, { cursor: 0, messages: new Map() });
  return inboxHistories.get(id);
}
function inboxOwnsConversation() { return inboxSelected?.status === 'open' && inboxSelected.assignedTo === inboxProfile?.user.id; }
function inboxSetControls() {
  for (const id of ['inbox-logout', 'inbox-login-retry', 'inbox-pending-retry', 'inbox-reload']) inboxElement(id).disabled = inboxBusy;
  inboxElement('inbox-conversation-list').querySelectorAll('button').forEach(button => { button.disabled = inboxBusy; });
  inboxElement('inbox-previous').disabled = inboxBusy || inboxPage === 1;
  inboxElement('inbox-next').disabled = inboxBusy || inboxPage * 20 >= inboxTotal;
  const open = inboxSelected?.status === 'open';
  const owner = inboxOwnsConversation();
  const admin = inboxProfile?.user.role === 'admin';
  const pending = inboxSelected && inboxDraft().pending;
  inboxElement('inbox-claim').disabled = inboxBusy || !inboxSelected || inboxSelected.status === 'closed' || (open && !owner);
  inboxElement('inbox-claim').textContent = owner ? 'Atendimento assumido por você' : 'Assumir atendimento';
  inboxElement('inbox-release').disabled = inboxBusy || !open || (!owner && !admin);
  inboxElement('inbox-close').disabled = inboxBusy || !inboxSelected || inboxSelected.status === 'closed' || (!owner && !admin);
  inboxElement('inbox-text').readOnly = !owner || Boolean(pending);
  inboxElement('inbox-send').disabled = inboxBusy || (!owner && !pending);
  inboxElement('inbox-send').textContent = pending ? 'Reenviar mesma resposta' : 'Enviar resposta';
  inboxElement('inbox-space').setAttribute('aria-busy', String(inboxBusy));
}
function inboxClearIdentityData() {
  inboxProfile = null; inboxCsrf = null; inboxSelected = null; inboxPage = 1; inboxTotal = 0;
  inboxQueueAttemptAt = 0; inboxMessagesAttemptAt = 0;
  inboxHistories.clear(); inboxDrafts.clear(); inboxMessageNodes.clear();
  inboxElement('inbox-conversation-list').replaceChildren(); inboxElement('inbox-messages').replaceChildren(); inboxElement('inbox-text').value = ''; inboxElement('inbox-identity').textContent = '';
  inboxElement('inbox-conversation-title').textContent = ''; inboxElement('inbox-conversation-detail').textContent = ''; inboxElement('inbox-conversation-state').textContent = ''; inboxElement('inbox-message-feedback').textContent = '';
  inboxElement('inbox-space').hidden = true; inboxElement('inbox-conversation').hidden = true; inboxElement('inbox-placeholder').hidden = false;
}
function inboxForget() {
  inboxGeneration++; inboxSuspended = false; inboxClearIdentityData();
  clearTimeout(inboxTimer); inboxController?.abort(); inboxBusy = false; inboxSetControls();
}
function inboxSchedule(delay) {
  clearTimeout(inboxTimer);
  if (!inboxProfile || inboxSuspended || document.hidden || inboxDisposed || inboxBusy) return;
  const now = Date.now();
  const next = Math.max(100, Math.min(inboxQueueAttemptAt + 5000 - now, inboxSelected ? inboxMessagesAttemptAt + 3000 - now : Infinity));
  inboxTimer = setTimeout(() => inboxRun(async () => {
    if (Date.now() - inboxQueueAttemptAt >= 5000) await inboxLoadQueue();
    if (!document.hidden && inboxSelected && Date.now() - inboxMessagesAttemptAt >= 3000) await inboxLoadMessages();
  }, true), delay === undefined ? next : delay);
}
function inboxShowPending(message, connectionFailure = false) {
  inboxSuspended = true;
  inboxElement('inbox-space').hidden = true; inboxElement('inbox-pending').hidden = false;
  inboxElement('inbox-feedback').textContent = '';
  inboxElement('inbox-description').textContent = connectionFailure ? 'Não foi possível verificar seu acesso. Tente novamente abaixo.' : 'O atendimento ainda precisa ser preparado na hospedagem.';
  const panel = inboxElement('inbox-pending');
  panel.querySelector('h2').textContent = connectionFailure ? 'Vamos conferir a conexão' : 'Prepare o atendimento';
  panel.querySelector('p').textContent = message;
}
async function inboxRun(work, automatic = false, focusId = null) {
  if (inboxBusy || inboxDisposed || (automatic && document.hidden)) return;
  clearTimeout(inboxTimer); const generation = inboxGeneration; const focusedId = document.activeElement?.id;
  inboxBusy = true; inboxPolling = automatic; inboxController = new AbortController(); inboxSetControls();
  try { await work(); }
  catch (error) {
    if (generation !== inboxGeneration || inboxDisposed || (automatic && error.name === 'AbortError')) return;
    if (error.status === 401) {
      inboxForget(); inboxElement('inbox-login').hidden = false; inboxElement('inbox-feedback').textContent = error.message;
      inboxElement('inbox-description').textContent = 'Entre com sua conta da equipe para acessar o atendimento.';
    } else if (error.status === 503) {
      inboxShowPending(error.message);
    } else if (inboxElement('inbox-space').hidden) {
      inboxShowPending(error.status ? error.message : 'A conexão falhou. Use Verificar novamente para tentar outra vez.', true);
    } else {
      if (inboxElement('inbox-feedback').textContent === 'Verificando seu acesso…') inboxElement('inbox-feedback').textContent = '';
      const feedback = inboxSelected ? 'inbox-message-feedback' : 'inbox-feedback';
      inboxElement(feedback).textContent = error.status ? error.message : 'A conexão falhou. A resposta foi preservada; reenviar o mesmo texto evita duplicação.';
    }
  } finally {
    if (generation === inboxGeneration) {
      inboxBusy = false; inboxPolling = false; inboxSetControls();
      if (!automatic && (focusId || focusedId)) { const target = inboxElement(focusId || focusedId); if (target && !target.disabled && !target.closest('[hidden]')) target.focus(); }
      inboxSchedule();
    }
  }
}
async function inboxInitialize({ preserve = Boolean(inboxProfile) } = {}) {
  if (inboxBusy) return;
  const previousId = preserve ? inboxProfile?.user.id : null;
  if (preserve) { inboxGeneration++; clearTimeout(inboxTimer); inboxController?.abort(); }
  else inboxForget();
  inboxElement('inbox-space').hidden = true; inboxElement('inbox-login').hidden = true; inboxElement('inbox-pending').hidden = true; inboxElement('inbox-feedback').textContent = 'Verificando seu acesso…';
  await inboxRun(async () => {
    const profile = await inboxApi('/api/auth/me');
    if (previousId !== profile.user.id) inboxClearIdentityData();
    inboxProfile = profile; inboxCsrf = profile.csrfToken;
    if (profile.capabilities?.chat !== true) { inboxShowPending('O chat ainda precisa ser preparado na hospedagem. A gestão da equipe e dos departamentos continua disponível.'); return; }
    inboxSuspended = false;
    inboxElement('inbox-space').hidden = false; inboxElement('inbox-identity').textContent = `${profile.user.name} · ${profile.company}`;
    inboxElement('inbox-description').textContent = profile.user.role === 'admin' ? 'Gerencie os atendimentos das áreas ativas. Habilite a entrada pública por departamento no acesso da equipe.' : 'Assuma e responda aos atendimentos das áreas às quais você está vinculado.';
    const selectionRetained = await inboxLoadQueue(); if (inboxSelected) await inboxLoadMessages();
    if (selectionRetained) inboxElement('inbox-feedback').textContent = '';
  });
}
async function inboxLoadQueue() {
  inboxQueueAttemptAt = Date.now();
  const generation = inboxGeneration;
  let data = await inboxApi(`/api/chat/team/conversations?page=${inboxPage}&limit=20`);
  if (generation !== inboxGeneration) return;
  const last = Math.max(1, Math.ceil(data.total / data.limit));
  if (data.page > last) { inboxPage = last; data = await inboxApi(`/api/chat/team/conversations?page=${inboxPage}&limit=20`); if (generation !== inboxGeneration) return; }
  inboxPage = data.page; inboxTotal = data.total;
  inboxElement('inbox-conversation-list').replaceChildren(); inboxElement('inbox-empty').hidden = data.total !== 0;
  inboxElement('inbox-page').textContent = `Página ${data.page} de ${Math.max(1, Math.ceil(data.total / data.limit))} · ${data.total} ${data.total === 1 ? 'atendimento' : 'atendimentos'}`;
  for (const conversation of data.conversations) {
    const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button'; button.id = `inbox-conversation-${conversation.id}`; button.className = 'conversation-select';
    const name = document.createElement('strong'); name.textContent = conversation.visitorName;
    const department = document.createElement('span'); department.textContent = conversation.departmentName;
    const state = document.createElement('span'); state.className = 'conversation-state'; state.textContent = inboxState(conversation);
    button.append(name, department, state); button.setAttribute('aria-pressed', String(conversation.id === inboxSelected?.id));
    button.addEventListener('click', () => inboxRun(async () => { await inboxSelect(conversation); }, false, 'inbox-conversation-title'));
    item.append(button); inboxElement('inbox-conversation-list').append(item);
  }
  let selectionRetained = true;
  if (inboxSelected) {
    const current = data.conversations.find(conversation => conversation.id === inboxSelected.id);
    if (current) { inboxSelected = current; inboxRenderConversation(); }
    else {
      selectionRetained = false;
      inboxDraft().text = inboxElement('inbox-text').value;
      inboxSelected = null; inboxMessageNodes.clear(); inboxElement('inbox-messages').replaceChildren();
      inboxElement('inbox-conversation').hidden = true; inboxElement('inbox-placeholder').hidden = false;
      inboxElement('inbox-feedback').textContent = 'O atendimento saiu desta página da fila. Se você abrir a conversa novamente, o rascunho e o envio pendente serão recuperados nesta aba.';
    }
  }
  inboxSetControls();
  return selectionRetained;
}
function inboxState(conversation) {
  if (conversation.status === 'waiting') return 'Na fila';
  if (conversation.status === 'closed') return 'Encerrado';
  return conversation.assignedTo === inboxProfile?.user.id ? 'Em atendimento com você' : 'Em atendimento com outro operador';
}
async function inboxSelect(conversation) {
  if (inboxSelected) inboxDraft().text = inboxElement('inbox-text').value;
  inboxSelected = conversation; inboxMessageNodes = new Map(); inboxElement('inbox-messages').replaceChildren();
  inboxElement('inbox-text').value = inboxDraft().text;
  inboxElement('inbox-message-feedback').textContent = inboxDraft().pending ? 'Há uma resposta aguardando confirmação. Reenvie o mesmo texto para confirmar sem duplicar.' : '';
  inboxElement('inbox-messages').setAttribute('aria-live', 'off'); inboxRenderConversation(); inboxRenderMessages(true);
  try { await inboxLoadMessages(); } finally { inboxElement('inbox-messages').setAttribute('aria-live', 'polite'); }
}
function inboxRenderConversation() {
  if (!inboxSelected) return;
  inboxElement('inbox-placeholder').hidden = true; inboxElement('inbox-conversation').hidden = false;
  inboxElement('inbox-conversation-title').textContent = inboxSelected.visitorName;
  inboxElement('inbox-conversation-detail').textContent = `${inboxSelected.departmentName} · nome informado pelo visitante`;
  inboxElement('inbox-conversation-state').textContent = inboxState(inboxSelected);
  inboxElement('inbox-compose-note').textContent = inboxSelected.status === 'closed' ? 'Atendimento encerrado. Você pode copiar um rascunho preservado ou confirmar o reenvio de uma resposta pendente.' : inboxOwnsConversation() ? 'Até 2.000 caracteres. Esta resposta será enviada ao visitante; notas privadas ainda não estão disponíveis.' : 'Assuma o atendimento para responder. Somente o responsável envia mensagens à pessoa.';
  inboxSetControls();
}
async function inboxLoadMessages() {
  inboxMessagesAttemptAt = Date.now();
  const generation = inboxGeneration; const id = inboxSelected.id; const history = inboxHistory(id);
  for (let page = 0; page < 10; page++) {
    let data;
    try { data = await inboxApi(`/api/chat/team/conversations/${id}/messages?after=${history.cursor}&limit=50`); }
    catch (error) {
      if (error.status === 404 || error.status === 403) {
        // A removed membership must not leave another area's history on screen.
        inboxHistories.delete(id); inboxMessageNodes.clear(); inboxElement('inbox-messages').replaceChildren();
        inboxSelected = null; inboxElement('inbox-conversation').hidden = true; inboxElement('inbox-placeholder').hidden = false;
      }
      throw error;
    }
    if (generation !== inboxGeneration || inboxSelected?.id !== id) return;
    for (const message of data.messages) history.messages.set(message.sequence, message);
    const previous = history.cursor; history.cursor = Math.max(history.cursor, data.cursor); inboxRenderMessages();
    if (!data.hasMore || history.cursor <= previous || (inboxPolling && document.hidden)) break;
  }
}
function inboxRenderMessages(forceScroll = false) {
  if (!inboxSelected) return;
  const log = inboxElement('inbox-messages'); const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const ordered = [...inboxHistory(inboxSelected.id).messages.values()].sort((a, b) => a.sequence - b.sequence);
  ordered.forEach((message, index) => {
    let item = inboxMessageNodes.get(message.sequence);
    if (!item) {
      item = document.createElement('div'); item.className = `chat-message ${message.sender === 'team' ? 'message-own' : 'message-other'}`;
      const author = document.createElement('strong'); author.textContent = message.sender === 'team' ? 'Equipe' : inboxSelected.visitorName;
      const text = document.createElement('p'); text.textContent = message.text;
      const time = document.createElement('time'); const date = new Date(message.createdAt); time.textContent = Number.isNaN(date.getTime()) ? 'Horário indisponível' : date.toLocaleString('pt-BR');
      if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
      item.append(author, text, time); inboxMessageNodes.set(message.sequence, item);
    }
    if (log.children[index] !== item) log.insertBefore(item, log.children[index] || null);
  });
  if (forceScroll || nearEnd) log.scrollTop = log.scrollHeight;
}
inboxElement('inbox-compose').addEventListener('submit', event => {
  event.preventDefault(); if (!inboxSelected || inboxBusy || (!inboxOwnsConversation() && !inboxDraft().pending)) return;
  const id = inboxSelected.id; const data = new FormData(event.currentTarget); const draft = inboxDraft(id); const text = String(data.get('text') || '').trim();
  if (!draft.pending && !text) { inboxElement('inbox-message-feedback').textContent = 'Escreva uma resposta antes de enviar.'; return; }
  if (!draft.pending) { const bytes = crypto.getRandomValues(new Uint8Array(16)); draft.pending = { text, clientKey: [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('') }; draft.text = text; inboxElement('inbox-text').value = text; }
  const payload = { ...draft.pending };
  inboxRun(async () => {
    inboxElement('inbox-message-feedback').textContent = 'Confirmando envio…';
    let result;
    try { result = await inboxApi(`/api/chat/team/conversations/${id}/messages`, { method: 'POST', headers: inboxHeaders(), body: JSON.stringify(payload) }); }
    catch (error) { if (error.status === 400 || error.status === 413) draft.pending = null; throw error; }
    inboxHistory(id).messages.set(result.message.sequence, result.message); draft.pending = null; draft.text = ''; inboxElement('inbox-text').value = '';
    inboxRenderMessages(); inboxElement('inbox-message-feedback').textContent = 'Resposta enviada.';
    inboxPage = 1; await inboxLoadQueue(); if (inboxSelected?.id === id) await inboxLoadMessages();
  });
});
inboxElement('inbox-text').addEventListener('input', () => { if (inboxSelected && !inboxDraft().pending) inboxDraft().text = inboxElement('inbox-text').value; });
for (const action of ['claim', 'release', 'close']) inboxElement('inbox-' + action).addEventListener('click', () => {
  if (!inboxSelected) return; const id = inboxSelected.id;
  inboxRun(async () => {
    const result = await inboxApi(`/api/chat/team/conversations/${id}/${action}`, { method: 'POST', headers: inboxHeaders(), body: '{}' });
    inboxSelected = result.conversation; inboxRenderConversation(); inboxElement('inbox-message-feedback').textContent = ({ claim: 'Atendimento assumido. Você pode responder.', release: 'Atendimento devolvido à fila.', close: 'Atendimento encerrado. Histórico preservado.' })[action];
    inboxPage = 1; await inboxLoadQueue(); if (inboxSelected?.id === id) await inboxLoadMessages();
  });
});
inboxElement('inbox-logout').addEventListener('click', () => inboxRun(async () => {
  await inboxApi('/api/auth/logout', { method: 'POST', headers: inboxHeaders(), body: '{}' });
  inboxForget(); inboxElement('inbox-login').hidden = false; inboxElement('inbox-feedback').textContent = 'Sessão encerrada. Entre novamente para acessar o atendimento.';
  inboxElement('inbox-description').textContent = 'Entre com sua conta da equipe para acessar o atendimento.';
}));
inboxElement('inbox-reload').addEventListener('click', () => inboxRun(async () => { const selectionRetained = await inboxLoadQueue(); if (inboxSelected) await inboxLoadMessages(); if (selectionRetained) inboxElement('inbox-feedback').textContent = 'Fila atualizada.'; }));
inboxElement('inbox-previous').addEventListener('click', () => inboxRun(async () => { inboxPage--; await inboxLoadQueue(); }));
inboxElement('inbox-next').addEventListener('click', () => inboxRun(async () => { inboxPage++; await inboxLoadQueue(); }));
inboxElement('inbox-login-retry').addEventListener('click', inboxInitialize); inboxElement('inbox-pending-retry').addEventListener('click', inboxInitialize);
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(inboxTimer); if (inboxPolling) inboxController?.abort(); } else inboxSchedule(0); });
window.addEventListener('pagehide', () => { inboxDisposed = true; inboxGeneration++; clearTimeout(inboxTimer); inboxController?.abort(); inboxBusy = false; });
window.addEventListener('pageshow', event => { if (event.persisted) { inboxDisposed = false; inboxInitialize({ preserve: true }); } });
inboxInitialize();
