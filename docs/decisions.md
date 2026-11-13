# Decision log

Every decision that shapes Tess: what was decided, who decided, why, and what it costs. Newest at the bottom of each
section. "Owner" = Krish's call; "Agent" = made by the AI agent working on his behalf (he can overrule any of these).
Add an entry whenever a decision is taken; never rewrite an old one; if it's reversed, add a new entry that says so.

Format: **D-NN · date · who** — decision. *Why.* Trade-off / revisit when.

## Product

- **D-01 · Nov 2026 · Owner** — Restyle the real Spotify desktop app rather than build a new client.
  *Everything Spotify has (library, downloads, lossless, lyrics, Canvas, Jam, DJ) keeps working; no API limits.*
  Trade-off: depends on Spotify's internals, which change with each Spotify update.
- **D-02 · Nov 2026 · Owner** — The design target is Apple Music's feel, including Liquid Glass.
  *That is the experience he wants on his Mac.* Outside design guides yield to this brief (see DESIGN.md).
- **D-03 · 13 Nov 2026 · Owner** — Windows version paused until the Mac work and performance are done; when it comes,
  it lives in this repo with one install address for both systems (#34).
- **D-04 · 13 Nov 2026 · Agent (delegated)** — Dial picking (#13): a play counts wherever it starts; "shown" means the
  selected item and its two neighbours; a play elsewhere makes the next Home visit pick a fresh ring.
  *Each fixes a documented weakness behind "what's playing isn't shown, picks feel off".* Owner asked for every open
  item to be finished; any of the three can be reversed.

## Architecture

- **D-10 · Nov 2026 · Owner** — One repository (`Flame119052/tess-music`) for theme, patcher, installer, Tess Mini,
  companion and tools; `Flame119052/tess-releases` stays as a read-only mirror. *0.1.x installs read the mirror;
  archiving it would strand them.* Never archive it.
- **D-11 · Nov 2026 · Agent** — Fork Spicetify CLI 2.46.4 as `tess-patcher` (config in `~/.config/tess-patcher`).
  *Never collides with a user's own Spicetify; Tess controls its own releases.* Trade-off: must be rebased when a
  Spotify update breaks it. Licence stays LGPL-2.1.
- **D-12 · Nov 2026 · Agent** — Every update is signed (Ed25519) and checked on the Mac before use; the loader keeps
  the last good theme and falls back if a new one fails to start. *A bad or tampered release can't take Spotify down.*
- **D-13 · 12–13 Nov 2026 · Owner** — Every part (theme, loader, patcher, Tess Mini, the updater itself) updates for
  life with no commands; anyone on any version who runs the install line once is upgraded in place with no
  duplicate helpers. *He never wants users to run a command again.*
- **D-14 · 13 Nov 2026 · Owner** — Health reports go to a private inbox (Cloudflare Worker) rather than public GitHub
  issues or local-only logs. *He wants to see problems without users having to report them; nobody may hijack it.*
  Agent design choices inside it: no read endpoint at all, anonymous install id, redaction, `tess reports off`.
- **D-15 · 13 Nov 2026 · Owner** — The inbox lives at `tess-music-player.janus.ing`, not the workers.dev address.
  *The workers.dev address contained part of his email; the Paperclip workers share that subdomain so it couldn't be
  renamed.* Cloudflare Access bypass for that one host only.
- **D-16 · 13 Nov 2026 · Owner** — Nothing on Cloudflare may cost money. Agent: hard caps (per-IP limiter, 30/h/IP,
  60/day/install, 2,000/day total, 24 KB, 30 days) so a flood is refused, never billed. Open: confirm the Workers plan
  is Free.
- **D-17 · 13 Nov 2026 · Owner** — A remote fix path that works even when updates are broken. Agent design: a separate
  rescue agent that updates never replace, a second key kept offline (not in GitHub/CI), serial + expiry + per-Mac
  targeting. *A stolen GitHub account or CI secret can't issue a rescue.* Trade-off: the rescue key is a master key
  to every Tess Mac; disclosure and an off switch are tracked in #53; key backup in #55.
- **D-18 · 13 Nov 2026 · Agent** — Installer scripts use only what every Mac has (`sh`, `zsh`, `curl`, `awk`, `ditto`).
  *`python3` on a Mac without developer tools only opens an install prompt; it silently broke a user's failure report.*
- **D-19 · 13 Nov 2026 · Agent** — Spotify's interface folder is never deleted and refilled; it's only replaced by
  swapping in a complete, checked copy, with a CI gate (`tools/check-safety.sh`) that blocks any release breaking this.
  *Delete-then-copy blanked a user's Spotify when macOS blocked the copy.* (#36)
- **D-20 · 13 Nov 2026 · Agent** — Sign every binary with one self-signed "Tess Music" identity (no Apple Developer
  ID). *macOS ties App Management and background-item approvals to the signing identity; ad-hoc signatures made users
  approve again after every update. $0.* Trade-off: Gatekeeper doesn't trust it (irrelevant for curl-installed files);
  an Apple Developer ID would also allow notarization later. (#28)
- **D-21 · 13 Nov 2026 · Agent** — When macOS blocks the patcher: check first (`can-write`), leave Spotify untouched,
  ask once with "Open Settings", never retry on a timer; re-apply only on a new Spotify version, a new patcher, or the
  user asking. *The old helper retried every few minutes and half-patched Spotify.* (#28)
- **D-22 · 13 Nov 2026 · Owner** — For DMG-installed Spotify copies: detect `com.apple.quarantine` upfront in
  `installer/tess-install.sh` before changing anything and tell the user to reinstall with Spotify's official
  installer (`Install Spotify.app`), rather than silently stripping quarantine flags or ad-hoc re-signing `Spotify.app`.
  (#51)
- **D-23 · 13 Nov 2026 · Owner** — Store raw signing keys on the internal APFS volume (`~/.config/tess-signing/`,
  `chmod 600`) rather than inside a `noowners` external drive `.env`; back them up via an AES-256 encrypted `.dmg`
  across separate network, external, and cloud storage with the passphrase in Apple Passwords / iCloud Keychain; leave
  the owner's FIDO-only YubiKey untouched; document public env/secret rules in `.env.example` + `docs/secrets-and-env.md`
  and keep machine-specific paths in gitignored `.local/`. (#55)

- **D-58 · 13 Nov 2026 · Owner** — Rescue orders start within a minute: a separate `music.tess.wake` agent asks
  `GET /v1/wake` every 60 s and starts the signed rescue line when the serial is newer than the last order run. The
  serial lives in D1 (strongly consistent) with KV as a fallback; the 6-hour `music.tess.rescue` check stays as the
  fallback, so a broken wake helper or inbox cannot stop rescue. The request carries no install id, and the helper can
  only start the rescue agent; the order still needs the offline key's signature. *The owner asked for a check-in to
  run when it is sent, not up to six hours later. True push would need a new service and an always-on connection on
  every Mac; one small request a minute is the simpler trade-off.* Revisit at a much larger user base (the Worker free
  tier allows ~100k requests/day).
- **D-59 · 13 Nov 2026 · Agent (owner asked to fix review findings)** — The wake check runs every five minutes, not every
  minute (reverses the 60 s in D-58). *Once a minute is 1,440 inbox requests a Mac a day; the free plan's 100,000 a day
  would run out at ~69 Macs and then block health reports too. Five minutes leaves room for ~340 Macs.* An order now
  starts within about five minutes. `tools/rescue.mjs` takes the next serial from GitHub's live API and the inbox's
  wake number, not the ~5-minute-cached raw address, so two orders sent close together never share a serial. (#68)
- **D-60 · 13 Nov 2026 · Owner** — Ship only the wake helper to users: a stable release that changes just the updater
  (0.2.14 + the wake additions, nothing removed) and adds the `wake` part; the theme, patcher, doctor and Tess Mini
  stay exactly as on stable. The rest of dev (0.2.23–0.2.28) is not promoted. (#68)
- **D-61 · 13 Nov 2026 · Owner** — Reverses D-60, which was a misreading and never shipped. The wake helper is for **one
  Mac only** (the user it was asked for), never for every Tess user: no stable or beta release carries the `wake` part,
  and it reaches that Mac only through its targeted rescue order. *The owner does not want quick remote control on
  every user's Mac.* Before any promote of dev, the `wake` part must come out of the parts list (or become per-Mac
  opt-in), or promoting would hand it to everyone. (#68)

## Releases and process

- **D-30 · 12 Nov 2026 · Owner** — Any change pushed to the repo ships automatically as a regular update.
  *Superseded by D-31 the next day.*
- **D-31 · 13 Nov 2026 · Owner** — "Dev first, you promote": every push goes to an internal `dev` channel only
  (the owner's Mac); users get a build only when the owner says "ship it" and it's promoted; the public install line
  runs only promoted installers. *A broken installer pushed straight to stable blanked a user's Spotify that morning.*
  (#43)
- **D-32 · Nov 2026 · Owner** — Work lands on `main`; pull requests only when the owner asks.
- **D-33 · Nov 2026 · Owner** — Test installers and updaters only against copies of Spotify; touch the real Spotify only
  with his OK and Spotify closed. *His Spotify was broken twice early on.*
- **D-34 · 13 Nov 2026 · Owner** — Every single thing he raises becomes a GitHub issue, closed with proof; GitHub is
  the shared memory across threads. *About a dozen fixes had been done without issues and were back-filled (#36–#52).*
- **D-35 · 13 Nov 2026 · Owner** — Work is split across threads; the repo carries AGENTS.md, CLAUDE.md, DESIGN.md,
  architecture, status, this log and the roadmap so any thread can start cold. (#44)
- **D-36 · 13 Nov 2026 · Owner** — Cheap/free models do research and audits (DeepSeek via OpenCode Go in T3 Code);
  the session's main model does judgment, specs and review.
- **D-37 · 13 Nov 2026 · Owner** — MIT licence for Tess; `patcher/` stays LGPL-2.1; every source credited in
  CREDITS.md. No personal names in the licence or anywhere public. (#52)
- **D-38 · 13 Nov 2026 · Owner** — Outside skills (Emil Kowalski, Impeccable, Taste) are read and their rules applied,
  not installed, until he decides to install one. (#42)
- **D-39 · 13 Nov 2026 · Owner** — No more feature building in the session that ended with the security audit; file
  everything as issues, document, and audit instead.
- **D-40 · 13 Nov 2026 · Owner** — Move shipping to Pull Requests → `dev` (auto on passed/merged PR) → `beta` →
  `stable`, with exact approvers ("passed by whom") TBD. Tracked in #62 before updating the live workflow rules.
- **D-41 · 13 Nov 2026 · Owner** — Standardize GitHub issue structure like large repos: 4-axis labels (`P0`–`P3`,
  `area:*`, type, status), phase milestones, plain-English titles for everyone, `CONTRIBUTING.md`, `CODEOWNERS`, and
  plain-language updates/explanations.

## Design and performance

- **D-50 · 13 Nov 2026 · Owner** — Optimise for real, never by making things worse: memory and speed improve together.
- **D-51 · 13 Nov 2026 · Agent** — "Under 200 MB at all times" is not reachable: Spotify alone, Tess off, measured
  ~1.2 GB. The target became Tess's own share and Spotify's needless work. (#35)
- **D-52 · 13 Nov 2026 · Agent** — Nothing moves for ever: records spin for 12 s after a song starts or play is pressed
  and on hover, then rest; the subtitle scrolls once per song; the progress line moves a pixel at a time.
  *On a visible Retina window any endless motion cost ~1/3 of a CPU core; at rest CPU went 71% → 29%.* The
  full-screen player is the one place continuous motion stays. (#35) Revisit if the owner wants records spinning
  continuously; the cost is known. *(Overruled by D-56.)*
- **D-53 · 13 Nov 2026 · Agent** — Replace broad `:has()` rules with `data-tess-*` marks set when Spotify draws; give
  Spotify's buttons `will-change: auto`; shelf arrows on hover. *Each was measured as a per-frame or per-change cost.*
  *(Visual trade-offs under review per D-56, #58.)*
- **D-54 · 13 Nov 2026 · Agent** — From Impeccable's craft floor: no eyebrow labels above headings (Home greeting,
  Dial reason/state moved under the title), one entrance per page. *The skill marks eyebrows as a ban.* Easy to
  reverse if the owner prefers the labels. (#42)
- **D-55 · 13 Nov 2026 · Agent** — The closed full-screen player sleeps (`display: none` after its exit animation) and
  its video plays only when open. *It was most of Tess's work while hidden.* *(Scoped by D-56: sleep/pause only when
  completely hidden, #57.)*
- **D-56 · 13 Nov 2026 · Owner** — Overrules D-52 and limits D-53/D-55: performance and efficiency must coexist with the
  rich, made-for-you Apple Music feel, never at the cost of quality (#58). Keep vinyls and foreground animations running
  whenever any part of Spotify is visible (even if overshadowed by another window); pause/sleep only when completely
  hidden (#57). Fix renamed Spotify selectors directly in our `patcher/` fork and watch upstream `spicetify/cli` (#59).
- **D-57 · 13 Nov 2026 · Owner** — Visual & UX priorities filed: fix artist Photo/Video switch & per-artist persistence
  (#60), separate Blends and Playlists in Library (#61), rework vinyl tonearm edge-to-label geometry & sync (#63),
  fix blank right side in no-lyrics full-screen transitions (#65), and collect customization/design controls (#64).
