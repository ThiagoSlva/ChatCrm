'use strict';

const byId = id => document.getElementById(id);
const panels = ['configuration', 'setup', 'login', 'account'];
let csrfToken = null;
let teamPage = 1;
let teamBusy = false;
let teamTotal = 0;
let departmentsAdmin = false;
let departmentsBusy = false;
let departmentsPage = 1;
let departmentsTotal = 0;
let departmentsGeneration = 0;
let selectedDepartment = null;
let departmentOperators = [];
let departmentMemberIds = new Set();
let membersPage = 1;
const departmentPageSize = 20;
let chatAvailable = false;
let departmentChannelLoaded = false;
function show(panel, title, description) {
  panels.forEach(id => { byId(id).hidden = id !== panel; });
  byId('title').textContent = title;
  byId('description').textContent = description;
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Não foi possível conectar ao banco. Confira a configuração e a migração.'); error.status = response.status; throw error; }
  return data;
}
async function refresh() {
  csrfToken = null;
  resetDepartments();
  const generation = departmentsGeneration;
  byId('team').hidden = true;
  byId('operator-list').replaceChildren();
  byId('operator-create').reset();
  byId('password-change').reset();
  byId('password-message').textContent = '';
  byId('message').textContent = '';
  try {
    const installation = await api('/api/installation');
    if (generation !== departmentsGeneration) return;
    if (installation.state === 'configuration-required') return show('configuration', 'Prepare sua instalação.', 'Falta configurar o banco e a URL do sistema na hospedagem.');
    if (installation.state === 'setup') return show('setup', 'Sua equipe começa aqui.', 'Crie sua empresa e o primeiro administrador.');
    try {
      const profile = await api('/api/auth/me');
      if (generation !== departmentsGeneration) return;
      csrfToken = profile.csrfToken;
      chatAvailable = profile.capabilities?.chat === true;
      byId('chat-shortcut').hidden = !chatAvailable;
      byId('user-name').textContent = profile.user.name;
      byId('user-detail').textContent = `${profile.company} · ${profile.user.email} · ${profile.user.role === 'admin' ? 'Administrador' : 'Operador'}`;
      byId('role-description').textContent = profile.user.role === 'admin' ? 'Gerencie os operadores e os departamentos da sua equipe abaixo.' : 'Você tem acesso de operador. A gestão da equipe fica com o administrador.';
      show('account', 'Bem-vindo à sua empresa.', 'Você entrou no Conversa Livre.');
      if (profile.user.role === 'admin') {
        byId('team').hidden = false; teamPage = 1;
        try { await loadTeam(); } catch (error) { if (error.status === 401) throw error; byId('team-message').textContent = 'Não foi possível carregar a equipe. Use Atualizar equipe para tentar novamente.'; }
      }
      if (generation !== departmentsGeneration) return;
      departmentsAdmin = profile.user.role === 'admin';
      if (profile.capabilities?.departments === true) {
        byId('departments').hidden = false;
        byId('department-create').hidden = !departmentsAdmin;
        byId('departments-title').textContent = departmentsAdmin ? 'Departamentos de atendimento' : 'Seus departamentos';
        byId('departments-description').textContent = departmentsAdmin ? 'Organize quem pode atender em cada área. Só os operadores vinculados a departamentos ativos podem acessar seu atendimento.' : 'Aqui aparecem apenas os departamentos ativos aos quais você está vinculado.';
        try { await loadDepartments(); }
        catch (error) { if (error.status === 401) throw error; showDepartmentError(error); }
      } else byId('departments-pending').hidden = !departmentsAdmin;
    } catch (error) {
      if (generation !== departmentsGeneration) return;
      if (error.status !== 401) throw error;
      show('login', 'Bom ter você por aqui.', 'Entre para acessar o espaço da sua equipe.');
    }
  } catch (error) { if (generation !== departmentsGeneration) return; show('configuration', 'Vamos conferir o banco.', 'A instalação ainda precisa de uma verificação.'); byId('message').textContent = error.message; }
}
for (const id of ['setup', 'login']) {
  byId(id).addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    byId('message').textContent = 'Aguarde…';
    try {
      const body = Object.fromEntries(new FormData(form));
      await api(id === 'setup' ? '/api/install' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      form.reset();
      await refresh();
      if (id === 'setup') byId('message').textContent = 'Administrador criado. Entre com seu e-mail e sua senha. Remova SETUP_TOKEN na hospedagem.';
    } catch (error) { byId('message').textContent = error.message; }
    finally { button.disabled = false; }
  });
}
byId('logout').addEventListener('click', async () => {
  byId('logout').disabled = true;
  try { await api('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } }); csrfToken = null; await refresh(); }
  catch (error) { byId('message').textContent = error.message; }
  finally { byId('logout').disabled = false; }
});
byId('retry').addEventListener('click', refresh);
byId('password-change').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  if (body.newPassword !== body.confirmation) { byId('password-message').textContent = 'A confirmação deve ser igual à nova senha.'; return; }
  const controls = form.querySelectorAll('input, button');
  controls.forEach(control => { control.disabled = true; });
  byId('password-message').textContent = 'Aguarde…';
  try {
    await api('/api/auth/password', { method: 'POST', headers: teamHeaders(), body: JSON.stringify(body) });
    form.reset(); await refresh();
    byId('message').textContent = 'Senha alterada e sessões encerradas. Entre com sua nova senha.';
    byId('email').focus();
  } catch (error) {
    form.reset();
    if (error.status === 401 || error.status === 409) { await refresh(); byId('message').textContent = error.message; }
    else byId('password-message').textContent = error.message;
  } finally { controls.forEach(control => { control.disabled = false; }); }
});

