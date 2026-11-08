import { MAX_QUESTION_CHARS } from './ask-limits.js';
import { boundedActivities } from './ask-activity.js';
// Phone conversation history is separate from the short follow-up context sent
// to an API. Store recent turns, not the (potentially very large) source passage.
const MAX_TURNS = 40, MAX_CHARACTERS = 100000, MAX_PAPERS = 20;
function paperGroup(key) {
  try {
    const parts = JSON.parse(key);
    if (Array.isArray(parts) && parts.length >= 5) return JSON.stringify([parts[0], parts[5] || 'document', ...(parts[5] === 'terminal-session' ? [parts[2], parts[3], parts[6]] : [])]);
  } catch {}
  return key;
}
function bounded(turns) {
  const kept = []; let size = 0;
  for (const turn of (Array.isArray(turns) ? turns : []).slice(-MAX_TURNS).reverse()) {
    if (!turn || typeof turn.id !== 'string') continue;
    const value = { ...turn, question: String(turn.question || '').slice(0, MAX_QUESTION_CHARS), answer: String(turn.answer || '').slice(0, 16000) };
    if (value.activities) value.activities = boundedActivities(value.activities);
    size += value.question.length + value.answer.length + (value.activities || []).reduce((n, a) => n + a.text.length, 0);
    if (size > MAX_CHARACTERS) break;
    kept.unshift(value);
  }
  return kept;
}

