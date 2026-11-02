import { Lexer, Parser } from 'marked';
import './web-reading.css';

export function closestQuestion(turns, { page, position }) {
  const located = turns.filter(t => t.question && t.position != null && Number.isFinite(Number(t.position)));
  const paged = page && located.some(t => t.page);
  return located.filter(t => !paged || t.page)
    .map((turn, index) => ({ turn, index, distance: paged ? Math.abs(page - turn.page) : Math.abs(position - turn.position) }))
    .sort((a, b) => a.distance - b.distance || b.index - a.index)[0]?.turn || null;
}

// Documents may contain arbitrary HTML. Copy only a small formatting vocabulary
// from an inert document, never raw attributes, event handlers, or embedded apps.
export function safeMarkdown(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const allowed = new Set('P H1 H2 H3 H4 H5 H6 EM STRONG DEL BLOCKQUOTE UL OL LI PRE CODE BR HR TABLE THEAD TBODY TR TH TD A IMG SUP SUB'.split(' '));
  const copy = node => {
    if (node.nodeType === 3) return document.createTextNode(node.textContent);
    if (!allowed.has(node.tagName)) return document.createDocumentFragment();
    const el = document.createElement(node.tagName.toLowerCase());
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (/^(https?:|mailto:|#)/i.test(href)) { el.href = href; el.rel = 'noopener noreferrer'; el.target = '_blank'; }
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      el.alt = node.getAttribute('alt') || '';
      if (/^https:\/\//i.test(src)) { el.src = src; el.loading = 'lazy'; el.referrerPolicy = 'no-referrer'; }
    }
    if (node.tagName === 'OL' && /^\d+$/.test(node.getAttribute('start'))) el.start = Number(node.getAttribute('start'));
    for (const child of node.childNodes) el.append(copy(child));
    return el;
  };
  const fragment = document.createDocumentFragment();
  for (const child of parsed.body.childNodes) fragment.append(copy(child));
  return fragment;
}
const icons = {
  chat: '<path d="M4 4h16v12H9l-5 4z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M8 21h8"/>',
  question: '<path d="M8 6a4 4 0 1 1 6 3.5c-2 1-2 2-2 3.5M12 17h.01"/><circle cx="12" cy="12" r="10"/>',
};
function button(id, label, icon) {
  const el = document.createElement('button'); el.id = id; el.type = 'button'; el.setAttribute('aria-label', label);
  el.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[icon] || ''}</svg><span></span>`;
  el.lastChild.textContent = label; return el;
}
export class WebReading {
  constructor({ ask, position, changed, library, settings }) {
    Object.assign(this, { ask, position, changed });
    this.generation = 0; this.seeking = false;
    this.root = document.createElement('section'); this.root.id = 'web-reading';
    this.root.innerHTML = '<div id="web-page-label" aria-live="off"></div><div id="web-document" tabindex="0" aria-label="Document"></div><div id="web-actions"></div>';
    document.querySelector('.reader-content').prepend(this.root);
    document.querySelector('.reader-content').append(document.getElementById('notice'));
    this.scroller = this.root.querySelector('#web-document'); this.actions = this.root.querySelector('#web-actions');
    this.near = button('web-nearby', 'Nearby question', 'question'); this.near.hidden = true;
    this.mic = button('web-speak', 'Hold to talk', 'mic');
    this.chat = button('web-chat', 'Chat', 'chat');
    this.actions.append(this.near, this.mic, this.chat);
    this.chat.onclick = () => this.openChat();
    this.near.onclick = () => this.openChat(this.nearest);
    this.dialog = document.createElement('dialog'); this.dialog.id = 'web-chat-dialog'; this.dialog.setAttribute('aria-label', 'Chat about this document');
    this.dialog.innerHTML = '<div class="web-chat-heading"><strong>Ask about this document</strong><button type="button" id="web-chat-close" aria-label="Close chat">✕</button></div>';
    document.body.append(this.dialog); this.dialog.append(document.getElementById('ask-panel'));
    document.getElementById('web-chat-close').onclick = () => this.closeChat();
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.closeChat(); });
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.closeChat(); });
    const viewport = () => this.fitChat();
    window.visualViewport?.addEventListener('resize', viewport);
    window.visualViewport?.addEventListener('scroll', viewport);
    window.addEventListener('resize', viewport);
    this.mic.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.mic.disabled) return;
      event.preventDefault(); this.mic.setPointerCapture(event.pointerId); this.holding = true;
      void ask.hold('phone'); this.update();
    });
    const release = () => {
      if (!this.holding) return; this.holding = false;
      void ask.release(); this.openChat(); this.update();
    };
    this.mic.addEventListener('pointerup', release);
    this.mic.addEventListener('lostpointercapture', release);
    this.mic.addEventListener('pointercancel', () => { if (this.holding) { this.holding = false; ask.cancelDictation(); this.update(); } });
    this.mic.addEventListener('keydown', event => {
      if ([' ', 'Enter'].includes(event.key) && !event.repeat && !this.holding && !this.mic.disabled) { event.preventDefault(); this.holding = true; void ask.hold('phone'); this.update(); }
    });
    this.mic.addEventListener('keyup', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); release(); } });
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
    this.scroller.addEventListener('scroll', () => {
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => { this.scrollFrame = null; this.onScroll(); });
    }, { passive: true });
    this.resize = new ResizeObserver(() => {
      if (this.width === this.scroller.clientWidth) return;
      this.width = this.scroller.clientWidth;
      if (this.pdf) this.renderPdfPages();
    });
    this.resize.observe(this.scroller);
    this.settings = settings; this.library = library;
    document.getElementById('ask-history-help').textContent = 'Conversations use the desktop sessions linked to this document in your shared library. Each model keeps its own history.';
    const help = document.querySelector('#library-help-content p');
    help.textContent = 'Read PDFs, Markdown and text from your shared desktop library. Add files here or on the desktop, then sync to transfer changes.';
    for (let node = document.getElementById('settings-speed'); node && node.id !== 'settings-reading-ask'; node = node.nextElementSibling) node.hidden = true;
    document.getElementById('ask-settings-link').addEventListener('click', () => this.closeChat());
  }
  fitChat() {
    const v = window.visualViewport;
    if (this.dialog.open && v && Math.abs(v.scale - 1) < .05 && innerHeight - v.height > 120) {
      const width = Math.min(540, v.width - 16), height = Math.max(180, v.height - 16);
      Object.assign(this.dialog.style, { position: 'fixed', margin: '0', left: `${v.offsetLeft + v.width - width - 8}px`,
        top: `${v.offsetTop + 8}px`, width: `${width}px`, height: `${height}px`, maxHeight: `${height}px` });
    } else this.dialog.removeAttribute('style');
  }
  async setDocument(doc, layout, savedY = 0) {
    const generation = ++this.generation;
    const previous = this.pdf; this.pdf = null;
    await previous?.destroy();
    if (generation !== this.generation) return null;
    this.layout = layout; this.document = doc; this.y = 0; this.page = null;
    this.scroller.replaceChildren(); this.targets = []; this.closeChat();
    if (!doc) { this.scroller.innerHTML = '<div class="web-empty"><p class="web-eyebrow">PAGEBORNE</p><h1>Your library.<br>Room to read.</h1><p>Choose a document to begin.</p><button type="button">Open library</button></div>'; this.scroller.querySelector('button').onclick = this.library; this.update(); return null; }
    if (doc.format === 'pdf') {
      this.scroller.textContent = 'Opening PDF…';
      const { WebPdf } = await import('./web-pdf.js');
      if (generation !== this.generation) return null;
      const pdf = this.pdf = new WebPdf();
      try { this.layout = await pdf.open(doc.content); }
      catch (error) {
        await pdf.destroy();
        if (this.pdf === pdf) this.pdf = null;
        throw error;
      }
      if (generation !== this.generation) { await pdf.destroy(); return null; }
      this.scroller.replaceChildren();
      for (const block of this.layout.blocks) {
        const el = document.createElement('section'); el.className = 'web-pdf-page'; el.dataset.page = block.page; el.dataset.y = block.y;
        el.style.aspectRatio = `${552} / ${block.height}`; el.setAttribute('aria-label', `PDF page ${block.page}`);
        this.scroller.append(el); this.targets.push({ el, y: block.y, height: block.height });
      }
    } else {
      const article = document.createElement('article'); article.className = 'web-prose'; this.scroller.append(article);
      let line = 1;
      const tokens = Lexer.lex(doc.content.replace(/\r\n?/g, '\n'), { gfm: true });
      for (const token of tokens) {
        if (token.type !== 'space') {
          const el = document.createElement('div'); el.className = 'web-markdown-block';
          const list = [token]; list.links = tokens.links;
          el.append(safeMarkdown(Parser.parse(list)));
          article.append(el);
          const block = layout.blocks.find(b => b.sourceLine >= line) || layout.blocks.at(-1);
          this.targets.push({ el, y: layout.blockY[block?.index] || 0 });
        }
        line += (token.raw.match(/\n/g) || []).length;
      }
    }
    if (this.pdf) this.renderPdfPages();
    else this.scroller.style.paddingBottom = '';
    this.goTo(savedY); this.update(); return this.layout;
  }
  onScroll() {
    if (!this.layout) return;
    const top = this.scroller.getBoundingClientRect().top + 12;
    const target = this.targets.find(t => t.el.getBoundingClientRect().bottom > top) || this.targets.at(-1);
    if (target) {
      const bounds = target.el.getBoundingClientRect();
      const next = this.targets[this.targets.indexOf(target) + 1];
      const fraction = Math.max(0, Math.min(1, (top - bounds.top) / Math.max(1, bounds.height)));
      this.y = Math.min(this.layout.maxY, target.y + fraction * (target.height || Math.max(0, (next?.y ?? this.layout.maxY) - target.y)));
      this.page = this.pdf ? Number(target.el.dataset.page) : null;
      this.position(this.y);
      if (this.pdf) { void this.pdf.text(this.page).catch(() => {}); this.renderPdfPages(); }
      this.update();
    }
  }
  readingUnits() {
    if (!this.layout || this.dialog.open) return [];
    const viewport = this.scroller.getBoundingClientRect();
    const key = `${this.scroller.scrollTop}:${viewport.width}:${viewport.height}:${this.scroller.scrollHeight}:${this.layout.textRevision}`;
    if (this.readingCache?.layout === this.layout && this.readingCache.key === key) return this.readingCache.units;
    const units = [], range = document.createRange();
    this.readingNodes ||= new WeakMap();
    for (const [index, target] of this.targets.entries()) {
      const rect = target.el.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      if (this.pdf) {
        if (!target.el.dataset.rendered) continue;
        const block = this.layout.blocks[index];
        if (!block.textLoaded) { void this.pdf.text(block.page).catch(() => {}); continue; }
        const scale = rect.height / block.height;
        for (const item of block.readingItems || []) {
          const top = rect.top + item.y * scale, bottom = top + item.height * scale;
          if (top >= viewport.top && bottom <= viewport.bottom) units.push(item);
        }
      } else {
        const walker = document.createTreeWalker(target.el, NodeFilter.SHOW_TEXT);
        let textNode, n = 0;
        while ((textNode = walker.nextNode())) {
          const number = n++; range.selectNodeContents(textNode);
          const bounds = range.getBoundingClientRect();
          if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue;
          if (!this.readingNodes.has(textNode)) this.readingNodes.set(textNode, [...textNode.textContent.matchAll(/\S*[\p{L}\p{N}]\S*/gu)]);
          const words = this.readingNodes.get(textNode);
          const box = i => { const word = words[i]; range.setStart(textNode, word.index); range.setEnd(textNode, word.index + word[0].length); return range.getBoundingClientRect(); };
          let low = 0, high = words.length;
          while (low < high) { const mid = (low + high) >>> 1; if (box(mid).bottom <= viewport.top) low = mid + 1; else high = mid; }
          for (let i = low; i < words.length; i++) {
            const r = box(i); if (r.top >= viewport.bottom) break;
            if (r.top >= viewport.top && r.bottom <= viewport.bottom) units.push({ key: `md:${index}:${number}:${i}`, words: 1, text: words[i][0] });
          }
        }
      }
    }
    this.readingCache = { layout: this.layout, key, units }; return units;
  }
  goTo(y, page) {
    if (!this.layout || !this.targets.length) return;
    if (this.pdf && page) y = this.layout.blocks[Math.max(0, Math.min(this.layout.blocks.length - 1, page - 1))].y;
    const target = this.targets.findLast(t => t.y <= y) || this.targets[0];
    const next = this.targets[this.targets.indexOf(target) + 1];
    const span = target.height || (next?.y ?? this.layout.maxY) - target.y;
    const offset = span > 0 ? Math.max(0, Math.min(1, (y - target.y) / span)) * target.el.offsetHeight : 0;
    this.scroller.scrollTop += target.el.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + offset - 12;
    this.onScroll();
  }
  renderPdfPages() {
    if (!this.pdf) return;
    this.scroller.style.paddingBottom = `${Math.max(110, this.scroller.clientHeight - (this.targets.at(-1)?.el.clientHeight || 0) + 24)}px`;
    const bounds = this.scroller.getBoundingClientRect(), padding = this.scroller.clientHeight;
    for (const { el } of this.targets) {
      const rect = el.getBoundingClientRect(), visible = rect.bottom >= bounds.top - padding && rect.top <= bounds.bottom + padding;
      const key = `${Math.round(rect.width)}`;
      if (visible && el.dataset.renderWidth !== key) {
        el.dataset.renderWidth = key;
        delete el.dataset.rendered;
        for (const canvas of el.querySelectorAll('canvas')) this.pdf.cancel(canvas);
        const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', el.getAttribute('aria-label'));
        el.replaceChildren(canvas);
        void this.pdf.render(Number(el.dataset.page), canvas, rect.width).then(() => {
          if (canvas.isConnected) { el.dataset.rendered = key; this.readingCache = null; }
        }).catch(error => {
          if (canvas.isConnected && error.name !== 'RenderingCancelledException') { el.textContent = 'Could not draw this page. Scroll away and back to retry.'; delete el.dataset.renderWidth; }
        });
      } else if (!visible && el.firstChild) {
        for (const canvas of el.querySelectorAll('canvas')) this.pdf.cancel(canvas);
        el.replaceChildren(); delete el.dataset.renderWidth; delete el.dataset.rendered;
      }
    }
  }
  openChat(turn) {
    if (!this.ask.open({ showConversation: false })) return;
    if (!this.dialog.open) this.dialog.showModal();
    this.fitChat();
    this.ask.phoneVisible = true; this.ask.render();
    this.dialog.querySelector('strong').textContent = this.ask.librarian ? 'Ask the librarian' : this.document?.title || 'Ask';
    if (turn) {
      this.ask.chatFollowing = false;
      requestAnimationFrame(() => {
        const node = [...document.querySelectorAll('#ask-messages .ask-message')].find(el => el.dataset.key === `${turn.id}:user`);
        if (node) document.getElementById('ask-history').scrollTop += node.getBoundingClientRect().top - document.getElementById('ask-history').getBoundingClientRect().top;
      });
    }
  }
  closeChat() {
    if (!this.dialog.open) return;
    if (['starting', 'listening'].includes(this.ask.session.status)) void this.ask.release();
    this.dialog.close(); this.ask.phoneVisible = false; this.ask.glassesVisible = false;
    this.chat.focus({ preventScroll: true });
  }
  update() {
    const { ask } = this, key = ask.currentPaperKey();
    const turns = key ? ask.chat.turns(key) : [];
    this.nearest = this.layout ? closestQuestion(turns, { page: this.page, position: 100 * (this.y || 0) / (this.layout.maxY || 1) }) : null;
    this.near.hidden = !this.nearest;
    if (this.nearest) this.near.lastChild.textContent = this.nearest.page ? `Question · p. ${this.nearest.page}` : 'Nearby question';
    this.near.disabled = this.chat.disabled = this.mic.disabled = !this.layout || !!ask.unavailableReason;
    for (const control of [this.near, this.chat, this.mic]) control.title = ask.unavailableReason || '';
    this.chat.lastChild.textContent = ask.unavailableReason ? 'Ask after loading' : 'Chat';
    this.mic.disabled ||= ask.session.status === 'transcribing';
    this.mic.classList.toggle('recording', !!this.holding);
    this.mic.lastChild.textContent = this.holding ? 'Release to review' : ask.unavailableReason ? 'PDF processing' : 'Hold to talk';
    this.chat.classList.toggle('unread', !!ask.replyUnread);
    this.root.querySelector('#web-page-label').textContent = this.layout ? this.pdf ? `Page ${this.page || 1} of ${this.layout.blocks.length}` : `${Math.round(100 * (this.y || 0) / (this.layout.maxY || 1))}%` : '';
  }
}
