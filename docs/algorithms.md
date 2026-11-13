# Every rule Tess uses to pick or order things

This is the plain-English guide to the decisions Tess makes for you: what goes on
the Dial, what order the Library is in, what the queue shows around a record, what
"On this day" means, where the tonearm sits, which video plays, and what colour the
window turns.

It is written for someone who does not write code. Each section ends with the
places the rule is thinnest, so you can decide what to change.

The four files that hold every rule:

| File | What it decides |
| --- | --- |
| `theme/Tess/src/dial-pick.js` | The Dial: scoring, the twelve that survive, the order around the ring |
| `theme/Tess/src/home.js` | Where Dial candidates come from, when the ring refreshes, "On this day" |
| `theme/Tess/src/core.js` | Library, queue, vinyl arm, video fallback, colours |
| `theme/Tess/src/playlist.js` | The cover wall and the artist/time breakdown on a playlist page |

`docs/dial-algorithm.md` is the older, deeper note on the scoring model alone.
This file is the whole picture, including everything that happens around it.

---

## 1. The Dial on Home

A ring of twelve records. Turn it with the wheel, a drag, the arrow keys, or a
click; whatever sits under the marker is previewed in the middle and plays when
you press Play.

### 1.1 Where the twelve come from

Two sources are read and then mixed into one list (`home.js:160`):

**A. What is drawn on Spotify's own Home page right now** — `shelfCandidates()`,
`home.js:91-108`. Tess walks every `component-shelf` on the page, in the order
Spotify drew them, then every card inside each shelf. Each card becomes one
candidate carrying the shelf number, its position within the shelf, its title,
subtitle and cover.

The shelf is named by reading its heading text (`home.js:81-89`):

| Heading starts with | Called | Trust |
| --- | --- | --- |
| "Made for" | `madeFor` | high |
| "Soundtrack your …" or "Your … morning/afternoon/evening/night" | `timeOfDay` | highest after the DJ |
| "Jump back in" | `jumpBackIn` | high |
| "Top mixes" | `topMixes` | medium |
| "Recently played" | `recent` | medium |
| anything else | `other` | low |

A card with no cover image, or no `spotify:` id on its title, is dropped
(`home.js:97-98`).

**B. Spotify's data, asked directly** — `apiCandidates()`, `home.js:109-127`:

- The DJ, hard-coded at `spotify:playlist:37i9dQZF1EYkqdzj48dyYq`, always with
  source `dj` (`home.js:27`, `home.js:110`).
- The last **20** things you played as contexts — playlists, albums, artists,
  shows — with the time you played each one (`home.js:112-116`).
- Up to **100** items from your library, with `lastPlayedAt` and `addedAt`
  (`home.js:119-123`). Items without a real `http` image are skipped.

If the two together produce fewer than four candidates, the Dial leaves the
previous ring on screen rather than showing something thin (`home.js:161`).

### 1.2 How each candidate is scored

Every candidate gets one number. It starts at the value of where it came from and
then moves up and down with what is true right now
(`dial-pick.js:31`, `dial-pick.js:282-373`):

| Where it came from | Starting points |
| --- | --- |
| DJ | 44 |
| Time-of-day shelf | 31 |
| Made For | 26 |
| Jump back in | 22 |
| Top mixes | 19 |
| Recently played | 17 |
| Your library | 13 |
| Anything else | 8 |

Then these are added:

| Signal | Points | Where |
| --- | --- | --- |
| It is the DJ | +6 | `dial-pick.js:291` |
| The "Soundtrack your Monday morning" shelf, on Monday morning | +12 for the right hour, +6 for the right weekday | `dial-pick.js:294-297` |
| A daylist | +4, plus 60% of the hour fit and 50% of the weekday fit | `dial-pick.js:298-302` |
| Discover Weekly, on Monday / any other day | +18 / +3 | `dial-pick.js:305` |
| Release Radar, on Friday / any other day | +18 / +3 | `dial-pick.js:306` |
| Saved in the last 3 days / in the last 14 | +7 / +3.15 | `dial-pick.js:308-312` |
| Played recently | up to +14, fading with a 7-day time constant | `dial-pick.js:314-316` |
| Last played in this same part of the day | +4 | `dial-pick.js:317` |
| High up the Home page | up to +7 for shelf 0, fading by shelf | `dial-pick.js:320` |
| Early within its own shelf | up to +3 | `dial-pick.js:321` |
| Pinned in your library | +9 | `dial-pick.js:322` |

Discover Weekly, Release Radar, daylist, the weekday and the time of day are all
recognised **by their English title text** (`dial-pick.js:90-107`), because
Spotify's shelf data does not label them.

Two more lifts come from what the Dial itself has learned (see 1.2.1).

The parts of the day are: night before 05:00, morning until 12:00, afternoon
until 17:00, evening until 22:00, then night again (`dial-pick.js:81-88`).

#### 1.2.1 What the Dial remembers

Every time the ring is drawn it writes down the twelve items it showed. Every time
you press Play on the ring it writes down that you played one (`home.js:130-144`,
stored in `localStorage` under `tess:dialHistory`, last 400 entries).

