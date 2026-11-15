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
  - Reviewer agents run on self-hosted runners labelled `tess-agent`: the Instabox box `tess-reviewer` first, and any
    `tess-backup` runner (the owner's VPS or omarchy, whichever is idle) when the box does not answer (D-65). They are
    started only by allowlisted GitHub accounts tagging `@tess-review`, and only after CI passes. *(This bullet is
    superseded by D-66: reviews are standard GitHub-hosted jobs now.)*
  - The review a change gets depends on which paths it touches. Docs changes get CI only. Normal changes get a lighter
    PR review. Sensitive changes get the strong model on both the approach and the PR.
  - The 5-minute wake check returns for everyone, because a rescue order can now only press D-62's five buttons. It
    reads public raw files (no inbox cost) and starts the updater when a release is published, or the rescue line when
    an order is. The updater itself runs every 30 minutes, restarts Spotify only when no music is playing, runs the
    doctor after each update, and rolls back on failure.
  - Supersedes D-32 (PRs are now the norm) and the "wake out of every release" part of D-61/D-62. (#71)
- **D-65 · 14 Nov 2026 · Owner** — A dedicated Instabox box (`tess-reviewer`) is the default reviewer machine, with the
  VPS (`paperclip-vps`) and `omarchy` as equal fallbacks, whichever the `tess-backup` label finds idle; neither comes
  first. A review wakes the box through its public `/ready` page and takes it only when its runner answers that it is
  active and idle; otherwise the job goes to a backup by label.
  *A review needs no macOS and no keys, so a box that exists only for reviews leaves the owner's Mac and Paperclip
  untouched, and costs nothing while it is paused.* Trade-off: it is a third-party host. It holds the reviewer's Claude
  login token, its GitHub runner credentials, and, during a job, that job's `GITHUB_TOKEN` (issues/PR comment write).
  It is made with `--no-vault` and holds no Tess signing or rescue keys. Its runner runs as an unprivileged user, and it
  reads outside code read-only. Trade-off: `/ready` is public, so anyone can keep waking the box instead of letting it
  pause, which spends free-plan time, and anyone can see when a review is running. Neither stops a review: the box is
  only asked, and the job falls back to a backup. Amends D-63's "reviewer agents run on the owner's machines".
  (#71)
- **D-66 · 15 Nov 2026 · Owner** — Reviews run on **GitHub's own hosted machines**, not on self-hosted runners. Every
  `@tess-review` is a standard GitHub Actions job on `ubuntu-latest`: a fresh virtual machine for that review, deleted
  when the job ends, free and unlimited for this public repository. There is no self-hosted runner, no T3, no Tailscale
  and no Instabox box to wake (D-65 is superseded). The job installs only the chosen reviewer's CLI, at a pinned
  version, and holds only that provider's key, from repository secrets the owner adds; fork PRs never reach it.
  bubblewrap stays: the job lifts Ubuntu 24.04's AppArmor limit on unprivileged user namespaces for that one
  disposable machine, and a job that cannot start the sandbox stops instead of running a reviewer bare.
  *Why:* the review reads outside code, so the safest place for it is a machine that exists only for that review. It
  holds no Tess key, cannot reach Paperclip or the owner's Mac, leaves no runner to patch or keep online, and costs
  nothing on a paused third-party box. Trade-off: the provider keys move from a machine's `.env` to repository
  secrets, and one of them is a key that bills an API rather than the ChatGPT plan (Codex's docs forbid the
  ChatGPT-account path on a public repository). This also retires the runner network filter, and makes #94 and #95
  moot. (#71)
- **D-67 · 15 Nov 2026 · Agent** — A review only reads a branch of this repository, and every verdict names the commit it
  read. The gate asks which repository the PR head lives in and refuses a fork head even when an allowlisted maintainer
  tagged it and CI is green, failing closed on a deleted or unknown head repository; the review repeats that check before
  it fetches anything. The head is then checked one last time immediately before posting, so a push during a long review
  costs a re-tag instead of attaching an approval to code nobody read, and the comment carries `Reviewed: <sha>`. The
  gate's rules moved from inline YAML into `tools/agent-gate.sh`, because a rule worth having is a rule worth a test.
  *Why:* the review job holds a provider key, and the fork author writes both the diff and the snapshot the reviewer
  reads. (#98)
- **D-68 · 15 Nov 2026 · Agent** — The reviewer's key is contained by what the model can *do*, and by what can leave the
  job, not by a network allowlist. Each CLI is given read-only tools only (Claude Read/Grep/Glob, Codex's read-only
  sandbox, OpenCode's deny-everything-but-read agent), so no tool exists that could send the key to an endpoint of a
  diff's choosing; the job holds one provider's key and no other. What *can* leave is text: a review whose body contains
  a held key is never posted, and the check now matches the key split over lines, base64'd, hex'd and percent-encoded,
  not just as written. A failed reviewer's raw output no longer reaches the log at all — one redacted, length-capped line
  of its stderr does, and its stdout (the review text, which a diff can dictate) never does.
  *Why not an authenticated proxy inside the job:* it only works if each CLI can be pointed at a local base URL, and the
  endpoint list per provider cannot be checked from here; a wrong guess would silently stop every review of that provider,
  and a blocking egress allowlist has the same failure. That stays the recommended next step if a reviewer is ever given a
  tool that can fetch a URL. *Amended by D-69 for Claude and Codex, whose endpoint is a single public host, so there is
  nothing to guess.* (#98)
- **D-69 · 15 Nov 2026 · Agent** — For **Claude and Codex, the key never enters the sandbox**. `tools/review-proxy.mjs`
  runs as its own process, holds the real key, and listens on loopback; the CLI is pointed at it with a **per-review
  token**: Claude through the documented gateway variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`), Codex through
  `-c` provider overrides (`base_url`, `env_key`, `wire_api`). The proxy adds the provider's own `Authorization` header to
  the request it forwards, and refuses any call that does not carry this job's token, so finding the port buys nothing.
  Neither sandbox holds `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_API_KEY` under any name, which matters because Codex's
  read-only sandbox still lets a shell run and a shell can print `env` — the one place in a review where a credential was
  reachable by the very diff being read. If the proxy cannot start, the review stops: it never falls back to the key in
  the sandbox. *Not covered:* OpenCode keeps its own key, because a review spends one connector's allowance at that
  connector's endpoint and a wrong base URL would stop every OpenCode review; its agent file denies every read outside
  the copy (absolute paths included, so `/proc` is out), so no tool it is given can read the key. The token the proxied
  sandboxes hold can still be printed, but it dies with the job, opens nothing, and the posted-text guard still refuses
  any comment containing a held key. An egress allowlist is still not part of this: the machine holds no other secret,
  and one wrong rule would stop every review. Verified with a fake upstream (`tools/test-agent-review.mjs`): the allowed
  call is forwarded with the key added, and a call with no token, another token, or a path outside the provider never
  reaches the upstream. No live provider call has been made from here, so the first review of each proxied provider is
  the live check. (#98)
  *Amended 15 Nov 2026, after review:* the proxy was forwarding **whatever method and route it was given**, so the token
  was a way to use everything the key can reach — a reproduced `DELETE /v1/files/file-123` arrived upstream with the real
  key. It now forwards **one exact request per provider and refuses the rest with a 403**, before anything is forwarded:
  `POST /v1/messages` (query limited to `beta`) for Claude Code 2.1.325, and `POST /v1/responses` for Codex 0.169.0.
  Those are not guesses: both pinned CLIs were run against a local upstream that logged every method and path, Claude in
  the review's own print mode (`--restricted --safe-mode --tools Read,Grep,Glob`, streamed and non-streamed, one tool
  turn) and Codex with the review's `-c` overrides. Nothing else was seen, so nothing else is allowed — including
  `count_tokens`, which the pinned Claude build has code for but never called here, and which is one line to add if a
  real review ever asks for it. The route match refuses other methods, other paths, `.`/`..` segments, `//`, a backslash,
  any percent-escape (so `%2f`, `%2e%2e` and `%5c` cannot hide), a fragment, a query key the CLI does not send, an
  absolute-form request line that names its own host, and `CONNECT`/`Upgrade`. The upstream host is the one the proxy was
  started with, never one from the request or its headers; every incoming `authorization`, `x-api-key` and
  `proxy-authorization` is dropped before the real key is added; and a body over 10 MB is refused rather than buffered.
  Both pinned CLIs were then run end to end through the real proxy: each completed a turn, and the only thing the
  upstream saw was its one inference route. (#98)

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
- **15 Nov 2026 · PR #87 second review (#71)** — A review is chosen by usage first and preference second: the agent
  reads both the 5-hour and the weekly window from the usage hub and skips a provider that is on pace to run out before
  its reset, even with usage left (Claude sat at 59% session and 16% weekly on 15 Nov). Pools are not shared even inside a
  provider: Opus spends Claude's weekly pool and Fable 5.2 has its own, and GLM-5.3 on OpenCode Go empties that allowance
  far faster per review than DeepSeek V4.1 Flash, so DeepSeek is the OpenCode default and GLM is tagged deliberately
  through the Z.ai coding plan. The guide gains a cost weight per row and states that one review is the budget until a
  per-review cap lands (#71). The review copy also drops symlinks and matches agent-file names in any letter case, and a
  skipped reviewer is named in the posted comment instead of falling through silently.
- **15 Nov 2026 · PR #87 third review (#71)** — Every reviewer now runs inside an unprivileged **bubblewrap** sandbox:
  only the review copy, the CLI and its runtime, and that provider's own config folder are bound, read-only, with a
  throwaway `HOME`, the network for the API call, and only its own key in the environment. A machine without a working
  sandbox refuses that provider and says so, instead of running it bare. Automatic selection now implements the pace rule
  the docs promised (a provider on track to empty a window before it resets is skipped) and keeps three reviews in hand in
  the 5-hour window; a candidate filtered out before it starts is named in the comment like one that ran and refused.
  Everything likely to change about reviewers — the order per role, the allowed models, the cost weight, dated pool
  notes, and quota reserved for the owner with an `until` date — lives in `.github/agents.json`, with one short
  "How to update this" guide in `docs/workflow.md`. (#71)
- **15 Nov 2026 · PR #87 fourth review (#71)** — The reviewer's network boundary is the **runner service**, not the
  sandbox: bubblewrap keeps the host network namespace because the API call needs it, so `tools/runner/network.conf` is a
  systemd drop-in for `actions.runner.*` that refuses loopback, link-local, multicast, `10/8`, `172.16/12`, `192.168/16`,
  Tailscale's `100.64/10`, the cloud metadata address and `fc00::/7`, and allows a single local address, the
  `systemd-resolved` stub `127.0.0.53`. A review therefore reaches its provider's API and nothing else on the machine —
  on `paperclip-vps`, not Paperclip's PostgreSQL, its services or the Tincan relay — and the one file covers Claude and
  every other provider. A machine whose resolver is the router (plain Arch) either turns on `systemd-resolved` or names
  that one address in the drop-in. A provider's config and sign-in files are mounted **inside** the throwaway `HOME`, at
  the path its CLI looks in: the earlier mounts sat at the runner's real home, which `HOME` had already moved away from,
  so OpenCode could not find its agent file and Codex could not find its login. Applying the drop-in to a machine is a
  root action the owner approves; the repository only carries the file and the check. (#71) *Retired with the
  self-hosted runners by D-66: there is no runner service to attach it to.*
- **15 Nov 2026 · Review caps (#71)** — One review is now bounded before it starts, not just advised in docs. Each
  provider gets the hardest limit it actually accepts: Claude 12 turns and a dollar ceiling (60 cents Opus, 30 Sonnet,
  explicitly a client-side estimate of API list prices rather than the plan's meter), Codex an effort plus compaction at
  180k tokens because it has no turn or budget cap at all, Cursor only a wall clock because it has no cap it can be told
  about — and only Cursor's own Composer, since Claude or GPT inside Cursor bills prepaid credit from the first
  request — and OpenCode 12 steps in its agent file. Every provider is killed at 600 s (480 s for terra and Cursor) and
  the next reviewer runs, with the timeout named in the comment. What a review used is now stated from the CLI's own
  report: Claude's `--output-format json` gives turns, dollars and tokens, Codex's `--json` gives tokens. The share of a
  5-hour window a review is assumed to take stopped being one number for everyone: it is `caps.per_review_pct` per model
  (sol 7, terra 3, GLM-5.3 4, GLM-5.3 Flash 0.2, DeepSeek 0.1), so a cheap reviewer can still run on a window that is
  nearly empty, while a model nobody has measured keeps the old cautious 10%. A review that stops because of one of those
  caps is skipped by name and the next reviewer runs, so a cap can never turn a review into a "changes needed" verdict
  about the change. Codex also needed `--skip-git-repo-check`, because the review copy is a `git archive` with no `.git`
  and every Codex review had been refused before any cap applied. (#71)
- **15 Nov 2026 · Usage snapshots (#93)** — A review picks its model from the freshest snapshot any of Krish's machines
  published in the last 30 minutes, not only from the runner's own hub. Each machine's `tess-usage` is read every few
  minutes by `tools/usage-publish` and written to one repository variable per machine (`USAGE_SNAPSHOT_MAC`, `_VPS`,
  `_OMARCHY`), which the review workflow passes to the job. The snapshot uses a strict allowlist schema rebuilt from
  scratch: a fixed provider/instance id, window kind, `%` left (0–100), ISO reset time, numeric pace fields, a
  timestamp and a machine name (`mac`, `vps`, `omarchy`) — no labels, plan names or free text. Providers a reviewer cannot
  be are dropped, and both publisher and reader validate the same schema so malformed or stale data falls back to
  today's behaviour, and the comment names the source and age (`Usage: vps, 5 min old`)
  so nobody has to guess. OpenCode is matched per connector (`opencode-go`, `zai-coding-plan`), because those are separate
  allowances. Scheduling is a LaunchAgent on the Mac and a user systemd timer on Linux, at the lowest priority the
  machine offers, with nothing system-wide; installing it on a machine is the owner's step, not a merge. (#93)
