// Merging two copies of the vault (this device's and the sync server's). A payload is
// { vault: [credential], cards: [card], profiles: [profile], tombstones: [{ id, at }] }; tombstones
// record deletions of any kind so they sync too.
// Works in the service worker and in Node.
(() => {
  const PM = (globalThis.PM ||= {});
  const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  const sameUser = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // Per login, the most recently updated copy wins. The same login saved separately on two devices has
  // two ids, so (site, username) also counts as a match. A deletion beats edits made before it.
  PM.mergePayloads = (a, b, now = Date.now()) => {
    const dead = new Map();
    for (const t of [...(a.tombstones || []), ...(b.tombstones || [])]) {
      if (now - t.at < TOMBSTONE_TTL_MS && !(dead.get(t.id) >= t.at)) dead.set(t.id, t.at);
    }
    const mergeList = (list, same) => {
      const out = [];
      for (const c of list) {
        if (dead.get(c.id) >= c.updated) continue;
        const i = out.findIndex((v) => v.id === c.id || same(v, c));
        if (i === -1) out.push(c);
        else if (c.updated > out[i].updated) out[i] = c;
      }
      return out.sort(byId);
    };
    return {
      vault: mergeList([...(a.vault || []), ...(b.vault || [])], (v, c) => v.site === c.site && sameUser(v.username, c.username)),
      cards: mergeList([...(a.cards || []), ...(b.cards || [])], (v, c) => v.number === c.number),
      profiles: mergeList([...(a.profiles || []), ...(b.profiles || [])], () => false),
      tombstones: [...dead].map(([id, at]) => ({ id, at })).sort(byId),
    };
  };

  const sorted = (list) => [...(list || [])].sort(byId);
  const canonical = (p) => JSON.stringify([sorted(p.vault), sorted(p.cards), sorted(p.profiles), sorted(p.tombstones)]);
  PM.samePayload = (a, b) => canonical(a) === canonical(b);
})();
