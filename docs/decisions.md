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
- **D-62 · 13 Nov 2026 · Owner** — The rescue line is limited to Tess and Spotify, so it can be trusted on everyone's Mac: an
  order names one of five fixed actions (`check`, `update`, `repair`, `restore-spotify`, `uninstall`) built into
  `rescue.sh`, and can't carry a script or command. The wake helper and every script-running tool are out of `main`
  and out of every release (D-61 made permanent). Rescue lines installed earlier (the owner's Mac and one other)
  keep the old script format; that's the owner's decision for those two Macs only, tracked privately. *"No user
  should get scripts giving me control over their Mac."* Trade-off: a problem none of the five actions can fix now
  needs a normal signed release instead of a one-off script. (#69)
- **D-63 · 13 Nov 2026 · Owner** — Work moves issue → approach comment → PR → `dev` → `beta` → `stable`
  (docs/workflow.md). Dev is live `main`, for the owner's Mac only. Krish *declaring a release* makes beta from every PR
  merged since the last beta. Promoting copies beta to stable.
  - Reviewer agents run on the owner's machines (self-hosted runners labelled `tess-agent`). They are started only by
    allowlisted GitHub accounts tagging `@tess-review`, and only after CI passes.
  - The review a change gets depends on which paths it touches. Docs changes get CI only. Normal changes get a lighter
    PR review. Sensitive changes get the strong model on both the approach and the PR.
  - The 5-minute wake check returns for everyone, because a rescue order can now only press D-62's five buttons. It
    reads public raw files (no inbox cost) and starts the updater when a release is published, or the rescue line when
    an order is. The updater itself runs every 30 minutes, restarts Spotify only when no music is playing, runs the
    doctor after each update, and rolls back on failure.
  - Supersedes D-32 (PRs are now the norm) and the "wake out of every release" part of D-61/D-62. (#71)
- **D-65 · 14 Nov 2026 · Agent (owner set the requirements)** — Support is **one Hermes bot on Krish's server**, which
  people message. It replaces both earlier directions in #70 — Instinct/tincan/Grok Bot, then a Telegram bot, then a
  Hermes profile installed on each person's own Mac. Nothing of the first two was built; the third is what this reverses.
  (#70)
  - **Why a server, not the person's Mac.** Two of Krish's requirements can't both hold with a local bot: every report
    has to be *filed with its P0–P3 and area labels*, which needs a token with triage rights, and a token inside an
    install line can be pulled out of it; and *he* has to control the allowlist, which needs one list. He named the
    answer: *"otherwise run the bot on a server and have the person paste only `tess report` output."*
  - **It is still a Hermes bot** — a profile (`tess-support`) with its own persona, skill and model, started by
    `support/setup.sh`. Hermes has no public chat link, so the one way a stranger reaches a Hermes bot is a messaging
    gateway; that is Telegram here, and it is the only platform-specific part.
  - **Access is Hermes' gate, not the model's judgement.** `TELEGRAM_ALLOWED_USERS` is checked in the gateway before
    the model is called, and a gateway with no list denies everyone. Anyone else gets one polite refusal and 24 hours of
    silence — `unauthorized_dm_behavior: decline`, never a pairing code. Krish adds and removes people with `/allow`,
    `/deny` and `/who`; `scripts/allowlist.mjs` refuses a wildcard, a phone number, a request not from his id, and
    removing himself, rewrites the list and the `.env` at 600 atomically, logs every change, and restarts the gateway.
    Hermes' own `allow_admin_from` is set to his id too, so Hermes' admin commands are his alone; the three support
    commands above are not Hermes commands, so for those the script's own check is the gate, and the docs say so.
  - **Every report reaches him twice**: the issue is filed with its labels by an issues-only token on the server, and a
    one-line message with the link goes to him on every triage. Nothing is filed from a person's browser.
  - **Nothing of Tess's runs on anyone's Mac** and no Node is needed there. The only command is `tess report`, which the
    person starts (D-62 unchanged), and the bot has no route to their machine.
  - **Never on the Paperclip machine.** `setup.sh` refuses when it finds `/srv/paperclip`, so Paperclip's files,
    database and services are never shared with it.
  - **The terminal is real, and that is stated, not hidden.** `config.yaml` removes the desktop, computer-use and
    browser toolsets and denies dangerous commands in unattended contexts, but a shell on that machine is a shell. The
    blast radius is one issues-only token on one public repo, and every access change is logged and echoed to Krish.
  - Trade-off: it needs a machine, a Telegram bot and a GitHub token, and it is the one part of Tess that lives
    outside a release. Revisit if Hermes grows a way for an outsider to reach a bot without a messaging gateway.

- **D-66 · 14 Nov 2026 · Owner** — Support reports go to the **inbox**, not to GitHub, and the model is **OpenCode's
  free tier**. The bot posts one JSON payload to a new `POST /v1/support` on the Worker at `tess-music-player.janus.ing`;
  the owner's side reads it with `tools/reports.mjs support list|show|filed` and files the issue with the P0–P3 and area
  labels from `docs/triage.md`. (#70)
  - **Why:** the person's side must never need a GitHub account, a token or a browser, the labels have to be applied by
    something with triage rights, and the owner already has one private place that stores reports anonymously. This is
    that place.
  - **Authenticated, unlike a health report.** Reporting is public by design (an installer can't hold a secret); a
    support report carries someone's own words, so it needs a token. Only a SHA-256 of each token is stored, every token
    has a label, and revoking is one command. An unknown, revoked or absent token is refused.
  - **No read endpoint**, unchanged: `GET` on the path is a 404, and reading needs the owner's Cloudflare login.
  - **The labels are validated twice** — in `triage.mjs` on the server and again in the Worker — because they become
    GitHub labels, and a made-up one would fail the filing instead of the report.
  - **The bot gets no GitHub token at all**, so a bot talked into something by a stranger can write to one inbox and
    nothing else. Filing happens with the owner's login, on the owner's machine.
  - Trade-off: two things on the owner's side before it works — applying `inbox/schema.sql` and deploying the Worker —
    and filing is a step he (or his agent) takes rather than something that happens on its own. Revisit if the inbox
    ever grows a read API; today that would undo D-14's rule.

- **D-67 · 14 Nov 2026 · Owner** — The support bot keeps a hard resource budget and cleans up after itself, and it is
  made of seven small skills rather than one long playbook. (#70)
  - **One session folder per visit**, capped at 60 MB, holding the screenshots, the recording, the doctor output and the
    chat scratch. Anything older than 24 hours is swept on the same run, and the whole scratch space stays under 500 MB.
  - **Recordings are capped at 50 MB and 2 minutes.** Over the cap they are re-encoded down when `ffmpeg` exists and
    refused when it does not — never stored "to sort out later".
  - **The folder is deleted the moment the inbox accepts the report.** Only a one-line receipt survives: report id,
    time, file count, size — no file names, no paths. *A person's screen is a liability to keep, and "it vanished" is not
    an answer to what happened to their file.*
  - **On the inbox side**, a recording goes to R2, never to the database, and is deleted when the report is filed or at
    14 days — by the scheduled job and by an R2 lifecycle rule, so an unapplied rule can't leave it lying there. There is
    no way to read one back.
  - **The process is capped where systemd can cap it**: `support/tess-support.service` gives it its own unprivileged
    user with `MemoryMax=1G` and `CPUQuota=50%`, and `setup.sh` starts it through that unit when it runs as root on a
    systemd machine. Where that isn't possible it starts the gateway plainly and says the process is uncapped rather
    than claiming otherwise. No background processes either way. It still refuses to run on paperclip-vps.
  - **Seven skills, one job each**: `tess-support` (front door), `tess-evidence`, `tess-repro`, `tess-duplicate`,
    `tess-gather`, `tess-triage`, `tess-handoff` — each with its own trigger, so the model loads one thing at a time
    instead of one long playbook and hoping it remembers the middle.
  - Trade-off: caps mean a genuinely large recording is refused rather than examined, so the bot asks for a shorter one.
    Revisit if R2 or Telegram raise their limits enough for that to stop mattering.

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
- **D-64 · 13 Nov 2026 · Agent** — A beta records its source `main` commit in `release.json` and keeps its generated
  notes in `RELEASE_NOTES.md`; the first declaration without that metadata uses the commit immediately before the
  previous beta's publication time. Reviewer selection reads T3's local usage cache, skips a provider with any
  exhausted quota window, and retries the next configured provider only when the CLI reports a usage limit.
  *This makes later release-note ranges exact and keeps model fallback deterministic without a network usage query.*
  Trade-off: the first declaration's range is time-based because old beta branches did not record their source.

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

- **14 Nov 2026 · PR #75 review fixes (#53)** — Ship the Tess command as an optional signed `command` part so the
  updater reaches existing Macs. Older channels can omit installer, uninstall, wake and command parts. Rescue off
  disables the launchd job and removes its login plist; ordinary updates preserve the independent rescue verifier.
  Part rollback requires a healthy doctor baseline so unrelated existing failures cannot ban good parts. Wake
  remembers the last rescue serial it triggered, including rejected or expired orders.

- **14 Nov 2026 · PR #75 sixth review (#53)** — The wake check reads the release and the rescue order separately, and skips the rescue read when the line is off. A repair names an older rescue script as able to run scripts. `tess status` says when that agent is still loaded after off, and the doctor unloads it and removes its login plist.
- **14 Nov 2026 · PR #75 seventh review (#53)** — Docs name the pre-13 Nov rescue scripts, which updates never replace and which can run a signed script. Existing Macs are not shown a new notice unless they repair or reinstall. #53's check is the install notice, the README, and SECURITY.md. That older format is the owner's Mac and one other (D-62); they see the plain wording the next time they repair. An unsolicited notice on every Mac is not part of this change. A sandbox calls launchctl only when a fake one is first on PATH, because the job label is the owner's real job.
- **14 Nov 2026 · PR #75 eighth review (#53)** — When the doctor part itself changes, the updater takes a new health baseline from that doctor instead of judging it by the previous one. `tess status` says the rescue line is not installed when its verifier is missing, and names an older script that can run any script. The doctor removes a leftover rescue login file even when that job is not loaded. An update does not add a rescue line on a Mac whose install notice said the line was not there.
- **14 Nov 2026 · PR #75 second review (#53, #71)** — Older channels retain the running installer and a built-in
  uninstaller when signed parts are absent, without claiming signed-part hashes. Rescue on creates its own plist
  and requires adoption success; wording permits an unexpired order sent while off because old rescue scripts
  cannot report adoption failure reliably. Reinstall and uninstall clear launchd's persistent rescue disable.
  Theme refresh runs with a copied config against staged Spotify files to preserve generated colors before swap.
