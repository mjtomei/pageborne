// The same live canvas remains mounted while enlarged: navigation, Ask and
// reading progress keep their existing state. CSS also works in iPhone/WebViews
// that cannot put arbitrary elements into browser fullscreen.
export class FullscreenReader {
  constructor(root, button, { cancel = () => {} } = {}) {
    Object.assign(this, { root, button, cancel });
    this.active = false;
    button.onclick = () => this.active ? this.exit() : this.enter();
    document.addEventListener('fullscreenchange', () => {
      if (this.native && !document.fullscreenElement) this.exit();
    });
    document.addEventListener('keydown', event => {
      if (!this.active) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); this.exit();
      } else if (event.key === 'Tab') {
        const controls = [...root.querySelectorAll('button:not(:disabled), [tabindex="0"]')]
          .filter(el => el.getClientRects().length && !el.hidden);
        const index = controls.indexOf(document.activeElement);
        if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1) {
          event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
        }
      }
    }, true);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(root.querySelector('.preview-stage'));
  }
  fit() {
    if (!this.active) return;
    const stage = this.root.querySelector('.preview-stage');
    this.root.style.setProperty('--screen-width', `${Math.max(0, Math.min(stage.clientWidth, stage.clientHeight * 2))}px`);
  }
  enter() {
    if (this.active) return;
    this.cancel(); this.active = true;
    this.placeholder = document.createComment('reader view');
    this.root.before(this.placeholder);
    // Move outside the scrolling reader panel; preserve every child's handlers.
    document.body.append(this.root);
    this.inert = [...document.body.children].filter(el => el !== this.root).map(el => [el, el.inert]);
    for (const [el] of this.inert) el.inert = true;
    this.root.classList.add('reader-fullscreen');
    document.body.classList.add('reader-expanded');
    this.button.setAttribute('aria-pressed', 'true');
    this.button.setAttribute('aria-label', 'Exit full screen');
    this.button.textContent = '✕'; this.fit(); this.button.focus({ preventScroll: true });
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      Promise.resolve(document.documentElement.requestFullscreen()).then(() => {
        this.native = document.fullscreenElement === document.documentElement;
        if (!this.active && this.native) void document.exitFullscreen().catch(() => {});
      }).catch(() => {}); // The viewport-filling view remains available.
    }
  }
  exit() {
    if (!this.active) return;
    this.cancel(); this.active = false;
    this.root.classList.remove('reader-fullscreen');
    document.body.classList.remove('reader-expanded');
    this.root.style.removeProperty('--screen-width');
    this.placeholder.replaceWith(this.root);
    for (const [el, value] of this.inert) el.inert = value;
    this.button.setAttribute('aria-pressed', 'false');
    this.button.setAttribute('aria-label', 'Full screen'); this.button.textContent = '⛶';
    this.button.focus({ preventScroll: true });
    if (this.native && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.native = false;
  }
}

// Request microphone permission directly in a user gesture. Release always
// pairs with start, even when permission/model setup has not finished yet.
export function installHoldButton(button, { start, release, cancel }) {
  let held = false;
  const begin = () => { if (held || button.disabled) return; held = true; void start(); };
  const finish = aborted => { if (!held) return; held = false; void (aborted ? cancel() : release()); };
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || button.disabled) return;
    event.preventDefault(); button.setPointerCapture(event.pointerId); begin();
  });
  button.addEventListener('pointerup', () => finish(false));
  for (const type of ['pointercancel', 'lostpointercapture']) button.addEventListener(type, () => finish(true));
  button.addEventListener('contextmenu', event => event.preventDefault());
  button.addEventListener('keydown', event => {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault(); if (!event.repeat) begin();
  });
  button.addEventListener('keyup', event => {
    if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); finish(false); }
  });
  button.addEventListener('blur', () => finish(true));
  window.addEventListener('blur', () => finish(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(true); });
}
