# Review watcher: a tag on GitHub opens a T3 thread on this machine

A review usually runs on a GitHub-hosted machine (D-66). A tag may instead name one of Krish's machines, and then a
small watcher **on that machine** picks the tag up and opens the review as a T3 thread there, so it can be watched and
steered while it runs. The thread answers with its review as its last message; **the watcher posts it**, with the same
marker and verdict a GitHub review uses. The thread itself never comments, pushes or merges anything.

**Writing the files is not installing them.** The timer below is the owner's step; nothing here is installed by a merge.

## The tag

```
@tess-review pr provider=codex model=gpt-6.1-sol effort=high author=opencode
@tess-review pr provider=opencode model=opencode-go/deepseek-v4.1-flash author=codex machine=mac prompt="focus on the installer fallback"
```

The first runs on GitHub, where `effort=` is passed to the reviewer's own CLI. The second runs on this Mac, so it leaves
`effort=` out (see the table).

| Option | What it does |
| --- | --- |
| `machine=github` | the default: the GitHub-hosted job, unchanged. The prompt becomes the reviewer's focus. |
| `machine=mac` / `machine=omarchy` | checked in the GitHub workflow, then run by that machine's watcher as a T3 thread. |
| `machine=vps` | refused: T3 on the VPS runs as root beside Paperclip, so no Tess agent goes through it. |
| `prompt="…"` | extra attention for this review. 400 characters at most, refused rather than cut. It is a request, never permission to skip a rule. |
| `effort=…` | **refused** for `machine=mac` and `machine=omarchy`: `t3 thread start` takes a provider and a model, with nowhere to put an effort, and a review must not run at an effort nobody chose. Leave it out there, or name the model that already means it. |

A tag with no `machine=` is the GitHub job, exactly as before. Whichever machine runs it, the same hard rules decide
whether it runs at all: the allowlist, CI green on the exact head, this repository's own branch, plans only, a strong
model for sensitive work, a reviewer from a different provider than the author, usage and reserve. The GitHub workflow
answers the tag first — "queued for `mac`" — and the watcher answers again only if a rule refuses it.

## How a tag reaches a machine, without opening a door to it

GitHub-hosted jobs cannot reach Krish's machines, and the self-hosted runners that could are gone. So the machine pulls:

1. The workflow's gate reads the tag, checks it, and stops. Its notice job posts `Review queued for mac`.
2. The watcher on the Mac polls GitHub every couple of minutes for comments that name `machine=mac`.
3. It checks each one with the same code the GitHub job uses (`tools/agent-review.mjs`), then starts
   `t3 thread start` — the machine's own CLI talking to its own local T3 server — with a fixed first message that
   contains nothing from the pull request.
4. It reads the new thread's runtime mode back from T3. Only if that is `approval-required` does it send the review
   (diff, issue, focus) to the same thread. A project left wider is refused, and the pull request is told why.
5. The thread answers with the review as its last message. The watcher checks the shape and posts it with its own `gh`,
   after confirming the pull request still points at the commit the review read.

Nothing is exposed inbound, and no T3 credential is stored on GitHub: the thread is started by the machine's own command,
using the sign-ins it already has. The watcher holds no key of its own.

## What a machine needs

1. **Node 22 or newer**, and `gh` signed in as an account that can comment on `Flame119052/tess-music` and read its
   `AGENT_ALLOWLIST` repository variable. It uses the sign-in this machine already has; there is no token file.
2. **T3 Code** running on that machine. The watcher does not start it.
3. **Its own clone of the repository**, which is also the T3 project the review threads belong to. It keeps itself on
   `main`, so the rules it runs are the rules on `main`:

   ```sh
   git clone https://github.com/Flame119052/tess-music ~/.local/share/tess-review-watch/src
   t3 project add ~/.local/share/tess-review-watch/src    # name it "Tess reviews"
   ```

   Then set **that project's default runtime mode to `approval-required`** in T3 (project settings → runtime mode). This
   is the boundary the watcher enforces, not a preference: every review thread inherits the project's mode, the watcher
   reads the mode back from T3 before sending anything, and a thread at any wider mode is refused. Nothing else in this
   folder is reviewed, and no other T3 project is used.

4. **One config file**, mode 600:

   ```sh
   mkdir -p ~/.config/tess-review-watch
   printf '{\n  "machine": "mac"\n}\n' > ~/.config/tess-review-watch/config.json
   chmod 600 ~/.config/tess-review-watch/config.json
   ```

   On omarchy use `"machine": "omarchy"`. Nothing on the VPS: it is refused on purpose. Other optional keys:
   `repoPath`, `stateDir`, `slots`, `slotWaitMs`, `slotStaleMs`, `providers` (the T3 provider instance per provider, if
   T3 renames one), and `allowlist` as a fallback for a token that cannot read the repository variable.

## Check it before scheduling it

```sh
cd ~/.local/share/tess-review-watch/src
node tools/review-watch/watch.mjs check
```

