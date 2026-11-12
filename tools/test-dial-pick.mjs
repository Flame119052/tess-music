// Tests for The Dial's selection algorithm — node --test compatible, no deps.
// Run: node tools/test-dial-pick.mjs

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const source = readFileSync(new URL('../theme/Tess/src/dial-pick.js', import.meta.url), 'utf8');
// The real theme runs in the page's own realm. Give the vm the host intrinsics
// too, so the runtime test measures the algorithm rather than vm cross-realm
// overhead (which is about 7x on this machine).
const sandbox = {
  window: {},
  Date, Math, Map, Set, Number, String, Object, Array, JSON, Infinity, NaN, isFinite,
};
vm.runInNewContext(source, sandbox, { filename: 'dial-pick.js' });
const { pickDialItems } = sandbox.window.TessDialPick;

const HOUR = 3600000;
const DAY = 86400000;
// A Monday, 9am local. Built with the local-date constructor so the weekday
// and hour buckets are the same in every timezone.
const MONDAY_9AM = new Date(2026, 10, 9, 9, 0, 0).getTime();
const WEDNESDAY_9AM = MONDAY_9AM + 2 * DAY;
const MONDAY_9PM = new Date(2026, 10, 9, 21, 0, 0).getTime();

function item(uri, title, sourceName, kind, extra = {}) {
  return {
    uri,
    title,
    subtitle: extra.subtitle ?? 'Test shelf',
    img: 'https://example.test/art.jpg',
    kind,
    source: sourceName,
    shelfIndex: extra.shelfIndex ?? null,
    position: extra.position ?? null,
    lastPlayedAt: extra.lastPlayedAt ?? null,
    addedAt: extra.addedAt ?? null,
    ownerIsSpotify: extra.ownerIsSpotify ?? false,
    pinned: extra.pinned ?? false,
  };
}

const uriFor = (name) => 'spotify:playlist:' + name.replace(/\W+/g, '').toLowerCase();

