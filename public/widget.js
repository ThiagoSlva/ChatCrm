'use strict';

(() => {
  const source = document.currentScript?.src;
  if (!source) return;
  let chatUrl;
  try {
    const parsed = new URL(source);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) return;
    chatUrl = new URL('/chat', parsed.origin).href;
  } catch { return; }
  function mount() {
    if (!document.body || document.getElementById('conversa-livre-widget')) return;
    const host = document.createElement('div'); host.id = 'conversa-livre-widget';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{position:fixed;right:20px;bottom:20px;z-index:2147483000}a{display:inline-flex;align-items:center;min-height:48px;max-width:calc(100vw - 40px);box-sizing:border-box;padding:14px 20px;border-radius:14px;background:#175cd3;color:white;font:600 15px system-ui,sans-serif;text-decoration:none;box-shadow:0 6px 24px #172b4d33}a:hover{background:#144ba9}a:focus-visible{outline:3px solid #087e8b;outline-offset:4px}@media(prefers-reduced-motion:no-preference){a{transition:background .15s}}';
    const link = document.createElement('a'); link.href = chatUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Abrir atendimento'; link.setAttribute('aria-label', 'Abrir atendimento da empresa em nova aba');
    root.append(style, link); document.body.append(host);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
