# The Dial: how the twelve slots are chosen

`theme/Tess/src/dial-pick.js` is the whole algorithm. It is a plain script with
no imports, no DOM and no network; it defines `window.TessDialPick.pickDialItems`
and is meant to be concatenated into the theme with the other `src/` files.

```js
const ring = TessDialPick.pickDialItems(candidates, {
  now, currentUri, dialHistory, slots: 12,
});
// [{ ...candidate, score, reason }, ...] in slot order, slot 0 first
```

Slot 0 sits under the marker when home opens. The user can spin the ring either
way, so slots 1 and 11 are the next most visible.

## The scoring model in one paragraph

Every candidate starts with a base score for where it came from. Spotify's DJ
leads, then the "Soundtrack your …" shelf, Made For, Jump back in, top mixes,
recent contexts, the library, and finally any other shelf. Signals are added on
top: whether the shelf was built for this weekday and hour, whether the item is
Discover Weekly on a Monday or Release Radar on a Friday, how recently it was
played, whether it was added in the last few days, how high it sits on the home
page, whether it is pinned, and whether the user usually plays this kind of thing
at this hour. The dial's own history then adjusts the score: items the user
actually played from the ring get a lift, items shown repeatedly and never played
sink, and both fade with a fourteen-day half-life. The raw score is rounded to a
whole point and a stable, day-seeded tie-breaker of up to 0.6 is added. That
rounding is deliberate: a few minutes of extra "recency" should not reshuffle the
ring every time home reopens.

## 1. Intent right now

| Signal | What it adds |
| --- | --- |
| DJ | base 44, plus 6 |
| "Soundtrack your Monday morning" on Monday morning | time-of-day shelf base 31, +12 for the matching hour, +6 for the matching weekday |
| daylist | +4, plus 60% of the hour fit and 50% of the weekday fit |
| Discover Weekly | +18 on Monday, +3 on other days |
| Release Radar | +18 on Friday, +3 on other days |
| Played recently | up to +14, decaying with a seven-day time constant |
| Played at this hour | +4 (habit) |
| Added in the last 3 days | +7; added in the last 14 days +3.15 |
| High on the home page | up to +7 for shelf 0, plus up to +3 for an early position |
| Pinned | +9 |

Discover Weekly, Release Radar and daylist are recognised by title, because the
shelf API does not label them. The same is true of the weekday and hour in the
"Soundtrack your …" title.

The user's usual hour is learned from `dialHistory`: for every past play, the
hour bucket (night, morning, afternoon, evening) of the play is recorded, along
with the source and kind of the item. At scoring time the current bucket's most
played source gets up to +8 and its most played kind up to +5. Candidate
`lastPlayedAt` values also contribute the +4 habit bonus when their local hour
falls in the current bucket.

## 2. Diversity

The picker never simply takes the top twelve scores.

- **One source** may supply at most 25% of the ring (3 of 12).
- **One kind** may supply at most about two thirds (8 of 12).
- **One title family** may supply at most half the ring. A family is the title
  with years and trailing numbers removed, so "Daily Mix 1", "Daily Mix 2" and
  "Your Top Songs 2023"/"2024" are each one family.
- **Artists**: at most two cards with `kind: 'artist'`.
- **Discovery and comfort**: at least one item classified as a discovery and one
  as familiar are kept when the pool contains either. This is the one case where
  the source/kind caps may be exceeded: the guarantee matters more than perfect
  balance.
- **Duplicates**: the same `uri` from several shelves is merged first. The
  strongest source wins (DJ > time-of-day > Made For > Jump back in > top mixes >
  recent > library > other), the earliest shelf position wins, the latest play
  wins, and the oldest "added" date wins.

Classification is heuristic and lives in `classify`:

- **Familiar**: library, Jump back in or recent, pinned, or played within seven
  days.
- **Discovery**: Discover Weekly, Release Radar, daylist, a recent addition that
  has not been played in a month, a podcast episode not played for two weeks, or
  a top mix untouched for three weeks. Familiar wins if both apply, so the two
  guarantees always refer to different items.

If the caps leave holes, the remaining slots are filled from the best leftovers
with the source/kind/family caps relaxed; the two-artist cap stays hard. A pool
dominated by one family can therefore produce a ring with unavoidable neighbours
from that family. The ordering pass degrades gracefully in that case rather than
dropping items.

## 3. Current playing and the DJ

The DJ is forced onto the ring before the normal selection pass, so no cap can
squeeze it out. It does not have to be slot 0.

Slot 0 is the highest-scoring selected item whose `uri` is not `currentUri`.
The current context can still appear later on the ring. If the ring somehow has
only the current item, there is no alternative to put first.

## 4. Learning, with a fourteen-day memory

Each history entry contributes `0.5 ^ (age / 14 days)`.