// About sixty realistic cards across every source. Times are relative to the
// Monday fixture so "recent" means recent on every run.
function fixtures(now = MONDAY_9AM) {
  const list = [
    item('spotify:playlist:37i9dQZF1EYkqdzj48dyYq', 'DJ', 'dj', 'dj', {
      shelfIndex: 0, position: 0, ownerIsSpotify: true, img: 'https://example.test/dj.jpg',
    }),
    item(uriFor('Soundtrack Monday morning'), 'Soundtrack your Monday morning', 'timeOfDay', 'playlist', { shelfIndex: 1, position: 0 }),
    item(uriFor('Soundtrack Monday evening'), 'Soundtrack your Monday evening', 'timeOfDay', 'playlist', { shelfIndex: 1, position: 1 }),
    item(uriFor('Soundtrack Monday afternoon'), 'Soundtrack your Monday afternoon', 'timeOfDay', 'playlist', { shelfIndex: 1, position: 2 }),
  ];

  // Made For: six Daily Mixes, Discover Weekly, Release Radar, daylist, and two
  // yearly "Your Top Songs" cards that belong to the same family.
  for (let i = 1; i <= 6; i += 1) {
    list.push(item(uriFor('Daily Mix ' + i), 'Daily Mix ' + i, 'madeFor', 'playlist', {
      shelfIndex: 2,
      position: i - 1,
      lastPlayedAt: i <= 3 ? now - (i * 5 + 1) * HOUR : now - (i * 3) * DAY,
      ownerIsSpotify: true,
    }));
  }
  list.push(item(uriFor('Discover Weekly'), 'Discover Weekly', 'madeFor', 'playlist', {
    shelfIndex: 2, position: 6, ownerIsSpotify: true,
  }));
  list.push(item(uriFor('Release Radar'), 'Release Radar', 'madeFor', 'playlist', {
    shelfIndex: 2, position: 7, ownerIsSpotify: true,
  }));
  list.push(item(uriFor('daylist'), 'daylist', 'madeFor', 'playlist', {
    shelfIndex: 2, position: 8, ownerIsSpotify: true,
  }));
  list.push(item(uriFor('Top Songs 2023'), 'Your Top Songs 2023', 'madeFor', 'playlist', { shelfIndex: 2, position: 9 }));
  list.push(item(uriFor('Top Songs 2024'), 'Your Top Songs 2024', 'madeFor', 'playlist', { shelfIndex: 2, position: 10 }));

  // Jump back in.
  for (let i = 1; i <= 5; i += 1) {
    list.push(item(uriFor('Jump back ' + i), 'Jump back in ' + i, 'jumpBackIn', 'playlist', {
      shelfIndex: 3,
      position: i - 1,
      lastPlayedAt: now - (i * 9) * HOUR,
    }));
  }

  // Your top mixes.
  for (let i = 1; i <= 5; i += 1) {
    list.push(item(uriFor('Top mix ' + i), 'Top mix ' + i, 'topMixes', 'playlist', {
      shelfIndex: 4,
      position: i - 1,
      lastPlayedAt: i <= 2 ? now - (i * 2) * DAY : now - (i * 15) * DAY,
    }));
  }

  // Recently played contexts, newest first.
  const recentAges = [2 * HOUR, 8 * HOUR, 1 * DAY, 3 * DAY, 6 * DAY, 20 * DAY];
  recentAges.forEach((age, i) => {
    list.push(item(uriFor('Recent ' + (i + 1)), 'Recent context ' + (i + 1), 'recent', i % 2 ? 'album' : 'playlist', {
      shelfIndex: 5,
      position: i,
      lastPlayedAt: now - age,
    }));
  });

  // Library, with a spread of added dates and a couple of pins.
  for (let i = 1; i <= 8; i += 1) {
    list.push(item(uriFor('Library ' + i), 'Saved album ' + i, 'library', i % 3 === 0 ? 'album' : 'playlist', {
      shelfIndex: 6,
      position: i - 1,
      addedAt: now - (i === 1 ? 1 : i === 2 ? 5 : i === 3 ? 40 : 200 + i) * DAY,
      lastPlayedAt: i === 4 ? now - 30 * HOUR : i === 5 ? now - 9 * DAY : null,
      pinned: i === 2,
      ownerIsSpotify: i % 2 === 0,
    }));
  }

  // Artists (four, to prove the two-artist cap) and a couple of shows.
  for (let i = 1; i <= 4; i += 1) {
    list.push(item(uriFor('Artist ' + i), 'Artist ' + i, i <= 2 ? 'recent' : 'other', 'artist', {
      shelfIndex: 7,
      position: i - 1,
      lastPlayedAt: i <= 2 ? now - i * 3 * HOUR : null,
    }));
  }
  list.push(item(uriFor('Show 1'), 'A show you follow', 'library', 'show', {
    shelfIndex: 6, position: 10, addedAt: now - 60 * DAY, lastPlayedAt: now - 12 * DAY,
  }));
  list.push(item(uriFor('Episode 1'), 'A fresh episode', 'other', 'episode', {
    shelfIndex: 8, position: 0, addedAt: now - 2 * DAY,
  }));

  // Other home shelves.
  for (let i = 1; i <= 5; i += 1) {
    list.push(item(uriFor('Other ' + i), 'Other shelf card ' + i, 'other', i % 2 ? 'playlist' : 'album', {
      shelfIndex: 8,
      position: i,
      ownerIsSpotify: i <= 2,
    }));
  }

  // Duplicates: Daily Mix 1 also appears as a Jump back in card, Discover Weekly
  // also on the recent list. The picker must merge them.
  list.push(item(uriFor('Daily Mix 1'), 'Daily Mix 1', 'jumpBackIn', 'playlist', {
    shelfIndex: 3, position: 5, lastPlayedAt: now - 2 * HOUR,
  }));
  list.push(item(uriFor('Discover Weekly'), 'Discover Weekly', 'recent', 'playlist', {
    shelfIndex: 5, position: 6,
  }));

  return list;
}

const byUri = (items, uri) => items.find((it) => it.uri === uri);
const idxOf = (items, uri) => items.findIndex((it) => it.uri === uri);
const family = (title) => String(title).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\b\d+\b/g, ' ').trim();