Each entry is then worth less as it ages: half its weight every **14 days**
(`dial-pick.js:52`, `dial-pick.js:204`). From that:

- **Played from the ring**: up to **+16** (`dial-pick.js:50`, `dial-pick.js:327`).
  One play today is worth the full +16. It is still worth +8 a fortnight later,
  and about +1.4 after seven weeks — which is when "You play this from the dial"
  stops being the reason shown on the ring (`dial-pick.js:348`).
- **Shown and never played**: up to **−12** (`dial-pick.js:51`,
  `dial-pick.js:328`). Two shows on the same day already reach the full penalty.
  Showing something twice and skipping it is enough to bury it for a month.
- **What you play at this hour**: for each part of the day the Dial keeps a
  running total per shelf and per kind of item. The shelf you use most in the
  current part of day gets up to **+8**, the kind up to **+5**
  (`dial-pick.js:53-54`, `dial-pick.js:333-340`).

The "what you play at this hour" totals can only be credited to candidates that
are on the page right now, because the history does not record which shelf an item
came from (`dial-pick.js:210-215`).

#### 1.2.2 Why the ring does not reshuffle every few minutes

The raw score is rounded to a whole point, and then a stable nudge of up to **0.6**
is added (`dial-pick.js:60-61`, `dial-pick.js:344-345`). The nudge is a fingerprint
of the item's id plus today's date, so it is identical all day and different
tomorrow.

The effect: opening Home twice in twenty minutes almost never changes the order,
because twenty extra minutes of "recently played" is worth far less than one point.
Overnight, the fingerprints change and the ring is genuinely new.

### 1.3 How twelve are picked out of everything

Taking the top twelve scores would give a ring of six Daily Mixes. Instead
(`dial-pick.js:377-497`):

- **The DJ is always on the ring.** It is placed first, before any cap applies, so
  no rule can squeeze it out (`dial-pick.js:415-417`).
- Then the best-scoring items are taken in order while these caps hold:
  - at most **3 of 12** from one shelf (`0.25 × 12`)
  - at most **8 of 12** of one kind — playlist, album, artist, show, episode
  - at most **6 of 12** from one title family
  - at most **2** artist cards (`dial-pick.js:57-59`, `dial-pick.js:378-380`)
- A **title family** is the title with years, brackets and numbers removed, so
  "Daily Mix 1", "Daily Mix 2" and "Daily Mix 3" are one family, and so are
  "Your Top Songs 2023" and "Your Top Songs 2024" (`dial-pick.js:111-119`).
- **At least one discovery and one familiar item** are forced in, if the pool has
  either. If the caps left no room, the weakest replaceable item is swapped out —
  never the DJ, never the best item, never what is currently playing
  (`dial-pick.js:424-485`). This is the one case where the caps may be exceeded.
  - *Familiar* means: from your library, Jump back in, recently played, pinned, or
    played within the last 7 days.
  - *Discovery* means: Discover Weekly, Release Radar, daylist, saved in the last
    3 weeks and unplayed for a month, a podcast episode unplayed for two weeks, or
    a top mix untouched for three weeks. Familiar wins if both are true, so the
    two guarantees always mean two different records (`dial-pick.js:230-248`).
- If the caps leave holes, the leftovers fill the ring with the caps relaxed —
  except the two-artist cap, which is never relaxed (`dial-pick.js:489-494`).

The same record arriving from several shelves is merged first. The strongest shelf
wins, the earliest shelf position wins, the latest play wins, and the oldest "saved"
date wins — so a mix that is both "Made For" and "Jump back in" counts once
(`dial-pick.js:171-185`).

### 1.4 Why they sit in that particular order

Slot 0 is straight up under the marker. The user can spin either way, so slots 1
and 11 are the next most visible.

1. The highest-scoring item goes in slot 0 — **unless that is what is already
   playing**, in which case the next best takes the marker and the current item can
   still appear elsewhere (`dial-pick.js:515-523`).
2. Slots are filled outward in the order 1, 11, 2, 10, 3, 9 … so both sides of the
   marker are shaped first (`dial-pick.js:527-530`).
3. For each slot, every remaining item is tried and penalties are subtracted for
   sitting next to something similar: **−9** same shelf, **−5** same kind, **−150**
   same title family (`dial-pick.js:501-508`). The huge family penalty keeps Daily
   Mix 1 and Daily Mix 2 apart; the small ones only break ties.
4. If two members of one family still ended up side by side, the ring is re-walked
   once by a small search that keeps slot 0 fixed and prefers the order step 3
   chose. It gives up if one family is more than half the ring, because then no
   layout exists (`dial-pick.js:555-600`).

### 1.5 When the ring refreshes

- The ring is worked out when Home is first drawn, when you navigate back to Home,
  and **immediately whenever the song changes** while Home is on screen
  (`home.js:423`, `home.js:426-433`).
- On top of that there is one hard limit: **at most once a minute** (`home.js:158`).
  The timer is stamped before the data is fetched, so a slow fetch still counts.
  Leave Home and come back inside a minute and you get the old ring back.
