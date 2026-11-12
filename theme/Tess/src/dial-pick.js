// Tess Music — The Dial: which items go on the ring, and in what order.
//
// Think of a radio programmer choosing the first records of the day. Each item
// starts with a score for where it came from (Spotify's DJ and its time-of-day
// shelf lead; a generic shelf trails). The score then rises or falls with what is
// happening right now: the weekday and hour the item was picked for, how recently
// it was played, and whether it is new this week. Finally the dial's own memory
// is applied: things you actually played from the ring get a lift, things shown
// over and over and never played sink, and both fade over a fortnight.
//
// The final score is rounded to a whole point and a small day-seeded tie-breaker
// is added, so the ring is stable within a day but not frozen forever. Selection
// then keeps the mix varied (no shelf or kind dominates, at most two artists,
// always the DJ, at least one discovery and one familiar item). Ordering puts the
// best item in slot 0 (unless it is already playing), then fills 1, 11, 2, 10 ...
// — outward from the marker, picking at each step the item that contrasts most
// with the neighbours it will sit beside, because the ring spins both ways.
//
// Plain script: no imports, no DOM, no network. Defines window.TessDialPick.

(function () {
  'use strict';

  // ---------------- tuning knobs ----------------

  const DAY = 86400000;
  const DEFAULT_SLOTS = 12;

  // Base pull of each home source, before personal signals. A source's own
  // editorial confidence, in one number.
  const SOURCE_BASE = { dj: 44, timeOfDay: 31, madeFor: 26, jumpBackIn: 22, topMixes: 19, recent: 17, library: 13, other: 8 };
  // Which source wins when the same uri arrives from several shelves (lower wins).
  const SOURCE_RANK = { dj: 0, timeOfDay: 1, madeFor: 2, jumpBackIn: 3, topMixes: 4, recent: 5, library: 6, other: 7 };

  // Signals added to the base.
  const TIME_OF_DAY_FIT = 12; // a "morning" shelf at breakfast
  const WEEKDAY_FIT = 6; // a "Monday" shelf on Monday
  const DAYLIST_LIFT = 4;
  const FRESHNESS = 18; // Discover Weekly on Monday, Release Radar on Friday
  const NEW_ADDITION = 7; // added in the last three days
  const RECENCY = 14; // last played recently
  const RECENCY_TAU = 7 * DAY;
  const SHELF_PULL = 7; // high on the home page
  const POSITION_PULL = 3; // early within its shelf
  const PINNED = 9;
  const HABIT = 4; // usually played at this hour of day
  const DJ_LIFT = 6;

  // The dial's memory.
  const HISTORY_PLAY = 16; // played from the ring
  const HISTORY_IGNORE = 12; // shown and never played
  const HISTORY_HALF_LIFE = 14 * DAY;
  const HOUR_SOURCE_PULL = 8; // sources you play at this hour
  const HOUR_KIND_PULL = 5; // kinds you play at this hour

  // Ring shape and stability.
  const SOURCE_SHARE = 0.25; // at most a quarter of the ring from one source
  const KIND_SHARE = 0.65; // at most about two thirds of the ring from one kind
  const MAX_ARTISTS = 2;
  const SCORE_QUANTUM = 1; // round scores to whole points before tie-breaking
  const DAY_TIE = 0.6; // day-seeded nudge inside one point
  const CONTRAST_SOURCE = 9; // score points given up to avoid a same-source neighbour
  const CONTRAST_KIND = 5;
  const CONTRAST_TITLE = 150; // near-identical family (Daily Mix 1 vs 2)
  const MAX_SLOTS = 32;

  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const KINDS = { playlist: true, album: true, artist: true, show: true, episode: true, dj: true, other: true };

  // ---------------- small helpers ----------------

  function hash(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function hourBucket(ms) {
    const h = new Date(ms).getHours();
    if (h < 5) return 'night';
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    if (h < 22) return 'evening';
    return 'night';
  }

  function titleSignals(title) {
    const t = String(title || '').toLowerCase();
    let weekday = -1;
    for (let i = 0; i < 7; i += 1) {
      if (t.includes(WEEKDAYS[i])) { weekday = i; break; }
    }
    const bucket = t.includes('morning') ? 'morning'
      : t.includes('afternoon') ? 'afternoon'
        : t.includes('evening') ? 'evening'
          : t.includes('night') ? 'night' : null;
    return {
      weekday,
      bucket,
      daylist: t.includes('daylist'),
      discoverWeekly: t.includes('discover weekly'),
      releaseRadar: t.includes('release radar'),
    };
  }

  // "Daily Mix 1" and "Daily Mix 2" share a family; "Your Top Songs 2023" and
  // "... 2024" do too. Used to keep near-identical cards off neighbouring slots.
  function familyOf(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(?:19|20)\d{2}\b/g, ' ')
      .replace(/\b\d+\b/g, ' ')
      .trim();
  }

  function bump(map, key, by) {
    map.set(key, (map.get(key) || 0) + by);
  }

  function addWeighted(map, bucket, key, weight) {
    let inner = map.get(bucket);
    if (!inner) { inner = new Map(); map.set(bucket, inner); }
    bump(inner, key, weight);
  }

  function maxOf(map) {
    let max = 0;
    for (const value of map.values()) if (value > max) max = value;
    return max;
  }

  // ---------------- merge the same uri from several shelves ----------------

  function mergeCandidates(candidates) {
    const byUri = new Map();
    for (const c of candidates) {
      if (!c || typeof c.uri !== 'string' || !c.uri) continue;
      const kind = KINDS[c.kind] ? c.kind : 'other';
      const source = SOURCE_RANK[c.source] !== undefined ? c.source : 'other';
      const shelfIndex = Number.isFinite(c.shelfIndex) ? c.shelfIndex : null;
      const position = Number.isFinite(c.position) ? c.position : null;
      const lastPlayedAt = Number.isFinite(c.lastPlayedAt) ? c.lastPlayedAt : null;
      const addedAt = Number.isFinite(c.addedAt) ? c.addedAt : null;
      const current = byUri.get(c.uri);

      if (!current) {
        byUri.set(c.uri, {
          uri: c.uri,
          title: c.title || '',
          subtitle: c.subtitle || '',
          img: c.img || '',
          kind,
          source,
          shelfIndex,
          position,
          lastPlayedAt,
          addedAt,
          ownerIsSpotify: !!c.ownerIsSpotify,
          pinned: !!c.pinned,
          sources: [source],
          isDj: c.source === 'dj',
        });
        continue;
      }

      // The same item can be both a made-for mix and a jump-back-in card. Keep
      // the strongest source, the earliest shelf slot, the latest play, and the
      // oldest "added" date (when it truly entered the library).
      if (!current.title && c.title) current.title = c.title;
      if (!current.subtitle && c.subtitle) current.subtitle = c.subtitle;
      if (!current.img && c.img) current.img = c.img;
      if (SOURCE_RANK[source] < SOURCE_RANK[current.source]) current.source = source;
      if (!current.sources.includes(source)) current.sources.push(source);
      if (shelfIndex !== null && (current.shelfIndex === null || shelfIndex < current.shelfIndex)) current.shelfIndex = shelfIndex;
      if (position !== null && (current.position === null || position < current.position)) current.position = position;
      if (lastPlayedAt !== null && (current.lastPlayedAt === null || lastPlayedAt > current.lastPlayedAt)) current.lastPlayedAt = lastPlayedAt;
      if (addedAt !== null && (current.addedAt === null || addedAt < current.addedAt)) current.addedAt = addedAt;
      current.ownerIsSpotify = current.ownerIsSpotify || !!c.ownerIsSpotify;
      current.pinned = current.pinned || !!c.pinned;
      current.isDj = current.isDj || c.source === 'dj';
    }
    for (const item of byUri.values()) item.family = familyOf(item.title) || item.uri;
    return Array.from(byUri.values());
  }

  // ---------------- learn from what the ring showed and played ----------------

  function buildHistory(history, now, metaByUri) {
    const byUri = new Map();
    const hourSource = new Map();
    const hourKind = new Map();
    if (!Array.isArray(history)) return { byUri, hourSource, hourKind, sourceMax: 0, kindMax: 0 };

    for (const entry of history) {
      if (!entry || typeof entry.uri !== 'string' || !entry.uri) continue;
      const when = Number.isFinite(entry.playedAt) ? entry.playedAt
        : Number.isFinite(entry.shownAt) ? entry.shownAt : null;
      if (when === null) continue;
      const decay = Math.pow(0.5, Math.max(0, now - when) / HISTORY_HALF_LIFE);

      let record = byUri.get(entry.uri);
      if (!record) { record = { played: 0, shown: 0 }; byUri.set(entry.uri, record); }
      if (Number.isFinite(entry.playedAt)) {
        record.played += decay;
        const meta = metaByUri.get(entry.uri);
        if (meta) {
          const at = hourBucket(entry.playedAt);
          addWeighted(hourSource, at, meta.source, decay);
          addWeighted(hourKind, at, meta.kind, decay);
        }
      } else {
        record.shown += decay;
      }
    }

    let sourceMax = 0;
    for (const inner of hourSource.values()) sourceMax = Math.max(sourceMax, maxOf(inner));
    let kindMax = 0;
    for (const inner of hourKind.values()) kindMax = Math.max(kindMax, maxOf(inner));
    return { byUri, hourSource, hourKind, sourceMax, kindMax };
  }

  // ---------------- classify and explain ----------------

  function classify(item, now, signals) {
    const ageAddedDays = item.addedAt !== null ? Math.max(0, now - item.addedAt) / DAY : Infinity;
    const agePlayedDays = item.lastPlayedAt !== null ? Math.max(0, now - item.lastPlayedAt) / DAY : Infinity;

    const familiar = item.source === 'library'
      || item.source === 'jumpBackIn'
      || item.source === 'recent'
      || item.pinned
      || agePlayedDays <= 7;

    const fresh = signals.discoverWeekly
      || signals.releaseRadar
      || signals.daylist
      || (ageAddedDays <= 21 && agePlayedDays > 30)
      || (item.kind === 'episode' && agePlayedDays > 14)
      || (item.source === 'topMixes' && agePlayedDays > 21);

    return { discovery: fresh && !familiar, comfort: familiar, agePlayedDays };
  }

  function titleCase(word) {
    return word ? word.charAt(0).toUpperCase() + word.slice(1) : '';
  }

  function reasonFor(item, signals, flags, env, historyPlayed) {
    if (historyPlayed) return 'You play this from the dial';
    if (item.isDj) return 'Your DJ, ready right now';
    if (signals.discoverWeekly && env.weekday === 1) return 'Your Monday discovery';
    if (signals.releaseRadar && env.weekday === 5) return 'New releases for Friday';
    if (signals.daylist) return 'Your ' + titleCase(WEEKDAYS[env.weekday]) + ' ' + env.bucket + ' daylist';
    if (item.source === 'timeOfDay') {
      if (signals.bucket === env.bucket && signals.weekday === env.weekday) {
        return 'Your ' + titleCase(WEEKDAYS[env.weekday]) + ' ' + env.bucket + ' mix';
      }
      return 'Picked for this ' + env.bucket;
    }
    if (item.pinned) return 'Pinned in your library';
    if (flags.comfort && flags.agePlayedDays <= 7) return 'Played most this week';
    if (flags.discovery) return signals.discoverWeekly ? 'Fresh discoveries for you' : 'Something new for you';
    if (flags.comfort && item.source === 'jumpBackIn') return 'Right where you left off';
    if (flags.comfort && item.source === 'library') return 'From your library';
    if (item.source === 'madeFor') return 'From your Made For shelf';
    if (item.source === 'topMixes') return 'From your top mixes';
    if (item.source === 'recent') return 'Recently played';
    if (item.source === 'jumpBackIn') return 'Jump back in';
    if (item.source === 'library') return 'From your library';
    if (item.kind === 'episode' || item.kind === 'show') return 'From a show for you';
    return 'Picked for you';
  }

  // ---------------- score every candidate ----------------

  function scoreAll(merged, hist, env) {
    const currentHourBucket = env.bucket;
    const currentWeekday = env.weekday;

    return merged.map((item) => {
      const signals = titleSignals(item.title);
      const base = SOURCE_BASE[item.source] !== undefined ? SOURCE_BASE[item.source] : SOURCE_BASE.other;
      let raw = base;

      if (item.isDj) raw += DJ_LIFT;

      // Context: the shelf the home page built for this exact day and hour.
      if (item.source === 'timeOfDay') {
        if (signals.bucket === currentHourBucket) raw += TIME_OF_DAY_FIT;
        if (signals.weekday === currentWeekday) raw += WEEKDAY_FIT;
      }
      if (signals.daylist) {
        raw += DAYLIST_LIFT;
        if (signals.bucket === currentHourBucket) raw += TIME_OF_DAY_FIT * 0.6;
        if (signals.weekday === currentWeekday) raw += WEEKDAY_FIT * 0.5;
      }

      // Freshness: Discover Weekly peaks on Monday, Release Radar on Friday.
      if (signals.discoverWeekly) raw += currentWeekday === 1 ? FRESHNESS : 3;
      if (signals.releaseRadar) raw += currentWeekday === 5 ? FRESHNESS : 3;

      if (item.addedAt !== null) {
        const age = Math.max(0, env.now - item.addedAt);
        if (age < 3 * DAY) raw += NEW_ADDITION;
        else if (age < 14 * DAY) raw += NEW_ADDITION * 0.45;
      }

      if (item.lastPlayedAt !== null) {
        const age = Math.max(0, env.now - item.lastPlayedAt);
        raw += RECENCY * Math.exp(-age / RECENCY_TAU);
        if (hourBucket(item.lastPlayedAt) === currentHourBucket) raw += HABIT;
      }

      if (item.shelfIndex !== null) raw += SHELF_PULL * Math.exp(-item.shelfIndex / 5);
      if (item.position !== null) raw += POSITION_PULL * Math.exp(-item.position / 8);
      if (item.pinned) raw += PINNED;

      // What the ring taught us about this exact item.
      const learned = hist.byUri.get(item.uri);
      if (learned) {
        raw += HISTORY_PLAY * Math.min(1, learned.played);
        raw -= HISTORY_IGNORE * Math.min(1, learned.shown * 0.5);
      }

      // What the ring taught us about this hour: the sources and kinds the user
      // tends to play at this point in the day.
      const sourceWeights = hist.hourSource.get(currentHourBucket);
      if (sourceWeights && hist.sourceMax > 0) {
        raw += HOUR_SOURCE_PULL * Math.min(1, (sourceWeights.get(item.source) || 0) / hist.sourceMax);
      }
      const kindWeights = hist.hourKind.get(currentHourBucket);
      if (kindWeights && hist.kindMax > 0) {
        raw += HOUR_KIND_PULL * Math.min(1, (kindWeights.get(item.kind) || 0) / hist.kindMax);
      }

      // Round to whole points, then nudge within the point by a stable, per-day
      // hash. Small changes in recency therefore rarely reshuffle the ring.
      const tie = hash(item.uri + '|' + env.daySeed) / 4294967296;
      const score = Math.round(raw / SCORE_QUANTUM) * SCORE_QUANTUM + tie * DAY_TIE;

      const flags = classify(item, env.now, signals);
      const historyPlayed = !!learned && learned.played > 0.08;

      return {
        uri: item.uri,
        title: item.title,
        subtitle: item.subtitle,
        img: item.img,
        kind: item.kind,
        source: item.source,
        sources: item.sources,
        family: item.family,
        shelfIndex: item.shelfIndex,
        position: item.position,
        lastPlayedAt: item.lastPlayedAt,
        addedAt: item.addedAt,
        ownerIsSpotify: item.ownerIsSpotify,
        pinned: item.pinned,
        score: Math.round(score * 100) / 100,
        flags,
        signals,
        historyPlayed,
        isDj: item.isDj,
        tie,
      };
    });
  }

  // ---------------- pick a balanced set ----------------

  function selectItems(ranked, slots, currentUri) {
    const perSource = Math.max(2, Math.floor(slots * SOURCE_SHARE));
    const perKind = Math.max(3, Math.ceil(slots * KIND_SHARE));
    const perFamily = Math.max(1, Math.floor(slots / 2));
    const chosen = [];
    const chosenUris = new Set();
    const sourceCount = new Map();
    const kindCount = new Map();
    const familyCount = new Map();
    let artists = 0;

    const allowed = (item, strict) => {
      if (chosenUris.has(item.uri)) return false;
      if (item.kind === 'artist' && artists >= MAX_ARTISTS) return false;
      if (!strict) return true;
      if ((sourceCount.get(item.source) || 0) >= perSource) return false;
      if ((kindCount.get(item.kind) || 0) >= perKind) return false;
      if ((familyCount.get(item.family) || 0) >= perFamily) return false;
      return true;
    };
    const take = (item) => {
      chosen.push(item);
      chosenUris.add(item.uri);
      bump(sourceCount, item.source, 1);
      bump(kindCount, item.kind, 1);
      bump(familyCount, item.family, 1);
      if (item.kind === 'artist') artists += 1;
    };
    const release = (index) => {
      const item = chosen.splice(index, 1)[0];
      chosenUris.delete(item.uri);
      bump(sourceCount, item.source, -1);
      bump(kindCount, item.kind, -1);
      bump(familyCount, item.family, -1);
      if (item.kind === 'artist') artists -= 1;
      return item;
    };

    // The DJ is the house band: always on the ring, whatever the caps say.
    const dj = ranked.find((item) => item.isDj);
    if (dj) take(dj);

    for (const item of ranked) {
      if (chosen.length >= slots) break;
      if (allowed(item, true)) take(item);
    }

    // The best item and the thing already playing are not swap fodder.
    const mustKeep = new Set();
    const best = chosen.reduce((top, item) => (top && top.score >= item.score ? top : item), null);
    if (best) mustKeep.add(best.uri);
    if (currentUri) mustKeep.add(currentUri);

    // Would this candidate fit if `removed` left the ring first? Used so the
    // discovery/comfort guarantee can normally keep every cap intact.
    const fitsAfter = (candidate, removed) => {
      const artistAfter = artists - (removed.kind === 'artist' ? 1 : 0);
      if (candidate.kind === 'artist' && artistAfter >= MAX_ARTISTS) return false;
      const sourceAfter = (sourceCount.get(candidate.source) || 0) - (removed.source === candidate.source ? 1 : 0);
      if (sourceAfter >= perSource) return false;
      const kindAfter = (kindCount.get(candidate.kind) || 0) - (removed.kind === candidate.kind ? 1 : 0);
      if (kindAfter >= perKind) return false;
      const familyAfter = (familyCount.get(candidate.family) || 0) - (removed.family === candidate.family ? 1 : 0);
      if (familyAfter >= perFamily) return false;
      return true;
    };

    // Guarantee at least one discovery and one familiar item when the pool has
    // one, even if the caps squeezed them out. Swap out the weakest eligible
    // item, never one that satisfies a guarantee already secured.
    const swapIn = (need) => {
      if (chosen.some((item) => item.flags[need])) return;
      const wanted = ranked.filter((item) => item.flags[need] && !chosenUris.has(item.uri));
      if (!wanted.length) return;

      for (let i = chosen.length - 1; i >= 0; i -= 1) {
        const removed = chosen[i];
        if (removed.isDj || mustKeep.has(removed.uri)) continue;
        for (const candidate of wanted) {
          if (!fitsAfter(candidate, removed)) continue;
          release(i);
          take(candidate);
          mustKeep.add(candidate.uri);
          return;
        }
      }

      if (chosen.length < slots) {
        take(wanted[0]);
        mustKeep.add(wanted[0].uri);
        return;
      }

      // Crowded ring: the guarantee matters more than perfect balance.
      let replacement = -1;
      let lowest = Infinity;
      for (let i = 0; i < chosen.length; i += 1) {
        const item = chosen[i];
        if (item.isDj || mustKeep.has(item.uri)) continue;
        if (item.score < lowest) { lowest = item.score; replacement = i; }
      }
      if (replacement === -1) return;
      const removed = release(replacement);
      const candidate = wanted.find((item) => allowed(item, false));
      if (candidate) { take(candidate); mustKeep.add(candidate.uri); }
      else take(removed);
    };
    swapIn('discovery');
    swapIn('comfort');

    // If caps left holes, fill with the best remaining items. Source and kind
    // balance is a preference; the artist cap stays hard.
    if (chosen.length < slots) {
      for (const item of ranked) {
        if (chosen.length >= slots) break;
        if (allowed(item, false)) take(item);
      }
    }

    return chosen;
  }

  // ---------------- order the ring by contrast ----------------

  function contrastPenalty(a, b) {
    if (!a || !b) return 0;
    let penalty = 0;
    if (a.source === b.source) penalty += CONTRAST_SOURCE;
    if (a.kind === b.kind) penalty += CONTRAST_KIND;
    if (a.family === b.family) penalty += CONTRAST_TITLE;
    return penalty;
  }

  function orderRing(chosen, currentUri) {
    const n = chosen.length;
    if (!n) return [];
    const ring = new Array(n).fill(null);

    // Best item goes under the marker, unless that is what is already playing.
    let first = -1;
    for (let i = 0; i < n; i += 1) {
      if (chosen[i].uri === currentUri) continue;
      if (first === -1 || chosen[i].score > chosen[first].score) first = i;
    }
    if (first === -1) first = 0;
    ring[0] = chosen[first];
    const remaining = chosen.filter((_, i) => i !== first);

    // Fill 1, n-1, 2, n-2, ... so both directions away from slot 0 are shaped
    // first, then the far side of the wheel.
    const positions = [0];
    for (let d = 1; d < n; d += 1) {
      positions.push(d % 2 === 1 ? (d + 1) / 2 : n - d / 2);
    }

    for (let p = 1; p < positions.length; p += 1) {
      const slot = positions[p];
      const before = ring[(slot - 1 + n) % n];
      const after = ring[(slot + 1) % n];
      let bestIndex = 0;
      let bestValue = -Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const item = remaining[i];
        const value = item.score - contrastPenalty(item, before) - contrastPenalty(item, after);
        if (value > bestValue) { bestValue = value; bestIndex = i; }
      }
      ring[slot] = remaining.splice(bestIndex, 1)[0];
    }

    return repairRing(ring);
  }

  // If members of the same family still ended up side by side, re-walk the ring
  // once, keeping slot 0 fixed and preferring the order the contrast pass chose.
  // A ring can hold at most floor(n/2) members of one family without neighbours
  // repeating, so if the selection obeyed that cap this always finds a layout.
  // With a degenerate pool (almost everything from one family) it gives up and
  // returns the best-effort ring instead.
  function repairRing(ring) {
    const n = ring.length;
    if (n < 3) return ring;
    let conflicts = false;
    for (let i = 0; i < n; i += 1) {
      if (ring[i].family === ring[(i + 1) % n].family) { conflicts = true; break; }
    }
    if (!conflicts) return ring;

    const counts = new Map();
    for (const item of ring) bump(counts, item.family, 1);
    let largest = 0;
    for (const count of counts.values()) if (count > largest) largest = count;
    if (largest > Math.floor(n / 2)) return ring;

    const fixed = ring[0];
    // Try the largest family first; that is the one that must be spread out.
    // Within a family, keep the contrast pass's order.
    const rest = ring.slice(1)
      .map((item, index) => ({ item, index }))
      .sort((a, b) => counts.get(b.item.family) - counts.get(a.item.family) || a.index - b.index)
      .map((entry) => entry.item);
    const used = new Array(rest.length).fill(false);
    const out = [fixed];
    let nodes = 0;

    const place = (position) => {
      if (position === n) return true;
      nodes += 1;
      if (nodes > 20000) return false;
      for (let i = 0; i < rest.length; i += 1) {
        if (used[i]) continue;
        const item = rest[i];
        if (out[position - 1].family === item.family) continue;
        if (position === n - 1 && fixed.family === item.family) continue;
        used[i] = true;
        out.push(item);
        if (place(position + 1)) return true;
        out.pop();
        used[i] = false;
      }
      return false;
    };

    return place(1) ? out : ring;
  }

  // ---------------- the public entry point ----------------

  function pickDialItems(candidates, context) {
    const list = Array.isArray(candidates) ? candidates : [];
    const ctx = context || {};
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const slots = Number.isFinite(ctx.slots) ? Math.max(0, Math.min(MAX_SLOTS, Math.floor(ctx.slots))) : DEFAULT_SLOTS;
    if (slots === 0) return [];
    const currentUri = typeof ctx.currentUri === 'string' ? ctx.currentUri : null;

    const merged = mergeCandidates(list);
    if (!merged.length) return [];

    const meta = new Map(merged.map((item) => [item.uri, item]));
    const hist = buildHistory(ctx.dialHistory, now, meta);
    const env = {
      now,
      bucket: hourBucket(now),
      weekday: new Date(now).getDay(),
      daySeed: hash(new Date(now).toDateString()),
    };

    const scored = scoreAll(merged, hist, env);
    scored.sort((a, b) => b.score - a.score || b.tie - a.tie || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));

    const chosen = selectItems(scored, slots, currentUri);
    const ring = orderRing(chosen, currentUri);

    return ring.map((item) => ({
      uri: item.uri,
      title: item.title,
      subtitle: item.subtitle,
      img: item.img,
      kind: item.kind,
      source: item.source,
      sources: item.sources,
      shelfIndex: item.shelfIndex,
      position: item.position,
      lastPlayedAt: item.lastPlayedAt,
      addedAt: item.addedAt,
      ownerIsSpotify: item.ownerIsSpotify,
      pinned: item.pinned,
      score: item.score,
      reason: reasonFor(item, item.signals, item.flags, env, item.historyPlayed),
    }));
  }

  window.TessDialPick = { pickDialItems };
})();
