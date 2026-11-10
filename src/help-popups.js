// Keep the original nodes so live model progress and existing labels continue
// updating while help is closed. Each popup is modal, keyboard accessible and
// returns focus to its question-mark button when dismissed.
export function helpPopup(nodes, { button, title = 'Help', anchor, control } = {}) {
  const first = nodes[0], parent = first.parentElement;
  const dialog = document.createElement('dialog'); dialog.className = 'help-popup';
  dialog.id = `help-popup-${helpPopup.count++}`;
  const header = document.createElement('div'); header.className = 'help-popup-heading';
  const heading = document.createElement('h2'); heading.id = `${dialog.id}-title`; heading.textContent = title;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'text-button'; close.textContent = 'Close';
  close.onclick = () => dialog.close(); header.append(heading, close);
  dialog.setAttribute('aria-labelledby', heading.id); dialog.append(header);
  const content = document.createElement('div'); content.className = 'help-popup-content'; dialog.append(content);
  if (!button) {
    button = document.createElement('button'); button.type = 'button'; button.className = 'help-button'; button.textContent = '?';
    button.setAttribute('aria-label', `Help: ${title}`);
    if (anchor) anchor.append(button);
    else {
      const previous = control || first.previousElementSibling;
      if (previous?.matches('label, .setting-row, .speed-control')) {
        const row = document.createElement('div'); row.className = 'help-control-row';
        previous.before(row); row.append(previous, button);
      } else if (previous?.matches('h2,h3,h4,h5,.settings-head,.ask-actions,.pdf-default-actions,.passage-heading,.passage-title,.debug-heading')) previous.append(button);
      else first.before(button);
    }
  }
  parent.insertBefore(dialog, first); content.append(...nodes);
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', dialog.id); button.setAttribute('aria-expanded', 'false');
  button.onclick = () => { dialog.showModal(); button.setAttribute('aria-expanded', 'true'); };
  // Escape closes this popup, not the settings drawer underneath it. Arrow
  // keys scroll help instead of being forwarded to the glasses controls.
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('close', () => { button.setAttribute('aria-expanded', 'false'); button.focus({ preventScroll: true }); });
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
  });
  return dialog;
}
helpPopup.count = 0;

export function installHelpPopups() {
  helpPopup([document.getElementById('library-clearance-explanation')], { button: document.getElementById('library-clearance-help'), title: 'Library clearance' });
  helpPopup([document.getElementById('library-help-content')], { button: document.getElementById('library-help'), title: 'Library' });
  helpPopup([document.getElementById('glasses-hints')], { button: document.getElementById('hints-toggle'), title: 'Glasses controls' });
  helpPopup(['ask-voice-help', 'ask-voice-models', 'ask-voice-metrics'].map(id => document.getElementById(id)), { title: 'Ask about this', button: document.getElementById('ask-help') });
  const candidates = [...document.querySelectorAll('p.muted')].filter(node => !node.closest('dialog.help-popup, #shared-settings, #library-reading-summary')
    && !node.hasAttribute('role') && !['app-version', 'ask-context', 'ask-empty'].includes(node.id));
  const pending = new Set(candidates);
  for (const first of candidates) {
    if (!pending.has(first)) continue;
    const nodes = []; let next = first;
    while (pending.has(next)) { pending.delete(next); nodes.push(next); next = next.nextElementSibling; }
    const control = first.id && document.querySelector(`[aria-describedby~="${first.id}"]`)?.closest('label,.speed-control');
    const previous = control || first.previousElementSibling;
    const title = first.id === 'passage-help' ? 'Reading preview' : first.id === 'value-help' ? 'Enter a value'
      : first.id === 'debug-help' ? 'Debug log' : first.classList.contains('library-note') ? 'Local library'
      : previous?.querySelector('label')?.textContent.trim() || previous?.firstChild?.textContent.trim() || 'Help';
    helpPopup(nodes, { title: title.slice(0, 70) || 'Help', control });
  }
}
