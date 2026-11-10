// A display summary only: retain every original event for storage and sync.
function documentKey(entry) {
  if (entry.kind === 'ask') {
    try {
      const key = JSON.parse(entry.document.key);
      // Document Ask keys wrap the source key. Librarian and terminal sessions
      // have a null source and must remain separate, even with matching titles.
      if (Array.isArray(key) && key.length === 5 && typeof key[0] === 'string'
          && ['terminal', 'provider'].includes(key[1])) return key[0];
    } catch { /* Older/unrecognized keys retain their original identity. */ }
  }
  return entry.document.key;
}
const location = () => ({ minPage: Infinity, maxPage: 0, minPosition: Infinity, maxPosition: 0 });

export function groupReadingEntries(entries) {
  const groups = [];
  for (const entry of [...entries].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))) {
    let group = groups.at(-1);
    const key = documentKey(entry), kind = entry.kind === 'ask' ? 'ask' : 'document';
    if (!group || group.day !== entry.day || group.scope !== entry.scope ||
        group.document.key !== key || group.document.id !== entry.document.id) {
      group = { ...entry, words: 0, seconds: 0, count: 0, startedAt: entry.at, endedAt: entry.endedAt || entry.at,
        document: { ...entry.document, key }, documentWords: 0, askWords: 0, documentViews: 0, askViews: 0,
        locations: { document: location(), ask: location() },
        platforms: new Set(), sessions: new Map(), views: [] };
      groups.push(group);
    }
    group.views.push(entry);
    group.words += entry.words; group.seconds += entry.seconds; group.count++;
    group[`${kind}Words`] += entry.words; group[`${kind}Views`]++;
    if (kind === 'document' && group.documentViews === 1) group.document = { ...entry.document };
    if (entry.at < group.startedAt) group.startedAt = entry.at;
    if ((entry.endedAt || entry.at) > group.endedAt) group.endedAt = entry.endedAt || entry.at;
    const range = group.locations[kind];
    if (entry.page) { range.minPage = Math.min(range.minPage, entry.page); range.maxPage = Math.max(range.maxPage, entry.page); }
    range.minPosition = Math.min(range.minPosition, entry.position);
    range.maxPosition = Math.max(range.maxPosition, entry.position);
    group.platforms.add(entry.platform);
    for (const session of entry.sessions || []) {
      const key = `${session.agent}:${session.id}`;
      if (!group.sessions.has(key)) group.sessions.set(key, session);
    }
  }
  return groups.map(({ locations, ...group }) => {
    const kind = group.documentViews ? 'document' : 'ask';
    // Ask pane numbers are unrelated to document pages or reading position.
    return { ...group, kind, ...locations[kind], platforms: [...group.platforms], sessions: [...group.sessions.values()] };
  });
}

export function readingGroupLocation(group) {
  if (group.maxPage) return group.minPage === group.maxPage ? `page ${group.minPage}` : `pages ${group.minPage}–${group.maxPage}`;
  const start = Math.round(group.minPosition), end = Math.round(group.maxPosition);
  return start === end ? `${start}%` : `${start}–${end}%`;
}
