// Reconstruct sessions from immutable observations, before filtering by day or
// source. Midnight and brief pauses must not turn one pane into two readings.
export function readingSessions(entries, maxPauseSeconds) {
  const sessions = [], active = new Map();
  for (const entry of [...entries].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const source = JSON.stringify([entry.scope, entry.kind || 'document', entry.document?.key,
      entry.document?.id, entry.document?.revision, entry.platform]);
    // Old logs have no run IDs: infer consecutive visits on the same surface.
    const key = entry.version === 2 ? `${source}:${entry.run}` : `legacy:${entry.platform}`;
    let session = active.get(key);
    const previous = session?.entries.at(-1);
    const end = previous && (Date.parse(previous.endedAt) || Date.parse(previous.at) + previous.seconds * 1000);
    if (!session || session.source !== source || !Number.isFinite(end)
        || Date.parse(entry.at) - end > maxPauseSeconds * 1000
        || previous.seconds > maxPauseSeconds || entry.seconds > maxPauseSeconds
        || ['leave', 'source', 'layout'].includes(previous.reason)) {
      session = { source, entries: [] }; sessions.push(session); active.set(key, session);
    }
    session.entries.push(entry);
  }
  return sessions.map(session => session.entries);
}

export function readingPaneKey(entry) {
  // A reflowed PDF page can span many panes; a source page number alone is not
  // sufficient. Word identity also works for phone Ask, which has no position.
  if (entry.version === 2) return entry.units[0]?.[0] ?? entry.viewId;
  return JSON.stringify([entry.page, entry.position]);
}
