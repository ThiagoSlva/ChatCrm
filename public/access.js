'use strict';

const byId = id => document.getElementById(id);
const panels = ['configuration', 'setup', 'login', 'account'];
let csrfToken = null;
let teamPage = 1;
let teamBusy = false;
let teamTotal = 0;
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
  byId('team').hidden = true;
  byId('operator-list').replaceChildren();
  byId('operator-create').reset();
  byId('password-change').reset();
  byId('password-message').textContent = '';
  byId('message').textContent = '';
  try {
    const installation = await api('/api/installation');
    if (installation.state === 'configuration-required') return show('configuration', 'Prepare sua instalação.', 'Falta configurar o banco e a URL do sistema na hospedagem.');
    if (installation.state === 'setup') return show('setup', 'Sua equipe começa aqui.', 'Crie sua empresa e o primeiro administrador.');
    try {
      const profile = await api('/api/auth/me');
      csrfToken = profile.csrfToken;
      byId('user-name').textContent = profile.user.name;
      byId('user-detail').textContent = `${profile.company} · ${profile.user.email} · ${profile.user.role === 'admin' ? 'Administrador' : 'Operador'}`;
      byId('role-description').textContent = profile.user.role === 'admin' ? 'Gerencie os operadores da sua equipe abaixo. O chat será a próxima entrega.' : 'Você tem acesso de operador. O atendimento ainda está em desenvolvimento; a gestão da equipe fica com o administrador.';
      show('account', 'Bem-vindo à sua empresa.', 'Você entrou no Conversa Livre.');
      if (profile.user.role === 'admin') {
        byId('team').hidden = false; teamPage = 1;
        try { await loadTeam(); } catch (error) { if (error.status === 401) throw error; byId('team-message').textContent = 'Não foi possível carregar a equipe. Use Atualizar equipe para tentar novamente.'; }
      }
    } catch (error) {
      if (error.status !== 401) throw error;
      show('login', 'Bom ter você por aqui.', 'Entre para acessar o espaço da sua equipe.');
    }
  } catch (error) { show('configuration', 'Vamos conferir o banco.', 'A instalação ainda precisa de uma verificação.'); byId('message').textContent = error.message; }
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
  const data = await api(`/api/team/operators?page=${teamPage}&limit=20`);
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
refresh();
