# Review watcher: a tag on GitHub opens a T3 thread on this machine

A review usually runs on a GitHub-hosted machine (D-66). A tag may instead name one of Krish's machines, and then a
small watcher **on that machine** picks the tag up and opens the review as a T3 thread there, so it can be watched and
steered while it runs. The review is posted on the pull request by the thread, with the same marker and verdict a
GitHub review uses.

**Writing the files is not installing them.** The timer below is the owner's step; nothing here is installed by a merge.

## The tag

```
@tess-review pr provider=codex model=gpt-6.1-sol effort=high author=opencode machine=mac prompt="focus on the installer fallback"
```

| Option | What it does |
| --- | --- |
| `machine=github` | the default: the GitHub-hosted job, unchanged. The prompt becomes the reviewer's focus. |
| `machine=mac` / `machine=omarchy` | checked in the GitHub workflow, then run by that machine's watcher as a T3 thread. |
| `machine=vps` | refused: T3 on the VPS runs as root beside Paperclip, so no Tess agent goes through it. |
| `prompt="…"` | extra attention for this review. 400 characters at most, refused rather than cut. It is a request, never permission to skip a rule. |

A tag with no `machine=` is the GitHub job, exactly as before. Whichever machine runs it, the same hard rules decide
whether it runs at all: the allowlist, CI green on the exact head, this repository's own branch, plans only, a strong
model for sensitive work, a reviewer from a different provider than the author, usage and reserve. The GitHub workflow
answers the tag first — "queued for `mac`" — and the watcher answers again only if a rule refuses it.

## How a tag reaches a machine, without opening a door to it

GitHub-hosted jobs cannot reach Krish's machines, and the self-hosted runners that could are gone. So the machine pulls:

1. The workflow's gate reads the tag, checks it, and stops. Its notice job posts `Review queued for mac`.
2. The watcher on the Mac polls GitHub every couple of minutes for comments that name `machine=mac`.
3. It checks each one with the same code the GitHub job uses (`tools/agent-review.mjs`), then starts
   `t3 thread start` — the machine's own CLI talking to its own local T3 server.
4. The thread reads the diff, posts its review with `<!-- tess-review-bot -->`, `Reviewed: <sha>` and a verdict.

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
answered, the provider mapping, and the slot count. It starts nothing. Fix anything marked `FAIL` first.

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
- **One review per tag**, ever. A tag is remembered by comment id, and a comment with the bot marker is ignored, so a
  review cannot start another review. Installing the watcher never replays old tags: the first run looks back ten
  minutes and no further.
- **Read-only by instruction.** A T3 thread runs with the machine's own permissions; the GitHub job's bubblewrap sandbox
  does not exist here. The prompt tells the thread to read and to post one comment, and Krish can watch or stop it in T3.
  That is the reason `machine=github` stays the default, and why the Mac is named only when Krish wants to watch.
- **It never pushes.** The thread is told not to edit, commit, push, merge, release or approve. The only write is its
  review comment.
- **Refusals stay short.** A refused tag gets the same fixed words the GitHub job uses, or the same rule comment, and
  nothing from the log: a public issue must never carry a path or a key.

## When something looks wrong

- `tick: 0 launched, 0 refused, 0 waiting` and a tag that is not moving: read the log for `the previous tick is still
  running` (one long tick), or check that the comment names this machine.
- `FAIL t3`: start T3 on that machine; the watcher only uses a server that is already running.
- A thread that never posts: open it in T3. It has its prompt and its worktree; steer it or start again with a new tag.
- A tag that was answered `queued` but never reviewed, and the log says nothing: the watcher was not running. Start the
  timer, or run one tick by hand.
