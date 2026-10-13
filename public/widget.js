'use strict';

(() => {
  const script = document.currentScript;
  const source = script?.src;
  if (!source) return;
  let chatUrl;
  try {
    const parsed = new URL(source);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) return;
    chatUrl = new URL('/chat', parsed.origin).href;
  } catch { return; }
  // Capture attributes while currentScript still refers to this embed, before DOMContentLoaded.
  const rawLabel = script.getAttribute('data-label') || '';
  const requestedLabel = rawLabel.trim();
  const label = requestedLabel && requestedLabel.length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/u.test(rawLabel)
    ? requestedLabel : 'Abrir atendimento';
  const position = (script.getAttribute('data-position') || '').trim().toLowerCase() === 'left' ? 'left' : 'right';
  function mount() {
    if (!document.body || document.getElementById('conversa-livre-widget')) return;
    const host = document.createElement('div'); host.id = 'conversa-livre-widget';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial!important;display:block!important;position:fixed!important;' + position + ':max(20px,env(safe-area-inset-' + position + '))!important;bottom:max(20px,env(safe-area-inset-bottom))!important;z-index:2147483000!important}a{display:inline-flex;align-items:center;min-height:48px;max-width:min(360px,calc(100vw - 40px - env(safe-area-inset-left) - env(safe-area-inset-right)));box-sizing:border-box;padding:14px 20px;border-radius:14px;background:#175cd3;color:white;font:600 15px/1.5 system-ui,sans-serif;text-decoration:none;white-space:normal;overflow-wrap:anywhere;box-shadow:0 6px 24px #172b4d33}a:hover{background:#144ba9}a:focus-visible{outline:3px solid #087e8b;outline-offset:4px}@media(prefers-reduced-motion:no-preference){a{transition:background .15s}}';
    const link = document.createElement('a'); link.href = chatUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label; link.setAttribute('aria-label', label + ' — atendimento da empresa em nova aba');
    root.append(style, link); document.body.append(host);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
