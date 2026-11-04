import { actionForGesture, keyBinding, PREVIEW_TIMING as T, SWIPES } from './controls.js';
import { safeTimeout as setTimeout, cancelTimeout as clearTimeout } from './timers.js';

// Recognition only: semantic actions belong to controls.js and the same app
// dispatcher used by glasses events. Delay taps to avoid a page turn before a
// double tap or tap-then-hold. Timers are canceled on navigation/suspension.
export class PreviewGestures {
  constructor(emit) { this.emit = emit; this.press = null; this.tap = null; }
  clearTap() { clearTimeout(this.tapTimer); this.tap = null; }
  down(x, y) {
    if (this.press) this.cancel();
    const second = this.tap && Math.hypot(x - this.tap.x, y - this.tap.y) <= T.doubleTapSlop;
    if (this.tap && !second) { this.clearTap(); this.emit('tap'); }
    else this.clearTap();
    const press = this.press = { x, y, second, moved: false, held: false };
    this.holdTimer = setTimeout(() => {
      if (this.press !== press || press.moved) return;
      press.held = true; this.emit(press.second ? 'menu' : 'hold-start');
    }, T.holdMs);
  }
  move(x, y) {
    const p = this.press; if (!p) return;
    if (Math.hypot(x - p.x, y - p.y) <= T.tapSlop) return;
    clearTimeout(this.holdTimer); p.moved = true;
    if (p.held && !p.second && !p.canceled) { p.canceled = true; this.emit('hold-cancel'); }
  }
  up(x, y) {
    this.move(x, y);
    const p = this.press; this.press = null; clearTimeout(this.holdTimer);
    if (!p) return;
    if (p.held) { if (!p.second && !p.canceled) this.emit('hold-end'); return; }
    const dx = x - p.x, dy = y - p.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= T.swipeDistance) {
      this.emit(SWIPES[Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'left' : 'right' : dy < 0 ? 'up' : 'down']); return;
    }
    if (p.moved) return;
    if (p.second) { this.emit('double-tap'); return; }
    this.tap = { x, y };
    this.tapTimer = setTimeout(() => { this.clearTap(); this.emit('tap'); }, T.doubleTapMs);
  }
  cancel() {
    clearTimeout(this.holdTimer); this.clearTap();
    const p = this.press; this.press = null;
    if (p?.held && !p.second && !p.canceled) this.emit('hold-cancel');
  }
}

export function installPreviewInput(element, { dispatch, keyboardAllowed = () => true, canUse = () => true,
  coordinates = event => [event.clientX, event.clientY] } = {}) {
  const gesture = name => { const action = actionForGesture(name); if (action) dispatch(action, 'preview'); };
  const recognizer = new PreviewGestures(gesture); const pointers = new Set(); const heldKeys = new Map();
  let primary; const controller = new AbortController();
  const on = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: controller.signal });
  const usable = () => canUse() && !element.closest('[inert]');
  const cancel = (keepPointers = false) => {
    if (keepPointers !== true) pointers.clear();
    recognizer.cancel(); primary = undefined;
    for (const _binding of heldKeys.values()) dispatch(actionForGesture('hold-cancel'), 'keyboard');
    heldKeys.clear();
  };
  on(element, 'pointerdown', event => {
    if (event.button !== 0 || !usable()) return;
    pointers.add(event.pointerId);
    if (pointers.size !== 1 || event.isPrimary === false) { cancel(true); return; }
    event.preventDefault(); element.focus({ preventScroll: true }); primary = event.pointerId;
    element.setPointerCapture?.(event.pointerId); recognizer.down(...coordinates(event));
  });
  on(element, 'pointermove', event => { if (event.pointerId === primary) recognizer.move(...coordinates(event)); });
  on(element, 'pointerup', event => {
    pointers.delete(event.pointerId);
    if (event.pointerId !== primary) return;
    primary = undefined;
    if (usable()) recognizer.up(...coordinates(event)); else recognizer.cancel();
  });
  on(element, 'pointercancel', event => { pointers.delete(event.pointerId); cancel(); });
  on(element, 'lostpointercapture', event => { pointers.delete(event.pointerId); if (event.pointerId === primary) cancel(); });
  on(element, 'contextmenu', event => { event.preventDefault(); });
  // Screen-reader activation has no pointer sequence. Normal compatibility
  // click/dblclick events must not fire another action after the recognizer.
  on(element, 'click', event => { event.preventDefault(); if (event.detail === 0 && usable()) gesture('tap'); });
  on(element, 'dblclick', event => event.preventDefault());
  on(window, 'keydown', event => {
    const binding = keyBinding(event); if (!binding || !keyboardAllowed(event)) return;
    event.preventDefault(); if (event.repeat) return;
    recognizer.cancel();
    if (binding.release) heldKeys.set(binding.code, binding);
    dispatch(binding.action || actionForGesture(binding.gesture), 'keyboard');
  });
  on(window, 'keyup', event => {
    // Finish a hold even if opening Ask moved focus to a field.
    const code = event.code || keyBinding(event)?.code; const binding = heldKeys.get(code);
    if (!binding) return; heldKeys.delete(code); event.preventDefault();
    dispatch(actionForGesture(binding.release), 'keyboard');
  });
  on(document, 'pointerdown', event => { if (!element.contains(event.target)) cancel(); }, { capture: true });
  on(window, 'blur', cancel);
  on(window, 'pagehide', cancel);
  on(document, 'visibilitychange', () => { if (document.hidden) cancel(); });
  return { cancel, destroy() { cancel(); controller.abort(); } };
}
