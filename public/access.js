'use strict';

const byId = id => document.getElementById(id);
const panels = ['configuration', 'setup', 'login', 'account'];
let csrfToken = null;
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
      show('account', 'Bem-vindo à sua empresa.', 'Você entrou no Conversa Livre.');
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
refresh();
