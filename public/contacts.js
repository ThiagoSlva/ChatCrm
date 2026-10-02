'use strict';

const contactsElement = id => document.getElementById(id);
const contactsFields = ['name', 'kind', 'company', 'email', 'phone'];
const contactsKinds = { lead: 'Lead', contact: 'Contato', customer: 'Cliente' };
const contactsEmptyValues = () => ({ departmentId: '', name: '', kind: 'lead', company: '', email: '', phone: '' });
let contactsProfile = null;
let contactsCsrf = null;
let contactsBusy = false;
let contactsGeneration = 0;
let contactsController = null;
let contactsDisposed = false;
let contactsDepartments = [];
let contactsFilters = { kind: 'all', q: '', departmentId: '' };
let contactsPage = 1;
let contactsTotal = 0;
let contactsSelectedId = null;
let contactsSelected = null;
let contactsConfirmed = false;
let contactsOutsidePage = false;
let contactsMode = 'create';
let contactsCreateDraft = { values: contactsEmptyValues(), pending: null };
const contactsDrafts = new Map();

function contactsError(status) {
  return ({ 400: 'Confira os campos e os limites informados antes de tentar novamente.', 401: 'Entre com sua conta da equipe para consultar os cadastros.', 403: 'Esta ação não está autorizada para sua conta.', 404: 'O cadastro ou a área está inacessível. Confira seus vínculos com o administrador.', 409: 'O cadastro mudou ou os dados do pedido conflitaram. Revise antes de salvar novamente.', 413: 'Os dados excederam o limite da instalação. Edite os campos e tente novamente.', 429: 'O limite de cadastros desta instalação foi atingido. Consulte o administrador.', 503: 'O cadastro de contatos aguarda preparação na hospedagem.' })[status] || 'Não foi possível confirmar a operação. O rascunho foi preservado; tente novamente.';
}
async function contactsApi(url, options = {}) {
  const generation = contactsGeneration; const controller = contactsController;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal });
  const data = await response.json().catch(() => ({}));
  if (generation !== contactsGeneration || controller !== contactsController || controller.signal.aborted || contactsDisposed) { const error = new Error('Request superseded.'); error.name = 'AbortError'; throw error; }
  if (!response.ok) { const error = new Error(contactsError(response.status)); error.status = response.status; throw error; }
  return data;
}
const contactsHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': contactsCsrf });
function contactsValues(contact) { return Object.fromEntries(contactsFields.map(field => [field, String(contact[field] || '')])); }
function contactsNewDraft(contact) { const values = contactsValues(contact); return { values: { ...values }, base: { ...values }, version: contact.version, conflict: false, current: null, pending: null }; }
function contactsChanged(draft) { return contactsFields.filter(field => draft.values[field] !== draft.base[field]); }
function contactsCapture(prefix) { return Object.fromEntries(new FormData(contactsElement('contacts-' + prefix))); }
function contactsWriteValues(prefix, values) { for (const [field, value] of Object.entries(values)) { const element = contactsElement('contacts-' + prefix + '-' + (field === 'departmentId' ? 'department' : field)); if (element) element.value = String(value); } }
function contactsSetControls() {
  for (const id of ['contacts-login-retry', 'contacts-pending-retry', 'contacts-logout', 'contacts-refresh', 'contacts-new', 'contacts-filter-apply', 'contacts-filter-clear']) contactsElement(id).disabled = contactsBusy;
  contactsElement('contacts-filters').querySelectorAll('input, select').forEach(element => { element.disabled = contactsBusy; });
  contactsElement('contacts-list').querySelectorAll('button').forEach(element => { element.disabled = contactsBusy; });
  contactsElement('contacts-previous').disabled = contactsBusy || contactsPage === 1;
  contactsElement('contacts-next').disabled = contactsBusy || contactsPage * 20 >= contactsTotal;
  contactsElement('contacts-create').querySelectorAll('input, select').forEach(element => { element.disabled = contactsBusy || Boolean(contactsCreateDraft.pending); });
  const canCreate = contactsDepartments.some(department => String(department.id) === contactsCreateDraft.values.departmentId);
  contactsElement('contacts-create-submit').disabled = contactsBusy || (!contactsCreateDraft.pending && !canCreate);
  contactsElement('contacts-create-submit').textContent = contactsCreateDraft.pending ? 'Confirmar mesmo cadastro' : 'Salvar cadastro';
  const draft = contactsDrafts.get(contactsSelectedId);
  contactsElement('contacts-edit').querySelectorAll('input, select').forEach(element => { element.disabled = contactsBusy || !contactsConfirmed || Boolean(draft?.pending); });
  contactsElement('contacts-edit-submit').disabled = contactsBusy || !contactsConfirmed || !draft || draft.conflict || (!draft.pending && contactsChanged(draft).length === 0);
  contactsElement('contacts-edit-submit').textContent = draft?.pending ? 'Confirmar mesma alteração' : 'Salvar alterações';
  contactsElement('contacts-current-reload').disabled = contactsBusy || !contactsSelectedId;
  contactsElement('contacts-use-version').disabled = contactsBusy || !draft?.current || !draft.conflict;
  contactsElement('contacts-detail-retry').disabled = contactsBusy || !contactsSelectedId;
  contactsElement('contacts-space').setAttribute('aria-busy', String(contactsBusy));
}
function contactsClearIdentity() {
  contactsProfile = null; contactsCsrf = null; contactsDepartments = [];
  contactsFilters = { kind: 'all', q: '', departmentId: '' }; contactsPage = 1; contactsTotal = 0;
  contactsSelectedId = null; contactsSelected = null; contactsConfirmed = false; contactsOutsidePage = false; contactsMode = 'create';
  contactsCreateDraft = { values: contactsEmptyValues(), pending: null }; contactsDrafts.clear();
  contactsElement('contacts-list').replaceChildren(); contactsElement('contacts-current-values').replaceChildren();
  contactsElement('contacts-identity').textContent = ''; contactsElement('contacts-page').textContent = '';
  contactsElement('contacts-create-feedback').textContent = ''; contactsElement('contacts-edit-feedback').textContent = '';
  contactsElement('contacts-edit-detail').textContent = ''; contactsElement('contacts-edit-version').textContent = '';
  contactsElement('contacts-space').hidden = true; contactsElement('contacts-edit').hidden = true; contactsElement('contacts-detail-unavailable').hidden = true;
  contactsWriteValues('create', contactsCreateDraft.values); contactsWriteValues('edit', contactsEmptyValues()); contactsWriteFilters();
}
function contactsForget() { contactsGeneration++; contactsController?.abort(); contactsBusy = false; contactsClearIdentity(); contactsSetControls(); }
function contactsPending(message, connectionFailure = false) {
  contactsConfirmed = false;
  contactsElement('contacts-space').hidden = true; contactsElement('contacts-pending').hidden = false; contactsElement('contacts-feedback').textContent = '';
  contactsElement('contacts-description').textContent = connectionFailure ? 'Não foi possível verificar seu acesso. Tente novamente abaixo.' : 'O cadastro de contatos ainda precisa ser preparado na hospedagem.';
  contactsElement('contacts-pending-title').textContent = connectionFailure ? 'Vamos conferir a conexão' : 'Prepare o cadastro de contatos';
  contactsElement('contacts-pending-description').textContent = message;
}
async function contactsRun(work, focusId = null) {
  if (contactsBusy || contactsDisposed) return;
  const generation = contactsGeneration; const focusedId = document.activeElement?.id;
  contactsBusy = true; contactsController = new AbortController(); contactsSetControls();
  try { await work(); }
  catch (error) {
    if (generation !== contactsGeneration || contactsDisposed || error.name === 'AbortError') return;
    if (error.status === 401) {
      contactsForget(); contactsElement('contacts-login').hidden = false; contactsElement('contacts-pending').hidden = true;
      contactsElement('contacts-description').textContent = 'Entre com sua conta da equipe para acessar os contatos.'; contactsElement('contacts-feedback').textContent = error.message;
    } else if (error.status === 503) contactsPending(error.message);
    else if (contactsElement('contacts-space').hidden) contactsPending(error.status ? error.message : 'A conexão falhou. Use Verificar novamente para tentar outra vez.', true);
    else {
      if (contactsSelectedId && !contactsConfirmed) contactsHideDetail('Não foi possível confirmar o cadastro nesta atualização. Seu rascunho foi preservado; use Verificar cadastro novamente.');
      contactsElement('contacts-feedback').textContent = error.uiMessage || (error.status ? error.message : 'A conexão falhou. Seus rascunhos e pedidos pendentes foram preservados nesta aba.');
    }
  } finally {
    if (generation === contactsGeneration) {
      contactsBusy = false; contactsSetControls();
      const element = contactsElement(focusId || focusedId);
      if (element && !element.disabled && !element.closest('[hidden]')) element.focus();
    }
  }
}
async function contactsInitialize({ preserve = Boolean(contactsProfile) } = {}) {
  if (contactsBusy) return;
  const previousId = preserve ? contactsProfile?.user.id : null;
  if (preserve) { contactsGeneration++; contactsController?.abort(); contactsConfirmed = false; }
  else contactsForget();
  contactsElement('contacts-space').hidden = true; contactsElement('contacts-login').hidden = true; contactsElement('contacts-pending').hidden = true; contactsElement('contacts-feedback').textContent = 'Verificando seu acesso…';
  await contactsRun(async () => {
    const profile = await contactsApi('/api/auth/me');
    if (profile.user.id !== previousId) contactsClearIdentity();
    contactsProfile = profile; contactsCsrf = profile.csrfToken;
    if (profile.capabilities?.contacts !== true) { contactsPending('O módulo aguarda preparação na hospedagem. Acesso, equipe e atendimento continuam disponíveis.'); return; }
    contactsElement('contacts-space').hidden = false;
    contactsElement('contacts-description').textContent = 'Organize pessoas e empresas por área, com cadastro manual e acesso da sua equipe.';
    contactsElement('contacts-identity').textContent = `${profile.user.name} · ${profile.company}`;
    await contactsLoadDepartments(); await contactsLoadList(); contactsRenderMode();
    contactsElement('contacts-feedback').textContent = '';
  });
}
function contactsWriteFilters() {
  contactsElement('contacts-filter-kind').value = contactsFilters.kind;
  contactsElement('contacts-filter-query').value = contactsFilters.q;
  contactsElement('contacts-filter-department').value = contactsFilters.departmentId;
}
async function contactsLoadDepartments() {
  const data = await contactsApi('/api/team/departments?page=1&limit=50');
  contactsDepartments = data.departments.filter(department => department.active);
  const filter = contactsElement('contacts-filter-department'); const create = contactsElement('contacts-create-department');
  const filterValue = filter.value; const createValue = contactsCreateDraft.values.departmentId;
  filter.replaceChildren(); create.replaceChildren();
  const all = document.createElement('option'); all.value = ''; all.textContent = 'Todas as minhas áreas'; filter.append(all);
  const choose = document.createElement('option'); choose.value = ''; choose.textContent = contactsDepartments.length ? 'Escolha uma área' : 'Nenhuma área disponível'; create.append(choose);
  for (const department of contactsDepartments) {
    for (const select of [filter, create]) { const option = document.createElement('option'); option.value = String(department.id); option.textContent = department.name; select.append(option); }
  }
  // Preserve selections without presenting a revoked area as currently accessible.
  for (const [select, value] of [[filter, filterValue], [create, createValue]]) {
    if (value && !contactsDepartments.some(department => String(department.id) === value)) { const option = document.createElement('option'); option.value = value; option.textContent = 'Área do rascunho ou filtro (indisponível)'; select.append(option); }
    select.value = value;
  }
  if (!contactsCreateDraft.pending && !createValue && contactsDepartments.length === 1) contactsCreateDraft.values.departmentId = String(contactsDepartments[0].id);
  contactsWriteValues('create', contactsCreateDraft.values); contactsElement('contacts-no-departments').hidden = contactsDepartments.length !== 0; contactsSetControls();
}
function contactsListUrl() {
  const query = new URLSearchParams({ page: String(contactsPage), limit: '20', kind: contactsFilters.kind });
  if (contactsFilters.q) query.set('q', contactsFilters.q);
  if (contactsFilters.departmentId) query.set('departmentId', contactsFilters.departmentId);
  return '/api/crm/contacts?' + query.toString();
}
async function contactsLoadList() {
  if (contactsSelectedId) contactsHideDetail('Verificando o acesso e a versão deste cadastro…');
  let data = await contactsApi(contactsListUrl());
  const last = Math.max(1, Math.ceil(data.total / data.limit));
  if (data.page > last) { contactsPage = last; data = await contactsApi(contactsListUrl()); }
  contactsPage = data.page; contactsTotal = data.total;
  contactsElement('contacts-list').replaceChildren(); contactsElement('contacts-empty').hidden = data.total !== 0;
  contactsElement('contacts-page').textContent = `Página ${data.page} de ${Math.max(1, Math.ceil(data.total / data.limit))} · ${data.total} ${data.total === 1 ? 'cadastro' : 'cadastros'}`;
  for (const contact of data.contacts) {
    const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button'; button.id = 'contacts-row-' + contact.id; button.className = 'conversation-select';
    const name = document.createElement('strong'); name.textContent = contact.name;
    const detail = document.createElement('span'); detail.textContent = `${contactsKinds[contact.kind]} · ${contact.departmentName}`;
    const company = document.createElement('span'); company.textContent = contact.company || 'Empresa não informada';
    button.append(name, detail, company); button.setAttribute('aria-pressed', String(contact.id === contactsSelectedId));
    button.addEventListener('click', () => contactsRun(() => contactsSelect(contact.id), 'contacts-edit-title'));
    item.append(button); contactsElement('contacts-list').append(item);
  }
  if (contactsSelectedId) { contactsOutsidePage = !data.contacts.some(contact => contact.id === contactsSelectedId); await contactsLoadDetail(contactsSelectedId); }
  contactsSetControls();
}
function contactsHideDetail(message, revoked = false) {
  contactsConfirmed = false; contactsSelected = null;
  contactsElement('contacts-edit').hidden = true; contactsElement('contacts-detail-unavailable').hidden = contactsMode !== 'edit';
  contactsElement('contacts-detail-unavailable-description').textContent = message;
  if (revoked) {
    const id = contactsSelectedId; contactsSelectedId = null;
    contactsElement('contacts-row-' + id)?.closest('li')?.remove(); contactsElement('contacts-current-values').replaceChildren();
    contactsWriteValues('edit', contactsEmptyValues()); contactsElement('contacts-edit-detail').textContent = ''; contactsElement('contacts-edit-version').textContent = '';
  }
  contactsSetControls();
}
async function contactsSelect(id) {
  contactsSelectedId = id; contactsMode = 'edit'; contactsOutsidePage = false;
  contactsHideDetail('Verificando o acesso e a versão deste cadastro…'); contactsRenderMode();
  await contactsLoadDetail(id);
}
async function contactsLoadDetail(id) {
  const generation = contactsGeneration;
  let data;
  try { data = await contactsApi('/api/crm/contacts/' + id); }
  catch (error) {
    if (generation === contactsGeneration && contactsSelectedId === id) contactsHideDetail(error.status === 403 || error.status === 404 ? 'Este cadastro não está mais acessível. O detalhe foi ocultado; confira seus vínculos com o administrador.' : 'A conexão falhou ao verificar o cadastro. Seu rascunho foi preservado. Tente verificar novamente.', error.status === 403 || error.status === 404);
    throw error;
  }
  if (generation !== contactsGeneration || contactsSelectedId !== id) return;
  contactsSelected = data.contact; contactsConfirmed = true;
  let draft = contactsDrafts.get(id);
  if (!draft || (contactsChanged(draft).length === 0 && !draft.pending && !draft.conflict)) { draft = contactsNewDraft(data.contact); contactsDrafts.set(id, draft); }
  else if (draft.version !== data.contact.version) { draft.conflict = true; draft.current = data.contact; }
  contactsRenderEdit(); contactsRenderMode();
}
function contactsRenderMode() {
  contactsElement('contacts-create').hidden = contactsMode !== 'create';
  contactsElement('contacts-edit').hidden = contactsMode !== 'edit' || !contactsConfirmed;
  contactsElement('contacts-detail-unavailable').hidden = contactsMode !== 'edit' || contactsConfirmed;
  contactsSetControls();
}
function contactsRenderEdit() {
  const draft = contactsDrafts.get(contactsSelectedId); if (!draft || !contactsSelected || !contactsConfirmed) return;
  contactsWriteValues('edit', draft.values);
  contactsElement('contacts-edit-detail').textContent = `${contactsSelected.departmentName} · ${contactsKinds[contactsSelected.kind]}${contactsOutsidePage ? ' · fora dos filtros ou desta página' : ''}`;
  contactsElement('contacts-edit-version').textContent = `Versão do rascunho: ${draft.version}.${draft.pending ? ' Há uma alteração aguardando confirmação.' : ''}`;
  contactsElement('contacts-conflict').hidden = !draft.conflict && !draft.current;
  contactsElement('contacts-current-values').replaceChildren(); contactsElement('contacts-current-values').hidden = !draft.current;
  contactsElement('contacts-use-version').hidden = !draft.conflict || !draft.current;
  contactsElement('contacts-conflict-description').textContent = draft.conflict ? 'O cadastro mudou. Seu rascunho continua no formulário. Compare os dados atuais abaixo; usar a nova versão não copia nem salva campos automaticamente.' : 'Você escolheu a versão atual. Compare seu rascunho com estes dados antes de salvar. Somente os campos que você alterou serão enviados.';
  if (draft.current) {
    const values = { 'Versão atual': String(draft.current.version), Nome: draft.current.name, Classificação: contactsKinds[draft.current.kind], Empresa: draft.current.company || 'Não informada', 'E-mail': draft.current.email || 'Não informado', Telefone: draft.current.phone || 'Não informado' };
    for (const [label, value] of Object.entries(values)) { const title = document.createElement('dt'); title.textContent = label; const description = document.createElement('dd'); description.textContent = value; contactsElement('contacts-current-values').append(title, description); }
  }
  if (draft.conflict) contactsElement('contacts-edit-feedback').textContent = 'O cadastro tem uma versão mais recente. Seu rascunho foi preservado; revise antes de reaplicar.';
  contactsSetControls();
}
function contactsNormalize(values) {
  const result = {};
  for (const field of contactsFields) result[field] = String(values[field] || '').normalize('NFC').trim();
  result.email = result.email.toLowerCase();
  if (result.name.length < 2 || result.name.length > 100 || result.company.length > 100 || result.email.length > 254 || result.phone.length > 40 || Object.values(result).some(value => /[\u0000-\u001f\u007f]/u.test(value))) throw new Error('Confira os campos: nome de 2 a 100 caracteres, empresa até 100, e-mail até 254 e telefone até 40, sem caracteres de controle.');
  if (result.email && (!/^[\x21-\x7e]+$/u.test(result.email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(result.email))) throw new Error('Informe um e-mail válido com caracteres ASCII ou deixe o campo vazio.');
  if (!/^[0-9 +()-]*$/u.test(result.phone)) throw new Error('Use somente números, espaços, +, parênteses e hífen no telefone.');
  if (!Object.hasOwn(contactsKinds, result.kind)) throw new Error('Escolha Lead, Contato ou Cliente.');
  return result;
}
function contactsClientKey() { const bytes = crypto.getRandomValues(new Uint8Array(16)); return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
contactsElement('contacts-create').addEventListener('submit', event => {
  event.preventDefault(); if (contactsBusy || !contactsProfile) return;
  const values = contactsCapture('create');
  if (!contactsCreateDraft.pending) {
    let normalized;
    try { normalized = contactsNormalize(values); } catch (error) { contactsElement('contacts-create-feedback').textContent = error.message; return; }
    const departmentId = Number(values.departmentId);
    if (!contactsDepartments.some(department => department.id === departmentId)) { contactsElement('contacts-create-feedback').textContent = 'Escolha uma área ativa à qual você tem acesso.'; return; }
    contactsCreateDraft.values = { ...normalized, departmentId: String(departmentId) };
    contactsCreateDraft.pending = { ...normalized, departmentId, clientKey: contactsClientKey() };
    contactsWriteValues('create', contactsCreateDraft.values);
  }
  const payload = { ...contactsCreateDraft.pending };
  contactsRun(async () => {
    contactsElement('contacts-create-feedback').textContent = 'Confirmando cadastro…';
    let data;
    try { data = await contactsApi('/api/crm/contacts', { method: 'POST', headers: contactsHeaders(), body: JSON.stringify(payload) }); }
    catch (error) {
      if ([400, 413, 409].includes(error.status)) contactsCreateDraft.pending = null;
      contactsElement('contacts-create-feedback').textContent = error.status === 409 ? 'Os dados do pedido conflitaram. Nada será sobrescrito automaticamente. Revise os campos e envie um novo pedido.' : error.status ? error.message : 'Não foi possível confirmar. Os campos estão preservados e bloqueados: confirme o mesmo cadastro para evitar duplicação.';
      throw error;
    }
    const departmentId = contactsCreateDraft.values.departmentId;
    contactsCreateDraft = { values: { ...contactsEmptyValues(), departmentId }, pending: null };
    contactsWriteValues('create', contactsCreateDraft.values); contactsElement('contacts-create-feedback').textContent = 'Cadastro confirmado.';
    contactsElement('contacts-feedback').textContent = 'Cadastro salvo. Confira os dados no detalhe.'; contactsPage = 1;
    try { await contactsLoadList(); await contactsSelect(data.contact.id); } catch (error) { error.uiMessage = 'O cadastro foi confirmado, mas não foi possível atualizar seu detalhe. Use Atualizar contatos para verificar.'; throw error; }
  }, 'contacts-edit-title');
});
contactsElement('contacts-edit').addEventListener('submit', event => {
  event.preventDefault(); if (contactsBusy || !contactsConfirmed || !contactsSelectedId) return;
  const id = contactsSelectedId; const draft = contactsDrafts.get(id); if (!draft || draft.conflict) return;
  const values = contactsCapture('edit');
  if (!draft.pending) {
    try { draft.values = contactsNormalize(values); } catch (error) { contactsElement('contacts-edit-feedback').textContent = error.message; return; }
    const changed = contactsChanged(draft); if (!changed.length) return;
    draft.pending = { version: draft.version, ...Object.fromEntries(changed.map(field => [field, draft.values[field]])) };
  }
  const payload = { ...draft.pending };
  contactsRun(async () => {
    contactsElement('contacts-edit-feedback').textContent = 'Confirmando alterações…';
    let data;
    try { data = await contactsApi('/api/crm/contacts/' + id, { method: 'PATCH', headers: contactsHeaders(), body: JSON.stringify(payload) }); }
    catch (error) {
      if (error.status === 400 || error.status === 413) draft.pending = null;
      if (error.status === 409) { draft.conflict = true; draft.current = null; contactsElement('contacts-edit-feedback').textContent = 'A versão mudou. Consulte os dados atuais e revise o rascunho antes de reaplicar.'; contactsRenderEdit(); }
      else if (error.status === 403 || error.status === 404) contactsHideDetail('Este cadastro não está mais acessível. O detalhe foi ocultado; confira seus vínculos.', true);
      else contactsElement('contacts-edit-feedback').textContent = error.status ? error.message : 'Não foi possível confirmar a alteração. O mesmo pedido e a versão foram preservados; confirme novamente ou consulte os dados atuais.';
      throw error;
    }
    contactsSelected = data.contact; contactsConfirmed = true; contactsDrafts.set(id, contactsNewDraft(data.contact)); contactsRenderEdit();
    contactsElement('contacts-edit-feedback').textContent = 'Alterações salvas.'; contactsElement('contacts-feedback').textContent = 'Cadastro atualizado.';
    try { await contactsLoadList(); } catch (error) { error.uiMessage = 'As alterações foram confirmadas, mas a lista não pôde ser atualizada. Use Atualizar contatos para verificar.'; throw error; }
  });
});
for (const prefix of ['create', 'edit']) {
  for (const field of contactsFields.concat(prefix === 'create' ? ['department'] : [])) {
    const element = contactsElement('contacts-' + prefix + '-' + field);
    const save = () => {
      if (prefix === 'create') { if (!contactsCreateDraft.pending) contactsCreateDraft.values[field === 'department' ? 'departmentId' : field] = element.value; }
      else { const draft = contactsDrafts.get(contactsSelectedId); if (draft && !draft.pending) draft.values[field] = element.value; }
      contactsSetControls();
    };
    element.addEventListener('input', save); element.addEventListener('change', save);
  }
}
contactsElement('contacts-current-reload').addEventListener('click', () => {
  if (!contactsSelectedId || contactsBusy) return; const id = contactsSelectedId;
  contactsRun(async () => {
    contactsHideDetail('Verificando o acesso e a versão deste cadastro…');
    let data;
    try { data = await contactsApi('/api/crm/contacts/' + id); }
    catch (error) {
      if (error.status === 403 || error.status === 404) contactsHideDetail('Este cadastro não está mais acessível. O detalhe foi ocultado; confira seus vínculos.', true);
      throw error;
    }
    const draft = contactsDrafts.get(id); if (!draft || contactsSelectedId !== id) return;
    contactsSelected = data.contact; contactsConfirmed = true; draft.current = data.contact; draft.conflict = true;
    contactsRenderEdit(); contactsRenderMode(); contactsElement('contacts-edit-feedback').textContent = 'Dados atuais consultados. Compare os campos; usar esta versão mantém seu rascunho e exige salvar novamente.';
  });
});
contactsElement('contacts-use-version').addEventListener('click', () => {
  if (contactsBusy || !contactsConfirmed) return;
  const draft = contactsDrafts.get(contactsSelectedId); if (!draft?.current || !draft.conflict) return;
  draft.version = draft.current.version; draft.conflict = false; draft.pending = null;
  contactsRenderEdit(); contactsElement('contacts-edit-feedback').textContent = 'Versão atual escolhida. Revise seu rascunho e clique Salvar alterações para reaplicar somente os campos alterados.';
});
contactsElement('contacts-filters').addEventListener('submit', event => {
  event.preventDefault(); const values = contactsCapture('filters'); if (contactsBusy) return;
  const q = String(values.q || '').normalize('NFC').trim();
  if (q.length > 100 || /[\u0000-\u001f\u007f]/u.test(q)) { contactsElement('contacts-feedback').textContent = 'Use até 100 caracteres na busca, sem caracteres de controle.'; return; }
  const filters = { kind: String(values.kind || 'all'), q, departmentId: String(values.departmentId || '') };
  contactsRun(async () => { contactsFilters = filters; contactsPage = 1; await contactsLoadList(); contactsElement('contacts-feedback').textContent = 'Filtros aplicados.'; });
});
contactsElement('contacts-filter-clear').addEventListener('click', () => {
  if (contactsBusy) return;
  contactsRun(async () => { contactsFilters = { kind: 'all', q: '', departmentId: '' }; contactsWriteFilters(); contactsPage = 1; await contactsLoadList(); contactsElement('contacts-feedback').textContent = 'Filtros limpos.'; });
});
contactsElement('contacts-refresh').addEventListener('click', () => contactsRun(async () => { await contactsLoadDepartments(); await contactsLoadList(); contactsElement('contacts-feedback').textContent = 'Contatos atualizados. Rascunhos preservados.'; }));
contactsElement('contacts-previous').addEventListener('click', () => contactsRun(async () => { contactsPage--; await contactsLoadList(); }));
contactsElement('contacts-next').addEventListener('click', () => contactsRun(async () => { contactsPage++; await contactsLoadList(); }));
contactsElement('contacts-new').addEventListener('click', () => {
  if (contactsBusy) return;
  contactsSelectedId = null; contactsSelected = null; contactsConfirmed = false; contactsMode = 'create'; contactsRenderMode();
  contactsWriteValues('create', contactsCreateDraft.values); contactsElement('contacts-create-title').focus();
  contactsElement('contacts-list').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', 'false'));
});
contactsElement('contacts-detail-retry').addEventListener('click', () => { if (contactsSelectedId) contactsRun(() => contactsLoadDetail(contactsSelectedId), 'contacts-edit-title'); });
contactsElement('contacts-login-retry').addEventListener('click', contactsInitialize); contactsElement('contacts-pending-retry').addEventListener('click', contactsInitialize);
contactsElement('contacts-logout').addEventListener('click', () => contactsRun(async () => {
  await contactsApi('/api/auth/logout', { method: 'POST', headers: contactsHeaders(), body: '{}' }); contactsForget();
  contactsElement('contacts-login').hidden = false; contactsElement('contacts-description').textContent = 'Entre com sua conta da equipe para acessar os contatos.'; contactsElement('contacts-feedback').textContent = 'Sessão encerrada. Entre novamente para acessar seus cadastros.';
}));
window.addEventListener('pagehide', () => { contactsDisposed = true; contactsGeneration++; contactsController?.abort(); contactsBusy = false; contactsConfirmed = false; });
window.addEventListener('pageshow', event => { if (event.persisted) { contactsDisposed = false; contactsInitialize({ preserve: true }); } });
contactsInitialize();
