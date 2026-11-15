---
name: tess-gather
description: "Collecting the machine facts for a Tess report: the doctor report, Tess and Spotify versions, macOS, Mac type, tess status and the last lines of the update log — all through the scrubber. Use before triage, once the person is willing to run one command."
version: 1.0.0
author: Tess Music
license: MIT
metadata:
  hermes:
    tags: [tess, support, doctor, versions]
---

# Gather the facts

Six things, and you ask for them **one message at a time**. A wall of commands is how people give up.

## The one command

```
tess report
```

Say what it is first: Tess's own check-up, which prints what's wrong and sends the same anonymous summary it already
sends after updates. **They** run it; you never touch their Mac.

If `tess` isn't a command on their machine, the same thing by hand:

```
zsh "$HOME/Library/Application Support/Tess/doctor.sh" --report
```

## The rest, one at a time

| What | How | Why it matters |
| --- | --- | --- |
| Tess version | Tess Settings, bottom of the panel: `Tess 0.1.9 · Stable updates` | decides whether a fix is already in |
| Spotify version | in the report's own `Tess is in Spotify …` line | Spotify updates break the patcher |
| macOS version | Apple menu → About This Mac | App Management differs across 13, 14, 15 |
| Mac type | same window: Apple silicon or Intel | a whole class of bugs is Intel-only |
| `tess status` | paste it | what the helper thinks it is doing |
| Last update-log lines | see below | the only place a real error appears |

The update log, only if the report shows nothing useful:

```
tail -40 "$HOME/Library/Application Support/Tess/guard.log"
```

If they'd rather not, that's fine — a report with the doctor output and their words is still worth sending. Say what's
missing in the report instead of guessing.

## Everything goes through the scrubber

The doctor already replaces the home folder, the account name, the computer name and emails. The triage step does it
again, because people paste things the doctor never saw. **Do not add anything back by hand**, and do not paste raw
output into a message to Krish — send the report, which is scrubbed, not the transcript.

## Never

- Never ask for a password, a screen share, remote access, or any command other than the two above.
- Never invent a version. `unknown` is a real answer and a better one than a guess.
- Never re-run the doctor "to be sure" more than once; it is their Mac and their time.
