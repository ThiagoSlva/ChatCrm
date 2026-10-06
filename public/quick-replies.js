'use strict';
(() => {
  const templates = Object.freeze([
    { id: 'welcome', title: 'Boas-vindas', text: 'Olá, {{visitante}}! Sou {{operador}}, da equipe de {{area}}. Como posso ajudar?' },
    { id: 'details', title: 'Entender a solicitação', text: 'Pode me contar um pouco mais sobre o que você precisa? Assim consigo orientar os próximos passos.' },
    { id: 'checking', title: 'Conferir informações', text: 'Vou conferir as informações para orientar você. Se houver mais algum detalhe sobre sua solicitação, pode enviar por aqui.' },
    { id: 'next', title: 'Combinar próximos passos', text: 'Vamos combinar os próximos passos. Qual resultado você precisa alcançar e o que já tentou até agora?' },
    { id: 'resolved', title: 'Confirmar solução', text: 'A orientação resolveu sua dúvida? Se ainda precisar de ajuda, me conte o que falta para seguirmos.' },
    { id: 'thanks', title: 'Agradecer o contato', text: 'Obrigado pelo contato, {{visitante}}! A equipe de {{area}} fica à disposição se você precisar conversar novamente.' }
  ].map(template => Object.freeze(template)));
  const plain = (value, fallback) => {
    if (typeof value !== 'string') return fallback;
    const text = value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
    const points = [...text];
    return (points.length > 80 ? points.slice(0, 79).join('') + '…' : text) || fallback;
  };
  const fold = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
  function search(query = '') {
    const term = typeof query === 'string' ? fold(query.normalize('NFC').trim().slice(0, 100)) : '';
    return templates.filter(template => fold(template.title + ' ' + template.text).includes(term));
  }
  function render(id, context = {}) {
    const template = templates.find(template => template.id === id);
    if (!template) return null;
    const values = { visitante: plain(context.visitorName, 'tudo bem'), operador: plain(context.operatorName, 'um integrante da equipe'), area: plain(context.departmentName, 'atendimento') };
    // One pass only: values are literal text, never HTML or another template.
    return template.text.replace(/\{\{(visitante|operador|area)\}\}/g, (_, key) => values[key]);
  }
  function append(draft, reply) {
    if (typeof draft !== 'string' || typeof reply !== 'string' || !reply) return null;
    const combined = draft + (draft ? '\n\n' : '') + reply;
    return combined.length <= 2000 ? combined : null;
  }
  window.ClQuickReplies = Object.freeze({ search, render, append });
})();
