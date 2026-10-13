'use strict';

const button = document.getElementById('refresh');
const statusHeading = document.getElementById('server-status');
const detail = document.getElementById('server-detail');
const version = document.getElementById('release-version');
const installationHeading = document.getElementById('installation-status');
const installationDetail = document.getElementById('installation-detail');
const cards = document.getElementById('status-cards');
let generation = 0;

function resetStatus() {
  statusHeading.textContent = 'Verificando…';
  detail.textContent = 'Consultando o aplicativo.';
  version.textContent = 'Versão a verificar';
  installationHeading.textContent = 'Verificando…';
  installationDetail.textContent = 'Consultando a configuração e o primeiro acesso.';
}

async function checkServer(current) {
  try {
    const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Servidor indisponível');
    const health = await response.json();
    if (health?.status !== 'ok' || health.application !== 'conversa-livre') throw new Error('Resposta inesperada');
    if (!current()) return;
    statusHeading.textContent = 'Servidor conectado';
    detail.textContent = 'O aplicativo está respondendo. A instalação é verificada separadamente.';
    version.textContent = typeof health.version === 'string' && health.version.length <= 64 &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(health.version)
      ? 'v' + health.version : 'Versão indisponível';
  } catch {
    if (!current()) return;
    statusHeading.textContent = 'Não foi possível verificar';
    detail.textContent = 'Verifique sua conexão e tente novamente. Se persistir, consulte a administração da hospedagem.';
    version.textContent = 'Versão indisponível';
  }
}

async function checkInstallation(current) {
  try {
    const response = await fetch('/api/installation', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const installation = await response.json();
    const states = new Map([
      ['configuration-required', ['Configuração pendente', 'A administração precisa preparar a instalação antes do primeiro acesso.']],
      ['setup', ['Primeiro acesso pendente', 'A configuração inicial está pronta para criar a empresa e o administrador.']],
      ['installed', ['Administrador criado', 'Entre para consultar os recursos habilitados para sua conta.']],
      ['database-unavailable', ['Banco indisponível', 'Não foi possível consultar a instalação. A administração precisa verificar o banco.']]
    ]);
    const state = states.get(installation?.state);
    const expectedStatus = installation?.state === 'database-unavailable' ? 503 : 200;
    if (!state || response.status !== expectedStatus) throw new Error('Resposta inesperada');
    if (!current()) return;
    installationHeading.textContent = state[0];
    installationDetail.textContent = state[1];
  } catch {
    if (!current()) return;
    installationHeading.textContent = 'Verificação indisponível';
    installationDetail.textContent = 'A instalação não foi confirmada. Verifique sua conexão e tente novamente.';
  }
}

async function refreshStatus() {
  if (button.disabled) return;
  const requestGeneration = ++generation;
  const current = () => generation === requestGeneration;
  const restoreFocus = document.activeElement === button;
  button.disabled = true;
  cards.setAttribute('aria-busy', 'true');
  resetStatus();
  await Promise.all([checkServer(current), checkInstallation(current)]);
  if (current()) {
    button.disabled = false;
    cards.setAttribute('aria-busy', 'false');
    if (restoreFocus && document.activeElement === document.body) button.focus({ preventScroll: true });
  }
}

button.addEventListener('click', refreshStatus);
window.addEventListener('pagehide', () => {
  generation++;
  resetStatus();
  button.disabled = false;
  cards.setAttribute('aria-busy', 'false');
});
window.addEventListener('pageshow', event => { if (event.persisted) refreshStatus(); });
refreshStatus();
