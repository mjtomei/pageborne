import { connectionMode, paperConnectionKey } from './ask-connections.js';
import { librarianConnectionKey } from './librarian.js';

export const ASK_AGENTS = ['claude', 'codex'];
export const LATEST_CLAUDE_LABEL = 'Claude Fable 5.2';
export const sessionModelName = model => typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)
  ? model.replace(/^claude-fable-(\d+)-(\d+)(?:-\d{8})?$/, 'Fable $1.$2') : '';
export const askScopeKey = paperId => JSON.stringify(paperId == null ? [null, 'librarian'] : [paperId]);
export const askChatKey = (config, paperId) => paperId == null ? librarianConnectionKey(config) : paperConnectionKey(config, paperId);
export const defaultAskAgent = (config, choices) => ASK_AGENTS.includes(choices?.defaultAgent) ? choices.defaultAgent
  : ASK_AGENTS.includes(config.agent) ? config.agent : 'claude';

// Pin pre-selector conversations before a default can change. Prefer the
// previously configured agent if both have history, otherwise recover the
// existing conversation even when a build changed its bundled default.
export function retainAskModels(config, choices = {}, bindings = {}, chats = {}) {
  if (connectionMode(config) !== 'terminal') return choices;
  const papers = new Set();
  for (const key of new Set([...Object.keys(bindings), ...Object.keys(chats)])) {
    let parts; try { parts = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parts) || parts[1] !== 'terminal' || parts[2] !== (config.chatScope || config.endpoint) || !ASK_AGENTS.includes(parts[3])) continue;
    if (parts.length === 5 && typeof parts[0] === 'string' || parts.length === 6 && parts[0] === null && parts[5] === 'librarian') papers.add(parts[0]);
  }
  let next = choices;
  for (const paperId of papers) {
    const scope = askScopeKey(paperId);
    if (ASK_AGENTS.includes(next.selections?.[scope])) continue;
    const agent = [config.agent, ...ASK_AGENTS].find(agent => {
      if (!ASK_AGENTS.includes(agent)) return false;
      const key = askChatKey({ ...config, agent }, paperId), binding = bindings[key];
      return binding?.sessionId || binding?.pending || binding?.reply || chats[key]?.length;
    });
    if (agent) next = { ...next, selections: { ...next.selections, [scope]: agent } };
  }
  return next;
}

export function askConfigFor(config, choices, paperId) {
  if (connectionMode(config) !== 'terminal') return config;
  const selected = choices?.selections?.[askScopeKey(paperId)];
  return { ...config, agent: ASK_AGENTS.includes(selected) ? selected : defaultAskAgent(config, choices) };
}
