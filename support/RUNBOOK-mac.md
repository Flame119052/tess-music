# Tess Support on someone's Mac: Krish's runbook

This page is for you, Krish. It covers how to give one person Tess Support on their Mac, watch what it uses, and take
it away again. You don't need to read any code. Run every command from your checkout of this repo
(`tess-music`), in Terminal.

**How it works.** The person's Mac never holds your OpenCode key. It holds a **support code** (we call it a token),
which is a long password that belongs to that one person. Their Mac sends every chat message to your inbox Worker
(`tess-music-player.janus.ing`). The Worker checks the code, counts the message against that day's limits, and only
then calls OpenCode Go with your key. If you revoke the code, it stops working on the person's next message, and
OpenCode is never called for them again.

Steps marked **(Cloudflare login)** only work on your Mac, signed in with `npx wrangler@4 login`. Every
`node tools/reports.mjs …` command needs that login, because it reads and writes the live inbox database.

## Once, before the first person

Skip any step that's already done.

1. **The database tables.** Check with `node tools/reports.mjs support tokens` **(Cloudflare login)**. If it prints
   `no support tokens …` or lists people, the tables exist. If it errors, run this from the `inbox/` folder
   **(Cloudflare login)**: `npx wrangler@4 d1 execute tess-inbox --remote --file schema.sql`
2. **Your OpenCode key, as a Worker secret.** From `inbox/` **(Cloudflare login)**:
   `npx wrangler@4 secret put OPENCODE_GO_API_KEY`. It asks you to paste the key. The key goes only to Cloudflare,
   not into a file, a command line or chat.
3. **Deploy the Worker** with the support chat in it. From `inbox/`, on an up-to-date `main` **(Cloudflare login)**:
   `npx wrangler@4 deploy`. The clear "this support code is not active" message in step 5 needs this branch's gate
   to be deployed.
4. **Turn Extra Usage off on your OpenCode account.** This is a setting on the OpenCode website, not a command, so
   nothing in this repo can check it for you. Sign in to your OpenCode account, find the Extra Usage setting
   (paying for use beyond what your Go plan includes), and switch it off. Then, if a bug or a stolen code ever got
   past the Worker's daily limits, OpenCode would just stop answering. It wouldn't bill you. The Worker's limits are
   the first wall, and this is the second.

## 1. Make a code for one person

**(Cloudflare login)**

```sh
node tools/reports.mjs support token add "Ada (Mac)"
```

Give each person their own name in the quotes, and never reuse a name. Revoking goes by this name, so one name
must mean one person. The command prints a code that starts with `tess_`. **It's shown once.** The database
keeps only a scrambled fingerprint (hash) of it, so nobody can look it up later, not even you. If you lose it,
make a new one.

## 2. Send the code safely

- Send the code **on its own**, in a private one-to-one message: Signal, iMessage, or read it to them on a call. It
  shouldn't be in the same message as the install line.
- Never put it in a GitHub issue or pull request, an email thread with other people, a group chat, or a screenshot.
- Ask them to delete the message once Tess Support is installed.
- If you think it leaked, revoke it (step 5) and make a new one. That takes two commands.

## 3. What the person runs