- The **4-second beat** (`home.js:453`) re-checks that the greeting and the ring are
  still where they belong, and stops early once they are (`home.js:403`) — so it is
  not a periodic reshuffle.
- If the newly chosen twelve are exactly the same list as the ones already on
  screen, nothing is redrawn (`home.js:171-172`).
- The **last ring is saved** and shown instantly on the next Home visit while the
  new one is worked out (`home.js:189-192`, key `tess:dialItems`).

So the ring is a fresh choice at most once a minute, and otherwise stays exactly
where it was, even while you scroll away and back. A pool of fewer than four
candidates also blocks a refresh for that minute while the stale ring stays up
(`home.js:161`).

### 1.6 When you play something that is not on the ring

This is the `songchange` handler (`home.js:426-433`), and it has three cases:

1. **What started playing is already on the ring.** The ring turns to it and
   selects it, animating the short way round (`home.js:249-255`).
2. **It is not on the ring.** The one-minute timer is cleared and the ring is
   rebuilt immediately (`home.js:432`). The new item is found among the candidates,
   or reconstructed from the player's own metadata if it was never a candidate
   (`home.js:167-169`, `home.js:181-187`), then pushed into **slot 0** — the last
   item on the old ring is dropped to make room.
3. **Nothing is playing** (paused with no context). The ring simply reselects what
   it had.

While the selected slot *is* what is playing, the middle of the ring switches to
"Playing now" or "Paused", shows the song and artist instead of the playlist name,
and puts the song's own cover on the record (`home.js:233-241`).

Since #13 (13 Nov 2026) any new playlist/album/artist/show that starts playing is recorded as a play, wherever it
was started, and only the selected item and its two neighbours are recorded as shown.

### Known weaknesses / ideas

