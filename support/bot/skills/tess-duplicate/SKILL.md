---
name: tess-duplicate
description: "Checking whether a Tess problem is already written down, before filing it: the cached list of open issue titles the inbox serves, plus the repo. Use immediately before filing anything."
version: 1.0.0
author: Tess Music
license: MIT
metadata:
  hermes:
    tags: [tess, support, duplicates, issues]
---

# Is it already written down?

Two reports of the same bug are worse than one: the second one gets closed, and the person who wrote it feels ignored.
Check first, every time. It costs ten seconds.

## 1. The cached list

The inbox serves the titles of open issues, so you don't need a GitHub login or a slow search:

```sh
curl -fsS "$TESS_INBOX/v1/issues" | head -c 200000
```

It answers `{"updated": <ms>, "issues": [{"n": 61, "title": "…"}, …]}`, refreshed by Krish's side. If it is empty or
older than a few days, say so in the report rather than pretending you checked.

Match on **what it is**, not on wording: "lyrics drift" and "lyrics out of sync" are the same thing. Read the closest
three titles, not all of them.

## 2. When something matches

- **Same problem, same cause** → it is a duplicate. Do not file. In the report you send, put the issue number in the
  title line, e.g. `Also seen: #65 — full-screen player right side blank`.
- **Same area, different problem** → not a duplicate. Note the neighbouring number as related, and file.
- **Cannot tell** → file it, and say what you compared. Krish can close it as a duplicate in five seconds; he can't
  un-close a bug nobody wrote down.

## 3. Never

- Never file something you have not checked the list for.
- Never say "this is already reported" to the person unless you **saw the number** in the list. "It looks like
  something we may already know about" is the honest version when you didn't.
- Never read the issue bodies and quote them — the person's own words are what matter, and other people's reports are
  not yours to repeat.