function teamHeaders() { return { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }; }
function setTeamBusy(value) {
  teamBusy = value;
  byId('team').querySelectorAll('button, input').forEach(control => { control.disabled = value; });
}
async function loadTeam() {
  const generation = departmentsGeneration;
  const data = await api(`/api/team/operators?page=${teamPage}&limit=20`);
  if (generation !== departmentsGeneration) return;
  teamTotal = data.total;
  // Deactivation retains rows, so page counts remain stable while managing access.
  byId('operator-list').replaceChildren();
  byId('team-empty').hidden = data.total !== 0;
  byId('team-page').textContent = `Página ${data.page} de ${Math.max(1, Math.ceil(data.total / data.limit))} · ${data.total} ${data.total === 1 ? 'operador' : 'operadores'}`;
  byId('team-previous').disabled = data.page === 1;
  byId('team-next').disabled = data.page * data.limit >= data.total;
  for (const user of data.users) {
    const item = document.createElement('li');
    const detail = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = user.name;
    const email = document.createElement('span'); email.textContent = user.email;
    const state = document.createElement('span'); state.textContent = user.active ? 'Ativo' : 'Desativado'; state.className = 'operator-state';
    detail.append(name, email, state);
    const action = document.createElement('button'); action.type = 'button'; action.className = 'secondary-button'; action.textContent = user.active ? 'Desativar' : 'Reativar'; action.setAttribute('aria-label', `${action.textContent} ${user.name}`);
    action.addEventListener('click', () => teamAction(async () => {
      await api(`/api/team/operators/${user.id}`, { method: 'PATCH', headers: teamHeaders(), body: JSON.stringify({ active: !user.active }) });
      byId('team-message').textContent = user.active ? 'Operador desativado e sessões encerradas.' : 'Operador reativado. Ele pode entrar novamente.';
    }));
    item.append(detail, action); byId('operator-list').append(item);
  }
}
async function teamAction(work) {
  if (teamBusy) return;
  setTeamBusy(true);
  byId('team-message').textContent = 'Aguarde…';
  try { await work(); await loadTeam(); }
  catch (error) {
    if (error.status === 401) { await refresh(); byId('message').textContent = 'Sua sessão encerrou. Entre novamente.'; }
    else byId('team-message').textContent = error.status === 409 ? 'O e-mail já está cadastrado ou o limite de 200 operadores foi atingido.' : error.message;
  } finally {
    setTeamBusy(false);
    // Preserve pagination boundaries after restoring the controls.
    byId('team-previous').disabled = teamPage === 1;
    byId('team-next').disabled = teamPage * 20 >= teamTotal;
  }
}
byId('operator-create').addEventListener('submit', event => {
  event.preventDefault();
  const form = byId('operator-create');
  const payload = JSON.stringify(Object.fromEntries(new FormData(form)));
  teamAction(async () => {
    await api('/api/team/operators', { method: 'POST', headers: teamHeaders(), body: payload });
    form.reset(); teamPage = 1; byId('team-message').textContent = 'Operador cadastrado. Compartilhe o acesso com a pessoa por um canal privado.';
  });
});
byId('team-reload').addEventListener('click', () => teamAction(async () => { byId('team-message').textContent = 'Equipe atualizada.'; }));
byId('team-previous').addEventListener('click', () => teamAction(async () => { teamPage--; byId('team-message').textContent = ''; }));
byId('team-next').addEventListener('click', () => teamAction(async () => { teamPage++; byId('team-message').textContent = ''; }));