> **Not merged yet.** The one-line installer is pull request
> [#126](https://github.com/Flame119052/tess-music/pull/126). Until it lands on `main`, the line below won't work.
> Check #126 for the final wording before you send it.

They open Terminal on their Mac and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh
```

It asks `Enter the code Krish gave you:`. They paste the code, and nothing shows as they type. The code never goes
on the command line or into shell history. It installs Hermes, the Tess Support profile, and a **Tess Support** icon
in the Dock. Opening that icon opens the chat. The first time it captures Spotify, macOS asks them to allow Screen
Recording, which they have to do by hand. On an Intel Mac, macOS may ask once to install Command Line Tools.

To remove it, they run the same line with `--uninstall` on the end:

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh -s -- --uninstall
```

## 4. Watch what it uses, and read what it sends

**(Cloudflare login)**

```sh
node tools/reports.mjs support usage
```

This shows today's use for each person, and for everyone together, against the limits:

```
support chat today (resets 00:00 UTC; caps as in inbox/wrangler.toml, a token cap of 0 is off)
Ada (Mac)                 12 of 80 requests  41000 of 300000 tokens  active
(everyone)                12 of 400 requests  41000 of 2000000 tokens
```

- A **request** is one call to the model, not one message. When the agent runs `tess doctor` or looks at a picture,
  one message from the person can take several requests.
- Counts restart at **00:00 UTC** every day. A person who hits their limit sees "This support chat has reached
  today's limit. It resets at 00:00 UTC."
- The limits printed come from `inbox/wrangler.toml` in your checkout. The live Worker uses whatever you last
  deployed.

Other commands:

```sh
node tools/reports.mjs support tokens         # who has a code, and which are revoked
node tools/reports.mjs support list           # the reports people's agents have sent, unfiled first
node tools/reports.mjs support show 12        # one report in full, plus the exact line that files it as an issue
node tools/reports.mjs support filed 12 --issue https://github.com/Flame119052/tess-music/issues/140
```

`support show` prints a ready-made `gh issue create …` line. Pasting it files the issue with the right priority and
labels. Then `support filed` records which issue it became. The Worker's nightly cleanup then deletes that report's
video and still.

## 5. Take it away (revoke)

**(Cloudflare login)**

```sh
node tools/reports.mjs support token revoke "Ada (Mac)"
```

Use the same name you gave in step 1. It takes effect on their next message. Their chat then shows
"This support code is not active. Ask Krish for a new one.", and OpenCode isn't called. Their Mac still has Tess
Support installed. Removing that is the `--uninstall` line in step 3. To give them access again, make a new code
under a new name (step 1). A revoked code never works again.

## 6. Set the daily limits

The limits live in `inbox/wrangler.toml`, under `[vars]`:

| Setting | Today | What it limits, per UTC day |
| --- | --- | --- |
| `SUPPORT_CHAT_SHARED_REQUESTS` | `"400"` | model calls for everyone together (the shared daily budget) |
| `SUPPORT_CHAT_SHARED_TOKENS` | `"2000000"` | tokens for everyone together |
| `SUPPORT_CHAT_PERSON_REQUESTS` | `"80"` | model calls for one person |
| `SUPPORT_CHAT_PERSON_TOKENS` | `"300000"` | tokens for one person |

To change one, edit the number (keep the quotes), merge it through a pull request as usual, then deploy from
`inbox/` on an up-to-date `main` **(Cloudflare login)**: `npx wrangler@4 deploy`.

- A **token** limit of `"0"` switches that token limit off. A **request** limit of `"0"` refuses every message.
- Change these values only in `wrangler.toml`. A value you change on the Cloudflare website is replaced by
  `wrangler.toml` on the next deploy.
- **Emergency stop for everyone**, without editing anything. From `inbox/` **(Cloudflare login)**:
  `npx wrangler@4 deploy --var SUPPORT_CHAT_SHARED_REQUESTS:0`. Every chat is refused straight away with the "reached
  today's limit" message. To turn chat back on, run a plain `npx wrangler@4 deploy`.

## If something looks wrong

- **Someone says the chat is refused.** Run `support tokens` and check their code is `active`. Then run
  `support usage` and see whether they or everyone have hit a limit.
- **Use is climbing fast for one person.** Revoke their code (step 5). A revoked code costs nothing more.
- **You're not sure what is running.** `node tools/test-support-mac-chat.mjs` runs the whole path on your Mac against a
  pretend model: make a code, install, chat, count it, revoke, refused. It touches only a scratch folder, a local copy
  of the database, and `127.0.0.1`. It never uses the live inbox or OpenCode.
