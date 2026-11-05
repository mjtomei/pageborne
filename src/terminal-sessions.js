import { paperConnectionKey } from './ask-connections.js';
import { instructionsForPlatform } from '../ai/providers.js';
import { byteLength, titleText, VISIBLE_LINES } from './native-text.js';

export const TERMINAL_SESSIONS_ID = Symbol('terminal-sessions');
export const SESSION_LIST_LIMIT = 100;
const label = value => String(value || '').replace(/\s+/g, ' ').trim();
export const sessionIdentity = session => JSON.stringify([session.provider, session.id]);
export function terminalSessionKey(config, id) {
  const key = JSON.parse(paperConnectionKey(config, 'session'));
  key[0] = null;
  // No document or requested workspace: identity follows the existing owner.
  key[4] = ''; key.push('terminal-session', id);
  return JSON.stringify(key);
}
export const terminalSessionContext = session => ({ scope: 'terminal-session', title: label(session.title) || 'Even Terminal', passage: '' });
export function terminalSessionQuestion(marker, question, platform) {
  return instructionsForPlatform(`${marker}\nPageborne desktop session. Continue this existing conversation and the user's requested work using its existing tools and permissions. The user is reading this discussion on glasses and cannot follow links. Keep progress and replies readable on text-only glasses, with short paragraphs.\n\n${question}`, platform);
}
export async function listTerminalSessions(clientFor, signal) {
  const providers = ['claude', 'codex'];
  const results = await Promise.allSettled(providers.map(provider => clientFor(provider).sessions(signal)));
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const sessions = new Map(), warnings = [];
  results.forEach((result, index) => {
    const provider = providers[index], name = provider === 'claude' ? 'Claude' : 'Codex';
    if (result.status === 'rejected') { warnings.push(`${name} unavailable`); return; }
    if (result.value.length >= SESSION_LIST_LIMIT) warnings.push(`${name}: latest ${SESSION_LIST_LIMIT}`);
    for (const raw of result.value) {
      if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 300) continue;
      const session = { id: raw.id, provider, title: label(raw.title || raw.summary || raw.firstPrompt || raw.id).slice(0, 300),
        timestamp: Number.isFinite(Date.parse(raw.timestamp)) ? Date.parse(raw.timestamp) : 0,
        status: ['busy', 'awaiting', 'idle'].includes(raw.status) ? raw.status : '' };
      sessions.set(sessionIdentity(session), session);
    }
  });
  return { sessions: [...sessions.values()].sort((a, b) => b.timestamp - a.timestamp || sessionIdentity(a).localeCompare(sessionIdentity(b))), warnings };
}
export function terminalSessionPicker(sessions = [], selected, status = '') {
  const items = [{ action: 'back', title: 'Back to library' }, { action: 'refresh', title: 'Refresh sessions' },
    ...sessions.map(session => ({ id: sessionIdentity(session), session,
      title: `${session.provider === 'claude' ? 'Claude' : 'Codex'} · ${session.title}${session.status === 'busy' ? ' · working' : session.status === 'awaiting' ? ' · needs input' : ''}` }))];
  return { kind: 'terminal-sessions', items, status, index: Math.max(0, items.findIndex(item => item.id === selected || item.action === selected)) };
}
export function terminalSessionPickerText(picker) {
  const count = picker.items.length - 2;
  const lines = [`Even Terminal · ${count} sessions`, picker.status || (count ? 'Recent first · Hold to refresh' : 'No sessions found. Tap Refresh to retry.')];
  const visible = VISIBLE_LINES - lines.length;
  const start = Math.max(0, Math.min(picker.items.length - visible, picker.index - Math.floor(visible / 2)));
  for (let i = start; i < Math.min(picker.items.length, start + visible); i++) {
    let bounded = '';
    for (const character of `${i === picker.index ? '> ' : '  '}${picker.items[i].title}`) {
      if (byteLength(bounded + character) > 93) { bounded += '…'; break; }
      bounded += character;
    }
    lines.push(titleText(bounded));
  }
  // Notices from two providers also stay within a single display line.
  lines[1] = titleText(lines[1]);
  return lines.join('\n');
}
