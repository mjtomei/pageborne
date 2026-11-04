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