- *(Fixed 13 Nov 2026, #13.)* **The Dial misses things played from elsewhere.** Play started from the sidebar,
  search, or an album page never gets the +16 "you play this from the dial" lift,
  because only the ring's own Play button records a play (`home.js:258`). It also
  means the ring is rebuilt from scratch after a play from the sidebar instead of
  learning from that play.
- *(Fixed 13 Nov 2026, #13.)* **Every slot counts as "shown".** `noteShown` writes down all twelve (`home.js:133-138`),
  but a person only really sees the two or three near the marker. Slots 6–11 are
  punished as "shown and skipped" for something nobody looked at, and two days of
  that reaches the full −12.
- **Slot 0 is stolen.** Forcing something played elsewhere into slot 0 knocks off
  the last item and breaks the contrast order built in 1.4 (`home.js:167-170`).
- **Shelf names are English text.** A non-English Spotify, or a renamed shelf,
  falls into `other` and loses 20–35 points of base score (`home.js:81-89`).
- **Only shelves are read from the page.** Home shortcut tiles, banners and
  "recently played" rows drawn differently are invisible to the Dial
  (`home.js:93-95`).
- **Hard ceilings on the pool**: 20 recent contexts and 100 library items
  (`home.js:113`, `home.js:119`), and only library items with an `http` image.
- *(Fixed 13 Nov 2026, #13.)* **The one-minute timer is wall-clock.** Leave Home and come back inside a minute
  and the ring is the one chosen before your last play (`home.js:158`).
- **No way to say "not this".** The only negative signal is "shown and not played",
  which cannot tell "boring" from "I never scrolled that far".
- **The DJ can never be dropped**, even on a day you never use it, and it always
  gets its +6 (`dial-pick.js:291`, `dial-pick.js:415`).
- **Memory lives in the browser.** `tess:dialHistory` is per-machine and per-profile
  and disappears with site data; a fresh install starts with no habits at all.
- **Ideas**: record which slot was played and how far the user spun, so "shown"
  means "near the marker"; add a long-press "less of this"; store the shelf name in
  the history entry so the hour-habit lift stops depending on today's page
  (already listed in `docs/remaining.md`).

---

## 2. The Library

Tess replaces Spotify's library list with its own. The same data drives three
different views depending on how wide the left panel is.

### 2.1 Loading, and what counts as a kind

`loadLibrary()` reads the library **100 items at a time, up to 2000 items**
(`core.js:1357-1371`). It builds a long fingerprint of every item's id, last-played
time, pin state and name; if the fingerprint is unchanged, nothing is redrawn. It
runs on first load, every **60 seconds**, whenever Spotify announces a library
change, and again 3 seconds after every song change so the thing you just played
moves to "Today" (`core.js:1705-1710`).

Each item is sorted into one kind (`core.js:1295-1306`):

- a playlist owned by Spotify with " + " in the name is a **Blend**, otherwise
  **Made by Spotify**
- a playlist you own is **Your playlists**, someone else's is **Saved playlists**
- albums and pre-release albums are **Albums**, concerts **Events**, local files
  **Local Files**, shows and episodes **Podcasts**, and the rest by their own type

The filter menu shows only kinds that are actually present, with a count of each
(`core.js:1373-1390`). The choice is remembered in `tess:libFilter`.

### 2.2 The timeline (normal panel width)

Items are grouped by when you last played them (`core.js:1338-1349`):

| Group | Rule |
| --- | --- |
| Pinned | pinned in the library, whatever its date |
| Today | played since midnight |
| Yesterday | one calendar day ago |
| This week | 2–6 calendar days ago |
| This month | 7–30 calendar days ago |
| *Month name* | older, same calendar year |
| *Year number* | older than that |

Order inside the whole list is: **pinned first, then most recently played first**
(`core.js:1407`). Groups are not a fixed running order — they appear in whatever
order the sorted items arrive, which is why the timeline reads downwards in time.

Search narrows on the item's **name only** (`core.js:1406`), and the kind filter
applies at the same time.

### 2.3 The river (wide panel)

When the left panel is **wider than 640 px** (`core.js:1651`), the timeline becomes
a horizontal river of covers:

- Each group becomes a **chapter** with its heading, its count, and a row of covers
  (`core.js:1422-1431`). The first cover in a chapter is enlarged as the chapter's
  representative (`core.js:1454`).
- A **ruler** of ticks along the top jumps to a chapter when clicked, and the tick
  for the chapter currently crossing the middle of the screen lights up
  (`core.js:1427-1431`, `core.js:1488-1492`).
- Covers **turn toward you** as they pass the middle: the angle is at most 18° and
  the depth at most 60 px, both scaled by how far the cover is from the centre line
  (`core.js:1473-1493`).
- Two rows fit the available height; each cell is between **130 and 380 px**
  depending on the window (`core.js:1477`).
- The mouse wheel scrolls sideways through time instead of up and down
  (`core.js:1495-1499`).

Below 640 px it is the vertical timeline again; below **160 px** the panel becomes
a rail (`core.js:1653`).

### 2.4 Glass Shelves (the expanded cover wall)

The shelf view is a separate arrangement of the same filtered, sorted list
(`core.js:1569-1616`), in a **fixed order of five shelves**
(`core.js:1532-1538`):

1. Playlists — your playlists, saved playlists, Made by Spotify, Blends, folders,
   local files
2. Albums
3. Artists (round portraits rather than sleeves)
4. Podcasts & books
5. Events

An empty shelf is omitted. Inside a shelf the order is the same as everywhere else:
pinned first, then most recently played.

Each non-artist record is drawn as a **sleeve standing on a shelf**: a spine strip
in a colour taken from its cover, the title running up the spine, and a small cover
at the foot. That spine colour is found by shrinking the cover to 6×6 and choosing
the most *colourful* pixel that is not too dark or too bright — the score is
saturation × how close the tone is to mid-grey (`core.js:1507-1531`). The results
are cached in `tess:spines` after a 1.5-second pause.

Three small behaviours sit on top:

- **Dock magnification**: as the pointer moves along a row, each spine swells by how
  close it is to the pointer, out to a **170 px** radius, eased so it feels smooth
  (`core.js:1542-1558`).
- **Arrival**: records appear one after another, 14 ms apart, for the first 60
  (`core.js:1560-1567`).
- **State**: the shelf item for whatever is playing, and for the page you are on,
  is marked (`core.js:1618-1627`).

### Known weaknesses / ideas

- **Recency is compared as text, not time.** `String(lastPlayedAt)` is sorted with a
  string comparison (`core.js:1407`, `core.js:1575`). That is correct for the ISO
  timestamps Spotify usually returns and wrong for anything else — a differently
  formatted date can land in the wrong place and an unparseable one sinks to the
  bottom.
- **Grouping is recomputed constantly.** `groupOf` runs once per item and then again
  for every chapter's count, so a 2000-item library does thousands of `Date`
  constructions per redraw (`core.js:1418-1425`).
- **"This month" is not a month.** 7–30 days is used regardless of the calendar, so
  on the 2nd of a month "This month" can be mostly last month (`core.js:1347`).
- **Pinned beats everything**, always, so a pinned album from 2019 sits above
  something you played this morning in every view.
- **Search only sees the name.** Typing an artist's name finds nothing unless the
  playlist or album title contains it (`core.js:1406`, `core.js:1574`).
- **The whole library is re-read every minute**, up to 2000 items, and diffed as one
  giant string (`core.js:1361-1367`).
- **No sorting control.** Release year, name, artist and "recently added" are not
  offered; the only order is pinned-then-played.
- **Shelves are one long row.** A 400-album library is a single horizontal strip
  with no second row and no paging.
- **The spine colour needs a cover.** Anything without an image falls back to a
  plain dark spine, and monochrome covers all look the same because the score
  rewards saturation.
- **The colour cache never shrinks.** `tess:spines` keeps one entry per cover URL
  forever (`core.js:1524-1526`).
- **Magnification radius is fixed** at 170 px, which is most of a short row on a
  laptop screen.
- **Ideas**: sort by "recently added" for album people; remember the last shelf you
  used; use a per-shelf cap and a second row before letting a shelf run off-screen.

---

## 3. The queue Cover Flow in the full-screen player

Open the player, press the queue button, and the single cover becomes a fan of
covers: what just played on the left, what plays next on the right
(`core.js:515-539`).

- It takes the **last 3** items from the player's "previous" list and the **next 4**
  tracks or episodes from its "next" list (`core.js:519-520`). Anything that is not
  a track or an episode is filtered out, which is why Autoplay's picks sometimes do
  not appear.
- Each card is offset from the centre by **62% of its own width plus 34% per extra
  step**, pushed back **160 px** in depth per step, turned **32°** away from the
  middle, scaled down 8% per step, faded 25% per step, and stacked in that order
  (`core.js:527-529`).
- Clicking a card **skips** to it: a card three places back calls Previous three
  times, a card two ahead calls Next twice (`core.js:533-536`).
- It is rebuilt when the player opens, when you switch to the queue view, and on
  every song change while the queue is open (`core.js:398`, `core.js:419`,
  `core.js:1210`).

The same panel normally shows a plain list of what is next — title, artist, up to 30
rows (`core.js:1110-1126`). The queue button swaps that list for the fan of covers
(`core.css:2347-2351`), so the two are alternatives, not two halves of one view.

### Known weaknesses / ideas

- **Nothing refreshes while the panel sits open.** Add a song to the queue and the
  fan does not move until the current song changes or you toggle the view.
- **Skipping by counting is brittle.** Clicking "three back" runs Previous three
  times; if a track ends between clicks the count lands somewhere else
  (`core.js:534-535`).
- **Depth is fixed in pixels**, 160 px per card, so on a small window the back cards
  can leave the visible area.
- **No drag or wheel.** It is a static fan, not a scrollable deck.
- **The right side is only what Spotify exposes.** Autoplay's own picks and the
  rest of a long context are not in `nextItems`, so the fan often looks shorter than
  the real queue.
- **Ideas**: a real deck that scrolls; seek to the actual queue index rather than
  counting skips; show the queue's source ("from this album") on each card.

---

## 4. "On this day", and every piece of "recently played" logic

### 4.1 On this day

A row of songs you saved to your library on this date in earlier years
(`home.js:338-383`).

1. Once per calendar day, it reads **every saved track**, 500 at a time, up to
   20,000 (`home.js:347-353`).
2. It keeps only tracks saved in an **earlier year** (`home.js:357`).
3. For each, it takes the month and day it was saved, puts them in **this** year,
   and measures how many days away that is from today (`home.js:355-356`).
4. It then takes the first of these that has anything in it:
   - exactly the same day → heading "On this day"
   - within 3 days → "This week, years ago"
   - within 7 days → "Around now, years ago"
   - nothing → the section stays hidden (`home.js:358-362`)
5. The matches are sorted **most recently saved first**, then cut to **12**
   (`home.js:363`, `home.js:368`).
6. The caption names the gaps in years — "Songs you saved 6, 4 years ago"
   (`home.js:364-366`).
7. Clicking a song starts **Liked Songs** at that song, so the music carries on from
   there rather than playing one track on its own (`home.js:376-379`).

The work happens when the browser is idle, with a 2-second ceiling, so it never
competes with drawing the page (`home.js:424`).

### 4.2 Where else "recently played" decides something

One idea, six different uses:

| Place | What it uses | Where |
| --- | --- | --- |
| The Dial's `recent` shelf | last 20 played contexts, with the time of each | `home.js:112-116` |
| Dial scoring | that time as "played recently" (+14 max) and "played at this hour" (+4) | `dial-pick.js:314-317` |
| Dial memory | your own play history with a 14-day half-life | `dial-pick.js:193-226` |
| Library timeline | `lastPlayedAt` per item, to choose Today / Yesterday / This week / … | `core.js:1338-1349` |
| Library order | `lastPlayedAt`, newest first | `core.js:1407` |
| ⌘K with an empty box | the last 8 played contexts | `core.js:1755-1760` |

A timestamp arriving in seconds rather than milliseconds is multiplied by 1000 on
the way in (`home.js:115`).

### Known weaknesses / ideas

- **Only songs.** "On this day" never shows an album, playlist or artist you saved
  that day, because it reads saved tracks only (`home.js:350`).
- **A burst of up to 40 requests, once a day.** Libraries over 20,000 tracks are
  silently cut off at the limit (`home.js:349`).
- **One failed load hides it until tomorrow.** The day is marked as done before the
  fetch, so an error leaves the section blank for the rest of the day
  (`home.js:345`, `home.js:354`).
- **Month-and-day only.** A song saved on 29 February only matches in a leap year,
  and a song saved on 31 December shows up on 1 January as "3 days"
  (`home.js:355-356`).
- **Newest-saved wins the twelve slots.** If you saved 40 songs on this day in 2014
  and 3 in 2022, you see the 2022 ones (`home.js:363`).
- **The caption counts matches you cannot see** — it is built before the cut to 12
  (`home.js:364-368`).
- **One click replaces what is playing.** A tap starts Liked Songs at that song;
  there is no "play next" and no preview.
- **Ideas**: include saved albums; shuffle the twelve; cache the result per day in
  storage so a reload after a failure retries; rank by a mix of years rather than
  by save date.

---

## 5. Vinyl: the arm is the progress bar

With **Vinyl** chosen in the full-screen player, the cover becomes a spinning record
and a tonearm lies across it. The arm's angle is the song's position: outer groove
at the start, label at the end. Paused, it lifts off and rests beside the record
(`core.js:447-513`).

### 5.1 The numbers

- Before anything is measured the defaults are **start 2°, end 24°, rest −28°**
  (`core.js:450`).
- The arm is an SVG in a 60 × 220 box with its pivot at (30, 22) and the stylus
  treated as (44, 205) (`core.js:369`). On screen it is 16% of the player's width,
  rotated about `50% 10%` — the pivot — and moves over half a second, linearly
  (`core.css:2400-2412`).
- **The record spins on its own** at one turn every 3.4 seconds and stops when
  paused (`core.css:2358-2370`); only the arm is driven by the song.

### 5.2 Measuring where the groove is (`measureArm`, `core.js:454-467`)

The arm and the record are two different sizes on different screens, so the angles
cannot be hard-coded. Instead Tess:

1. Reads the record's on-screen box, gives up if it has no width yet.
2. Works out where the pivot is, and where the stylus tip would be at any angle —
   the arm is a rigid rod, so the tip swings on an arc.
3. Tries **every 0.25° from −40° to +80°** and asks how far the tip would be from
   the record's centre.
4. Finds two target angles:
   - the one that puts the tip at **95%** of the record's radius — the outer groove
   - the one that puts it at **20.5%** of the record's width — the label edge, or as
     close as the arm can physically reach, plus 2 px
5. Sets `ARM_START` to the smaller of the two and `ARM_END` to the larger, so the
   angle always increases as the song plays. `ARM_REST` is 26° back from the start,
   clear of the record.

It is measured on the first frame in Vinyl mode and again on **window resize**
(`core.js:468`, `core.js:474`).

### 5.3 Placing the arm (`placeArm`, `core.js:471-476`)

```
angle = START + (END − START) × min(1, position ÷ duration)
```

- While playing, the arm is rotated to that angle.
- While paused, it is rotated to `ARM_REST` instead — lifted off the record.
- Nothing is updated while you are dragging it, and nothing is updated when Vinyl
  is not the current look.

The arm is redrawn from the same 60-times-a-second loop that updates the progress
bar and the lyrics, and only while the full-screen player is open
(`core.js:1247-1260`, `core.js:1266-1271`).

### 5.4 Dragging the arm

- **Picking it up** (`core.js:487-493`): the pointer is captured, the difference
  between the arm's current angle and the pointer's angle is remembered so the arm
  does not jump, and the half-second transition is switched off so it tracks your
  hand exactly.
- **Moving** (`core.js:494-499`): the angle is clamped between the rest position and
  **2° past the end**. You can lift the arm off the record, and you can overshoot the
  label slightly, but not further.
- **Dropping** (`core.js:500-511`):
  - If the arm came down **more than 4° before the start**, the record **pauses**. It
    does not rewind.
  - Otherwise the fraction `(angle − START) ÷ (END − START)` is turned into a time
    and the player **seeks** there, then **starts playing** if it was paused.
  - Cancelling the gesture (for example, the pointer leaves the window) does exactly
    the same thing as dropping it.

### Known weaknesses / ideas

- **Every song uses the whole record.** The arm always sweeps from the outer groove
  to the label, however long the song is, so a 2-minute track moves about four times
  faster than an 8-minute one, and the same timestamp puts the arm in a different
  place on each song. A real turntable turns at a fixed speed, so there the arm's
  position depends on minutes elapsed, not on the fraction of the song played.
- **Start and end are "whichever is smaller/larger".** If a window shape ever put the
  label angle outside the outer-groove angle, the mapping would silently run
  backwards, because the measurement assumes the smaller angle is always the start
  (`core.js:466`).
- **Entering the queue view changes the player's width** (`core.css:2350`) but does
  not re-measure the arm, so until the window is resized or the look is re-applied
  the arm is mapping to the old, larger record.
- **No preview while dragging.** You cannot see the time you are about to land on:
  the clock and the scrubber keep reporting actual playback, not the arm's position.
- **The arm's transition is linear**, so after a seek it glides to the new angle
  over half a second instead of snapping, and it always runs about half a second
  behind the true position.
- **Dropping near the rest pauses instead of rewinding** (`core.js:505`). "Put it
  back at the beginning" is the one gesture people try, and it does something else.
- **Dropping anywhere on the record starts playback**, even if you were paused on
  purpose.
- **Only the full-screen player has an arm.** The small record in the right-hand
  panel is decoration; dragging it does nothing (`core.css:2354`).
- **The arm is a fixed rod with a fixed stylus point.** The record's real groove
  spacing is not modelled, so the last 10% of a song occupies the same angle as the
  first 10%.
- **Ideas**: show a small time bubble while dragging; treat "lift and drop before
  the start" as seek-to-zero plus pause; re-measure whenever the record's box
  changes, not just on window resize; bend the angle curve slightly so the label
  region is easier to hit.

---

## 6. The video fallback

"Video" in the full-screen player, or "Animated artwork" in the panel, plays a
looping Canvas clip instead of the still cover. Since most songs have no Canvas of
their own, there is a fallback chain (`core.js:1930-1974`):

1. **The track's own Canvas.** First from the player's current metadata when the
   track is the one playing; otherwise asked of Spotify's GraphQL endpoint and
   cached for up to 40 tracks (`core.js:1939-1950`).
2. **A Canvas from the artist.** Tess asks for the artist's **top 6 tracks in chart
   order**, all at once, and takes the first one that has a video
   (`core.js:1957-1974`). Only real answers are cached, so a failure is retried next
   time.
3. **Nothing** — the cover then drifts slowly instead (`core.js:1931-1932`).

The fallback to the artist only happens for **the track that is currently playing**
(`core.js:1936`).

### 6.1 Playing the clip

Spotify's built-in browser cannot decode the H.264 Canvas files, so Tess does what
Spotify's own player does (`core.js:1128-1174`):

- Read the video manifest for the file.
- Choose a **VP9 WebM** profile **no taller than 1280 px**, the largest that fits.
- Feed the initialisation chunk and then every segment into a `MediaSource`, in
  order, waiting for each to be accepted.
- Loop it, muted, and never wait for `play()` to resolve, because it can hang while
  the window is in the background.

The same clip is used in three places: the full-screen cover, the square cover in
the right-hand panel, and the full-height artist page header
(`core.js:1202-1208`, `core.js:1034-1037`, `core.js:2048-2058`).

On artist pages the default is video; a small Photo/Video switch on the header
remembers your choice per artist in `tess:heroPref` (`core.js:2043-2044`,
`core.js:2092-2108`). The header's light/dark text decision re-reads pixels from the
video at most every 4 seconds, and only while the title is over it
(`core.js:2144-2150`).

### Known weaknesses / ideas

- **The fallback can be a different song.** "Animated artwork" for a quiet ballad
  can be the video from the artist's biggest hit, which reads as a mistake more
  often than as a feature.
- **The whole clip is downloaded before it plays.** Segments are appended and only
  then is playback started (`core.js:1159-1169`), so a slow connection means a still
  cover for a few seconds rather than a clip that starts and fills in.
- **VP9 only, 1280 px ceiling.** Any device or manifest that does not offer VP9 gets
  the still cover with no explanation (`core.js:1145-1147`).
- **No fallback for a mid-change track.** The artist lookup is skipped unless the
  track is the current one, so during a song change there is no video at all
  (`core.js:1936`).
- **A failed artist lookup is retried on every song change** from that artist.
- **The artist header runs its own copy of the same pipeline**, so a song and its
  artist page can each request the same clip separately.

---

## 7. Colours: the time of day, mixed with the artwork

Two things decide the window's colour: the artwork of the current song, and the
hour on the clock. The setting is **"Follow the time of day"**, on by default
(`core.js:100`, `core.js:123`).

### 7.1 The four moods

| From | Tone mixed in | How much | Brightness | Blue kept | Meaning |
| --- | --- | --- | --- | --- | --- |
| 05:00 | warm `255,176,110` | 15% | 1.05 | 0.96 | gentle sunrise light |
| 11:00 | neutral `200,215,235` | 10% | 1.08 | 1.00 | clean midday |
| 16:00 | amber `255,150,90` | 16% | 1.00 | 0.92 | golden hour |
| 20:00 | dim `120,70,60` | 12% | 0.86 | 0.82 | night, dimmer and low in blue |

That table is `core.js:240-246`; the lookup takes the latest row whose start hour
has passed, and anything before 05:00 counts as night (`core.js:247-250`).

### 7.2 The artwork's four colours

The cover is shrunk to a 4 × 4 image and four of the sixteen pixels are taken as
the song's palette (`core.js:225-236`). Those four colours are then bent toward
today's tone (`core.js:284`):

```
each colour = (colour × (1 − mix) + tone × mix) × brightness
blue channel × blue-kept
never above 255
```

The result is painted as four soft, blurred fields on a tiny 96 × 54 canvas, then
stretched by the graphics chip. The previous painting cross-fades out, and the
finished canvas is also written into the page as a background image so every panel
and the top bar sit on the same light (`core.js:278-295`).

How fast the light drifts comes from how colourful the artwork is: the average
spread across the four colours sets a drift time of **80 seconds for muted artwork
down to 40 seconds for vivid artwork** (`core.js:285-286`). It is repainted once per
song and once every **60 seconds** so it picks up the next part of the day
(`core.js:296`).

On an artist page the four colours come from the header photo instead, and the song
takes over again when you leave (`core.js:2129`, `core.js:2034`).

### 7.3 The Dial's own light

The Dial paints its own small aurora behind the ring from the selected cover,
sampling four colours the same way and placing them on soft ellipses, cross-fading
when the selection changes (`home.js:298-336`). It changes with every turn of the
ring, not just every song.

The Library's spines use a third, stricter rule: the most saturated tone close to
mid-brightness, so a spine looks like printed card rather than mud
(`core.js:1507-1531`).

### Known weaknesses / ideas

- **Hour of day is the only input.** No season, latitude or sunrise, so "morning" is
  the same warm light in December and June, and 04:59 is night while 05:00 is
  sunrise.
- **Night can swallow the artwork.** At 20:00 the mix is 12% and brightness 0.86, so
  a dark cover gets darker still; at 11:00 brightness 1.08 clips bright covers
  against 255.
- **Four pixels is a guess.** A cover with one dominant hue and one accent is
  reduced to whatever those four samples happen to land on; the Dial then looks
  different from the window because it samples the same image separately.
- **The drift speed is a linear guess** (`80 − saturation × 40` seconds), so any two
  covers of similar saturation drift identically.
- **A daypart change can be up to a minute late** because the repaint is on a
  60-second timer (`core.js:296`).
- **A full-page raster per song.** The canvas is exported to a data URL and set as a
  CSS variable on the root element (`core.js:294`), which is a new image to keep in
  memory each time the colours change.
- **The spine colour cache is unbounded** and never revalidates when a playlist's
  cover changes but its URL stays the same.
- **Ideas**: blend the mood over 30 minutes instead of stepping at the hour; add a
  "keep the artwork's own light" strength slider; one shared palette cache used by
  the window, the Dial and the spines.

---

## Appendix: every number that decides something

All of these are constants at the top of their file.

| Constant | Value | Decides | Where |
| --- | --- | --- | --- |
| `SLOTS` | 12 | How many records are on the Dial | `home.js:29` |
| `DEFAULT_SLOTS` / `MAX_SLOTS` | 12 / 32 | Ring size bounds | `dial-pick.js:27`, `dial-pick.js:65` |
| `SOURCE_BASE` | DJ 44 … other 8 | Starting score per shelf | `dial-pick.js:31` |
| `TIME_OF_DAY_FIT` / `WEEKDAY_FIT` | 12 / 6 | Right-hour and right-day bonuses | `dial-pick.js:36-37` |
| `DAYLIST_LIFT` | 4 | Daylist bonus | `dial-pick.js:38` |
| `FRESHNESS` | 18 | Monday / Friday discovery spike | `dial-pick.js:39` |
| `NEW_ADDITION` | 7 | Recently saved bonus | `dial-pick.js:40` |
| `RECENCY` / `RECENCY_TAU` | 14 / 7 days | How much a recent play is worth | `dial-pick.js:41-42` |
| `SHELF_PULL` / `POSITION_PULL` | 7 / 3 | Home-page placement | `dial-pick.js:43-44` |
| `PINNED` | 9 | Pinned bonus | `dial-pick.js:45` |
| `HABIT` | 4 | Same-hour-of-day play | `dial-pick.js:46` |
| `DJ_LIFT` | 6 | The DJ's extra | `dial-pick.js:47` |
| `HISTORY_PLAY` / `HISTORY_IGNORE` | 16 / 12 | The Dial's memory | `dial-pick.js:50-51` |
| `HISTORY_HALF_LIFE` | 14 days | How fast that memory fades | `dial-pick.js:52` |
| `HOUR_SOURCE_PULL` / `HOUR_KIND_PULL` | 8 / 5 | What you use at this hour | `dial-pick.js:53-54` |
| `SOURCE_SHARE` | 0.25 | Most of the ring from one shelf | `dial-pick.js:57` |
| `KIND_SHARE` | 0.65 | Most of the ring of one kind | `dial-pick.js:58` |
| `MAX_ARTISTS` | 2 | Artist cards allowed | `dial-pick.js:59` |
| `SCORE_QUANTUM` / `DAY_TIE` | 1 / 0.6 | Stability during the day | `dial-pick.js:60-61` |
| `CONTRAST_SOURCE` / `KIND` / `TITLE` | 9 / 5 / 150 | Neighbour penalties | `dial-pick.js:62-64` |
| Dial refresh interval | 60 s | How often the ring can change | `home.js:158` |
| Dial history cap | 400 entries | Memory length | `home.js:132` |
| Recent contexts read | 20 | Dial pool | `home.js:113` |
| Library items read | 100 | Dial pool | `home.js:119` |
| On this day scan | 20,000 tracks max, 12 shown | Row size | `home.js:349`, `home.js:368` |
| Library load | 2000 items, 60 s | Sidebar size and refresh | `core.js:1361`, `core.js:1705` |
| River threshold | 640 px wide, 160 px rail | Which library view | `core.js:1651-1653` |
| Queue fan | 3 back, 4 forward | Cover Flow reach | `core.js:519-520` |
| `ARM_START` / `ARM_END` / `ARM_REST` | 2° / 24° / −28°, then measured | Arm range | `core.js:450` |
| Arm drag clamp | rest … end + 2° | How far you can pull it | `core.js:496` |
| Arm pause threshold | start − 4° | Lift-off means pause | `core.js:505` |
| Artist video attempt | top 6 tracks | Which clip is borrowed | `core.js:1966` |
| Canvas cache | 40 tracks | Video lookup memory | `core.js:1947` |
| Dayparts | 05 / 11 / 16 / 20 | Mood boundaries | `core.js:240-246` |
| Aurora repaint | 60 s | When the mood catches up | `core.js:296` |
| Aurora drift | 40–80 s | How fast the light moves | `core.js:286` |
| Spine magnification | 170 px | Dock reach | `core.js:1555` |
| Shelf arrival | 60 records, 14 ms apart | Opening animation | `core.js:1563-1564` |