- An item with `playedAt` collects play weight. Up to +16 is added.
- An entry with only `shownAt` collects "shown but ignored" weight. Up to −12 is
  subtracted. Two ignored shows are enough to reach the cap, so repeatedly
  showing something the user skips pushes it down.
- Played and ignored weights are kept separately. An item shown often but played
  once still gets both the lift and the penalty, which is the honest reading of
  the history.

The source/kind affinity uses only history entries whose URIs also appear in the
current candidate pool, because the history format does not store the shelf.
That is fine in practice: a home page almost always contains the things the ring
showed recently.

## 5. Stability

- The tie-breaker is a hash of `uri + local date`. It is stable for the whole day
  and changes overnight.
- Scores are rounded to whole points before the tie-breaker is added. Small
  changes in recency (opening home twice in twenty minutes) usually stay inside
  the same point.
- No randomness, no `Date.now` reads except when `context.now` is omitted, and no
  dependence on object iteration order. The same inputs produce the same output.

## 6. Slot order

1. Put the best non-current item in slot 0.
2. Fill slots in the order 1, 11, 2, 10, 3, 9, … so both directions from the
   marker are shaped first.
3. For each slot, try every remaining item and subtract contrast penalties from
   its score: −9 for the same source as an already-placed neighbour, −5 for the
   same kind, and −150 for the same title family. The large family penalty keeps
   "Daily Mix 1" and "Daily Mix 2" apart; the smaller ones merely break ties
   between otherwise similar items.
4. If any family neighbours still remain, re-walk the ring once with a small
   depth-first search. Slot 0 stays fixed. The search prefers the order the
   contrast pass chose and only runs when there is a clash.

That gives a ring that starts with the strongest item, then alternates familiar
and new, playlist and album, one source and another. Because the fill order goes
outward from slot 0, slots 1 and 11 are deliberately chosen to contrast with
slot 0.

## 7. Cost

Merging, scoring, sorting and selection are O(n log n) with a handful of maps;
the ring pass is O(slots²) and the family repair is bounded. There are no network
calls, timers or DOM reads. On a 300-candidate pool the module runs in roughly
0.2 ms in the page's own realm (about 1 ms through Node's `vm`, which adds
cross-realm overhead). The test suite asserts an average under 2 ms over 100
runs.

## Tuning knobs

All of them are `const` at the top of `dial-pick.js`.

| Knob | Default | Effect |
| --- | --- | --- |
| `SOURCE_BASE` | DJ 44 … other 8 | How much each shelf is trusted before personal signals |
| `FRESHNESS` | 18 | Size of the Monday/Friday discovery spike |
| `RECENCY` / `RECENCY_TAU` | 14 / 7 days | How strongly a recent play lifts an item |
| `SHELF_PULL` / `POSITION_PULL` | 7 / 3 | How much home-page placement matters |
| `HISTORY_PLAY` / `HISTORY_IGNORE` | 16 / 12 | Strength of the dial's item memory |
| `HISTORY_HALF_LIFE` | 14 days | How fast the memory fades |
| `HOUR_SOURCE_PULL` / `HOUR_KIND_PULL` | 8 / 5 | How much "what I play at this hour" matters |
| `SOURCE_SHARE` | 0.25 | Maximum share from one source |
| `KIND_SHARE` | 0.65 | Maximum share from one kind |
| `MAX_ARTISTS` | 2 | Artist-card cap |
| `SCORE_QUANTUM` / `DAY_TIE` | 1 / 0.6 | Stability versus day-to-day freshness |
| `CONTRAST_SOURCE` / `CONTRAST_KIND` / `CONTRAST_TITLE` | 9 / 5 / 150 | Neighbour contrast in the ring order |

Things worth tuning first, if the ring feels wrong in use:

- **Too much discovery / too samey**: raise or lower `FRESHNESS` and the
  discovery conditions in `classify`.
- **Favourite items never appear**: raise `HISTORY_PLAY`, lower `HISTORY_IGNORE`,
  or widen `SOURCE_SHARE` slightly.
- **Ring changes too often during the day**: raise `SCORE_QUANTUM` (for example
  to 2) or lower `DAY_TIE`.
- **Too many Daily Mixes near each other**: the family cap and
  `CONTRAST_TITLE` already prevent it; raising the cap is the only way to allow
  more siblings on the ring.
- **DJ too dominant**: lower the DJ base or `DJ_LIFT`; the DJ is still forced
  onto the ring.

## Tests

```sh
node tools/test-dial-pick.mjs
```

The suite loads the file through `node:vm` with a fake `window`, builds about
sixty realistic cards across every source, and checks determinism, merging,
DJ presence, slot 0 versus the current context, source/kind/artist caps,
family separation, discovery and comfort guarantees, the Monday and time-of-day
boosts, learning up and down, twenty-minute stability, custom slot counts, empty
input, and the 2 ms budget.
