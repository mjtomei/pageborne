import { readingDay } from './reading-activity.js';
import { groupReadingEntries, readingGroupLocation } from './reading-history-groups.js';
import { safeMarkdown } from './safe-markdown.js';
import { marked } from 'marked';
import './reading-history.css';

const number = value => Math.round(value).toLocaleString();
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
export class ReadingHistoryUI {
  constructor({ log, sync, sessions, conversation, openDocument, exists, pause }) {
    Object.assign(this, { log, sync, sessions, conversation, openDocument, exists, pause });
    this.dialog = node('dialog', null, 'reading-history'); this.dialog.id = 'reading-history';
    this.dialog.setAttribute('aria-labelledby', 'reading-history-title');
    const heading = node('div', null, 'reading-history-heading'), title = node('h2', 'Reading history'); title.id = 'reading-history-title';
    const close = node('button', 'Close'); close.type = 'button'; close.onclick = () => this.dialog.close(); heading.append(title, close);
    this.body = node('div', null, 'reading-history-body'); this.dialog.append(heading, this.body); document.body.append(this.dialog);
    this.dialog.addEventListener('close', () => { this.request?.abort(); this.chat = false; });
    this.day = readingDay(new Date()); this.limit = 50;
  }
  async open() {
    this.pause(); this.chat = false; this.day = readingDay(new Date()); this.limit = 50;
    this.dialog.showModal(); this.render(); await this.sync(); this.render();
  }
  render() {
    if (!this.dialog.open || this.chat) return;
    this.body.replaceChildren();
    const entries = this.log()?.entries || [], totals = new Map();
    for (const e of entries) totals.set(e.day, (totals.get(e.day) || 0) + e.words);
    const selected = groupReadingEntries(entries.filter(e => e.day === this.day));
    this.body.append(node('p', `${number(totals.get(this.day) || 0)} words`, 'reading-total'));
    const label = node('label', 'Day '), date = node('input'); date.type = 'date'; date.value = this.day; date.max = readingDay(new Date());
    date.onchange = () => { if (/^\d{4}-\d{2}-\d{2}$/.test(date.value)) { this.day = date.value; this.limit = 50; this.render(); } }; label.append(date); this.body.append(label);
    const chart = node('div', null, 'reading-chart'); chart.setAttribute('role', 'group'); chart.setAttribute('aria-label', 'Words read per day, 30 days ending on the selected day');
    const days = []; const end = new Date(`${this.day}T12:00:00`);
    for (let i = 29; i >= 0; i--) { const d = new Date(end); d.setDate(end.getDate() - i); days.push(readingDay(d)); }
    const max = Math.max(1, ...days.map(day => totals.get(day) || 0));
    for (const day of days) {
      const words = totals.get(day) || 0, bar = node('button'); bar.type = 'button'; bar.title = `${day}: ${number(words)} words`;
      bar.setAttribute('aria-label', bar.title); bar.setAttribute('aria-pressed', String(day === this.day));
      const fill = node('span'); fill.style.height = `${Math.max(2, words / max * 100)}%`; bar.append(fill);
      bar.onclick = () => { this.day = day; this.limit = 50; this.render(); }; chart.append(bar);
    }
    this.body.append(chart, node('p', `${days[0]} — ${days.at(-1)} · peak ${number(max === 1 && !totals.size ? 0 : max)} words/day`, 'muted'),
      node('p', 'Estimated from text shown and then moved past at 10–900 words/minute. Fast paging, image-only views and views idle for over five minutes do not count. Rereading counts again. Days use the device’s local date.', 'reading-explanation muted'),
      node('p', this.sync.status?.() || 'Saved on this device', 'muted'));
    if (!selected.length) this.body.append(node('p', 'No reading logged for this day yet. Read some text, then move on to the next page or document.', 'reading-empty'));
    const list = node('ol', null, 'reading-entries');
    for (const entry of selected.slice(0, this.limit)) {
      const time = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const start = time(entry.startedAt), end = time(entry.endedAt);
      const item = node('li'), heading = node('h3', entry.document.title), metadata = node('p', `${number(entry.words)} words · ${readingGroupLocation(entry)} · ${start === end ? start : `${start}–${end}`} · ${entry.platforms.join(', ')}`, 'muted');
      item.append(heading, metadata);
      if (entry.count === 1) item.append(node('p', entry.excerpt, 'reading-excerpt'));
      const actions = node('div', null, 'reading-entry-actions');
      if (this.exists(entry)) {
        const read = node('button', 'Open document'); read.onclick = () => { this.dialog.close(); this.openDocument(entry); }; actions.append(read);
      } else actions.append(node('span', 'Document no longer in this library', 'muted'));
      const sessions = this.sessions(entry);
      const sessionNumbers = new Map();
      for (const session of sessions) {
        const index = (sessionNumbers.get(session.agent) || 0) + 1; sessionNumbers.set(session.agent, index);
        const suffix = sessions.filter(s => s.agent === session.agent).length > 1 ? ` ${index}` : '';
        const link = node('button', `${session.agent === 'claude' ? 'Claude' : 'Codex'} conversation${suffix}`);
        link.onclick = () => this.openConversation(entry, session); actions.append(link);
      }
      if (!sessions.length) actions.append(node('span', 'No linked conversation', 'muted'));
      item.append(actions); list.append(item);
    }
    this.body.append(list);
    if (selected.length > this.limit) { const more = node('button', 'Show more entries'); more.onclick = () => { this.limit += 50; this.render(); }; this.body.append(more); }
  }
  async openConversation(entry, session) {
    this.request?.abort(); const request = this.request = new AbortController(); this.chat = true; this.body.replaceChildren();
    const back = node('button', '← Reading history'); back.onclick = () => { request.abort(); this.chat = false; this.render(); };
    const refresh = node('button', 'Refresh'); refresh.onclick = () => this.openConversation(entry, session);
    this.body.append(back, refresh, node('h3', entry.document.title), node('p', 'Latest messages from the linked desktop conversation. The original document is not required.', 'muted'));
    const content = node('div', 'Loading conversation…', 'reading-conversation'); content.setAttribute('aria-live', 'polite'); this.body.append(content);
    try {
      const result = await this.conversation(entry, session, request.signal);
      if (request.signal.aborted) return;
      if (!result) throw new Error('Update the desktop conversation extension to view this session.');
      content.replaceChildren();
      for (const turn of result.turns) {
        if (turn.question) { content.append(node('h4', 'You'), node('p', turn.question)); }
        if (turn.answer) { const answer = node('div'); answer.append(safeMarkdown(marked.parse(turn.answer))); content.append(node('h4', session.agent === 'claude' ? 'Claude' : 'Codex'), answer); }
      }
      if (!result.turns.length) content.textContent = 'No messages are available in this session yet.';
    } catch (error) { if (!request.signal.aborted) content.textContent = `Could not load conversation: ${error.message}`; }
  }
}