function assertRingShape(ring, slots) {
  assert.ok(Array.isArray(ring), 'returns an array');
  assert.ok(ring.length <= slots, 'never exceeds the slot count');
  assert.equal(new Set(ring.map((it) => it.uri)).size, ring.length, 'no duplicate uris');
  for (const it of ring) {
    assert.equal(typeof it.uri, 'string');
    assert.equal(typeof it.title, 'string');
    assert.equal(typeof it.reason, 'string');
    assert.ok(it.reason.length > 3, 'reason is a readable caption');
    assert.equal(typeof it.score, 'number');
    assert.ok(Number.isFinite(it.score));
  }
}

test('is deterministic and returns a well-formed ring', () => {
  const candidates = fixtures();
  const context = { now: MONDAY_9AM, currentUri: null, dialHistory: [] };
  const a = pickDialItems(candidates, context);
  const b = pickDialItems(candidates, context);
  assert.deepEqual(a, b, 'same inputs give the same ring');
  assertRingShape(a, 12);
  assert.equal(a.length, 12);
  assert.ok(new Set(a.map((it) => it.source)).size >= 4, 'a varied ring');
  assert.notEqual(a[1].source, a[0].source, 'slot 1 contrasts with slot 0');
  assert.notEqual(a[11].source, a[0].source, 'slot 11 contrasts with slot 0');
});

