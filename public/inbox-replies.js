'use strict';
inboxReplies = (() => {
  const element = suffix => inboxElement('inbox-replies-' + suffix);
  let expanded = false;
  function editable() {
    return !inboxBusy && !inboxDisposed && inboxMetadataConfirmed && inboxOwnsConversation() && !inboxDraft().pending;
  }
  function preview() {
    return window.ClQuickReplies.render(element('model').value, {
      visitorName: inboxSelected?.visitorName, operatorName: inboxProfile?.user.name, departmentName: inboxSelected?.departmentName
    });
  }
  function controls() {
    const canEdit = editable();
    element('toggle').disabled = !canEdit;
    element('toggle').setAttribute('aria-expanded', String(expanded));
    element('panel').hidden = !expanded;
    element('query').disabled = !canEdit; element('model').disabled = !canEdit;
    const text = preview();
    element('preview').textContent = text || 'Selecione um modelo para conferir o texto.';
    element('insert').disabled = !canEdit || !text;
  }
  function list() {
    const previous = element('model').value, templates = window.ClQuickReplies.search(element('query').value);
    element('model').replaceChildren();
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Selecione um modelo'; element('model').append(empty);
    for (const template of templates) {
      const option = document.createElement('option'); option.value = template.id; option.textContent = template.title; element('model').append(option);
    }
    element('model').value = templates.some(template => template.id === previous) ? previous : '';
    element('count').textContent = templates.length ? templates.length + (templates.length === 1 ? ' modelo encontrado.' : ' modelos encontrados.') : 'Nenhum modelo encontrado. Tente outra busca.';
    controls();
  }
  function clear() {
    expanded = false; element('query').value = ''; element('model').value = ''; element('feedback').textContent = ''; list();
  }
  element('toggle').addEventListener('click', () => {
    if (!editable()) return;
    expanded = !expanded; controls();
    if (expanded) element('query').focus();
  });
  element('query').addEventListener('input', list);
  element('model').addEventListener('change', () => { element('feedback').textContent = ''; controls(); });
  element('panel').addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault(); expanded = false; controls();
    if (!element('toggle').disabled) element('toggle').focus();
  });
  element('insert').addEventListener('click', () => {
    if (!editable()) return;
    const text = window.ClQuickReplies.append(inboxElement('inbox-text').value, preview());
    if (text === null) {
      element('feedback').textContent = 'O modelo ultrapassaria 2.000 caracteres junto com seu rascunho. Edite o rascunho antes de inserir; nenhum texto foi alterado.'; return;
    }
    inboxElement('inbox-text').value = text; inboxDraft().text = text;
    element('feedback').textContent = 'Modelo acrescentado ao rascunho. Revise o texto antes de enviar.';
    expanded = false; controls(); inboxElement('inbox-text').focus();
    inboxElement('inbox-text').setSelectionRange(text.length, text.length);
  });
  list();
  return { controls, clear };
})();