It prints the machine, the repository, the checkout, the rules file, the allowlist it read, whether the local T3 server
answered, the runtime mode a review must run at, the provider mapping, and the slot count. It starts nothing. Fix
anything marked `FAIL` first.

One tick by hand (this is what the timer runs; it is safe to run whenever):

```sh
node tools/review-watch/watch.mjs
```

## Schedule it

**macOS: a LaunchAgent** (every 2 minutes, and once at login):

```sh
sed "s#/Users/REPLACE_ME#$HOME#" tools/review-watch/music.tess.review-watch.plist \
  > ~/Library/LaunchAgents/music.tess.review-watch.plist
launchctl bootout "gui/$(id -u)/music.tess.review-watch" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/music.tess.review-watch.plist
```

`launchctl print "gui/$(id -u)/music.tess.review-watch"` shows the last exit status, and
`~/Library/Logs/tess-review-watch.log` holds one summary line per tick. To stop it:
`launchctl bootout "gui/$(id -u)/music.tess.review-watch"`.

**Linux: a user timer** (no `sudo`, nothing system-wide):

```sh
mkdir -p ~/.config/systemd/user
cp tools/review-watch/tess-review-watch.service tools/review-watch/tess-review-watch.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tess-review-watch.timer
```

`systemctl --user list-timers tess-review-watch` shows the next run, and `journalctl --user -u tess-review-watch -n 20`
the last ticks. To stop it: `systemctl --user disable --now tess-review-watch.timer`.

## What it will and will not do

- **At most two reviews at once** per machine (`slots`). A tag that arrives while both are busy waits its turn; after
  `slotWaitMs` (30 minutes) the watcher answers `every review slot on this machine is busy` and stops waiting.
- **A slot is held for as long as its thread exists**, settled or not. A slot is given back when its review is posted,
  refused or gone — never on a timer while a thread is still there, because that would run more reviews at once than
  the cap allows. A slot whose thread has disappeared is reclaimed after `slotStaleMs`.
- **One review per tag**, ever. A tag is remembered by comment id and by age, and a comment with the bot marker is
  ignored, so a review cannot start another review. Installing the watcher never replays old tags: the first run looks
  back ten minutes and no further.
- **The tag that runs is the tag as it reads now.** Every tag is read again from GitHub the moment it is acted on. A tag
  deleted after it was queued does nothing; a tag edited after it was queued is judged again on its new words rather than
  on the copy saved here.
- **A launch happens once.** The intent, then the thread's id, are written down before and immediately after
  `t3 thread start`, and the thread's title carries the comment id, so a tick that dies half-way adopts the thread it
  already made instead of starting a second one.
- **Nothing a pull request controls reaches a thread that is not read-only.** The first message is fixed words; the
  review (diff, issue, focus) is sent only after T3 reports the thread at `approval-required`. On macOS that means
  Codex gets an OS-level read-only sandbox with no network, and Claude asks before it runs a command.
- **Nothing posts from the thread.** The watcher holds the write; the thread is only read text and a worktree.

### What the boundary is, and what it is not

Enforced, and checked before anything from a pull request arrives:

- the runtime mode T3 itself reported for the thread (wider than `approval-required` → refused, never reviewed);
- the commit reviewed (CI green on it, this repository's own head, unchanged at launch and at posting);
- the allowlist, the author rule, the tier, plans-only, usage and reserve, read from `main`;
- who posts. The thread cannot post, push, merge or release in your name, because it is never given a way to.

Not enforced, and stated plainly: the review thread still runs as the owner's user account. A model with a read-only
sandbox can still *read* a file the owner can read, and nothing here can change that; what stops a leak is that the
sandbox has no network and no writes (Codex), or that a command waits for the owner's approval (Claude). Krish's signing
keys are outside the worktree and outside the review, but they are not behind a second door. That is why this path is
opt-in per tag, `machine=github` stays the default, and a Mac review is watched while it runs.

- **Refusals stay short.** A refused tag gets the same fixed words the GitHub job uses, or the same rule comment, and
  nothing from the log: a public issue must never carry a path or a key.

## When something looks wrong

- `tick: 0 launched, 0 posted, 0 refused, 0 waiting` and a tag that is not moving: read the log for `the previous tick is still
  running` (one long tick), or check that the comment names this machine.
- `FAIL t3`: start T3 on that machine; the watcher only uses a server that is already running.
- `Review not run. Why: this machine cannot run the review read-only yet`: the T3 project is not at `approval-required`.
  Set it (project settings → runtime mode), delete the gate thread if you like, and tag again.
- `Review not run. Why: the review came back in a shape this machine will not post`: open the thread named in the
  comment; it answered with something that was not a review (no marker, no commit, no verdict), so it was dropped rather
  than posted.
- A thread that is still working: open it in T3. It has its prompt and its worktree; steer it or start again with a new
  tag. A thread waiting for an approval is visible there too, and holds its slot until it ends.
- A tag that was answered `queued` but never reviewed, and the log says nothing: the watcher was not running. Start the
  timer, or run one tick by hand.