test('merges duplicate uris and keeps the strongest source signals', () => {
  const candidates = fixtures();
  const ring = pickDialItems(candidates, { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  const mixes = ring.filter((it) => it.uri === uriFor('Daily Mix 1'));
  assert.equal(mixes.length, 1, 'Daily Mix 1 appears once');
  const merged = mixes[0];
  assert.equal(merged.source, 'madeFor', 'Made For outranks Jump back in');
  assert.ok(merged.sources.includes('madeFor') && merged.sources.includes('jumpBackIn'));
  assert.equal(merged.shelfIndex, 2, 'earliest shelf wins');
});

test('always includes the DJ', () => {
  const ring = pickDialItems(fixtures(), { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  assert.ok(ring.some((it) => it.uri === 'spotify:playlist:37i9dQZF1EYkqdzj48dyYq'), 'DJ is on the ring');
});

test('the best item is slot 0, and the thing already playing is not', () => {
  const candidates = fixtures();
  const plain = pickDialItems(candidates, { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  const currentUri = plain[0].uri;
  assert.ok(currentUri, 'fixture has a best item');

  const ring = pickDialItems(candidates, { now: MONDAY_9AM, currentUri, dialHistory: [] });
  assert.notEqual(ring[0].uri, currentUri, 'current context is not under the marker');
  assert.ok(ring.some((it) => it.uri === currentUri), 'but it is still available later');

  const rest = ring.filter((it) => it.uri !== currentUri);
  assert.equal(ring[0].score, Math.max(...rest.map((it) => it.score)), 'slot 0 holds the best playable item');
});

test('diversity: source share, kind share, and at most two artists', () => {
  const ring = pickDialItems(fixtures(), { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  const sourceCounts = {};
  const kindCounts = {};
  for (const it of ring) {
    sourceCounts[it.source] = (sourceCounts[it.source] || 0) + 1;
    kindCounts[it.kind] = (kindCounts[it.kind] || 0) + 1;
  }
  for (const [source, count] of Object.entries(sourceCounts)) {
    assert.ok(count <= 3, `${source} takes ${count} slots, cap is 3`);
  }
  for (const [kind, count] of Object.entries(kindCounts)) {
    assert.ok(count <= 8, `${kind} takes ${count} slots, cap is 8`);
  }
  assert.ok(kindCounts.artist === undefined || kindCounts.artist <= 2, 'at most two artists');
});

test('near-identical cards never sit in adjacent slots', () => {
  // Force the Daily Mix family into the pool: six siblings, ten neighbours.
  const candidates = [
    item('spotify:playlist:37i9dQZF1EYkqdzj48dyYq', 'DJ', 'dj', 'dj', { shelfIndex: 0 }),
  ];
  for (let i = 1; i <= 6; i += 1) {
    candidates.push(item(uriFor('Daily Mix ' + i), 'Daily Mix ' + i, 'madeFor', 'playlist', {
      shelfIndex: 1, position: i,
    }));
  }
  for (let i = 1; i <= 10; i += 1) {
    candidates.push(item(uriFor('Filler ' + i), 'Filler ' + i, i % 2 ? 'jumpBackIn' : 'library', 'playlist', {
      shelfIndex: 2, position: i,
    }));
  }

  const ring = pickDialItems(candidates, { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  assertRingShape(ring, 12);
  const mixesOnRing = ring.filter((it) => /daily mix/i.test(it.title));
  assert.ok(mixesOnRing.length >= 3, 'several siblings made the ring');
  for (let i = 0; i < ring.length; i += 1) {
    const next = ring[(i + 1) % ring.length];
    assert.notEqual(family(ring[i].title), family(next.title), `slots ${i} and ${(i + 1) % ring.length} share a family`);
  }
});

test('always keeps one discovery and one familiar item when available', () => {
  const ring = pickDialItems(fixtures(), { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  const discovery = ring.some((it) => /discover weekly|release radar/i.test(it.title) || it.source === 'timeOfDay');
  const familiar = ring.some((it) => it.source === 'jumpBackIn' || it.source === 'library' || it.source === 'recent');
  assert.ok(discovery, 'a discovery item is present');
  assert.ok(familiar, 'a familiar item is present');
});

test('Discover Weekly gets its Monday boost', () => {
  // A small pool where Discover Weekly is guaranteed a place on both days.
  const candidates = [
    item('spotify:playlist:37i9dQZF1EYkqdzj48dyYq', 'DJ', 'dj', 'dj', { shelfIndex: 0 }),
    item(uriFor('Discover Weekly'), 'Discover Weekly', 'madeFor', 'playlist', { shelfIndex: 1, position: 0, ownerIsSpotify: true }),
    item(uriFor('Release Radar'), 'Release Radar', 'madeFor', 'playlist', { shelfIndex: 1, position: 1, ownerIsSpotify: true }),
  ];
  for (let i = 1; i <= 9; i += 1) {
    candidates.push(item(uriFor('Monday filler ' + i), 'Monday filler ' + i, i % 2 ? 'jumpBackIn' : 'library', 'playlist', {
      shelfIndex: 2, position: i,
    }));
  }

  const monday = pickDialItems(candidates, { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  const wednesday = pickDialItems(candidates, { now: WEDNESDAY_9AM, currentUri: null, dialHistory: [] });
  const uri = uriFor('Discover Weekly');

  const mondayItem = byUri(monday, uri);
  const wednesdayItem = byUri(wednesday, uri);
  assert.ok(mondayItem && wednesdayItem, 'Discover Weekly is on both rings');
  assert.ok(mondayItem.score >= wednesdayItem.score + 10, `Monday ${mondayItem.score} vs Wednesday ${wednesdayItem.score}`);
  assert.ok(idxOf(monday, uri) <= idxOf(wednesday, uri), 'it sits at least as near the marker on Monday');
});

test('the time-of-day shelf fits the hour and weekday', () => {
  const candidates = fixtures();
  const uri = uriFor('Soundtrack Monday morning');
  const morning = pickDialItems(candidates, { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  const evening = pickDialItems(candidates, { now: MONDAY_9PM, currentUri: null, dialHistory: [] });
  const morningItem = byUri(morning, uri);
  const eveningItem = byUri(evening, uri);
  assert.ok(morningItem && eveningItem, 'the morning shelf is on both rings');
  assert.ok(morningItem.score >= eveningItem.score + 8, `morning ${morningItem.score} vs evening ${eveningItem.score}`);
});

test('the dial memory fades over about fourteen days', () => {
  const uri = uriFor('Decay subject');
  const candidates = [
    item('spotify:playlist:37i9dQZF1EYkqdzj48dyYq', 'DJ', 'dj', 'dj', { shelfIndex: 0 }),
    item(uri, 'Decay subject', 'library', 'playlist', { shelfIndex: 1 }),
  ];
  for (let i = 1; i <= 10; i += 1) {
    candidates.push(item(uriFor('Decay filler ' + i), 'Decay filler ' + i, i % 2 ? 'jumpBackIn' : 'topMixes', 'playlist', {
      shelfIndex: 2, position: i,
    }));
  }

  const recent = pickDialItems(candidates, {
    now: MONDAY_9AM,
    currentUri: null,
    dialHistory: [{ uri, shownAt: MONDAY_9AM - 2 * DAY, playedAt: MONDAY_9AM - 1 * DAY + 6 * HOUR }],
  });
  const old = pickDialItems(candidates, {
    now: MONDAY_9AM,
    currentUri: null,
    dialHistory: [{ uri, shownAt: MONDAY_9AM - 30 * DAY, playedAt: MONDAY_9AM - 29 * DAY + 6 * HOUR }],
  });
  const recentItem = byUri(recent, uri);
  const oldItem = byUri(old, uri);
  assert.ok(recentItem && oldItem, 'the subject is on both rings');
  assert.ok(recentItem.score >= oldItem.score + 8, `a play yesterday (${recentItem.score}) beats one a month ago (${oldItem.score})`);
});

test('learns the hour: last-played habit and same-hour source affinity', () => {
  const morningUri = uriFor('Morning habit');
  const nightUri = uriFor('Night habit');
  const historyUri = uriFor('History subject');
  const targetUri = uriFor('Affinity target');
  const sunday9am = new Date(2026, 10, 8, 9, 0, 0).getTime();
  const sunday9pm = new Date(2026, 10, 8, 21, 0, 0).getTime();

  const base = [
    item('spotify:playlist:37i9dQZF1EYkqdzj48dyYq', 'DJ', 'dj', 'dj', { shelfIndex: 0 }),
    item(morningUri, 'Morning habit', 'madeFor', 'playlist', { shelfIndex: 1, lastPlayedAt: sunday9am }),
    item(nightUri, 'Night habit', 'madeFor', 'playlist', { shelfIndex: 1, lastPlayedAt: sunday9pm }),
    item(historyUri, 'History subject', 'madeFor', 'playlist', { shelfIndex: 1, lastPlayedAt: null }),
    item(targetUri, 'Affinity target', 'madeFor', 'playlist', { shelfIndex: 1, lastPlayedAt: null }),
  ];
  for (let i = 1; i <= 7; i += 1) {
    base.push(item(uriFor('Hour filler ' + i), 'Hour filler ' + i, i % 2 ? 'jumpBackIn' : 'library', 'playlist', {
      shelfIndex: 2, position: i,
    }));
  }

  const plain = pickDialItems(base, { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  const learned = pickDialItems(base, {
    now: MONDAY_9AM,
    currentUri: null,
    dialHistory: [{ uri: historyUri, shownAt: MONDAY_9AM - 1 * HOUR, playedAt: MONDAY_9AM - 1 * HOUR }],
  });

  assert.ok(byUri(plain, morningUri).score > byUri(plain, nightUri).score, 'a 9am habit outranks a 9pm habit at 9am');

  const targetPlain = byUri(plain, targetUri);
  const targetLearned = byUri(learned, targetUri);
  assert.ok(targetPlain && targetLearned, 'the affinity target is on both rings');
  assert.ok(targetLearned.score >= targetPlain.score + 8, `same-hour Made For plays lift it (${targetPlain.score} to ${targetLearned.score})`);
});

test('the ring learns: played items rise, ignored items sink', () => {
  // Exactly twelve cards, so both study subjects are on the ring before and
  // after the history is applied.
  const playedUri = uriFor('Daily Mix 5');
  const ignoredUri = uriFor('Daily Mix 6');
  const candidates = [
    item('spotify:playlist:37i9dQZF1EYkqdzj48dyYq', 'DJ', 'dj', 'dj', { shelfIndex: 0 }),
    item(playedUri, 'Daily Mix 5', 'madeFor', 'playlist', { shelfIndex: 1, position: 4 }),
    item(ignoredUri, 'Daily Mix 6', 'madeFor', 'playlist', { shelfIndex: 1, position: 5 }),
  ];
  for (let i = 1; i <= 9; i += 1) {
    candidates.push(item(uriFor('Learning filler ' + i), 'Learning filler ' + i, i % 2 ? 'jumpBackIn' : 'library', 'playlist', {
      shelfIndex: 2, position: i,
    }));
  }

  const base = pickDialItems(candidates, { now: MONDAY_9AM, currentUri: null, dialHistory: [] });

  const history = [
    { uri: playedUri, shownAt: MONDAY_9AM - 12 * DAY, playedAt: MONDAY_9AM - 11 * DAY + 6 * HOUR },
    { uri: playedUri, shownAt: MONDAY_9AM - 6 * DAY, playedAt: MONDAY_9AM - 5 * DAY + 6 * HOUR },
    { uri: playedUri, shownAt: MONDAY_9AM - 3 * DAY, playedAt: MONDAY_9AM - 2 * DAY + 6 * HOUR },
    { uri: ignoredUri, shownAt: MONDAY_9AM - 13 * DAY, playedAt: null },
    { uri: ignoredUri, shownAt: MONDAY_9AM - 10 * DAY, playedAt: null },
    { uri: ignoredUri, shownAt: MONDAY_9AM - 7 * DAY, playedAt: null },
    { uri: ignoredUri, shownAt: MONDAY_9AM - 4 * DAY, playedAt: null },
    { uri: ignoredUri, shownAt: MONDAY_9AM - 1 * DAY, playedAt: null },
  ];
  const learned = pickDialItems(candidates, { now: MONDAY_9AM, currentUri: null, dialHistory: history });

  const basePlayed = byUri(base, playedUri);
  const learnedPlayed = byUri(learned, playedUri);
  const baseIgnored = byUri(base, ignoredUri);
  const learnedIgnored = byUri(learned, ignoredUri);

  assert.ok(basePlayed && learnedPlayed, 'the played item is on both rings');
  assert.ok(learnedPlayed.score >= basePlayed.score + 8, `played rose from ${basePlayed.score} to ${learnedPlayed.score}`);
  assert.ok(idxOf(learned, playedUri) <= idxOf(base, playedUri), 'and sits no further from the marker');

  assert.ok(baseIgnored && learnedIgnored, 'the ignored item is on both rings');
  assert.ok(learnedIgnored.score <= baseIgnored.score - 8, `ignored sank from ${baseIgnored.score} to ${learnedIgnored.score}`);
});

test('the ring is stable across a day and survives a small clock step', () => {
  const candidates = fixtures();
  const a = pickDialItems(candidates, { now: MONDAY_9AM, currentUri: null, dialHistory: [] });
  const b = pickDialItems(candidates, { now: MONDAY_9AM + 20 * 60 * 1000, currentUri: null, dialHistory: [] });
  assert.deepEqual(a.map((it) => it.uri), b.map((it) => it.uri), 'twenty minutes does not reshuffle the ring');
});

test('honours a custom slot count', () => {
  const ring = pickDialItems(fixtures(), { now: MONDAY_9AM, currentUri: null, dialHistory: [], slots: 5 });
  assertRingShape(ring, 5);
  assert.equal(ring.length, 5);
  assert.equal(pickDialItems(fixtures(), { now: MONDAY_9AM, slots: 0 }).length, 0);
});

test('runs comfortably under 2 ms for 300 candidates', () => {
  const base = fixtures();
  const many = [];
  for (let i = 0; i < 300; i += 1) {
    const seed = base[i % base.length];
    many.push({
      ...seed,
      uri: 'spotify:playlist:perf' + i,
      title: seed.title + ' ' + i,
      shelfIndex: (seed.shelfIndex ?? 0) + (i % 3),
      position: seed.position ?? 0,
    });
  }
  const context = { now: MONDAY_9AM, currentUri: 'spotify:playlist:perf2', dialHistory: [] };
  for (let i = 0; i < 5; i += 1) pickDialItems(many, context);

  const runs = 100;
  const start = performance.now();
  for (let i = 0; i < runs; i += 1) pickDialItems(many, context);
  const average = (performance.now() - start) / runs;
  assert.ok(average < 2, `average ${average.toFixed(3)} ms over ${runs} runs`);
  console.log(`      runtime: ${average.toFixed(3)} ms average for 300 candidates`);
});

test('handles an empty or junk input safely', () => {
  assert.equal(pickDialItems([], { now: MONDAY_9AM }).length, 0);
  assert.equal(pickDialItems(null, { now: MONDAY_9AM }).length, 0);
  assert.equal(pickDialItems([{ title: 'no uri' }], { now: MONDAY_9AM }).length, 0);
});
