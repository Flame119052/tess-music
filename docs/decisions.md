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
- **D-70 · 15 Nov 2026 · Agent** — When `node tools/agent-review.mjs pick` finds no reviewer with room, post a marker
  comment (`<!-- tess-review-bot -->`) listing each skipped candidate, its reason, the earliest blocking window reset in
  UTC plus a relative time, and asking to tag again after that time; then keep the `review` job failing (`exit 1`).
  *Why:* GitHub Actions workflow jobs have no `neutral` conclusion (that only exists in the Checks API), and `skipped`
  is only possible if `pick` lives in an earlier job (which would either give `gate` write permissions or spin up a
  third VM and still leave the workflow run green when no review occurred). Staying failed inside `review` after posting
  the PR comment leaves PR CI (`check.yml`) unaffected, keeps `gate` read-only, and honestly shows in Actions that the
  review did not complete. *Narrowed by D-72: the job no longer looks for a reviewer with room, so this comment is what
  a tag gets when the model it named has no room.*
- **D-71 · 15 Nov 2026 · Owner** — Every reviewer runs on one of Krish's subscription plans and never on a pay-per-use API
  key. The allowed list is Claude's plan, the ChatGPT plan (Codex), the OpenCode Go plan and the Z.ai coding plan; a model
  reached only by an API key is not on it, a tag naming one is refused, and `CODEX_API_KEY`/`CURSOR_API_KEY` are gone.
  *Why:* a review should spend quota Krish has already paid for, not bill per token, and a key is a worse thing to keep
  on a runner than a plan login. Trade-off: the plans are finite, so usage decides when a review can happen.
- **D-72 · 15 Nov 2026 · Owner** — The agent that tags the review chooses the reviewer, and the job only checks and runs
  that choice. It weighs usage left in the 5-hour and weekly windows, pace, time to reset, `caps.per_review_pct`, the
  `reserve` block, the `strong` list for a sensitive tier, and a different provider from the PR's `Made by:` line, then
  names the model in the tag with a line saying why. The job refuses a choice that breaks a hard rule — not on the
  plans-only list, not `strong` for a sensitive tier, the author's own provider, a used-up window, a reserve, a missing
  or expiring Codex login — with a marker comment naming the reason and, for usage, the reset time, and then stops.
  **No silent fallback**, and a tag with no model is refused too.
  *Why:* the agent knows what the change is worth and has the usage in front of it; a job that re-ranks models quietly
  produced reviews nobody chose, and the earlier "try the next one" design hid a refused model inside a verdict.
  Trade-off: a refusal costs a re-tag, which is cheaper than a review by the wrong model.
