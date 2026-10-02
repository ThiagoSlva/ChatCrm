'use strict';
const salesElement = id => document.getElementById(id);
const salesStages = { new: 'Novo', qualified: 'Qualificado', proposal: 'Proposta', won: 'Ganho', lost: 'Perdido' };
let salesProfile = null, salesCsrf = null, salesBusy = false, salesGeneration = 0, salesController = null, salesDisposed = false;
let salesDepartments = [], salesFilters = { stage: 'all', q: '', departmentId: '' }, salesPage = 1, salesTotal = 0;
let salesContactFilters = { q: '', departmentId: '' }, salesContactPage = 1, salesContactTotal = 0;
let salesCreateContactId = null, salesCreateContact = null, salesCreateContactConfirmed = false;
let salesCreateDraft = { values: { title: '', amount: '0,00' }, pending: null };
let salesSelectedId = null, salesSelected = null, salesConfirmed = false, salesOutsidePage = false, salesMode = 'create';
let salesEventsPage = 1, salesEventsTotal = 0;
const salesDrafts = new Map(), salesHistoryPages = new Map();
function salesError(status) {
  return ({ 400: 'Confira título, valor e etapa antes de tentar novamente.', 401: 'Entre com sua conta da equipe para consultar vendas.', 403: 'Esta ação não está autorizada para sua conta.', 404: 'A oportunidade ou o contato está inacessível. Confira seus vínculos com o administrador.', 409: 'A oportunidade mudou. Compare a versão atual e revise seu rascunho.', 413: 'Os dados excederam o limite. Edite o título e o valor antes de tentar novamente.', 429: 'O limite de oportunidades desta instalação foi atingido. Consulte o administrador.', 503: 'As oportunidades aguardam preparação na hospedagem.' })[status] || 'Não foi possível confirmar a operação. O rascunho foi preservado.';
}
function salesPositiveId(value) { return Number.isInteger(value) && value > 0 && value <= 4294967295; }
function salesOpportunityValid(value) {
  return value && typeof value === 'object' && ['id', 'contactId', 'departmentId', 'version'].every(field => salesPositiveId(value[field])) &&
    ['title', 'contactName', 'departmentName'].every(field => typeof value[field] === 'string') &&
    Number.isInteger(value.amountCents) && value.amountCents >= 0 && value.amountCents <= 999999999 && value.currency === 'BRL' && Object.hasOwn(salesStages, value.stage);
}
function salesResponseValid(url, method, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const path = url.split('?')[0];
  const pagination = items => Array.isArray(items) && Number.isInteger(data.total) && data.total >= 0 && salesPositiveId(data.page) && Number.isInteger(data.limit) && data.limit >= 1 && data.limit <= 50 && items.length <= data.limit;
  const contact = value => value && salesPositiveId(value.id) && salesPositiveId(value.departmentId) && typeof value.name === 'string' && typeof value.departmentName === 'string';
  if (path === '/api/auth/me') return data.user && salesPositiveId(data.user.id) && typeof data.csrfToken === 'string' && data.capabilities && typeof data.capabilities === 'object';
  if (path === '/api/auth/logout') return data.authenticated === false;
  if (path === '/api/team/departments') return Array.isArray(data.departments) && data.departments.every(value => salesPositiveId(value.id) && typeof value.name === 'string' && typeof value.active === 'boolean');
  if (path === '/api/crm/contacts') return pagination(data.contacts) && data.contacts.every(contact);
  if (/^\/api\/crm\/contacts\/\d+$/u.test(path)) return contact(data.contact);
  if (path === '/api/crm/opportunities' && method === 'GET') return pagination(data.opportunities) && data.opportunities.every(salesOpportunityValid);
  if (path === '/api/crm/opportunities' || /^\/api\/crm\/opportunities\/\d+$/u.test(path)) return salesOpportunityValid(data.opportunity);
  if (/^\/api\/crm\/opportunities\/\d+\/events$/u.test(path)) return pagination(data.events) && data.events.every(value => salesPositiveId(value.version) && typeof value.actorName === 'string' && typeof value.title === 'string' && Number.isInteger(value.amountCents) && value.amountCents >= 0 && value.amountCents <= 999999999 && Object.hasOwn(salesStages, value.stage) && typeof value.createdAt === 'string');
  return false;
}
async function salesApi(url, options = {}) {
  const generation = salesGeneration, controller = salesController;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal });
  let parsed = true; const data = await response.json().catch(() => { parsed = false; return {}; });
  if (generation !== salesGeneration || controller !== salesController || controller.signal.aborted || salesDisposed) { const error = new Error('Request superseded.'); error.name = 'AbortError'; throw error; }
  if (!response.ok) { const error = new Error(salesError(response.status)); error.status = response.status; throw error; }
  if (!parsed || !salesResponseValid(url, options.method || 'GET', data)) throw new Error('Resposta incompleta. Não foi possível confirmar a operação; o pedido foi preservado.');
  return data;
}
const salesHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': salesCsrf });
const salesCurrency = cents => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const salesAmountText = cents => Math.floor(cents / 100).toLocaleString('pt-BR') + ',' + String(cents % 100).padStart(2, '0');
function salesAmount(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/u.test(text)) throw new Error('Use um valor em formato brasileiro, como 1.234,56, sem sinal ou símbolo de moeda.');
  const parts = text.split(','), reais = Number(parts[0].replaceAll('.', '')), cents = reais * 100 + Number((parts[1] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 999999999) throw new Error('O valor deve ficar entre R$ 0,00 e R$ 9.999.999,99.');
  return cents;
}
function salesNormalize(values) {
  const title = String(values.title || '').trim().normalize('NFC'), amountCents = salesAmount(values.amount);
  if (title.length < 2 || title.length > 150 || /[\u0000-\u001f\u007f]/u.test(title)) throw new Error('Use um título de 2 a 150 caracteres, sem caracteres de controle.');
  const result = { title, amountCents };
  if (Object.hasOwn(values, 'stage')) { if (!Object.hasOwn(salesStages, values.stage)) throw new Error('Escolha uma das etapas disponíveis.'); result.stage = values.stage; }
  return result;
}
const salesSafeValues = opportunity => ({ title: opportunity.title, amountCents: opportunity.amountCents, stage: opportunity.stage });
function salesNewDraft(opportunity) { return { values: { title: opportunity.title, amount: salesAmountText(opportunity.amountCents), stage: opportunity.stage }, base: salesSafeValues(opportunity), version: opportunity.version, touched: new Set(), pending: null, conflict: false, current: null, stageConfirmed: false }; }
function salesChanges(draft) {
  let normalized;
  try { normalized = salesNormalize(draft.values); } catch { return [...draft.touched]; }
  return [...draft.touched].filter(field => normalized[field] !== draft.base[field]);
}
function salesWriteValues(prefix, values) {
  for (const [field, value] of Object.entries(values)) { const element = salesElement('sales-' + prefix + '-' + (field === 'title' ? 'title-input' : field)); if (element) element.value = String(value); }
}
function salesSetControls() {
  for (const id of ['sales-login-retry', 'sales-pending-retry', 'sales-logout', 'sales-new', 'sales-refresh', 'sales-filter-apply', 'sales-filter-clear']) salesElement(id).disabled = salesBusy;
  salesElement('sales-filters').querySelectorAll('input, select').forEach(element => { element.disabled = salesBusy; });
  salesElement('sales-list').querySelectorAll('button').forEach(element => { element.disabled = salesBusy; });
  salesElement('sales-previous').disabled = salesBusy || salesPage === 1; salesElement('sales-next').disabled = salesBusy || salesPage * 20 >= salesTotal;
  const locked = Boolean(salesCreateDraft.pending);
  salesElement('sales-contact-filters').querySelectorAll('input, select, button').forEach(element => { element.disabled = salesBusy || locked; });
  salesElement('sales-contact-list').querySelectorAll('button').forEach(element => { element.disabled = salesBusy || locked; });
  salesElement('sales-contact-previous').disabled = salesBusy || locked || salesContactPage === 1;
  salesElement('sales-contact-next').disabled = salesBusy || locked || salesContactPage * 20 >= salesContactTotal;
  salesElement('sales-create').querySelectorAll('input').forEach(element => { element.disabled = salesBusy || locked; });
  salesElement('sales-create-submit').disabled = salesBusy || (!locked && !salesCreateContactConfirmed);
  salesElement('sales-create-submit').textContent = locked ? 'Confirmar mesma oportunidade' : 'Salvar oportunidade';
  const draft = salesDrafts.get(salesSelectedId);
  salesElement('sales-edit').querySelectorAll('input, select').forEach(element => { element.disabled = salesBusy || !salesConfirmed || Boolean(draft?.pending); });
  salesElement('sales-edit-submit').disabled = salesBusy || !salesConfirmed || !draft || draft.conflict || (!draft.pending && salesChanges(draft).length === 0);
  salesElement('sales-edit-submit').textContent = draft?.pending ? 'Confirmar mesma alteração' : 'Salvar alterações';
  salesElement('sales-current-reload').disabled = salesBusy || !salesSelectedId;
  salesElement('sales-use-version').disabled = salesBusy || !draft?.current || !draft.conflict;
  salesElement('sales-detail-retry').disabled = salesBusy || !salesSelectedId;
  salesElement('sales-events-previous').disabled = salesBusy || !salesConfirmed || salesEventsPage === 1;
  salesElement('sales-events-next').disabled = salesBusy || !salesConfirmed || salesEventsPage * 20 >= salesEventsTotal;
  salesElement('sales-space').setAttribute('aria-busy', String(salesBusy));
}
function salesClearIdentity() {
  salesProfile = null; salesCsrf = null; salesDepartments = []; salesFilters = { stage: 'all', q: '', departmentId: '' }; salesPage = 1; salesTotal = 0;
  salesContactFilters = { q: '', departmentId: '' }; salesContactPage = 1; salesContactTotal = 0;
  salesCreateContactId = null; salesCreateContact = null; salesCreateContactConfirmed = false; salesCreateDraft = { values: { title: '', amount: '0,00' }, pending: null };
  salesSelectedId = null; salesSelected = null; salesConfirmed = false; salesOutsidePage = false; salesMode = 'create'; salesEventsPage = 1; salesEventsTotal = 0;
  salesDrafts.clear(); salesHistoryPages.clear();
  for (const id of ['sales-list', 'sales-contact-list', 'sales-current-values', 'sales-events-list']) salesElement(id).replaceChildren();
  for (const id of ['sales-identity', 'sales-page', 'sales-contact-page', 'sales-contact-feedback', 'sales-create-feedback', 'sales-edit-feedback', 'sales-edit-detail', 'sales-edit-state', 'sales-edit-version', 'sales-events-page', 'sales-events-feedback']) salesElement(id).textContent = '';
  salesElement('sales-space').hidden = true; salesElement('sales-edit-panel').hidden = true; salesElement('sales-detail-unavailable').hidden = true;
  salesElement('sales-create-panel').hidden = false; salesElement('sales-stage-confirm-label').hidden = true; salesElement('sales-conflict').hidden = true;
  for (const id of ['sales-filter-department', 'sales-contact-department']) { const select = salesElement(id); select.replaceChildren(); const option = document.createElement('option'); option.value = ''; option.textContent = 'Todas as minhas áreas'; select.append(option); select.value = ''; }
  salesWriteValues('create', salesCreateDraft.values); salesWriteValues('edit', { title: '', amount: '0,00', stage: 'new' }); salesWriteFilters(); salesRenderCreateContact();
}
function salesForget() { salesGeneration++; salesController?.abort(); salesBusy = false; salesClearIdentity(); salesSetControls(); }
function salesPending(message, connectionFailure = false) {
  salesConfirmed = false; salesCreateContactConfirmed = false;
  salesElement('sales-space').hidden = true; salesElement('sales-pending').hidden = false; salesElement('sales-feedback').textContent = '';
  salesElement('sales-description').textContent = connectionFailure ? 'Não foi possível verificar seu acesso. Tente novamente abaixo.' : 'O módulo de vendas ainda precisa ser preparado na hospedagem.';
  salesElement('sales-pending-title').textContent = connectionFailure ? 'Vamos conferir a conexão' : 'Prepare as oportunidades';
  salesElement('sales-pending-description').textContent = message;
}
async function salesRun(work, focusId = null) {
  if (salesBusy || salesDisposed) return;
  const generation = salesGeneration, focusedId = document.activeElement?.id;
  salesBusy = true; salesController = new AbortController(); salesSetControls();
  try { await work(); }
  catch (error) {
    if (generation !== salesGeneration || salesDisposed || error.name === 'AbortError') return;
    if (error.status === 401) {
      salesForget(); salesElement('sales-login').hidden = false; salesElement('sales-pending').hidden = true; salesElement('sales-description').textContent = 'Entre com sua conta da equipe para acessar vendas.'; salesElement('sales-feedback').textContent = error.message;
    } else if (error.status === 503) salesPending(error.message);
    else if (salesElement('sales-space').hidden) salesPending(error.status ? error.message : 'A conexão falhou. Use Verificar novamente para tentar outra vez.', true);
    else {
      if (salesSelectedId && !salesConfirmed) salesHideDetail('Não foi possível confirmar a oportunidade. Seu rascunho foi preservado; use Verificar oportunidade novamente.');
      salesElement('sales-feedback').textContent = error.uiMessage || (error.status ? error.message : 'A conexão falhou. Rascunhos e pedidos pendentes foram preservados nesta aba.');
    }
  } finally {
    if (generation === salesGeneration) { salesBusy = false; salesSetControls(); const element = salesElement(focusId || focusedId); if (element && !element.disabled && !element.closest('[hidden]')) element.focus(); }
  }
}
async function salesInitialize({ preserve = Boolean(salesProfile) } = {}) {
  if (salesBusy) return; const previousId = preserve ? salesProfile?.user.id : null;
  if (preserve) { salesGeneration++; salesController?.abort(); salesConfirmed = false; salesCreateContactConfirmed = false; } else salesForget();
  salesElement('sales-space').hidden = true; salesElement('sales-login').hidden = true; salesElement('sales-pending').hidden = true; salesElement('sales-feedback').textContent = 'Verificando seu acesso…';
  await salesRun(async () => {
    const profile = await salesApi('/api/auth/me'); if (profile.user.id !== previousId) salesClearIdentity();
    salesProfile = profile; salesCsrf = profile.csrfToken;
    if (profile.capabilities?.opportunities !== true) { salesPending('As oportunidades aguardam preparação na hospedagem. Contatos, atendimento e acesso da equipe continuam disponíveis.'); return; }
    salesElement('sales-space').hidden = false; salesElement('sales-description').textContent = 'Acompanhe seu funil em lista, registre valores e revise o histórico de cada oportunidade.';
    salesElement('sales-identity').textContent = `${profile.user.name} · ${profile.company}`;
    await salesLoadDepartments(); await salesLoadList(); await salesLoadContactChoices(); salesRenderMode(); salesElement('sales-feedback').textContent = '';
  });
}
function salesWriteFilters() {
  salesElement('sales-filter-stage').value = salesFilters.stage; salesElement('sales-filter-query').value = salesFilters.q; salesElement('sales-filter-department').value = salesFilters.departmentId;
  salesElement('sales-contact-query').value = salesContactFilters.q; salesElement('sales-contact-department').value = salesContactFilters.departmentId;
}
async function salesLoadDepartments() {
  const data = await salesApi('/api/team/departments?page=1&limit=50'); salesDepartments = data.departments.filter(department => department.active);
  for (const id of ['sales-filter-department', 'sales-contact-department']) {
    const select = salesElement(id), value = select.value; select.replaceChildren(); const all = document.createElement('option'); all.value = ''; all.textContent = 'Todas as minhas áreas'; select.append(all);
    for (const department of salesDepartments) { const option = document.createElement('option'); option.value = String(department.id); option.textContent = department.name; select.append(option); }
    if (value && !salesDepartments.some(department => String(department.id) === value)) { const option = document.createElement('option'); option.value = value; option.textContent = 'Área do filtro (indisponível)'; select.append(option); }
    select.value = value;
  }
}
function salesListUrl() {
  const query = new URLSearchParams({ page: String(salesPage), limit: '20', stage: salesFilters.stage });
  if (salesFilters.q) query.set('q', salesFilters.q); if (salesFilters.departmentId) query.set('departmentId', salesFilters.departmentId);
  return '/api/crm/opportunities?' + query.toString();
}
async function salesLoadList() {
  if (salesSelectedId) salesHideDetail('Verificando acesso e versão desta oportunidade…');
  let data = await salesApi(salesListUrl()); const last = Math.max(1, Math.ceil(data.total / data.limit));
  if (data.page > last) { salesPage = last; data = await salesApi(salesListUrl()); }
  salesPage = data.page; salesTotal = data.total; salesElement('sales-list').replaceChildren(); salesElement('sales-empty').hidden = data.total !== 0;
  salesElement('sales-page').textContent = `Página ${data.page} de ${Math.max(1, Math.ceil(data.total / data.limit))} · ${data.total} ${data.total === 1 ? 'oportunidade' : 'oportunidades'}`;
  for (const opportunity of data.opportunities) {
    const item = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.id = 'sales-row-' + opportunity.id; button.className = 'conversation-select';
    const title = document.createElement('strong'); title.textContent = opportunity.title;
    const contact = document.createElement('span'); contact.textContent = `${opportunity.contactName} · ${opportunity.departmentName}`;
    const state = document.createElement('span'); state.textContent = `${salesStages[opportunity.stage]} · ${salesCurrency(opportunity.amountCents)}`;
    button.append(title, contact, state); button.setAttribute('aria-pressed', String(opportunity.id === salesSelectedId)); button.addEventListener('click', () => salesRun(() => salesSelect(opportunity.id), 'sales-edit-title'));
    item.append(button); salesElement('sales-list').append(item);
  }
  if (salesSelectedId) { salesOutsidePage = !data.opportunities.some(opportunity => opportunity.id === salesSelectedId); await salesLoadDetail(salesSelectedId); }
  salesSetControls();
}
function salesContactUrl() {
  const query = new URLSearchParams({ page: String(salesContactPage), limit: '20', kind: 'all' });
  if (salesContactFilters.q) query.set('q', salesContactFilters.q); if (salesContactFilters.departmentId) query.set('departmentId', salesContactFilters.departmentId);
  return '/api/crm/contacts?' + query.toString();
}
async function salesLoadContactChoices() {
  let data = await salesApi(salesContactUrl()); const last = Math.max(1, Math.ceil(data.total / data.limit));
  if (data.page > last) { salesContactPage = last; data = await salesApi(salesContactUrl()); }
  salesContactPage = data.page; salesContactTotal = data.total; salesElement('sales-contact-list').replaceChildren(); salesElement('sales-contact-empty').hidden = data.total !== 0;
  salesElement('sales-contact-page').textContent = `Página ${data.page} de ${Math.max(1, Math.ceil(data.total / data.limit))} · ${data.total} ${data.total === 1 ? 'contato' : 'contatos'}`;
  for (const contact of data.contacts) {
    const item = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.className = 'conversation-select'; button.id = 'sales-contact-' + contact.id;
    const name = document.createElement('strong'); name.textContent = contact.name; const area = document.createElement('span'); area.textContent = contact.departmentName;
    button.append(name, area); button.setAttribute('aria-pressed', String(contact.id === salesCreateContactId));
    button.addEventListener('click', () => { if (!salesCreateDraft.pending) salesRun(async () => { salesCreateContactId = contact.id; await salesRevalidateCreateContact(); }, 'sales-create-title-input'); }); item.append(button); salesElement('sales-contact-list').append(item);
  }
  const confirmed = salesCreateContactId ? await salesRevalidateCreateContact() : true; salesSetControls(); return confirmed;
}
async function salesRevalidateCreateContact() {
  const id = salesCreateContactId, generation = salesGeneration; salesCreateContactConfirmed = false; salesCreateContact = null; salesRenderCreateContact();
  try { const data = await salesApi('/api/crm/contacts/' + id); if (salesCreateContactId !== id) return; salesCreateContact = data.contact; salesCreateContactConfirmed = true; salesElement('sales-contact-feedback').textContent = ''; }
  catch (error) {
    if (generation !== salesGeneration || salesDisposed || salesCreateContactId !== id) throw error;
    if (error.status === 401 || error.status === 503) throw error;
    salesElement('sales-contact-feedback').textContent = error.status === 403 || error.status === 404 ? 'O contato selecionado não está acessível. Confira seus vínculos; pedidos pendentes permanecem preservados.' : 'Não foi possível confirmar o contato selecionado. Busque novamente para revalidar.';
    if (!salesCreateDraft.pending && (error.status === 403 || error.status === 404)) salesCreateContactId = null;
  }
  salesRenderCreateContact(); salesSetControls();
  salesElement('sales-contact-list').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.id === 'sales-contact-' + salesCreateContactId)));
  return salesCreateContactConfirmed;
}
function salesRenderCreateContact() {
  salesElement('sales-create-contact').textContent = salesCreateContactConfirmed && salesCreateContact ? `Contato selecionado: ${salesCreateContact.name} · ${salesCreateContact.departmentName}` : salesCreateDraft.pending ? 'Contato do pedido pendente: acesso ainda não confirmado. Reenvios mantêm o mesmo contato e os mesmos dados.' : 'Selecione um contato autorizado na lista acima.';
}
function salesHideDetail(message, revoked = false) {
  salesConfirmed = false; salesSelected = null; salesElement('sales-edit-panel').hidden = true; salesElement('sales-detail-unavailable').hidden = salesMode !== 'edit';
  salesElement('sales-detail-unavailable-description').textContent = message; salesElement('sales-events-list').replaceChildren(); salesElement('sales-events-page').textContent = ''; salesEventsTotal = 0;
  if (revoked) { const id = salesSelectedId; salesSelectedId = null; salesHistoryPages.delete(id); salesElement('sales-row-' + id)?.closest('li')?.remove(); salesElement('sales-current-values').replaceChildren(); salesWriteValues('edit', { title: '', amount: '0,00', stage: 'new' }); for (const suffix of ['detail', 'state', 'version', 'feedback']) salesElement('sales-edit-' + suffix).textContent = ''; }
  salesSetControls();
}
async function salesSelect(id) { salesSelectedId = id; salesMode = 'edit'; salesOutsidePage = false; salesHideDetail('Verificando acesso e versão desta oportunidade…'); salesRenderMode(); await salesLoadDetail(id); }
async function salesLoadDetail(id) {
  let data; const generation = salesGeneration;
  try { data = await salesApi('/api/crm/opportunities/' + id); }
  catch (error) { if (generation === salesGeneration && salesSelectedId === id) salesHideDetail(error.status === 403 || error.status === 404 ? 'Esta oportunidade não está mais acessível. O detalhe e o histórico foram ocultados.' : 'A conexão falhou. Seu rascunho foi preservado; verifique novamente.', error.status === 403 || error.status === 404); throw error; }
  if (generation !== salesGeneration || salesSelectedId !== id) return;
  salesSelected = data.opportunity; salesConfirmed = true; let draft = salesDrafts.get(id);
  if (!draft || (!salesChanges(draft).length && !draft.pending && !draft.conflict)) { draft = salesNewDraft(data.opportunity); salesDrafts.set(id, draft); }
  else if (draft.version !== data.opportunity.version) { draft.conflict = true; draft.current = data.opportunity; draft.stageConfirmed = false; }
  salesEventsPage = salesHistoryPages.get(id) || 1; salesRenderEdit(); salesRenderMode(); await salesLoadEvents();
}
async function salesLoadEvents() {
  if (!salesSelectedId || !salesConfirmed) return; const id = salesSelectedId, generation = salesGeneration; let data;
  salesElement('sales-events-feedback').textContent = 'Verificando o histórico…';
  try {
    const url = () => `/api/crm/opportunities/${id}/events?page=${salesEventsPage}&limit=20`;
    data = await salesApi(url()); const last = Math.max(1, Math.ceil(data.total / data.limit)); if (data.page > last) { salesEventsPage = last; data = await salesApi(url()); }
  } catch (error) { if (generation !== salesGeneration || salesDisposed || salesSelectedId !== id) throw error; if (error.status === 403 || error.status === 404) salesHideDetail('Esta oportunidade não está mais acessível. O detalhe e o histórico foram ocultados.', true); else salesElement('sales-events-feedback').textContent = 'Não foi possível carregar o histórico. Use Atualizar vendas para tentar novamente.'; throw error; }
  if (salesSelectedId !== id) return; salesEventsPage = data.page; salesEventsTotal = data.total; salesHistoryPages.set(id, data.page);
  salesElement('sales-events-list').replaceChildren(); salesElement('sales-events-empty').hidden = data.total !== 0;
  for (const event of data.events) {
    const item = document.createElement('li'), header = document.createElement('strong'), state = document.createElement('p'), actor = document.createElement('p'), time = document.createElement('time');
    header.textContent = `Versão ${event.version} · ${event.title}`; state.textContent = `${salesStages[event.stage]} · ${salesCurrency(event.amountCents)}`; actor.textContent = `Registrado por ${event.actorName}`;
    const date = new Date(event.createdAt); time.textContent = Number.isNaN(date.getTime()) ? 'Horário indisponível' : date.toLocaleString('pt-BR'); if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
    item.append(header, state, actor, time); salesElement('sales-events-list').append(item);
  }
  salesElement('sales-events-page').textContent = `Página ${data.page} de ${Math.max(1, Math.ceil(data.total / data.limit))} · ${data.total} ${data.total === 1 ? 'registro' : 'registros'}`;
  salesElement('sales-events-feedback').textContent = ''; salesSetControls();
}
function salesRenderMode() { salesElement('sales-create-panel').hidden = salesMode !== 'create'; salesElement('sales-edit-panel').hidden = salesMode !== 'edit' || !salesConfirmed; salesElement('sales-detail-unavailable').hidden = salesMode !== 'edit' || salesConfirmed; salesSetControls(); }
function salesRenderStageConfirmation() {
  const draft = salesDrafts.get(salesSelectedId); const changed = draft && salesSelected && salesChanges(draft).includes('stage') && draft.values.stage !== salesSelected.stage;
  salesElement('sales-stage-confirm-label').hidden = !changed; salesElement('sales-stage-confirm').checked = Boolean(draft?.stageConfirmed);
  if (changed) salesElement('sales-stage-confirm-text').textContent = `Confirmo a mudança de ${salesStages[salesSelected.stage]} para ${salesStages[draft.values.stage]}, incluindo encerramento ou reabertura quando aplicável.`;
}
function salesRenderEdit() {
  const draft = salesDrafts.get(salesSelectedId); if (!draft || !salesSelected || !salesConfirmed) return;
  salesWriteValues('edit', draft.values); salesElement('sales-edit-detail').textContent = `${salesSelected.contactName} · ${salesSelected.departmentName}${salesOutsidePage ? ' · fora dos filtros ou desta página' : ''}`;
  salesElement('sales-edit-state').textContent = `Etapa confirmada: ${salesStages[salesSelected.stage]} · ${salesCurrency(salesSelected.amountCents)}`;
  salesElement('sales-edit-version').textContent = `Versão do rascunho: ${draft.version}.${draft.pending ? ' Há uma alteração aguardando confirmação.' : ''}`;
  salesElement('sales-conflict').hidden = !draft.conflict && !draft.current; salesElement('sales-current-values').replaceChildren(); salesElement('sales-current-values').hidden = !draft.current; salesElement('sales-use-version').hidden = !draft.conflict || !draft.current;
  salesElement('sales-conflict-description').textContent = draft.conflict ? 'A oportunidade mudou. Compare os dados atuais. Usar a nova versão não copia nem salva campos automaticamente.' : 'Versão atual escolhida. Revise o rascunho e confirme o formulário para salvar somente os campos editados.';
  if (draft.current) for (const [label, value] of Object.entries({ 'Versão atual': String(draft.current.version), Título: draft.current.title, Valor: salesCurrency(draft.current.amountCents), Etapa: salesStages[draft.current.stage] })) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; salesElement('sales-current-values').append(dt, dd); }
  if (draft.conflict) salesElement('sales-edit-feedback').textContent = 'A oportunidade tem uma versão mais recente. Seu rascunho foi preservado; compare antes de reaplicar.';
  salesRenderStageConfirmation(); salesSetControls();
}
function salesClientKey() { const bytes = crypto.getRandomValues(new Uint8Array(16)); return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
salesElement('sales-create').addEventListener('submit', event => {
  event.preventDefault(); if (salesBusy || !salesProfile) return; const values = Object.fromEntries(new FormData(event.currentTarget));
  if (!salesCreateDraft.pending) {
    if (!salesCreateContactConfirmed || !salesCreateContactId) { salesElement('sales-create-feedback').textContent = 'Selecione um contato autorizado antes de salvar.'; return; }
    let normalized; try { normalized = salesNormalize(values); } catch (error) { salesElement('sales-create-feedback').textContent = error.message; return; }
    salesCreateDraft.values = { title: normalized.title, amount: salesAmountText(normalized.amountCents) }; salesWriteValues('create', salesCreateDraft.values);
    salesCreateDraft.pending = { contactId: salesCreateContactId, ...normalized, clientKey: salesClientKey() };
  }
  const payload = { ...salesCreateDraft.pending }, generation = salesGeneration;
  salesRun(async () => {
    salesElement('sales-create-feedback').textContent = 'Confirmando oportunidade…'; let data;
    try { data = await salesApi('/api/crm/opportunities', { method: 'POST', headers: salesHeaders(), body: JSON.stringify(payload) }); }
    catch (error) { if (generation !== salesGeneration || salesDisposed) throw error; if ([400, 413, 409].includes(error.status)) salesCreateDraft.pending = null; salesElement('sales-create-feedback').textContent = error.status ? error.message : 'Não foi possível confirmar. Título, valor, contato e chave foram preservados; confirme a mesma oportunidade para evitar duplicação.'; throw error; }
    salesCreateDraft = { values: { title: '', amount: '0,00' }, pending: null }; salesWriteValues('create', salesCreateDraft.values); salesElement('sales-create-feedback').textContent = 'Oportunidade confirmada.'; salesPage = 1;
    salesElement('sales-feedback').textContent = 'Oportunidade salva na etapa Novo ou confirmada por reenvio.';
    try { await salesLoadList(); await salesSelect(data.opportunity.id); } catch (error) { error.uiMessage = 'O cadastro foi confirmado, mas seu detalhe não pôde ser atualizado. Use Atualizar vendas para verificar.'; throw error; }
  }, 'sales-edit-title');
});
salesElement('sales-edit').addEventListener('submit', event => {
  event.preventDefault(); if (salesBusy || !salesConfirmed || !salesSelectedId) return; const id = salesSelectedId, draft = salesDrafts.get(id); if (!draft || draft.conflict) return;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  if (!draft.pending) {
    let normalized; try { normalized = salesNormalize(values); } catch (error) { salesElement('sales-edit-feedback').textContent = error.message; return; }
    draft.values = { title: normalized.title, amount: salesAmountText(normalized.amountCents), stage: normalized.stage }; const changed = salesChanges(draft);
    if (!changed.length) { salesElement('sales-edit-feedback').textContent = 'O rascunho já corresponde aos dados confirmados.'; return; }
    if (changed.includes('stage') && normalized.stage !== salesSelected.stage && !draft.stageConfirmed) { salesElement('sales-edit-feedback').textContent = 'Confirme a mudança de etapa antes de salvar.'; salesElement('sales-stage-confirm').focus(); return; }
    draft.pending = { version: draft.version, ...Object.fromEntries(changed.map(field => [field, normalized[field]])) }; salesWriteValues('edit', draft.values);
  }
  const payload = { ...draft.pending }, generation = salesGeneration;
  salesRun(async () => {
    salesElement('sales-edit-feedback').textContent = 'Confirmando alterações…'; let data;
    try { data = await salesApi('/api/crm/opportunities/' + id, { method: 'PATCH', headers: salesHeaders(), body: JSON.stringify(payload) }); }
    catch (error) {
      if (generation !== salesGeneration || salesDisposed) throw error;
      if (error.status === 400 || error.status === 413) draft.pending = null;
      if (error.status === 409) { draft.conflict = true; draft.current = null; draft.stageConfirmed = false; salesRenderEdit(); }
      else if (error.status === 403 || error.status === 404) salesHideDetail('Esta oportunidade não está mais acessível. O detalhe e o histórico foram ocultados.', true);
      else salesElement('sales-edit-feedback').textContent = error.status ? error.message : 'Não foi possível confirmar. O mesmo pedido e a versão foram preservados; confirme novamente ou consulte os dados atuais.';
      throw error;
    }
    salesSelected = data.opportunity; salesConfirmed = true; salesDrafts.set(id, salesNewDraft(data.opportunity)); salesHistoryPages.set(id, 1); salesRenderEdit(); salesElement('sales-edit-feedback').textContent = 'Alterações salvas.'; salesElement('sales-feedback').textContent = 'Oportunidade atualizada.';
    try { await salesLoadList(); } catch (error) { error.uiMessage = 'As alterações foram confirmadas, mas a lista não pôde ser atualizada. Use Atualizar vendas para verificar.'; throw error; }
  });
});
for (const prefix of ['create', 'edit']) for (const field of prefix === 'create' ? ['title', 'amount'] : ['title', 'amount', 'stage']) {
  const element = salesElement('sales-' + prefix + '-' + (field === 'title' ? 'title-input' : field));
  const save = () => {
    if (prefix === 'create') { if (!salesCreateDraft.pending) salesCreateDraft.values[field] = element.value; }
    else { const draft = salesDrafts.get(salesSelectedId); if (draft && !draft.pending) { draft.values[field] = element.value; draft.touched.add(field === 'amount' ? 'amountCents' : field); if (field === 'stage') draft.stageConfirmed = false; salesRenderStageConfirmation(); } }
    salesSetControls();
  };
  element.addEventListener('input', save); element.addEventListener('change', save);
}
salesElement('sales-stage-confirm').addEventListener('change', event => { const draft = salesDrafts.get(salesSelectedId); if (draft && !draft.pending && !salesBusy) draft.stageConfirmed = event.currentTarget.checked; });
salesElement('sales-current-reload').addEventListener('click', () => {
  if (salesBusy || !salesSelectedId) return; const id = salesSelectedId;
  salesRun(async () => {
    salesHideDetail('Verificando acesso e versão desta oportunidade…'); let data;
    try { data = await salesApi('/api/crm/opportunities/' + id); } catch (error) { if (error.status === 403 || error.status === 404) salesHideDetail('Esta oportunidade não está mais acessível. O detalhe e o histórico foram ocultados.', true); throw error; }
    const draft = salesDrafts.get(id); if (!draft || salesSelectedId !== id) return;
    salesSelected = data.opportunity; salesConfirmed = true; draft.current = data.opportunity; draft.conflict = true; draft.stageConfirmed = false; salesRenderEdit(); salesRenderMode(); await salesLoadEvents();
  });
});
salesElement('sales-use-version').addEventListener('click', () => {
  if (salesBusy || !salesConfirmed) return; const draft = salesDrafts.get(salesSelectedId); if (!draft?.current || !draft.conflict) return;
  draft.version = draft.current.version; draft.base = salesSafeValues(draft.current); draft.conflict = false; draft.pending = null; draft.stageConfirmed = false; salesRenderEdit();
  salesElement('sales-edit-feedback').textContent = salesChanges(draft).length ? 'Versão atual escolhida. Revise o rascunho e confirme o formulário para salvar somente os campos editados.' : 'Os campos editados do rascunho já constam da versão atual. Nenhuma alteração adicional é necessária.';
});
function salesQuery(value) { const q = String(value || '').trim().normalize('NFC'); if (q.length > 100 || /[\u0000-\u001f\u007f]/u.test(q)) throw new Error('Use até 100 caracteres na busca, sem caracteres de controle.'); return q; }
salesElement('sales-filters').addEventListener('submit', event => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); if (salesBusy) return; let q;
  try { q = salesQuery(values.q); } catch (error) { salesElement('sales-feedback').textContent = error.message; return; }
  salesRun(async () => { salesFilters = { stage: String(values.stage || 'all'), q, departmentId: String(values.departmentId || '') }; salesPage = 1; await salesLoadList(); salesElement('sales-feedback').textContent = 'Filtros aplicados.'; });
});
salesElement('sales-filter-clear').addEventListener('click', () => { if (!salesBusy) salesRun(async () => { salesFilters = { stage: 'all', q: '', departmentId: '' }; salesWriteFilters(); salesPage = 1; await salesLoadList(); salesElement('sales-feedback').textContent = 'Filtros limpos.'; }); });
salesElement('sales-contact-filters').addEventListener('submit', event => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); if (salesBusy || salesCreateDraft.pending) return; let q;
  try { q = salesQuery(values.q); } catch (error) { salesElement('sales-contact-feedback').textContent = error.message; return; }
  salesRun(async () => { salesContactFilters = { q, departmentId: String(values.departmentId || '') }; salesContactPage = 1; const confirmed = await salesLoadContactChoices(); if (confirmed) salesElement('sales-contact-feedback').textContent = 'Busca de contatos atualizada.'; });
});
salesElement('sales-refresh').addEventListener('click', () => salesRun(async () => { await salesLoadDepartments(); await salesLoadList(); await salesLoadContactChoices(); salesElement('sales-feedback').textContent = 'Vendas atualizadas. Rascunhos preservados.'; }));
salesElement('sales-previous').addEventListener('click', () => salesRun(async () => { salesPage--; await salesLoadList(); }));
salesElement('sales-next').addEventListener('click', () => salesRun(async () => { salesPage++; await salesLoadList(); }));
salesElement('sales-contact-previous').addEventListener('click', () => { if (!salesCreateDraft.pending) salesRun(async () => { salesContactPage--; await salesLoadContactChoices(); }); });
salesElement('sales-contact-next').addEventListener('click', () => { if (!salesCreateDraft.pending) salesRun(async () => { salesContactPage++; await salesLoadContactChoices(); }); });
salesElement('sales-events-previous').addEventListener('click', () => salesRun(async () => { salesEventsPage--; await salesLoadEvents(); }));
salesElement('sales-events-next').addEventListener('click', () => salesRun(async () => { salesEventsPage++; await salesLoadEvents(); }));
salesElement('sales-new').addEventListener('click', () => { if (salesBusy) return; salesSelectedId = null; salesSelected = null; salesConfirmed = false; salesMode = 'create'; salesRenderMode(); salesWriteValues('create', salesCreateDraft.values); salesRenderCreateContact(); salesElement('sales-create-title').focus(); salesElement('sales-list').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', 'false')); });
salesElement('sales-detail-retry').addEventListener('click', () => { if (salesSelectedId) salesRun(() => salesLoadDetail(salesSelectedId), 'sales-edit-title'); });
salesElement('sales-login-retry').addEventListener('click', salesInitialize); salesElement('sales-pending-retry').addEventListener('click', salesInitialize);
salesElement('sales-logout').addEventListener('click', () => salesRun(async () => { await salesApi('/api/auth/logout', { method: 'POST', headers: salesHeaders(), body: '{}' }); salesForget(); salesElement('sales-login').hidden = false; salesElement('sales-description').textContent = 'Entre com sua conta da equipe para acessar vendas.'; salesElement('sales-feedback').textContent = 'Sessão encerrada. Entre novamente para acessar vendas.'; }));
window.addEventListener('pagehide', () => { salesDisposed = true; salesGeneration++; salesController?.abort(); salesBusy = false; salesConfirmed = false; salesCreateContactConfirmed = false; });
window.addEventListener('pageshow', event => { if (event.persisted) { salesDisposed = false; salesInitialize({ preserve: true }); } });
salesInitialize();
