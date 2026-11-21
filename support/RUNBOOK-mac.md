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
3. **The `SALT` secret** (health reports already need it, so it is most likely there). It has to be a random
   value at least 16 characters long. Anything shorter makes every health report fail. Check from `inbox/`
   **(Cloudflare login)** with `npx wrangler@4 secret list`. You should see `SALT` and, after step 2,
   `OPENCODE_GO_API_KEY`. If `SALT` is missing, this generates one and uploads it. The value is not printed and
   not saved in a file:

   ```sh
   openssl rand -hex 32 | npx wrangler@4 secret put SALT
   ```
4. **The storage bucket.** A still of the Spotify window is stored here, and so is a recording the person
   attaches themselves. The bot does not record the screen. A deploy fails without the bucket. Check **(Cloudflare login)** with
   `npx wrangler@4 r2 bucket list`, which should list `tess-support`. If it doesn't, create it:

   ```sh
   npx wrangler@4 r2 bucket create tess-support
   ```

   The 14-day rule is a separate check. Run it even when the bucket was already there, because an older setup can
   create `tess-support` without the rule. **(Cloudflare login)**:

   ```sh
   npx wrangler@4 r2 bucket lifecycle list tess-support
   ```

   If that list has no rule that deletes objects after 14 days, add one. The rule covers the whole bucket. Wrangler
   asks you to confirm that. `--force` answers yes. The Worker deletes each file sooner, and this rule backs that up:

   ```sh
   npx wrangler@4 r2 bucket lifecycle add tess-support delete-after-14-days --expire-days 14 --force
   ```
5. **Deploy the Worker** with the support chat in it. From `inbox/`, on an up-to-date `main` **(Cloudflare login)**:
   `npx wrangler@4 deploy`. The "This support code is not active" answer in section 6 (revoke) comes from a Worker deployed
   after this runbook was added.
6. **Turn Extra Usage off on your OpenCode account.** This is a setting on the OpenCode website, not a command, so
   nothing in this repo can check it for you. Sign in to your OpenCode account, find the Extra Usage setting
   (paying for use beyond what your Go plan includes), and switch it off. Then, if a bug or a stolen code ever got
   past the Worker's daily limits, OpenCode would just stop answering. It wouldn't bill you. The Worker's limits are
   the first wall, and this is the second.

## The one-click way: invite one Mac, and it offers to install itself

Steps 1–3 have a shorter path for a Mac that already runs Tess. Instead of making a code and sending a command, you
invite that Mac. About 20 minutes later (at most three hours, when its Mac next checks for Tess updates) it shows a
native dialog on their screen:

> **Tess Music**
> Krish invited you to Tess Support — a private helper in your Dock that can check Spotify and send him a bug note when
> something looks off. Nothing runs unless you open it.
>
> Install Tess Support?
>
> [ Not now ] [ Install ]

Nothing is typed, nothing is pasted, and nothing about Tess Support is downloaded or mentioned on a Mac you did not
invite. **Not now** is remembered for that invite for good. Closing the dialog or leaving it alone is not an answer,
so it asks again next time they are at the Mac.

**(Cloudflare login)** First find that Mac's 32-character install id. `node tools/reports.mjs macs` lists each Mac's
latest report; `node tools/reports.mjs show <n>` prints its full `install id` line.

Then invite it:

```sh
node tools/reports.mjs support invite add <install id> "tester-1 Mac" --hours 72
```

- The label follows the same rule as a code's label: one label per person, and a label that doesn't name them.
- `--hours` is optional. It defaults to 72 hours and cannot be more than 168 (a week), so an unused invite closes on
  its own.
- The database keeps only a scrambled fingerprint (SHA-256) of the install id. It never holds the id, and it never
  holds a code: the code is made inside the Worker at the moment the person clicks **Install**, is used once, and is
  never shown to anyone.

**What Install does on their Mac.** It downloads Tess Support's installer and its signature, checks the signature
first, and only then claims the invite and runs the installer. A download or a bad signature costs nothing: the invite
is still there and it tries again. When it finishes, a welcome dialog says Tess Support is in the Dock and offers
**Open Tess Support**. If the installer fails part-way, it says some files may have been partly set up (it never claims
nothing changed) and points at the uninstall command or at you.

**Where the invite stands:**

```sh
node tools/reports.mjs support invites
```

`pending` means it is still waiting on that Mac; `claimed` means they installed; `expired` means the hours ran out;
`revoked` means you closed it.

**If it says `claimed` but Tess Support never appeared** — the network dropped the reply after the claim, so the code
was made and lost — revoke that label with `node tools/reports.mjs support token revoke "<label>"`, then run
`node tools/reports.mjs support invite add <install id> "<label>"` again. A new invite asks their Mac once more.

**Changed your mind?** Before it is claimed:

```sh
node tools/reports.mjs support invite revoke <invite id>
```

After it is claimed it is a normal Tess Support install: revoke its code by label with section 6, and remove it with
the uninstall line in section 3. Revoking a claimed invite is refused, because the person already has it.

**If nothing appears on their Mac.** The Mac must have a Tess build whose updater knows about invites (a build from
after this was promoted), its `install-id` must still be the one you invited, and the invite must not have expired.
An invite is only offered when Tess Support is not already installed there.

## 1. Make a code for one person

**(Cloudflare login)**

```sh
node tools/reports.mjs support token add "tester-1 Mac"
```

Give each person their own label in the quotes, and never reuse one. Revoking goes by this label, so one label
must mean one person. Use a label that doesn't name them (`tester-1 Mac`, not their real name), because
`support usage` and `support tokens` print it, and keep who is who somewhere private. The command prints a code that starts with `tess_`. **It's shown once.** The database
keeps only a scrambled fingerprint (hash) of it, so nobody can look it up later, not even you. If you lose it,
make a new one.