- **D-73 · 15 Nov 2026 · Agent** — Codex reviews on the ChatGPT plan, not the OpenAI API: the CI login lives in
  `CODEX_AUTH_JSON` (a dedicated `codex login` in its own `CODEX_HOME`, `tools/codex-ci-login.mjs`), and the proxy
  forwards it to `POST https://chatgpt.com/backend-api/codex/responses`, adding `authorization` and `chatgpt-account-id`
  with `originator: codex_cli_rs`. Verified by pointing a real `codex exec` at a local proxy that logged the request and
  forwarded it: the plan backend answered it as a plan request, not a 401 or 404. The token never enters the sandbox, and
  the proxy's config (holding it) is written to `RUNNER_TEMP` at 0600. Because a refresh rotates the refresh token and a
  disposable runner cannot persist the rotated file (the vendor's own guidance is to persist it between runs), a review
  refuses to start inside the last 12 hours of the token and the secret is renewed by hand. *Why:* the plan is the only
  Codex access that is not billed per token, and the vendor's "do not use this on public repositories" caution is about a
  login reaching fork-authored code, which this gate already refuses. Trade-off: an honest recurring human step, about
  every nine days, instead of a key that never expires.
- **D-74 · 15 Nov 2026 · Agent** — Antigravity (`agy`, 1.5.3) is not a reviewer. It runs on Krish's Mac and lists its
  models, but it keeps its account token in the OS keyring (`keyringAuth`, "secret not found in keyring") and has no login
  subcommand or headless credential file for that account, so a GitHub Linux VM cannot sign in on the plan. *Why:* a
  reviewer that cannot authenticate on the runner is worse than one that is honestly absent, and storing a keyring dump
  as a secret would be a worse credential than the plan login it replaces. Revisit if it grows a credential-file login.
- **D-75 · 15 Nov 2026 · Agent** — Authorship is attested by the tag, not read from the pull request. The tag carries
  `author=<provider>` (`claude`, `codex`, `opencode`, `antigravity`, or `none` for a person), written by the one allowlisted
  account allowed to tag; a review is refused when that field is missing, unknown, the reviewer's own provider, or
  contradicted by the PR's `Made by` line. The parser reads both shapes the repo really writes — `Made by: …` on one line
  and the template's `## Made by` heading — and prose can only ever add a refusal. *Why:* the earlier rule read the
  `Made by` line out of the PR body, which its own author can edit, delete, or point at a different provider; it also
  missed this repository's own `## Made by` format, so an OpenCode review of a DeepSeek change was allowed. *Trade-off:*
  a tag now carries one more field, and the tagging agent has to state something the job cannot verify by itself.
  *Guard, not permission:* no wording anywhere can make a review run that a rule would refuse.

- **D-76 · 15 Nov 2026 · Owner** — One review tag names the model, the **machine** and an optional focus:
  `@tess-review pr provider=… model=… effort=… author=… machine=github|mac|omarchy prompt="…"`. `machine=` omitted means
  today's GitHub-hosted review, so no existing tag changes meaning; `prompt=` becomes the reviewer's focus, capped at 400
  characters and framed as extra attention, never permission. A tag for `mac` or `omarchy` is checked by the workflow,
  answered with `Review queued for <machine>`, and run by a watcher **on that machine**, which polls GitHub and opens the
  review with that machine's own `t3 thread start`. `machine=vps` is refused with its reason. *Why:* GitHub-hosted jobs
  cannot reach Krish's machines and the self-hosted runners are gone (D-66), so a pull model is the only way to get a
  review into T3 where he can watch or steer it — with no inbound access and no T3 credential on GitHub. *Trade-off:* an
  extra step before a review appears, and a tag for a machine cannot carry `effort=`. Reuses the two-slot cap, the fixed
  refusal codes and the CRLF-safe parser from #90, whose dispatcher needed a runner and a stored T3 sign-in; that PR is
  closed in favour of this. (#71)

- **D-77 · 15 Nov 2026 · Owner** — A machine review is **sent only to a thread T3 reports at `approval-required`**, and
  the thread never posts it. The watcher opens the thread with a fixed first line that holds nothing from the pull
  request, reads the thread's runtime mode back from the local T3 server, and only then sends the diff, the issue and the
  focus; a wider mode is refused with a comment naming the setting. The thread answers with the review as its last
  message, and the watcher — plain code, no model — checks the marker, the commit and the verdict line and posts it after
  confirming the head has not moved. A tag is fetched again by id before it runs, so a deleted or edited tag cannot
  launch from the copy in the state file; a launch is recorded before and after `t3 thread start` and keyed to the comment
  id in the thread title, so a tick that dies half-way adopts its thread. A slot is held while its thread exists and
  reclaimed only when the thread is gone or a tick died before starting one, never on a timer. *Why:* a T3 thread runs
  with Krish's own permissions, and #105's review found that a prompt saying "stay read-only" is not a boundary, that a
  queued tag could run after deletion, that a live review's slot expired under a two-hour timer, that a crash could
  start a second thread, and that `effort=` was silently dropped. *Trade-off:* a review takes two messages (the gate,
  then the review) and its comment appears one tick after the thread settles; the read-only promise is still bounded by
  T3's own mapping (Codex: OS read-only, no network; Claude: per-tool approval), and files outside the worktree stay
  readable by the owner's own account, so the Mac stays opt-in per tag and GitHub stays the default. (#71, #105)

- **D-78 · 15 Nov 2026 · Owner** — A machine review runs in the **same stripped copy** the GitHub job reads, and reads
  `idle` as the end of a turn. `t3 thread start` can only give a thread a project root or a new worktree, so the watcher
  builds a commit in its own clone whose tree is the reviewed head with every agent setting, instruction file (any depth,
  any letter case) and link removed, and starts the thread on a worktree of that ref; the commit has no parent, so the
  change's own history cannot hand `AGENTS.md` back through `git show`. The copy is deleted with the review — worktree and
  ref both. A turn is finished when T3 reports the run over (`idle`, `completed`, or one of the ended statuses) and the
  newest run is the one `t3 thread send` started; the sidebar's `settled` is days of quiet and is never consulted, which
  is what had left finished reviews unposted and both slots held. The mode is read before each send *and* before the
  answer is accepted, and a thread found wider gets nothing further and loses its copy. Both paths now share the prompt's
  context (`buildPrContext`: compacted diff, SENSITIVE notices, changed files read from the copy the thread has) and the
  comment's footer (`formatReviewComment`), and the watcher applies the same key refusal (`looksSecret`, held secrets)
  before posting. *Why:* #105's second review showed the boundary was a read-back rather than a folder — the thread
  started on the pull request's own tree, and its answer was posted unchecked — and that a machine review was missing
  #104's bounds entirely. *Trade-off:* `t3 thread start` takes no token limit, so the comment says `Cap: none on this
  path` and the bound is the same `timeout_s` the GitHub job uses. (#71, #105)

- **D-79 · 15 Nov 2026 · Owner** — The reviewer's copy gets an **object store of its own**. D-78 built the stripped
  commit in the watcher's clone, and a worktree of it shares that clone's object store, so `git show <sha>:AGENTS.md`
  answered from inside the thread's folder — the removed instructions were one command away. Now a pull request's head
  is fetched into a scratch bare repository under the state directory, the filtered tree is archived out of it and
  written into the project as one branch with one commit, and the scratch repository is deleted before a thread exists.
  The reviewed commit is then in no object store the reviewer's git can reach, and `git cat-file -e <sha>` fails in the
  worktree as well as in the project. The copy is deleted with the review — worktree, branch, and a `gc --prune=now`
  behind them — so nothing of one review is readable from the next. A thread's copy is also waited for: `t3 thread
  start` returns while the worktree is still being written, and the changed files are read from it, so the review is
  held until the index matches `HEAD`'s tree and refused with a comment after `copyWaitMs`. *Why:* the re-check at
  `6fec684` printed `AGENTS.md` from the worktree through the shared store, and found the changed-files section missing
  whenever the checkout had not finished. *Trade-off:* the project's object store still holds the repo's own `main` (it
  is the checkout the watcher keeps current), so the copy can see the public history — never the reviewed commit. A
  temporary T3 project per review was rejected: a new project gets the environment's default runtime mode, not the
  `approval-required` the gate needs, and `t3 project add` cannot set one. (#71, #105)
- **D-80 · 15 Nov 2026 · Agent** — One privacy filter for every report path is a function copied byte for byte, not a new
  installed file: `installer/redact.sh` holds `tess_redact`, the installer's failure report, the doctor's report and the
  rescue report each carry that same function, and `tools/check-safety.sh` fails if any copy drifts. It removes the home
  folder of every account on the Mac, this account's short name where no letter touches it, this Mac's computer and local
  host names, and email addresses.
  *Why:* every installed script is standalone and may run when the others are broken, so a shared file would either be a
  new signed part the rescue line cannot rely on or a thing that silently goes missing. The gate removes the real
  problem: the installer leaked the account name while the doctor removed it (SEC-10), because the two were written
  separately. *Revisit* if the filter ever needs to change between report paths, which it must not.
- **D-81 · 15 Nov 2026 · Agent** — Tess takes ownership of a Spotify bundle only after macOS confirms it is Spotify's own
  app: `CFBundleIdentifier` is `com.spotify.client`, `codesign --verify --strict` passes, `spctl` accepts it, and
  `codesign --verify --strict --ignore-resources -R=…` tests a code requirement — `anchor apple generic and certificate
  leaf[subject.OU] = "2FNC3A47ZF"` — against the signature itself, never a line read out of `codesign -dvvv` output. The
  path is canonicalised first, and a canonical path holding a control character (a newline, a CR, a tab) is refused
  before any of those checks. Otherwise the install stops and says to reinstall Spotify from Spotify.
  *Why:* `sudo chown -R` on a path chosen from a running process's name, with no signature check, was a root-owned
  recursive write on an attacker-influencable folder (SEC-09). `codesign -dvvv` also prints `Executable=<path>`, so a
  bundle whose folder name carries a newline — reached through a clean-looking symlink that `pwd -P` resolves — put a
  forged `TeamIdentifier=` line into that output: a text search accepted a team that is not Spotify's, and `spctl`
  accepts any notarized app. A requirement is evaluated by codesign against the certificate, so no text in a path can
  stand in for it. Resources are skipped in the requirement call only because the seal is checked on the line before and
  Tess itself rewrites Spotify's interface files. *Trade-off:* a Spotify copied out of a DMG by hand now stops here
  rather than being silently taken over — which matches the app-management and DMG warnings elsewhere.
- **D-82 · 15 Nov 2026 · Agent** — A rescue order may carry `timeout <seconds>` (60-3600, 1800 by default), is stopped at
  its limit with the limit in the log, and reports only the lines it wrote through the shared filter. The action runs in
  a process group of its own, and the limit stops the whole group — TERM, a ten-second grace period, then KILL — so
  nothing the order started outlives it, and the stop is logged only after the group is gone.
  *Why:* a fixed 15-minute kill could interrupt a real repair silently, and the old upload sent the whole log tail with
  only the home folder removed (SEC-16). Killing the one pid that was started stopped the action's shell and left its
  children — the patcher, `ditto`, `curl` — running and reparented, while the log said the order had stopped and the
  rescue plist's `AbandonProcessGroup` meant launchd would not reap them either. `/bin/sh` turns job control on for the
  action because zsh refuses `set -m` in a script and the rescue script's own group must not be the one that is killed.
  *Trade-off:* an order that genuinely needs longer than an hour cannot ask for it; the next order can, and an order whose
  child ignores TERM takes the grace period before it is killed.
- **D-83 · 15 Nov 2026 · Agent** — The inbox refuses health reports when `SALT` is missing or shorter than 16 characters,
  measures the body in bytes, counts every limit with one statement, and stores no character a terminal would hide: C0
  and C1 controls, bidi overrides and marks, zero-width characters and the byte-order mark are removed on write, and
  again when `tools/reports.mjs` prints them.
  *Why:* an unset salt made the stored per-IP keys a plain hash of an IPv4 address (SEC-11), the character-counted body
  limit allowed a four-times-larger stored report (SEC-14), and check-then-act counters could be overshot by concurrent
  requests. Anyone can post a report, and a bidi override in one can reorder the line so a path reads as a different
  path in the owner's terminal. *Trade-off:* a deployment without the secret loses reports instead of storing weak data,
  which is the way a privacy control should fail.
- **D-84 · 15 Nov 2026 · Agent** — `tess-patcher can-write` moved into `src/cmd` as `CanWrite`, and probes with
  `os.CreateTemp` (exclusive, random name) instead of a predictable `.tess-can-write` opened with `O_TRUNC`.
  *Why:* a planted link at the known name was followed and truncated inside Spotify's bundle (SEC-20), and a Go test for
  it could not live in `package main` — that package's `init()` exits before any test runs, and does so on a real Mac's
  config. *Trade-off:* one more file in `src/cmd`, and the command is now reachable from a package that already has
  tests.
- **D-85 · 15 Nov 2026 · Agent** — Every script that can act on a Mac (`install.sh`, `tess-install.sh`, `updater.sh`,
  `doctor.sh`, `rescue.sh`, `uninstall.sh`, `wake.sh`, `tess-command.sh`) carries the same guard block at the top.
  Sourcing one does nothing and says why; handing its text to a shell (`sh -c "$(cat …)"`, zsh `eval`) exits the same
  way, because then the file is not what runs and its own checks cannot see it; outside `TESS_TEST=1`, a copy
  inside a git checkout or worktree (a `.git` folder or file above it) also exits unless `TESS_REAL_INSTALL` is exactly
  `1` (`0` and `false` mean off to a person and must not open it). *Why:* an agent testing one function ran
  `sh -c '. installer/tess-install.sh; …'`, which ran the real installer on the owner's Mac from the stable channel with
  no sandbox (#107). A checkout's copy must not be able to act at all outside a sandbox. *Not affected:* the installed
  copies (not checkout files), the published install line (`curl … | sh` names no file, so it is code from a pipe), the
  sandbox tests (`TESS_TEST=1`), and `installer/redact.sh`, which is a library and stays sourceable. The
  handed-to-a-shell refusal reads the shell's own state (`ZSH_EVAL_CONTEXT` on zsh, `$-` and `ps -o args=` on sh/bash),
  never the script's text, so the piped install line (whose shell has no `-c` and no file) is untouched. zsh marks an eval at any depth (`eval`, `cmdarg:eval`, `toplevel:eval`), so every eval there is refused. *Known limit:* `/bin/sh` and bash set no flag for `eval`, so `eval "$(cat installer/…)"` from an sh or bash script outside a checkout is indistinguishable from the piped install line and is not refused; AGENTS.md rule 2 forbids it, and the gate's own tests run the scripts only through the sandbox. Detection
  walks up for a `.git` entry instead of asking `git`, because a user's Mac may have no developer tools, and stops at
  the home folder so a dotfiles repository in `~` is not mistaken for a checkout. *Trade-off:* a deliberate real run
  from a checkout needs one environment variable, and the block is copied into every script (the gate compares the
  copies byte for byte, and `tools/test-script-guards.mjs` proves the behaviour) rather than living in one library,
  because each installed script has to stand alone.
- **D-86 · 15 Nov 2026 · Agent** — The folder swap runs inside the signed patcher, as `tess-patcher swap-apps <Apps>
  <staged>`, and the scripts call it instead of copying with `ditto` and renaming with `mv`. It does what `apply`
  already does — copy beside `Apps`, check `xpui.spa`/`xpui/index.html`, two renames, restore the original on any
  failure or after an interrupted run — but relative to a folder held open, not to a path: the check resolves
  `Contents/Resources` once and validates it (separator-bounded, still `Contents/Resources` after its symlinks are
  resolved, so `/var` may stand for `/private/var` but a symlinked `Resources` is refused, and the bundle's
  `CFBundleIdentifier` must be `com.spotify.client`), and it opens as it validates — the bundle from `/` with
  `O_NOFOLLOW`, `Contents` and then `Resources` relative to it, with `Info.plist` read through that same `Contents`
  descriptor and the folder's device and inode recorded before the plist is parsed. Every create, rename and delete of
  `Apps`, `.tess-new` and `.tess-old`, the copy itself and the recovery of an interrupted run are `…at` calls on that
  descriptor (`swapAppsAt`). The folder is compared with what the path names before the first write and again before
  each rename, and a folder that no longer matches stops the swap with the original left in place. It takes no config
  (so it never rewrites `config-xpui.ini`) and reports macOS's block as exit 3 as `can-write` does. The bundle's
  `CFBundleIdentifier` is read out of those bytes and never out of a path an outside tool opens again: a binary plist
  goes to `plutil` on stdin, where a second process cannot reach it.
  *Why:* macOS App Management denied `/usr/bin/ditto`, attributed to `/bin/zsh` because launchd starts the helper that
  way, so every background theme update failed while Spotify was left intact (16:36 on 15 Nov, #108). The signed
  patcher has its own approval, so the same copy is allowed there. A shell fallback was removed rather than kept: it
  is the path that cannot work in the background, and two swap implementations were already one place to drift. The
  path check started as a plain string ending, which let `…/NotContents/Resources/Apps` and a symlinked `Resources`
  rename another folder aside and then delete it (#110 review). A path that is checked and then used again is not the
  same folder either: with `Resources` moved aside and a symlink left in its place during the copy, the path version
  finished writing through the link, renamed that folder's `Apps` aside, deleted it, and exited 0 (measured). A
  descriptor cannot be redirected, so the swap keeps writing where it started and the re-check notices. Opening the
  descriptor after the check was still a check-then-use: with the plist read blocked and a *real* directory — not a
  symlink, so `O_NOFOLLOW` sees nothing — moved into the `Resources` name, the swap took that folder's inode as its
  own, replaced its `Apps`, deleted its `keep-me` and exited 0 while the folder that was validated was untouched
  (measured). So `Resources` is opened and recorded before the plist read, and the path is compared with it again when
  the read returns; a swap of `Resources` or of `Contents` in that window now aborts before the first write, which
  `TestSwapAppsAbortsWhenFolderReplacedDuringPlistRead` proves for both. The same review found
  `tools/check-safety.sh` blind to `rm -rf "$APPS/xpui"` and `ditto "$1" "${APPS}"`; it now fails any statement whose
  write verb names the folder, in any quoting and with any path after it, and allows only a copy whose source is the
  folder and whose later arguments do not name it — `ditto "$APPS" "$APPS/xpui"` writes the live interface in place
  and fails the gate. The same pass had two more holes, both found by the next review. The plist was written into a
  temporary file that `PlistBuddy` was pointed at, so a second process on the same account could replace that file with
  a Spotify plist while the check ran: a bundle whose own plist says `com.example.other` was swapped, its `keep-me`
  deleted and the command exited 0 (measured, 6 of 12 runs); `plutil` on stdin has no name to replace
  (`TestSwapAppsIgnoresReplacedTempPlist` rewrites any `tess-plist*` it can find during the check, for eight runs, and
  none is ever written). And the gate's word match started at `$APPS`, so a slash glued in front of the quotes
  (`/"$APPS"`, which the shell expands to the same folder) hid the destination — `ditto "$APPS/xpui" /"$APPS"` rewrote
  the live `xpui.spa` in a probe. Each argument is now stripped of a leading `/`, repeated slashes and `./` before it
  is matched, so the slashes cannot hide a write. Re-check 5 then found three holes left by reading one physical line
  and asking awk for the character before a verb. That character does not exist at column 0, and BSD awk answers with
  the verb's own first letter, so `installer/tess-install.sh:396` — a `ditto` at column 0 — was never looked at; a
  trailing backslash ended the check at the verb while the folder sat on the next line; and a redirect's path was
  trimmed after only one quote, so `printf x >/"$APPS/x"` kept its slash. The gate now joins backslash-continued lines
  into one logical line and remembers the line it started on, normalises that line once — quotes off, `${APPS}` to
  `$APPS`, `//` to `/`, a leading `/` or `./` dropped in front of a variable and after `>`, `>>`, `>|` or `>&` — and
  matches by token position, where the start of a line is an ordinary word boundary and position 1 needs no character
  before it. That reads the same on BSD and GNU awk. The 63 fixtures now include column 0, a joined copy, move, delete
  and redirect, and the column-0 read out at line 396, which stays allowed.
  *Trade-off:* the updater can no longer restore a theme if the patcher itself is missing; Spotify then stays exactly
  as it was, which is the required failure. The test bundles must now carry an `Info.plist` that names Spotify, so a
  sandbox has to be shaped like a real app bundle. The swap is macOS-shaped (`golang.org/x/sys/unix`), so the swap-apps
  command refuses on anything else rather than falling back to a path. `apply` and `backup` keep the path-based swap,
  where the folder comes from the user's own Spicetify config. `tools/test-swap-recovery.mjs` builds the real binary,
  kills it during the copy and between the renames, and proves the next run restores Spotify's folder.
- **D-87 · 18 Nov 2026 · Agent** — Extend `tools/check-safety.sh` (follow-up to D-86) to refuse five rare ways of
  writing into `$APPS`/`$A0`: verbs glued to `(`, `$(`, or backticks (splitting on `(`, `)`, and `` ` `` while placing
  a `$APPS` placeholder when a skipped nested word names the folder, so `ditto "$APPS" "$(dirname "$APPS")/Apps.bak"`
  and `rm -rf "$(dirname "$APPS")"` are caught while nested reads like `out=$(ditto "$APPS" "$TMP/a")` stay allowed,
  and quoted/unbalanced `(` cannot hide trailing words); `dd` with `of="$APPS/..."`; `find "$APPS"` with `-delete`,
  `-fprint`/`-fprint0`/`-fprintf`/`-fls` naming the folder, or `-exec`/`-execdir`/`-ok`/`-okdir` scanning every word up
  to `\;` or `+` for a write verb or shell (keeping escaped `\;`/`\(` intact so trailing `-delete` is not cut off);
  `tar` extracting into `-C "$APPS"`, `--dir*="$APPS"`, or `--cd="$APPS"` (parsing old-style letter groups in order,
  glued `-f`/`-C` values like getopt, and flagging unconsumed extract words) or creating/mutating an archive
  `-f "$APPS/..."` (while allowing `-c`/`-t` reads such as `tar -czf "$TMP/bak.tgz" -C "$APPS" .`); and zsh `>!` / `>|`
  or `$(…)`/backtick redirects naming the folder.
  *Why:* Grok 4.7's sixth re-check on #110 and the Opus re-checks on #114 showed each of these bypassed the tokeniser or
  verb checks on a fake folder, and POSIX/BSD+GNU awk keeps the gate runnable on both macOS and Linux CI. *Trade-off:*
  `tar` and `find` flag parsing lives in awk rather than a full shell parser, so unmodelled flag combinations,
  non-letter old-style `tar` flags, or nested `$(…)` inside redirects (which stop at the first `)`) can either be
  conservative or slip past; reads out of `$APPS` remain covered by must-pass fixtures. The gate deliberately does not
  check writes through a variable, through another working directory, or through `xargs`. (#111)

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

- **D-88 · 14 Nov 2026 · Agent** — PR #75 review fixes (#53): ship the Tess command as an optional signed `command` part so the
  updater reaches existing Macs. Older channels can omit installer, uninstall, wake and command parts. Rescue off
  disables the launchd job and removes its login plist; ordinary updates preserve the independent rescue verifier.
  Part rollback requires a healthy doctor baseline so unrelated existing failures cannot ban good parts. Wake
  remembers the last rescue serial it triggered, including rejected or expired orders.

- **D-89 · 14 Nov 2026 · Agent** — PR #75 sixth review (#53): the wake check reads the release and the rescue order separately, and skips the rescue read when the line is off. A repair names an older rescue script as able to run scripts. `tess status` says when that agent is still loaded after off, and the doctor unloads it and removes its login plist.
- **D-90 · 14 Nov 2026 · Agent** — PR #75 seventh review (#53): docs name the pre-13 Nov rescue scripts, which updates never replace and which can run a signed script. Existing Macs are not shown a new notice unless they repair or reinstall. #53's check is the install notice, the README, and SECURITY.md. That older format is the owner's Mac and one other (D-62); they see the plain wording the next time they repair. An unsolicited notice on every Mac is not part of this change. A sandbox calls launchctl only when a fake one is first on PATH, because the job label is the owner's real job. *(Overruled by D-93.)*
- **D-91 · 14 Nov 2026 · Agent** — PR #75 eighth review (#53): when the doctor part itself changes, the updater takes a new health baseline from that doctor instead of judging it by the previous one. `tess status` says the rescue line is not installed when its verifier is missing, and names an older script that can run any script. The doctor removes a leftover rescue login file even when that job is not loaded. An update does not add a rescue line on a Mac whose install notice said the line was not there.
- **D-92 · 14 Nov 2026 · Agent** — PR #75 second review (#53, #71): older channels retain the running installer and a built-in
  uninstaller when signed parts are absent, without claiming signed-part hashes. Rescue on creates its own plist
  and requires adoption success; wording permits an unexpired order sent while off because old rescue scripts
  cannot report adoption failure reliably. Reinstall and uninstall clear launchd's persistent rescue disable.
  Theme refresh runs with a copied config against staged Spotify files to preserve generated colors before swap.
- **D-93 · 14 Nov 2026 · Owner** — An existing Mac is told about the rescue line **once, after its next update**.
  The owner's words: "the rescue notice seems unnecessary as well but sure, just have it pop up".
  The Macs that get it are the ones where `rescue.sh` is present and `state/rescue-notice-shown` is not: the line is
  there, and the person was never told. The update shows the notice once as a macOS notification, the same `notify()`
  the updater already uses (`osascript display notification`). A test run skips that popup and leaves
  `state/rescue-notice-pending`. `tess status` prints the same notice if it has not been seen, and either showing
  records `rescue-notice-shown`. An older script, one without the `tess-rescue 2` marker, gets the wording the installer
  already uses for that script: a signed order can run any script. (#91)
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
- **15 Nov 2026 · Review token cap & footer fix (#103)** — PR #76's Codex `gpt-6.1-sol` review spent 779,470 tokens
  (777,093 in, 2,377 out) because raw `gh pr diff 76` was 693 KB (~578 KB in vendored/sourcemap files under
  `patcher/prebuilt/`), no changed-file contents were supplied inline so the reviewer spent extra turns reading files,
  and `model_auto_compact_token_limit=180000` only compacts per-turn context rather than session total tokens. PR prompts
  now compact the diff (omitting vendored/generated/map/lockfile diffs, capping at 16 KB/file and 64 KB total), inline
  changed files/hunk excerpts (up to 16 KB/file and 64 KB total), and direct the reviewer to start there while keeping
  the snapshot read-only if external callers need checking. Codex reviews lower `model_auto_compact_token_limit` to
  `64000`, enable `features.rollout_budget` (`limit_tokens=200000`, `enforce_limit=true`,
  `reminder_at_remaining_tokens=[50000]`), and stream `--json` lines so any review exceeding `caps.codex.max_tokens`
  (200,000) is killed immediately and refused with a comment. Expected per-review usage drops to ~25k–100k tokens
  (~1–4% of a 5-hour window typical, 7% ceiling on `sol`). Comment formatting now separates `Used:` and `Usage:` with a
  newline and strips any standalone `Verdict:` line regardless of trailing punctuation/markdown so exactly one verdict
  line is posted. (#103)
- **D-94 · 18 Nov 2026 · Agent** — The six reviewer follow-ups from #75 (#91), each with the reason it exists: `tess rescue
  on` while offline leaves an already-on line on, because adoption reads a live order and a person asking for "on" again
  is not asking to switch their working line off. `tess rescue off` stops an order that has already started: the running
  group and the time it started are written to `Tess/rescue/order.pid`, and `off` writes `off` to the order's stop file
  before it TERMs then KILLs the group, and only when the number still leads its own group, the start time still matches,
  and its command is one of Tess's (`AbandonProcessGroup` would otherwise leave it changing Spotify after the
  person said stop). The stop file is how the log and the report say `rescue off` stopped the order. The wake check reads the rescue branch only when the verifier is installed as well as on, so a Mac
  that never had the line makes one request every five minutes, not two. `tess status` says the job is **loaded** and
  separately whether an order is running now, because "running" was being read as the job rather than the order. The
  signed parts list writes the installer and uninstaller before the command, since a Mac gaining all three in one update
  must never hold a command that points at nothing. The installer's inherited copy of the command is compared with
  `tess-command.sh` byte for byte, because those older channels run the copy and not the signed part.
