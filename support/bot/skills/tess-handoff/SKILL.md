---
name: tess-handoff
description: "The end of a Tess support visit: send exactly one report to the inbox, clean up the session, and tell the person in plain words what happens next. Use as the last step of every visit that produces a report."
version: 1.0.0
author: Tess Music
license: MIT
metadata:
  hermes:
    tags: [tess, support, handoff, inbox]
---

# Hand it over

One report, one message to the person, one message to Krish, and the session folder deleted. In that order.

## 1. Send the report

```sh
SKILLS="${HERMES_HOME:-$HOME/.hermes}/profiles/tess-support/skills"
node "$SKILLS/tess-support/scripts/triage.mjs" … --mode inbox > "$HOME/.hermes/cache/support/payload.json"
curl -fsS -X POST "$TESS_INBOX/v1/support" \
  -H "authorization: Bearer $TESS_SUPPORT_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @"$HOME/.hermes/cache/support/payload.json"
```

A `201` with an `id` means it is stored; that number is how Krish finds it. Nothing else is a success:

| Answer | What it means | What you do |
| --- | --- | --- |
| `201` | stored | keep the id, go to step 2 |
| `401` | this bot's token is wrong or revoked | tell Krish; do not retry |
| `413` | the report is too big | shorten the write-up, not the facts, and try once |
| `429` | too many in an hour | tell Krish; the report waits |
| anything else | the inbox is unhappy | tell Krish with the answer, keep the report in the folder |

**One report per visit.** Not one per message, and never a second one "to be safe" — that is how the inbox fills with
duplicates.

## 1b. Send the recording, if there is one

The report carries the words; the recording carries what a still can't show. It goes to the inbox straight after the
report, against the id the inbox just gave you — **before** the folder is deleted.

```sh
# .mov -> video/quicktime, .mp4 -> video/mp4, .webm -> video/webm, .mkv -> video/x-matroska
curl -fsS -X PUT "$TESS_INBOX/v1/support/recording/<report id>" \
  -H "authorization: Bearer $TESS_SUPPORT_TOKEN" \
  -H "content-type: video/quicktime" \
  --data-binary @"<session dir>/<file>.mov"
```

`204` means it is stored. The inbox keeps it only until the issue is filed, or 14 days at most, and there is no way to
read it back.

If the upload fails, say so in the message to Krish — **do not** silently delete the recording, and do not retry more
than once. A missing recording is worth knowing about; a person's screen left lying around is not.

If there is no recording, skip this step.

## 2. Delete the session

Only after the inbox answered `201` **and** any recording has been sent (or there wasn't one):

```sh
node "$SKILLS/tess-support/scripts/session.mjs" handoff <dir> <report id>
```

It writes one line — report id, time, how many files, how big — to `handoffs.log` and removes the folder: the
screenshots, the recording, the doctor output, the scratch. It only ever deletes inside the session root, so a wrong
path is refused rather than removed. **If the report or the recording failed to send, do not delete** — the folder is
the only copy, and the sweep will get it in 24 hours.

## 3. Tell the person

One short message, plain words, always with the next thing in it:

> I've written this down for the person who builds Tess, with your report and my notes on what I saw. It's marked as
> urgent, so it goes to the top. Fixes reach you by themselves when they ship — you don't need to do anything.

Then, if it applies: the known-problem line, or the click path if it turned out to be their Mac.

Never a date. Never "should be fixed soon". Never "we're aware of this issue" — to them it is not an issue.

## 4. Tell Krish

One message to `TESS_OWNER_ID`, from `triage.mjs --mode krish`, plus the report number:

> Tess support: Lyrics drift half a second behind the song · P2 · area: theme · inbox #42

If it was `P0` or `P1`, that message goes before you finish talking to the person.
