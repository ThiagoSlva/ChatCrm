'use strict';

window.ClSetupChecklist = (() => {
  const el = suffix => document.getElementById('setup-checklist-' + suffix);
  let generation = 0, controller = null, admin = false, refreshAccess = null, suspended = false;
  function clear() {
    generation++; controller?.abort(); controller = null; admin = false;
    el('panel').hidden = true; el('list').replaceChildren(); el('status').textContent = '';
    el('refresh').disabled = false; el('panel').setAttribute('aria-busy', 'false');
  }
  function row(title, state, description, href, action) {
    const item = document.createElement('li'), heading = document.createElement('h3');
    const status = document.createElement('strong'), detail = document.createElement('p');
    heading.textContent = title; status.textContent = state; detail.textContent = description;
    item.append(heading, status, detail);
    if (href) { const link = document.createElement('a'); link.href = href; link.textContent = action; item.append(link); }
    el('list').append(item); return { status, detail };
  }
  async function read(url, activeController) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.any([activeController.signal, AbortSignal.timeout(8000)]) });
    if (!response.ok) { const error = new Error('Verificação não confirmada.'); error.status = response.status; throw error; }
    return response.json();
  }
  async function update(profile = null) {
    if (suspended) return;
    if (!profile && (!admin || el('refresh').disabled)) return;
    const allowedBefore = admin;
    clear();
    if (profile && profile.user?.role !== 'admin') return;
    admin = allowedBefore || profile?.user?.role === 'admin';
    const currentGeneration = generation, activeController = new AbortController(); controller = activeController;
    const current = () => generation === currentGeneration && !activeController.signal.aborted;
    const restoreFocus = document.activeElement === el('refresh');
    el('panel').hidden = false; el('panel').setAttribute('aria-busy', 'true'); el('refresh').disabled = true;
    el('status').textContent = 'Verificando os primeiros passos…';
    try {
      if (!profile) profile = await read('/api/auth/me', activeController);
      if (!current()) return;
      if (profile?.user?.role !== 'admin') { clear(); refreshAccess?.(); return; }
      admin = true;
      const capabilities = profile.capabilities || {}, chat = capabilities.departments === true && capabilities.chat === true;
      let publicConfirmed = true;
      row('Acesso da administração', 'Confirmado', 'Seu acesso administrativo está ativo.', '#team', 'Gerenciar equipe');
      row('Estrutura de atendimento', chat ? 'Preparada' : 'Preparação pendente', chat
        ? 'Departamentos e atendimento estão disponíveis para configurar.'
        : 'Peça à administração da hospedagem para preparar o banco antes de configurar o atendimento.',
        chat ? '#departments' : null, 'Gerenciar departamentos');
      const publicEntry = row('Entrada pública de visitantes', chat ? 'Verificando…' : 'Preparação pendente', chat
        ? 'Consultando as áreas que podem receber novas conversas.' : 'A estrutura de atendimento precisa ser preparada primeiro.',
        chat ? '#departments' : null, 'Revisar entrada pública');
      row('Modelos da equipe', capabilities.replies === true ? 'Preparados' : 'Preparação pendente', capabilities.replies === true
        ? 'O catálogo está disponível para cadastrar modelos. Isso não confirma que já existam respostas cadastradas.'
        : 'O catálogo precisa de preparação do banco pela administração da hospedagem. Os outros recursos podem continuar disponíveis.',
        capabilities.replies === true ? '/respostas' : null, 'Abrir modelos');
      if (chat) {
        try {
          const data = await read('/api/chat/public/departments', activeController);
          if (!current()) return;
          if (!Array.isArray(data?.departments) || data.departments.length > 50 ||
            !data.departments.every(d => Number.isInteger(d?.id) && d.id > 0 && d.id <= 4294967295 &&
              typeof d.name === 'string' && d.name.trim() && d.name.length <= 100) ||
            new Set(data.departments.map(d => d.id)).size !== data.departments.length) throw new Error('Resposta inválida.');
          const count = data.departments.length;
          publicEntry.status.textContent = count ? 'Habilitada' : 'Nenhuma área habilitada';
          publicEntry.detail.textContent = count
            ? `${count} ${count === 1 ? 'área pode receber' : 'áreas podem receber'} novas conversas. Confira a equipe e teste sua página pública antes de divulgar.`
            : 'Em Departamentos, escolha uma área ativa, abra Gerenciar e salve Receber novos atendimentos pelo site. Vincule os operadores que vão atender nela.';
        } catch (error) {
          if (!current()) return;
          publicConfirmed = false;
          publicEntry.status.textContent = 'Não confirmado';
          publicEntry.detail.textContent = 'Não foi possível consultar a entrada pública. Atualize a verificação para tentar novamente.';
        }
      }
      if (current()) el('status').textContent = publicConfirmed
        ? 'Verificação concluída. Nenhuma configuração foi alterada. Atualize após preparar o banco ou ajustar os departamentos.'
        : 'Verificação parcial: a entrada pública não foi confirmada. Nenhuma configuração foi alterada. Atualize para tentar novamente.';
    } catch (error) {
      if (!current()) return;
      if (error.status === 401 || error.status === 403) { clear(); refreshAccess?.(); return; }
      el('status').textContent = 'Não foi possível confirmar seu acesso. Atualize a verificação para tentar novamente.';
    } finally {
      if (current()) {
        el('refresh').disabled = false; el('panel').setAttribute('aria-busy', 'false');
        if (restoreFocus && document.activeElement === document.body) el('refresh').focus();
      }
    }
  }
  el('refresh').addEventListener('click', () => update());
  window.addEventListener('pagehide', () => { suspended = true; clear(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { suspended = false; clear(); refreshAccess?.(); } });
  return { clear, update, init: callback => { refreshAccess = callback; } };
})();
