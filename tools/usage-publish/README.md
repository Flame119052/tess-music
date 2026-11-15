# Usage snapshots: what is left, from whichever machine is awake

The reviewer picks a model by what is left. Until now it could only read the usage hub on the machine that runs the
review, so a runner knew nothing about the Mac's Claude window or Codex's week. Each of Krish's machines now publishes
a small, quota-only snapshot every 5 minutes, and the reviewer uses the freshest one.

**Publishing is not installing.** These files are the script and the scheduling. Installing the timer on a machine is a
separate step Krish approves; nothing here is installed by a merge.

## What a snapshot holds

Only numbers a quota is made of, and nothing else:

| Field | Meaning |
| --- | --- |
| `machine` | `mac`, `vps` or `omarchy` |
| `takenAt` | when this machine read its own hub |
| `providers[].provider`, `.instance` | `claude`, `codex`, `cursor`, `opencode`; for OpenCode the connector (`opencode-go`, `zai-coding-plan`) because each has its own allowance |
| `windows[].kind` | `session` (5-hour), `weekly`, `monthly`, `other` |
| `windows[].leftPercent` | the share **left**, the way the hub prints it |
| `windows[].resetsAt` | when that window renews |
| `windows[].pace` | the hub's own sentence, e.g. `22.8pp ahead of even burn, runs out in ~7h 22m` |

No keys, no account names, no balances, and no plan names. Providers a reviewer cannot be (Devin, DeepSeek,
Antigravity, …) are left out entirely, and the publisher refuses to publish anything that looks like a credential or
holds no windows.

One repository Actions variable per machine: `USAGE_SNAPSHOT_MAC`, `USAGE_SNAPSHOT_VPS`, `USAGE_SNAPSHOT_OMARCHY`. The
agent-review workflow passes all three to the review job. A snapshot older than **30 minutes** is ignored, so a sleeping
Mac falls back to the runner's own hub instead of an hour-old number; an empty or missing variable is the same.

## What a machine needs

1. **`tess-usage`** at `~/.local/bin/tess-usage` (already there on all three machines).
2. **Node** (the hub is Node).
3. **A GitHub token that may write this repository's variables, and nothing else.** A fine-grained token for
   `Flame119052/tess-music` with **Variables: Read and write** is enough. Sign `gh` in with it as the account that owns
   `~/.local/bin/tess-usage`:

   ```sh
   gh auth login --with-token < ~/.config/tess-usage-publish/token
   chmod 600 ~/.config/tess-usage-publish/token
   ```

   Or keep `GH_TOKEN` in a file only that account can read and let the timer load it. Never put the token in the
   repository, in a shell history, or in the timer file.
4. **The publisher**, copied from this folder to `~/.local/bin/tess-usage-publish` (`chmod 700`). When this file changes
   on `main`, copy it again.

Try it by hand first. It prints the snapshot and sets nothing:

```sh
node publish.mjs --machine mac --dry-run
```

Then the real thing (one line on stderr, no quota, and a new variable in the repository):

```sh
tess-usage-publish --machine vps
```

## macOS: a LaunchAgent

```sh
cp tools/usage-publish/publish.mjs ~/.local/bin/tess-usage-publish
chmod 700 ~/.local/bin/tess-usage-publish
sed "s#/Users/REPLACE_ME#$HOME#" tools/usage-publish/music.tess.usage-publish.plist \
  > ~/Library/LaunchAgents/music.tess.usage-publish.plist
launchctl bootout "gui/$(id -u)/music.tess.usage-publish" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/music.tess.usage-publish.plist
```

It runs every 5 minutes and once at login. `launchctl print "gui/$(id -u)/music.tess.usage-publish"` shows its last
exit status, and `~/Library/Logs/tess-usage-publish.log` holds the one summary line per run. To stop it:
`launchctl bootout "gui/$(id -u)/music.tess.usage-publish"`.

## Linux: a user timer

Nothing is installed system-wide, and no `sudo` is needed. On a machine where the account with `tess-usage` is not the
one you log in as, run this as that account (on the VPS today that is `root`, whose user manager is still not a
system-wide unit).

```sh
mkdir -p ~/.config/systemd/user ~/.local/bin
cp tools/usage-publish/publish.mjs ~/.local/bin/tess-usage-publish
chmod 700 ~/.local/bin/tess-usage-publish
cp tools/usage-publish/tess-usage-publish.service tools/usage-publish/tess-usage-publish.timer ~/.config/systemd/user/
sed -i 's/--machine vps/--machine omarchy/' ~/.config/systemd/user/tess-usage-publish.service   # on omarchy
systemctl --user daemon-reload
systemctl --user enable --now tess-usage-publish.timer
```

`systemctl --user list-timers tess-usage-publish` shows when it runs next, and `journalctl --user -u
tess-usage-publish -n 5` shows the last summary lines. On the VPS the unit is at the lowest CPU, disk and memory
priority the kernel offers, so Paperclip always wins; if the publish is squeezed it simply runs a few minutes later.
Keeping the timer alive after logout needs `loginctl enable-linger` for that account, which is an owner choice.

To stop it: `systemctl --user disable --now tess-usage-publish.timer`.

## Why it is safe to publish

- The snapshot is derived only from what `tess-usage` prints, and the parser keeps numbers, reset times and pace text.
  Anything else in a line is dropped.
- A second guard refuses to publish a snapshot whose text matches a key or token shape, an empty snapshot, or one over
  40 KB (a repository variable's practical limit).
- The token can write repository variables for this repository only. It cannot read the repo, run a workflow, or reach
  a provider. Nothing on a reviewer machine holds it: the runners read the variables GitHub already passes them.
- The reviewer never hands these values to a model CLI: `reviewerEnv` in `tools/agent-review.mjs` allows only HOME,
  PATH and that provider's own key.

## Adding or removing a machine

Add the variable (`USAGE_SNAPSHOT_<NAME>`), one line to `snapshotVariables` in `tools/agent-review.mjs`, and one line to
the `env:` block of the `review` job in `.github/workflows/agent-review.yml`. Removing a machine is deleting those three
lines; its variable can stay, because nothing reads it.
