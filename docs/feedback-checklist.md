# Tess Music — feedback checklist (12 Nov 2026)

Every point Krish raised in the build conversation, with its state. "Checked" means verified in the running app
(screenshot, measurement or an in-app script); "Fixed, not seen" means the cause is fixed but it wasn't watched
on screen.

| # | Point | State |
|---|---|---|
| 1 | Full-screen player's close pill overlapped the window buttons | Fixed: pill starts 92 px in, clear of them |
| 2 | Subtitle scrolled even when the artist fit | Checked: only scrolls when the text overflows; album shown only when it differs from the title |
| 3 | Setting for Canvas video vs picture in full screen | Checked: Settings → Theme |
| 4 | Artist video fills the screen until scroll; text changes colour; where the video comes from | Checked: video from the artist's top songs' Canvas; title turns dark over light video |
| 5 | Library sidebar unique (Dia-inspired), black gap at its end | Checked: Timeline library, gap gone |
| 6 | Downloads stuck at 5 of 591, folder on the Dell SSD, survive the drive being unplugged | Done by SWE-2: storage moved off the network share, guard LaunchAgent |
| 7 | Right sidebar not aligned with the rest | Checked |
| 8 | Bar square, not Apple-like | Checked: glass capsule |
| 9 | Artist page broke when scrolling (colour strip) | Checked |
| 10 | Right panel: Apple-style lyrics, expand opens full screen, cover click opens full screen | Checked |
| 11 | Apple Music's smooth artist-page transition | Checked: video stays, blurs and dims as you scroll |
| 12 | Right-panel cover broken with and without video | Checked: one square cover, Canvas inside |
| 13 | "Notifications settings" button does nothing | Not fixable in the theme: macOS shows it only when Spotify's notifications are off in System Settings |
| 14 | Bar covers Settings; Theme section with all settings | Checked |
| 15 | Devices icon out of place | Checked: redrawn |
| 16 | Queue panel rework | Checked: pill tabs, rows, Jam card |
| 17 | Homepage redesign | Checked: greeting, the Dial, On this day |
| 18 | Black line and plain black after scrolling | Checked |
| 19 | Doubled square-in-circle shapes everywhere | Checked: shape audit clean |
| 20 | RAM / CPU / GPU usage | Improved: three duplicate copies of the scripts removed, backgrounds painted once, no blended grain, event-driven updates. Final on-screen CPU not measured |
| 21 | Expanded library broken | Checked: Timeline as a cover grid |
| 22 | Gap at the start of the lyrics card | Fixed, not seen |
| 23 | Library: option B + multi-select filter | Checked |
| 24 | Home: DJ card, then a circular picker (the Dial) + algorithm | Checked: Dial; DeepSeek's algorithm, 16 tests pass |
| 25 | Rich background, not cheap gradients; colour psychology | Checked: aurora from artwork, time-of-day tone, grain |
| 26 | "Made for Krish" green text ugly | Checked |
| 27 | Playlist colour cut off when scrolling | Checked |
| 28 | Black strip on home scroll; recently played opening web links | Checked |
| 29 | Greeting should stay pinned | Checked: pinned above scrolling cards |
| 30 | Top-bar icons outside the glass | Checked |
| 31 | Search dropdown display; rework search | Checked: search box opens the Tess search panel |
| 32 | Right-click menus missing options | Checked: Spotify's full menu, sidebar items deep in the list |
| 33 | Playlists plain | Checked: cover wall header, artist ribbon, years chart |
| 34 | Add-to-playlist popup unreadable | Checked |
| 35 | Right-click menu unreadable | Checked |
| 36 | Dial: select what's playing, show the song; Dial slow to appear | Checked; appearance speed not timed on screen |
| 37 | About / Credits dialogs, hover tooltips unreadable | Fixed, not seen (palette restored outside the panels) |
| 38 | Queue tab button off-theme | Checked |
| 39 | Artist page: default → album cover → video flash | Fixed, not seen |
| 40 | Lag clicking sidebar items | Checked: no long scripts; transition freeze capped |
| 41 | Right-click in expanded library | Checked via the same route as the sidebar |
| 42 | Expand/collapse transition terrible | Fixed, not seen: morph |
| 43 | Right-click sometimes a 4-item custom menu | Checked: always Spotify's |
| 44 | Pieces appearing 2–5 s late | Fixed: placed when Spotify draws |
| 45 | Unpin took 2 s | Fixed: applied from Spotify's change event |
| 46 | Greeting shrinks and disappears | Checked |
| 47 | 10–15 s UI lag after songs | Checked: was three script copies; now one |
| 48 | Library and right panel messed up | Checked |
| 49 | Everything black | Checked: layout layers clear again |
| 50 | Move off the Dell SSD onto the iMac | Done: ~/Developer/tess-music |
| 51 | Artists no longer videos | Checked: video was being made in an inert document |
| 52 | Background should hum with the song/artist | Checked: smooth drift in the song's colours, the artist's on their page |
| 53 | Black bar at the bottom of artist pages | Checked: picture covers the whole page |
| 54 | Video vs photo balance per artist | Checked: Photo / Video switch per artist |

Not built yet (deferred by Krish): listening stats page, lyric share cards, Apple-style album pages,
word-by-word lyrics (#2).
