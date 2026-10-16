// In-memory matchmaking queue. Pure logic (no I/O) so it's easy to test; the
// realtime layer feeds it and opens conversations when it reports a match.
//
// Roles: 'talk' (needs to vent), 'listen' (here to support), 'either'.
// Preferences (soft, only break ties): same topic, same age band, someone new.
// talk<->listen and anything<->either match right away. talk<->talk and
// listen<->listen only pair up once both have waited `sameRoleAfterMs`, so nobody
// waits forever when the queue is lopsided.

const ROLES = ['talk', 'listen', 'either'];

function rolesFit(a, b) {
  if (a === 'either' || b === 'either') return true;
  return a !== b;
}

function createMatchmaker({ onMatch, now = Date.now, sameRoleAfterMs = 30000 }) {
  const queue = new Map(); // userId -> entry, in join order

  function score(a, b, t) {
    if (a.userId === b.userId) return -Infinity;
    if (a.blocked.has(b.userId) || b.blocked.has(a.userId)) return -Infinity;
    const fit = rolesFit(a.role, b.role);
    if (!fit && (t - a.joinedAt < sameRoleAfterMs || t - b.joinedAt < sameRoleAfterMs)) return -Infinity;
    let s = fit ? 10 : 0;
    if (a.topic && a.topic === b.topic) s += 3;
    // People tend to be more at ease with someone near their age (never shown to anyone).
    if (a.ageBand && a.ageBand === b.ageBand) s += 2;
    // "Random" should mostly mean new people; past partners are a fallback.
    if (a.known.has(b.userId) || b.known.has(a.userId)) s -= 5;
    return s;
  }

  function bestPartner(entry, t) {
    let best = null;
    let bestScore = -Infinity;
    for (const other of queue.values()) {
      const s = score(entry, other, t);
      if (s > bestScore) {
        best = other;
        bestScore = s;
      }
    }
    return best;
  }

  function pair(a, b) {
    queue.delete(a.userId);
    queue.delete(b.userId);
    onMatch(a, b);
  }

  return {
    join({ userId, role = 'either', topic = '', ageBand = '', blocked = new Set(), known = new Set() }) {
      queue.delete(userId);
      const entry = { userId, role: ROLES.includes(role) ? role : 'either', topic, ageBand, blocked, known, joinedAt: now() };
      const partner = bestPartner(entry, entry.joinedAt);
      if (partner) {
        pair(partner, entry);
        return true;
      }
      queue.set(userId, entry);
      return false;
    },

    leave(userId) {
      return queue.delete(userId);
    },

    // Pairs people whose roles only fit after waiting. Call on an interval.
    sweep() {
      const t = now();
      for (const entry of [...queue.values()]) {
        if (!queue.has(entry.userId)) continue;
        queue.delete(entry.userId); // so it can't match itself
        const partner = bestPartner(entry, t);
        if (partner) {
          queue.delete(partner.userId);
          onMatch(partner, entry);
        } else {
          queue.set(entry.userId, entry);
        }
      }
    },

    isQueued: (userId) => queue.has(userId),
    get size() {
      return queue.size;
    },
  };
}

module.exports = { createMatchmaker, ROLES };