## 2. Send the code safely

- Send the code **on its own**, in a private one-to-one message: Signal, iMessage, or read it to them on a call. It
  shouldn't be in the same message as the install line.
- Never put it in a GitHub issue or pull request, an email thread with other people, a group chat, or a screenshot.
- Ask them to delete the message once Tess Support is installed.
- If you think it leaked, revoke it (step 5) and make a new one. That takes two commands.

## 3. What the person runs

They open Terminal on their Mac and paste:

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh
```

It asks `Enter the code Krish gave you:`. They paste the code, and nothing shows as they type. The code is not an
argument of the install, and it is not kept in the history of what they typed. It installs Hermes, the Tess
Support profile, and a **Tess Support** icon in the Dock. Opening that icon opens the chat. On an Intel Mac,
macOS may ask once to install Command Line Tools.

To remove it, they run the same line with `--uninstall` on the end:

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh -s -- --uninstall
```

## 4. What the person sees

They click **Tess Support** in the Dock. The chat is already open. They type what broke and send it. The bot does
not ask them to paste a command, and it does not run one.

Before any picture, it asks this, in these words:

> May I take one still of the Spotify window? It can show your Spotify name, your picture, your friends' activity, and your playlist names.

The picture is taken only when their very next reply to that question is a plain yes: `yes`, `y` or `go ahead`, on its
own (capitals and punctuation don't matter). Any other reply, including `ok`, `sure` or a yes inside a longer sentence,
means the note goes out without a picture, and a no stays a no for that visit. A yes covers one picture and lapses
after five minutes. If macOS hasn't allowed Screen Recording, the bot says so and sends the note without a picture. It does
not record the screen. The first time a still needs Screen Recording, macOS asks them to allow it, which they do by
hand. If they would rather not, the bot says so and continues with their words.

When the note is in, they see one short message: it has been written down, and a fix reaches them when it ships.

## 5. Watch what it uses, and read what it sends

**(Cloudflare login)**

```sh
node tools/reports.mjs support usage
```

This shows today's use for each person, and for everyone together, against the limits:

```
support chat today (resets 00:00 UTC; caps as in inbox/wrangler.toml, a token cap of 0 is off)
tester-1 Mac              12 of 80 requests  41000 of 300000 tokens  active
(everyone)                12 of 400 requests  41000 of 2000000 tokens
```

- A **request** is one call to the model, not one message. The doctor and a look at the still can each be their own
  call, so one message from the person can take several requests.
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
picture, and a recording only if the person attached one themselves.

## 6. Take it away (revoke)

**(Cloudflare login)**

```sh
node tools/reports.mjs support token revoke "tester-1 Mac"
```

Use the same name you gave in step 1. Then confirm it:

```sh
node tools/reports.mjs support tokens
```

The name you revoked should show `REVOKED`. If the name was not an active code, the revoke command stops and prints
`no active token labelled "…" — run support tokens to see exact names`. That code is still active.

It takes effect on their next message. The Worker answers it with
"This support code is not active. Ask Krish for a new one." Their chat shows that error, possibly with Hermes's own
sign-in wording beside it, and OpenCode isn't called. Their Mac still has Tess
Support installed. Removing that is the `--uninstall` line in step 3. To give them access again, make a new code
under a new name (step 1). A revoked code never works again.

## 7. Set the daily limits

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
- **Emergency stop for everyone**, without editing anything **(Cloudflare login)**. First make sure you're on an up-to-date
  `main`, because a deploy publishes whatever code is in the folder:

  ```sh
  cd ~/Developer/tess-music
  git switch main && git pull --ff-only
  git status -sb    # the first line must read exactly: ## main...origin/main
  cd inbox && npx wrangler@4 deploy --var SUPPORT_CHAT_SHARED_REQUESTS:0
  ```

  If `git switch` or `git pull` stops with an error, or the first line says anything else, don't deploy: ask for help.
  Once it's deployed, every chat is refused straight away with the "reached today's limit" message. To turn chat back on, run a plain `npx wrangler@4 deploy`.

### Switching the model or upstream (`go` ↔ `zen`)

The Worker always replaces the model name with `SUPPORT_MODEL` and only talks to the two allowlisted OpenCode endpoints
(`"go"` for OpenCode Go, `"zen"` for OpenCode Zen), so you can switch models without updating anyone's Mac.

- **Temporary live test** (reverts on the next plain `npx wrangler@4 deploy`):

  ```sh
  cd ~/Developer/tess-music/inbox
  npx wrangler@4 deploy --var SUPPORT_UPSTREAM:zen --var SUPPORT_MODEL:hy4-flash-free
  ```

- **Flip back to OpenCode Go** immediately if needed:

  ```sh
  cd ~/Developer/tess-music/inbox
  npx wrangler@4 deploy --var SUPPORT_UPSTREAM:go --var SUPPORT_MODEL:deepseek-v4.1-flash
  ```

- **Durable switch:** edit `SUPPORT_UPSTREAM` and `SUPPORT_MODEL` in `inbox/wrangler.toml`, merge through a pull
  request, pull `main`, and run a plain `npx wrangler@4 deploy`.

## If something looks wrong

- **Someone says the chat is refused.** Run `support tokens` and check their code is `active`. Then run
  `support usage` and see whether they or everyone have hit a limit.
- **Use is climbing fast for one person.** Revoke their code (step 5). A revoked code costs nothing more.
- **You're not sure what is running.** `node tools/test-support-mac-chat.mjs` runs the whole path on your Mac against a
  pretend model: make a code, install, chat, count it, revoke, refused. It touches only a scratch folder, a local copy
  of the database, and `127.0.0.1`. It never uses the live inbox or OpenCode.
