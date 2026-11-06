// A display summary only: retain every original event for storage and sync.
export function groupReadingEntries(entries) {
  const groups = [];
  for (const entry of [...entries].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))) {
    let group = groups.at(-1);
    if (!group || (group.kind || 'document') !== (entry.kind || 'document') || group.day !== entry.day || group.scope !== entry.scope ||
        group.document.key !== entry.document.key || group.document.id !== entry.document.id) {
      group = { ...entry, words: 0, seconds: 0, count: 0, startedAt: entry.at, endedAt: entry.endedAt || entry.at,
        minPage: Infinity, maxPage: 0, minPosition: Infinity, maxPosition: 0,
        platforms: new Set(), sessions: new Map(), views: [] };
      groups.push(group);
    }
    group.views.push(entry);
    group.words += entry.words; group.seconds += entry.seconds; group.count++;
    if (entry.at < group.startedAt) group.startedAt = entry.at;
    if ((entry.endedAt || entry.at) > group.endedAt) group.endedAt = entry.endedAt || entry.at;
    if (entry.page) { group.minPage = Math.min(group.minPage, entry.page); group.maxPage = Math.max(group.maxPage, entry.page); }
    group.minPosition = Math.min(group.minPosition, entry.position);
    group.maxPosition = Math.max(group.maxPosition, entry.position);
    group.platforms.add(entry.platform);
    for (const session of entry.sessions || []) {
      const key = `${session.agent}:${session.id}`;
      if (!group.sessions.has(key)) group.sessions.set(key, session);
    }
  }
  return groups.map(group => ({ ...group, platforms: [...group.platforms], sessions: [...group.sessions.values()] }));
}

export function readingGroupLocation(group) {
  if (group.maxPage) return group.minPage === group.maxPage ? `page ${group.minPage}` : `pages ${group.minPage}–${group.maxPage}`;
  const start = Math.round(group.minPosition), end = Math.round(group.maxPosition);
  return start === end ? `${start}%` : `${start}–${end}%`;
}