export class AskChat {
  constructor(read, save) { this.read = read; this.save = save; this.cache = new Map(); }
  turns(key) {
    if (!this.cache.has(key)) this.cache.set(key, bounded(this.read()[key]));
    return this.cache.get(key);
  }
  persist(key) {
    const turns = bounded(this.turns(key)); this.cache.set(key, turns);
    const all = { ...this.read() }; delete all[key];
    if (turns.length) all[key] = turns;
    // Count documents, not model variants. Switching models must not evict
    // the other conversation for an otherwise retained document.
    const recent = [...new Set(Object.keys(all).reverse().map(paperGroup))].slice(0, MAX_PAPERS);
    for (const old of Object.keys(all)) if (!recent.includes(paperGroup(old))) delete all[old];
    this.save(all);
  }
  begin(key, question, context) {
    const id = crypto.randomUUID();
    this.turns(key).push({ id, question, answer: '', readThrough: 0, resumeFromHere: true, state: 'pending', page: context.page, position: context.position });
    this.persist(key); return id;
  }
  update(key, id, answer, state = 'pending') {
    const turn = this.turns(key).find(t => t.id === id); if (!turn) return;
    answer = String(answer || '').slice(0, 16000);
    if (turn.answer === answer && turn.state === state) return;
    turn.answer = answer; turn.state = state;
    // Streaming updates stay in memory; checkpoint when leaving the chat and
    // when a turn finishes, rather than writing phone storage on every chunk.
    if (state !== 'pending') this.persist(key);
  }
  reconcile(key, binding) {
    const item = binding?.pending || binding?.reply; if (!item) return;
    const id = item.turnId || item.marker || `reply:${binding.sessionId}:${binding.seenEventId || 0}`;
    const turns = this.turns(key);
    if (!turns.some(t => t.id === id)) {
      turns.push({ id, question: item.question || '', answer: item.answer || '',
        ...(binding.pending || item.unread ? { readThrough: 0 } : {}), state: binding.pending ? 'pending' : 'complete' });
      this.persist(key);
    } else if (binding.reply && !binding.pending) {
      const turn = turns.find(turn => turn.id === id);
      if (item.unread && turn.readThrough == null) turn.readThrough = 0;
      this.update(key, id, item.answer, 'complete');
    }
    const turn = this.turns(key).find(turn => turn.id === id);
    if (binding.pending?.marker && turn.marker !== binding.pending.marker) {
      turn.marker = binding.pending.marker; this.persist(key);
    }
    return id;
  }
  mergeConversation(key, sessionId, incoming, { baseline = false } = {}) {
    const existing = this.turns(key), before = JSON.stringify(existing), used = new Set(), ordered = [];
    const matched = incoming.map(remote => {
      const identities = [remote.id, ...(remote.aliases || [])];
      let turn = existing.find(t => !used.has(t) && t.remoteSession === sessionId &&
        identities.some(id => t.remoteId === id || t.remoteAliases?.includes(id)));
      if (!turn && remote.marker) turn = existing.find(t => !used.has(t) && t.marker === remote.marker);
      // Migrate old phone turns that predate stored correlation markers. Match
      // each occurrence once; repeated questions are separate messages.
      if (!turn && remote.marker) turn = existing.find(t => !used.has(t) && !t.remoteId && !t.marker && t.question === remote.question &&
        (!t.answer || remote.answer === t.answer || remote.answer.startsWith(t.answer) || remote.answer.endsWith(t.answer)));
      // Older external replies had no question. Recover it from shared history.
      if (!turn && remote.answer) turn = existing.find(t => !used.has(t) && !t.remoteId && !t.question && t.answer && remote.answer.endsWith(t.answer));
      if (turn) used.add(turn);
      return turn;
    });
    const frontier = matched.findLastIndex(Boolean), historicalIds = [];
    let reply;
    for (const [index, remote] of incoming.entries()) {
      const identities = [remote.id, ...(remote.aliases || [])];
      let turn = matched[index];
      const fresh = !turn;
      if (!turn) turn = { id: `shared:${sessionId}:${remote.id}`, readThrough: 0 };
      const oldAnswer = turn.answer || '', oldState = turn.state;
      // A delayed snapshot must not replace a longer reply already received.
      // A local completed result may omit historical agent commentary. Keep
      // that result and its read offsets when first associating its remote ID.
      const localResult = (!turn.remoteId || turn.remoteResultOnly) && oldState === 'complete' && oldAnswer && remote.answer.endsWith(oldAnswer);
      const answer = localResult || (remote.answer || remote.state === 'pending') && oldAnswer.startsWith(remote.answer) && oldAnswer.length > remote.answer.length ? oldAnswer : remote.answer;
      const state = oldState === 'complete' && remote.state === 'pending' ? 'complete' : remote.state;
      const historical = state === 'complete' && (fresh && (index <= frontier || baseline && frontier < 0)
        || baseline && !fresh && /^(shared:|reply:)/.test(turn.id));
      if (historical) { delete turn.readThrough; historicalIds.push(turn.id); }
      if (localResult && remote.answer !== oldAnswer) turn.remoteResultOnly = true;
      // Merge by stable activity ID. Older servers/snapshots may omit activity
      // already seen; they must not erase it or regress a completed operation.
      if (remote.activities) {
        const activities = new Map((turn.activities || []).map(a => [a.id, a]));
        for (const next of boundedActivities(remote.activities)) {
          const old = activities.get(next.id);
          if (old && old.state !== 'pending' && next.state === 'pending') {
            if (next.detail && !old.detail) activities.set(next.id, { ...old, detail: next.detail });
            continue;
          }
          activities.set(next.id, { ...next, ...(!next.detail && old?.detail ? { detail: old.detail } : {}) });
        }
        turn.activities = boundedActivities([...activities.values()]);
      }
      Object.assign(turn, { remoteSession: sessionId, remoteId: remote.id, remoteAliases: [...new Set([...(turn.remoteAliases || []), ...identities])],
        ...(remote.marker ? { marker: remote.marker } : {}), question: remote.question, answer, state });
      if (!historical && state === 'complete' && answer && (fresh || oldState !== 'complete')) {
        if (turn.readThrough == null) turn.readThrough = 0;
        delete turn.unreadDismissed;
        reply = turn;
      }
      ordered.push(turn);
    }
    // Keep unsent/failed local questions and older cached history. Insert them
    // relative to known neighbors, while the shared messages retain server order.
    let prefix = 0;
    for (const [index, turn] of existing.entries()) {
      if (used.has(turn)) continue;
      const next = existing.slice(index + 1).find(t => used.has(t));
      if (next) ordered.splice(ordered.indexOf(next), 0, turn);
      else if (turn.remoteSession === sessionId && ordered.length && !existing.slice(0, index).some(t => used.has(t))) ordered.splice(prefix++, 0, turn);
      else ordered.push(turn);
    }
    this.cache.set(key, bounded(ordered));
    const changed = before !== JSON.stringify(this.turns(key));
    if (changed) this.persist(key);
    return { changed, historicalIds, reply: reply && this.turns(key).find(t => t.id === reply.id) };
  }
  history(key) {
    return this.turns(key).filter(t => t.state === 'complete' && t.question && t.answer).slice(-4)
      .flatMap(t => [{ role: 'user', content: t.question }, { role: 'assistant', content: t.answer }]);
  }
  vocabularyHistory(key) {
    return this.turns(key).slice(-12).flatMap(t => [
      { role: 'user', content: t.question }, { role: 'assistant', content: t.answer },
    ]).filter(message => message.content);
  }
  forget(key) { this.cache.delete(key); const all = { ...this.read() }; delete all[key]; this.save(all); }
  clear() { this.cache.clear(); this.save({}); }
}