function resetDepartments() {
  departmentsGeneration++;
  departmentsAdmin = false; departmentsBusy = false; departmentsPage = 1; departmentsTotal = 0;
  selectedDepartment = null; departmentOperators = []; departmentMemberIds = new Set(); membersPage = 1;
  chatAvailable = false; departmentChannelLoaded = false;
  byId('chat-shortcut').hidden = true; byId('department-channel').hidden = true;
  byId('widget-code').value = ''; byId('widget-feedback').textContent = '';
  byId('departments').hidden = true;
  byId('departments-pending').hidden = true;
  byId('department-detail').hidden = true;
  byId('department-create').hidden = true;
  byId('department-list').replaceChildren();
  byId('department-member-list').replaceChildren();
  byId('department-create').reset(); byId('department-edit').reset();
  byId('departments-message').textContent = ''; byId('department-members-message').textContent = '';
  setDepartmentsBusy(false);
}
function setDepartmentsBusy(value) {
  departmentsBusy = value;
  byId('departments').setAttribute('aria-busy', String(value));
  byId('departments').querySelectorAll('button, input').forEach(control => { control.disabled = value; });
  if (!value) {
    byId('departments-previous').disabled = departmentsPage === 1;
    byId('departments-next').disabled = departmentsPage * departmentPageSize >= departmentsTotal;
    byId('members-previous').disabled = membersPage === 1;
    byId('members-next').disabled = membersPage * departmentPageSize >= departmentOperators.length;
    byId('department-public').disabled = !departmentChannelLoaded;
    byId('department-channel-save').disabled = !departmentChannelLoaded;
  }
}
function showDepartmentError(error) {
  byId('departments-message').textContent = error.status === 503 ? 'Departamentos aguardam preparação da instalação.' : error.message;
  if (error.status === 503) {
    closeDepartmentDetail();
    byId('department-list').replaceChildren();
    byId('department-create').hidden = true;
    byId('departments-pending').hidden = !departmentsAdmin;
  }
}
async function loadDepartments() {
  const generation = departmentsGeneration;
  let data = await api(`/api/team/departments?page=${departmentsPage}&limit=${departmentPageSize}`);
  if (generation !== departmentsGeneration) return;
  // Operator visibility can shrink when a membership or department is disabled elsewhere.
  const lastPage = Math.max(1, Math.ceil(data.total / data.limit));
  if (data.page > lastPage) {
    departmentsPage = lastPage;
    data = await api(`/api/team/departments?page=${departmentsPage}&limit=${departmentPageSize}`);
    if (generation !== departmentsGeneration) return;
  }
  departmentsTotal = data.total; departmentsPage = data.page;
  byId('departments-pending').hidden = true;
  byId('department-create').hidden = !departmentsAdmin;
  byId('department-list').replaceChildren();
  byId('departments-empty').hidden = data.total !== 0;
  byId('departments-empty').textContent = departmentsAdmin ? 'Nenhum departamento cadastrado. Crie uma área e adicione os operadores que poderão atendê-la.' : 'Você ainda não tem departamentos ativos. Peça ao administrador para conferir seus vínculos.';
  byId('departments-page').textContent = `Página ${data.page} de ${Math.max(1, Math.ceil(data.total / data.limit))} · ${data.total} ${data.total === 1 ? 'departamento' : 'departamentos'}`;
  for (const department of data.departments) {
    const item = document.createElement('li');
    const detail = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = department.name;
    const state = document.createElement('span'); state.textContent = department.active ? 'Ativo' : 'Desativado'; state.className = 'operator-state';
    detail.append(name, state); item.append(detail);
    if (departmentsAdmin) {
      const action = document.createElement('button'); action.type = 'button'; action.id = `department-manage-${department.id}`; action.className = 'secondary-button'; action.textContent = 'Gerenciar'; action.setAttribute('aria-label', `Gerenciar ${department.name}`);
      action.addEventListener('click', () => departmentAction(async () => { await loadDepartmentDetail(department.id); }, { reloadList: false, focusDetail: true }));
      item.append(action);
    }
    byId('department-list').append(item);
  }
  setDepartmentsBusy(departmentsBusy);
}
async function allDepartmentUsers(url) {
  const users = [];
  // Both endpoints have a hard limit of 200 operators. Never follow unbounded pagination.
  for (let page = 1; page <= 4; page++) {
    const data = await api(`${url}?page=${page}&limit=50`);
    if (!Array.isArray(data.users) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 200) throw new Error('Não foi possível conferir a lista de operadores. Atualize e tente novamente.');
    users.push(...data.users);
    if (page * 50 >= data.total) return users;
  }
  return users;
}
async function loadDepartmentDetail(id) {
  const generation = departmentsGeneration;
  const [detail, operators, members] = await Promise.all([
    api(`/api/team/departments/${id}`),
    allDepartmentUsers('/api/team/operators'),
    allDepartmentUsers(`/api/team/departments/${id}/members`)
  ]);
  if (generation !== departmentsGeneration) return;
  selectedDepartment = detail.department;
  departmentOperators = operators;
  departmentMemberIds = new Set(members.map(user => user.id));
  membersPage = Math.min(membersPage, Math.max(1, Math.ceil(operators.length / departmentPageSize)));
  byId('department-detail').hidden = false;
  byId('department-detail-title').textContent = `Gerenciar ${selectedDepartment.name}`;
  byId('department-detail-state').textContent = selectedDepartment.active ? 'Departamento ativo. O acesso de cada operador também exige uma conta ativa e um vínculo nesta área.' : 'Departamento desativado. Os vínculos estão preservados, mas os operadores não têm acesso ao atendimento desta área.';
  byId('department-edit-name').value = selectedDepartment.name;
  byId('department-toggle').textContent = selectedDepartment.active ? 'Desativar departamento' : 'Reativar departamento';
  byId('department-members-message').textContent = '';
  renderDepartmentMembers();
  await loadDepartmentChannel(id);
}
function renderDepartmentMembers() {
  byId('department-member-list').replaceChildren();
  byId('department-members-empty').hidden = departmentOperators.length !== 0;
  byId('members-page').textContent = `Página ${membersPage} de ${Math.max(1, Math.ceil(departmentOperators.length / departmentPageSize))} · ${departmentMemberIds.size} ${departmentMemberIds.size === 1 ? 'vínculo' : 'vínculos'}`;
  if (!selectedDepartment) return;
  const departmentId = selectedDepartment.id;
  const start = (membersPage - 1) * departmentPageSize;
  for (const user of departmentOperators.slice(start, start + departmentPageSize)) {
    const member = departmentMemberIds.has(user.id);
    const item = document.createElement('li');
    const detail = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = user.name;
    const email = document.createElement('span'); email.textContent = user.email;
    const state = document.createElement('span'); state.className = 'operator-state'; state.textContent = `${user.active ? 'Operador ativo' : 'Operador desativado'} · ${member ? 'Vinculado' : 'Sem vínculo'}`;
    detail.append(name, email, state);
    const action = document.createElement('button'); action.type = 'button'; action.id = `department-member-action-${user.id}`; action.className = 'secondary-button'; action.textContent = member ? 'Remover vínculo' : 'Adicionar vínculo'; action.setAttribute('aria-label', `${action.textContent} de ${user.name}`);
    action.addEventListener('click', () => departmentAction(async () => {
      await api(`/api/team/departments/${departmentId}/members/${user.id}`, { method: 'PUT', headers: teamHeaders(), body: JSON.stringify({ member: !member }) });
    }, { reloadDetail: true, success: member ? 'Vínculo removido. O operador perde o acesso a este departamento.' : 'Vínculo adicionado. O acesso exige operador e departamento ativos.' }));
    item.append(detail, action); byId('department-member-list').append(item);
  }
  setDepartmentsBusy(departmentsBusy);
}
function closeDepartmentDetail() {
  selectedDepartment = null; departmentOperators = []; departmentMemberIds = new Set(); membersPage = 1;
  byId('department-detail').hidden = true;
  byId('department-edit').reset(); byId('department-member-list').replaceChildren();
  byId('department-members-message').textContent = '';
  departmentChannelLoaded = false; byId('department-channel').hidden = true;
}
async function loadDepartmentChannel(id) {
  const generation = departmentsGeneration;
  departmentChannelLoaded = false; byId('department-channel').hidden = !chatAvailable;
  if (!chatAvailable) return;
  byId('department-channel-state').textContent = 'Conferindo a entrada pública…';
  byId('widget-feedback').textContent = '';
  byId('public-chat-link').href = new URL('/chat', location.origin).href;
  byId('widget-code').value = `<script src="${new URL('/widget.js', location.origin).href}" defer></script>`;
  try {
    const channel = await api(`/api/chat/team/channels/${id}`);
    if (generation !== departmentsGeneration || selectedDepartment?.id !== id) return;
    departmentChannelLoaded = true; byId('department-public').checked = channel.enabled;
    byId('department-channel-state').textContent = channel.enabled ? 'Entrada pública habilitada. Novas conversas exigem também um departamento ativo.' : 'Entrada pública desabilitada. Este departamento não recebe novas conversas pelo site.';
  } catch (error) {
    if (generation !== departmentsGeneration) return;
    if (error.status === 401) throw error;
    byId('department-channel-state').textContent = error.status === 503 ? 'O atendimento aguarda preparação na hospedagem.' : 'Não foi possível conferir a entrada pública. Atualize o departamento para tentar novamente.';
  }
  if (generation === departmentsGeneration) setDepartmentsBusy(departmentsBusy);
}
async function departmentAction(work, options = {}) {
  if (departmentsBusy) return;
  const generation = departmentsGeneration;
  const detailId = selectedDepartment?.id;
  const focusedId = document.activeElement?.id;
  setDepartmentsBusy(true);
  byId('departments-message').textContent = 'Aguarde…';
  try {
    await work();
    if (generation !== departmentsGeneration) return;
    if (options.reloadList !== false) await loadDepartments();
    if (options.reloadDetail && detailId) await loadDepartmentDetail(detailId);
    if (generation !== departmentsGeneration) return;
    if (options.reloadDetail && selectedDepartment) {
      byId('departments-message').textContent = '';
      byId('department-members-message').textContent = options.success || '';
    } else byId('departments-message').textContent = options.success || '';
  } catch (error) {
    if (generation !== departmentsGeneration) return;
    if (error.status === 401) { await refresh(); byId('message').textContent = 'Sua sessão encerrou. Entre novamente.'; byId('email').focus(); }
    else {
      if (error.status === 404 && detailId) closeDepartmentDetail();
      showDepartmentError(error);
    }
  } finally {
    if (generation === departmentsGeneration) {
      setDepartmentsBusy(false);
      if (options.focusDetail && selectedDepartment) byId('department-detail-title').focus();
      else if (focusedId) {
        const target = byId(focusedId);
        if (target && !target.closest('[hidden]') && !target.disabled) target.focus();
      }
    }
  }
}
byId('department-create').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  const generation = departmentsGeneration;
  departmentAction(async () => {
    await api('/api/team/departments', { method: 'POST', headers: teamHeaders(), body: JSON.stringify(body) });
    if (generation !== departmentsGeneration) return;
    form.reset(); departmentsPage = 1;
  }, { success: 'Departamento criado. Use Gerenciar para adicionar os operadores.' });
});
byId('department-edit').addEventListener('submit', event => {
  event.preventDefault();
  if (!selectedDepartment) return;
  const id = selectedDepartment.id;
  const body = Object.fromEntries(new FormData(event.currentTarget));
  departmentAction(async () => { await api(`/api/team/departments/${id}`, { method: 'PATCH', headers: teamHeaders(), body: JSON.stringify(body) }); }, { reloadDetail: true, success: 'Nome do departamento atualizado.' });
});
byId('department-toggle').addEventListener('click', () => {
  if (!selectedDepartment) return;
  const { id, active } = selectedDepartment;
  departmentAction(async () => { await api(`/api/team/departments/${id}`, { method: 'PATCH', headers: teamHeaders(), body: JSON.stringify({ active: !active }) }); }, { reloadDetail: true, success: active ? 'Departamento desativado. Os vínculos foram preservados.' : 'Departamento reativado. Operadores ativos vinculados recuperam o acesso.' });
});
byId('department-close').addEventListener('click', () => { closeDepartmentDetail(); byId('departments-reload').focus(); });
byId('departments-reload').addEventListener('click', () => departmentAction(async () => {}, { reloadDetail: Boolean(selectedDepartment), success: 'Departamentos atualizados.' }));
byId('departments-previous').addEventListener('click', () => departmentAction(async () => { departmentsPage--; }));
byId('departments-next').addEventListener('click', () => departmentAction(async () => { departmentsPage++; }));
byId('members-reload').addEventListener('click', () => departmentAction(async () => {}, { reloadList: false, reloadDetail: true, success: 'Operadores e vínculos atualizados.' }));
byId('members-previous').addEventListener('click', () => { if (departmentsBusy || membersPage <= 1) return; membersPage--; renderDepartmentMembers(); });
byId('members-next').addEventListener('click', () => { if (departmentsBusy || membersPage * departmentPageSize >= departmentOperators.length) return; membersPage++; renderDepartmentMembers(); });
byId('department-channel-form').addEventListener('submit', event => {
  event.preventDefault(); if (!selectedDepartment || !departmentChannelLoaded) return;
  const id = selectedDepartment.id; const body = { enabled: new FormData(event.currentTarget).has('enabled') };
  departmentAction(async () => { await api(`/api/chat/team/channels/${id}`, { method: 'PUT', headers: teamHeaders(), body: JSON.stringify(body) }); }, { reloadDetail: true, success: body.enabled ? 'Entrada pública habilitada.' : 'Entrada pública desabilitada. Conversas existentes foram preservadas.' });
});
byId('widget-copy').addEventListener('click', async () => {
  const input = byId('widget-code');
  try { await navigator.clipboard.writeText(input.value); byId('widget-feedback').textContent = 'Código do botão copiado.'; }
  catch { input.focus(); input.select(); byId('widget-feedback').textContent = 'Selecione e copie o código acima para seu site.'; }
});
refresh();
