'use strict';

const button = document.getElementById('refresh');
const statusHeading = document.getElementById('server-status');
const detail = document.getElementById('server-detail');

async function refreshStatus() {
  button.disabled = true;
  statusHeading.textContent = 'Verificando…';
  try {
    const response = await fetch(new URL('health', window.location.href), {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Servidor indisponivel');
    const health = await response.json();
    if (health.status !== 'ok') throw new Error('Resposta inesperada');
    statusHeading.textContent = 'Servidor conectado';
    detail.textContent = 'O aplicativo Node.js está respondendo. Esta confirmação não verifica MySQL ou WebSocket.';
    try {
      const installationResponse = await fetch('/api/installation', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const installation = await installationResponse.json();
      const states = {
        'configuration-required': ['Configuração pendente', 'Configure o banco exclusivo e a URL da aplicação para começar.'],
        'setup': ['Pronto para começar', 'Crie sua empresa e o primeiro administrador usando o segredo de instalação.'],
        'installed': ['Administrador criado', 'O primeiro acesso está pronto. Entre com seu e-mail e senha.'],
        'database-unavailable': ['Verifique o banco', 'Confira as variáveis privadas e execute a migração na hospedagem.']
      };
      const state = states[installation.state] || ['Verificação indisponível', 'Confira o acesso da equipe.'];
      document.getElementById('installation-status').textContent = state[0];
      document.getElementById('installation-detail').textContent = state[1];
    } catch {
      document.getElementById('installation-status').textContent = 'Verificação indisponível';
      document.getElementById('installation-detail').textContent = 'Tente novamente quando a conexão estiver disponível.';
    }
  } catch {
    statusHeading.textContent = 'Não foi possível verificar';
    detail.textContent = 'Confira a URL e o estado da aplicação no painel da hospedagem e tente novamente.';
    document.getElementById('installation-status').textContent = 'Verificação indisponível';
  } finally {
    button.disabled = false;
  }
}

button.addEventListener('click', refreshStatus);
refreshStatus();
