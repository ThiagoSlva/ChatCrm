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
  } catch {
    statusHeading.textContent = 'Não foi possível verificar';
    detail.textContent = 'Confira a URL e o estado da aplicação no painel da hospedagem e tente novamente.';
  } finally {
    button.disabled = false;
  }
}

button.addEventListener('click', refreshStatus);
refreshStatus();
