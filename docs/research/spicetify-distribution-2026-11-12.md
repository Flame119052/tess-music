# Shipping Tess to strangers: Marketplace, self-served updates, and the 2026 install reality — 2026-11-12

**Short answer: yes, a single developer can ship a theme to many users and push updates without anyone reinstalling — three popular themes already do exactly that, and Tess is one small refactor away from it.** The mechanism is not Marketplace magic: Marketplace reads a `manifest.json` from a GitHub repo tagged `spicetify-themes`, then at **every Spotify start** fetches the theme's `user.css`, `color.ini` and any `include` scripts **from a URL** and injects them as `<style>`/`<script>` tags. Nothing is copied into the `Themes` folder, so whatever is at that URL at startup is what the user sees. Comfy, Bloom and Lucid all exploit this further: their shipped `theme.js` is a five-line loader that appends a `<script>` pointing at their own hosted bundle, and Comfy's `user.css` is a one-line `@import`. Spotify's renderer ships **no Content-Security-Policy** (verified on the installed client), so remote script loading from any origin works — no `eval`, no blob tricks needed. The one thing nobody can dodge is Spotify's own auto-update: it replaces the patched app bundle, which wipes Spicetify, the theme, **and Marketplace itself**, until someone runs `spicetify backup apply` again. Spicetify's official answer is to point the launcher at `spicetify auto`, which re-backups and re-applies on demand.

Sources were read on 2026-11-12 unless another date is given. Everything below is either source code I read at a pinned URL, an official doc, or something I verified on this machine's Spotify **1.3.8.620** install.

---

## 1. How a theme gets into Marketplace, how it installs, and how updates reach users

### 1.1 Listing: a public repo, a topic tag, a root `manifest.json`

Marketplace never takes submissions for themes. It searches GitHub by topic and then reads a manifest from each repo it finds. The wiki states the requirements plainly:

> "In order for your creation to be visible in Marketplace, you'll need to make a **public GitHub repository**… Contains its respective **GitHub topic tag**… Have a valid **`manifest.json`** in the root folder"
> — <https://github.com/spicetify/marketplace/wiki/Publishing-to-Marketplace> (read 2026-11-12)

Topic tags: **`spicetify-themes`** for themes (`spicetify-extensions`, `spicetify-apps`, `spicetify-custom-apps` for the others).

Theme manifest fields, verbatim from the same wiki page:

| Key | Description | Required |
|---|---|---|
| `name` | Your theme name | ✅ |
| `description` | Description for your theme | ✅ |
| `preview` | A path to your preview image. Must be relative to your project root. | ✅ |
| `usercss` | A path to your user.css file. Must be relative to your project root. | ✅ |
| `schemes` | A path to your color.ini file. Must be relative to your project root. | ✅ |
| `include` | Array of extension URLs* that is needed to be included with the theme. | |
| `readme` | The filename for your theme's README file. | ✅ |
| `branch` | Specific branch used for publication. Will use default branch if not present. | |
| `authors` | Array of authors with names and URLs. Will use repo owner if not present. | |
| `tags` | Array of tags to show along with the card. | |

> "_*_: GitHub RAW links will **not** work, use GitHub Pages URL if you must."

That last footnote is **stale** — the code converts raw URLs to jsDelivr automatically (see 1.3). "Most fields also support http/https URLs (`preview`, `main`, `readme`, `usercss`, `schemes`)" is the line that matters for self-hosted updates, and it is exactly what Bloom, Lucid and Comfy rely on.

Discovery is a GitHub topic search, not a curated index — `getTaggedRepos("spicetify-themes", page, BLACKLIST, showArchived, sortMode)` in [`src/logic/FetchRemotes.ts`](https://github.com/spicetify/marketplace/blob/main/src/logic/FetchRemotes.ts) (read 2026-11-12), called with `spicetify-${type}s` from [`src/extensions/extension.tsx`](https://github.com/spicetify/marketplace/blob/main/src/extensions/extension.tsx). `resources/blacklist.json` removes repos by name. A manifest is accepted only if `manifest?.name && manifest?.usercss && manifest?.description` — so a missing `usercss` silently hides the theme rather than erroring.

Marketplace itself is a *custom app* installed once from a release zip by `resources/install.sh`, which unpacks to `$XDG_CONFIG_HOME/spicetify/CustomApps/marketplace` and runs `spicetify config custom_apps …` (<https://github.com/spicetify/marketplace/blob/main/resources/install.sh>, read 2026-11-12).

### 1.2 Install: no files in `Themes/` — a record in local storage plus runtime injection

Installing a theme stores a **manifest record** (name, repo, branch, `cssURL`, `schemesURL`, parsed colour schemes, `include`, `activeScheme`, `lastUpdated`) under a key `marketplace:installed:<user>/<repo>/<usercss>` and sets `themeInstalled` to that key. Storage is Dexie/IndexedDB with a localStorage fallback ([`src/logic/Storage.ts`](https://github.com/spicetify/marketplace/blob/main/src/logic/Storage.ts)); keys are in `src/constants.ts` (`installedThemes`, `themeInstalled`, `localTheme`).

From [`src/components/Card/Card.tsx`](https://github.com/spicetify/marketplace/blob/main/src/components/Card/Card.tsx):

```ts
await marketplaceStorage.mutateAsync((storage) => {
  const installedThemes = readStoredStringArray(storage.get(LOCALSTORAGE_KEYS.installedThemes))…
  storage.set(this.localStorageKey, record);
  storage.set(LOCALSTORAGE_KEYS.installedThemes, JSON.stringify([...installedThemes, this.localStorageKey]));
  if (shouldActivate) storage.set(LOCALSTORAGE_KEYS.themeInstalled, this.localStorageKey);
});
```

Nothing is written to disk, and nothing could be: the Marketplace extension runs inside Spotify's renderer and has no filesystem API. A theme installed this way also *requires* the config file to say `current_theme = marketplace`, because the startup path bails out otherwise ([`src/extensions/extension.tsx`](https://github.com/spicetify/marketplace/blob/main/src/extensions/extension.tsx)):

```ts
if (localTheme.toLocaleLowerCase() !== "marketplace") {
  Spicetify.showNotification(t("notifications.wrongLocalTheme"), true, 5000);
  return;
}
```

### 1.3 Updates: automatic, on every Spotify start, from whatever is on the branch

This is the important bit. The CSS is fetched **at startup**, not at install time, and injected as a `<style>` element. `parseCSS` in [`src/logic/Utils.ts`](https://github.com/spicetify/marketplace/blob/main/src/logic/Utils.ts):

```ts
const userCssUrl = isGithubRawUrl(themeData.cssURL)
  ? `https://cdn.jsdelivr.${tld}/gh/${themeData.user}/${themeData.repo}@${themeData.branch}/${themeData.manifest.usercss}`
  : themeData.cssURL;
…
const response = await fetch(`${userCssUrl}?time=${Date.now()}`);
let css = await response.text();
```

and `injectUserCSS`:

```ts
const userCssTag = document.createElement("style");
userCssTag.classList.add("marketplaceCSS");
userCssTag.classList.add("marketplaceUserCSS");
userCssTag.innerHTML = userCSS;
document.body.appendChild(userCssTag);
```

So: **push a new `user.css` to the branch → every user sees it the next time Spotify starts.** No reinstall, no version bump, no notification. The only delay is CDN caching (jsDelivr caches branch URLs for 12 h — see 2.3) plus the `?time=<now>` query string that defeats the browser cache.

Two caveats that decide your architecture:

- **Only file *contents* update this way.** `include` (the list of scripts), `schemes` and `branch` are read from the stored record, so adding a *new* script to `include`, or a new colour scheme, requires an update/reinstall. `lastUpdated` is compared against the repo's `pushed_at`, and opening the Installed tab silently re-runs the install when they differ (`refreshInstalledItem()` → `installTheme(true, recordMeta)` in `Card.tsx`). That is manual-trigger, not startup-trigger.
- **Colour schemes are stored parsed.** `prepareTheme` parses `color.ini` with `parseIni` at install and saves `schemes` into the record; at startup `injectColourScheme` only writes the *stored* values as `:root { --spice-*: … }`. Edit `color.ini` on the branch and existing users keep the old palette until they update. Put new palettes in CSS variables in `user.css` instead if you want them live.

### 1.4 Does Marketplace support a theme's `theme.js` and colour schemes?

**Colour schemes: yes, first-class** (`schemes` is a required manifest field; the scheme is applied as `:root` CSS custom properties, and Marketplace adds album-art-based and colour-shift modes on top).

**Theme JS: yes, but only through `include`, as a URL.** There is no `theme.js` manifest field — the theme's script is treated as an included extension script and appended as a `<script src>`:

```ts
for (const script of themeManifest.include) {
  const newScript = document.createElement("script");
  let src = script;
  if (isGithubRawUrl(script)) { … src = `https://cdn.jsdelivr.${tld}/gh/${user}/${repo}@${branch}/${filePath}`; }
  if (filePath.endsWith(".mjs")) newScript.type = "module";
  newScript.src = `${src}?time=${Date.now()}`;
  newScript.classList.add("marketplaceScript");
  document.body.appendChild(newScript);
}
```

Note `addExtensionToSpicetifyConfig(script)` is called with the *URL*, so it pushes e.g. `theme.js` into `Spicetify.Config.extensions` at runtime only — harmless, but it means Marketplace's in-memory config drifts from `config-xpui.ini`. Nothing depends on it.

Marketplace is also **not a distribution channel for local files**: if you ship `theme.js` inside a `Themes/Tess/` folder the classic way, `spicetify apply` *copies* it into the app bundle, and it is frozen there. Verified on this machine: `/Applications/Spotify.app/Contents/Resources/Apps/xpui/extensions/theme.js` is 141,222 bytes — byte-identical to `theme/Tess/theme.js` — and `xpui/index.html` ends with `<script defer src='extensions/theme.js'></script>`. Local installs update only when the user re-runs `spicetify apply`. A loader fixes that (section 2).

---

## 2. Can a theme load its real code remotely at startup? Yes — that is the current best practice

### 2.1 Three production examples, all using a ~5-line loader

**Comfy** (806★) ships both a loader script *and* a CSS redirect. [`Comfy/theme.js`](https://github.com/Comfy-Themes/Spicetify/blob/main/Comfy/theme.js) is 265 bytes, in full:

```js
(() => {
	const themeScript = document.createElement("SCRIPT");
	themeScript.setAttribute("type", "text/javascript");
	themeScript.setAttribute("src", "https://comfy-themes.github.io/Spicetify/Comfy/theme.script.js");
	document.head.appendChild(themeScript);
})();
```

and [`Comfy/user.css`](https://github.com/Comfy-Themes/Spicetify/blob/main/Comfy/user.css) is 71 bytes, in full:

```css
@import url("https://comfy-themes.github.io/Spicetify/Comfy/app.css");
```

Its real bundle (`Comfy/theme.script.js`) is 70,571 bytes, and its `manifest.json` points `include` at the raw GitHub URL on `branch: "main"` (Marketplace rewrites it to jsDelivr). Its own `install.sh` downloads `color.ini`, `user.css` and `theme.js` — i.e. **the local install is also a loader**, so Comfy users get live updates whether they came via Marketplace or the script.

**Bloom** (682★) has [`remote/theme.js`](https://github.com/nimsandu/spicetify-bloom/blob/main/remote/theme.js):

```js
(() => {
  const themeScript = document.createElement('script');
  themeScript.type = 'text/javascript';
  themeScript.src = 'https://nimsandu.github.io/spicetify-bloom/src/theme.js';
  document.head.appendChild(themeScript);
})();
```

and a manifest built entirely from hosted URLs:

```json
"usercss": "https://nimsandu.github.io/spicetify-bloom/src/user.css",
"schemes": "https://nimsandu.github.io/spicetify-bloom/src/color.ini",
"include": ["https://nimsandu.github.io/spicetify-bloom/src/theme.js"]
```

Served size of that `src/theme.js`: 17,186 bytes (matches the committed file), HTTP 200, checked 2026-11-12.

**Lucid** (493★) does the same from a custom domain, [`remote/theme.js`](https://github.com/sanoojes/spicetify-lucid/blob/main/remote/theme.js):

```js
const themeScript = document.createElement("script");
themeScript.type = "text/javascript";
themeScript.src = "https://cdn.jsdelivr.net/gh/sanoojes/Spicetify-Lucid@refs/heads/main/src/theme.js";
document.head.appendChild(themeScript);
```

Served `https://spicetify-lucid.sanooj.uk/spice/theme.js` = 1,083,754 bytes, HTTP 200. **That jsDelivr URL in the loader is dead** (HTTP 404, checked 2026-11-12) because the *built* bundle is not committed under `src/` — the repo's `src/` holds `.tsx` sources only. Lucid works because its manifest points `usercss`/`schemes`/`include` at its own domain. Lesson: a loader whose URL 404s fails silently; verify your own URL from a clean machine.

### 2.2 What Spotify's renderer CSP actually allows

There is **no Content-Security-Policy in the app**. Concretely, on Spotify **1.3.8.620** (macOS, read 2026-11-12):

- `/Applications/Spotify.app/Contents/Resources/Apps/xpui/index.html` (2,880 bytes) contains no `<meta http-equiv="Content-Security-Policy">`. Its `<head>` is only `title`, `charset`, `preconnect` hints, font preloads, and a `xpui-snapshot.css` link.
- `grep -rl "Content-Security-Policy"` across `/Applications/Spotify.app/Contents/Resources` returns exactly one file: `Apps/xpui/licenses-loader.html` (the open-source-licences viewer). Nothing in `Apps/xpui/*.js`, nothing in the `MacOS/Spotify` binary.
- `spicetify/cli` contains no CSP handling at all (`grep -rn "Content-Security-Policy\|script-src\|connect-src"` over the whole repo → no matches), so it is not stripping one either.

Consequences, each with a production proof rather than a theory:

| Directive | Status | Proof |
|---|---|---|
| `script-src` (remote, cross-origin) | Unrestricted | Comfy/Bloom/Lucid load their bundle from `comfy-themes.github.io`, `nimsandu.github.io`, `spicetify-lucid.sanooj.uk`; Marketplace loads extensions from `cdn.jsdelivr.net`. Arbitrary origins, not just Spotify's. |
| `script-src` (inline) | Unrestricted | Marketplace injects an inline script on boot: `reactSimpleCodeEditorFix.innerHTML = "const global = globalThis;"` then `document.body.appendChild(...)` (`extension.tsx`). Any `script-src` without `'unsafe-inline'` would break it. |
| `connect-src` | Unrestricted | Marketplace `fetch`es `api.github.com` (star/`pushed_at` refresh, `POST /markdown`) and `cdn.jsdelivr.*` at runtime; Tess already `fetch`es `spclient.wg.spotify.com` and `i.scdn.co`. |
| `eval` / `new Function` | Not needed, not verified | Because `<script src>` works, don't fetch-and-eval. A same-origin-ish text bundle would need `eval`, and while the absence of CSP suggests it works, I have no shipped example to point at — treat as unverified. |

Practical rule: **a remote `<script src>` to your own HTTPS host is the supported path**, because three themes and the Marketplace itself already depend on it.

### 2.3 Hosting: branch URL vs tag vs GitHub Releases

jsDelivr's own documentation pins the caching semantics that decide how fast your update lands (<https://github.com/jsdelivr/jsdelivr#caching>, README read 2026-11-12):

> - "**Static Versions and commit hashes** — Effectively forever. The caching headers are set for 1 year but we also permanently cache the files in our S3 storage…"
> - "**Version aliasing** — 7 days. This also includes `latest` versions…"
> - "**Branches** — 12 hours."

and on GitHub URLs (`/gh/user/repo@version/file`):

> "We use a permanent S3 storage to ensure all files remain available even if GitHub goes down or a repository or a release is deleted by its author."

Implications for Tess:

- **Branch ref (`@main`)** → updates propagate within ~12 h, no action needed. This is what Bloom and Lucid do. `?time=<now>` in the loader/manifest URL defeats browser cache but not the CDN.
- **Semver tag (`@v2.1.0`)** → immutable and permanently cached. Safe, reproducible, but every release is a new URL, so the *loader itself* must be the thing that keeps updating (i.e. the loader stays on `@main` or lives in the manifest, and it points at the tag). Purging a tag requires the purge API, which jsDelivr gates by email request ("To avoid abuse, access to purge is given after an email request").
- **GitHub Releases:** jsDelivr's `/gh/` route serves **repo files**, not release *assets*. There is no "versioned bundle from GitHub Releases" path through jsDelivr. Options are (a) commit the built bundle to the repo / a `dist` branch (Bloom has a `dist` branch), (b) attach it to a tag and serve via jsDelivr at that tag, or (c) serve it yourself (GitHub Pages or a small static host) and skip jsDelivr.
- **Don't use `raw.githubusercontent.com`** as the primary URL: Marketplace already rewrites it to jsDelivr when it can, and your own loader has no such rewrite — the wiki's own footnote says raw links were considered unreliable for `include`.

So: **versioned release = tag in the repo + loader on `@main` (or in `manifest.include`) that points at the tag you promote.** That gives atomic rollback (edit one line, or repoint a pointer file) and a stable 12 h worst-case propagation, with no eval.

---

## 3. Install and update on an end-user's machine in 2026

### 3.1 The official install scripts

**macOS / Linux** — <https://raw.githubusercontent.com/spicetify/cli/main/install.sh> (read 2026-11-12). It refuses to run under sudo/root unless `--root` is passed; picks `darwin-amd64` / `darwin-arm64` (also linux variants); resolves the latest tag from the GitHub releases JSON; downloads `spicetify-$tag-$target.tar.gz` into `~/.spicetify`; `chmod +x ~/.spicetify/spicetify`; then appends `export PATH=$PATH:$HOME/.spicetify` to the user's shell rc (`.zshrc`, `.bashrc`, `.profile`, honouring `ZDOTDIR`) if it isn't already there. If Spicetify is already present it offers to run `spicetify update` instead.

**Windows** — <https://raw.githubusercontent.com/spicetify/cli/main/install.ps1>: requires PowerShell ≥ 5.1, warns if run as Administrator, installs to `%LOCALAPPDATA%\spicetify`, migrates from the old `$HOME\spicetify-cli`, and adds to the user PATH.

**Marketplace** (separate, optional): `curl -fsSL https://raw.githubusercontent.com/spicetify/marketplace/main/resources/install.sh | sh` (or `iwr -useb …install.ps1 | iex`), per <https://spicetify.app/docs/getting-started> (read 2026-11-12).

First-run sequence the docs give: `spicetify` (writes config), then `spicetify backup apply enable-devtools`. The docs also warn: "If this is a fresh Spotify install, open Spotify and log in for at least 60 seconds before running Spicetify."

### 3.2 What happens when Spotify auto-updates: the theme vanishes, and so does Marketplace

Official, unambiguous:

> "Spotify updates periodically. After a Spotify update, you'll need to re-apply Spicetify: `spicetify backup apply`"
> — <https://spicetify.app/docs/getting-started> (read 2026-11-12)

> "After any Spotify update, always run `spicetify backup apply`. Optionally, set the Spotify shortcut to run `spicetify auto` (instead of direct path to Spotify executable), so that Spicetify can backup and apply, when it needs to, then launch Spotify automatically."
> — <https://spicetify.app/docs/faq> (read 2026-11-12)

Mechanically, Spicetify classifies the app's `Apps` folder by what's in it ([`src/status/spotify/spotify.go`](https://github.com/spicetify/cli/blob/main/src/status/spotify/spotify.go), read 2026-11-12):

```go
// STOCK Spotify is in original state
// APPLIED Spotify is modified
// MIXED Spotify has modified files and stock files
…
if spaCount > 0 && dirCount > 0 { cur = MIXED } else if spaCount > 0 { cur = STOCK } else if dirCount > 0 { cur = APPLIED }
```

`apply` refuses to run against an un-backed-up or version-mismatched client ("Spotify version and backup version are mismatched… Please run `spicetify backup apply`", `src/cmd/apply.go`). A Spotify update restores `xpui.spa` → the folder reads `STOCK` again → every injected file, including `extensions/theme.js` and the Marketplace extension's script tag, is gone. **Marketplace does not survive a Spotify update**; it is injected by the same `index.html` that gets replaced. (Corroborated by an independent community tool's README: "Every time it does, it overwrites `xpui.spa` and your Spicetify patch disappears — custom theme gone, extensions gone, Marketplace gone", <https://github.com/DhakadG/spicetify-guardian>, read 2026-11-12 — anecdotal source, consistent with the code above.)

So: **the re-apply problem is unavoidable and orthogonal to the update mechanism.** Users will lose the theme every time Spotify updates unless something re-applies. That is the single biggest support cost of shipping Tess.

### 3.3 Existing answers to auto-reapply

- **`spicetify auto` (official).** "Automatically backup (if needed) and apply, then launch Spotify. Useful as a shortcut target instead of the Spotify executable." (<https://spicetify.app/docs/cli/commands>, read 2026-11-12). The implementation is exactly what you want ([`src/cmd/auto.go`](https://github.com/spicetify/cli/blob/main/src/cmd/auto.go)):

  ```go
  if spotStat.IsBackupable() && (backStat.IsEmpty() || backStat.IsOutdated()) { Backup(spicetifyVersion, true) … }
  if !backStat.IsBackuped() { os.Exit(1) }
  if !spotStat.IsApplied() && backStat.IsBackuped() { CheckStates(); InitSetting(); Apply(spicetifyVersion) }
  ```

  On macOS that means editing the Dock/Finder alias for Spotify.app to run `spicetify auto` instead — no launchd plist is shipped by Spicetify, and nothing wires this up for the user.
- **Block Spotify updates (official, blunt).** `spicetify spotify-updates block` — help text: "Block Spotify updates by patching spotify executable" (`spicetify.go`). On macOS the implementation does not patch the binary at all; it makes the update-staging directory immutable ([`src/cmd/block-updates.go`](https://github.com/spicetify/cli/blob/main/src/cmd/block-updates.go)):

  ```go
  updateDir := homeDir + "/Library/Application Support/Spotify/PersistentCache/Update"
  exec.Command("pkill", "Spotify").Run()
  exec.Command("mkdir", "-p", updateDir).Run()
  exec.Command("chflags", "uchg", updateDir).Run()
  ```

  (On Windows it does patch the executable, replacing `desktop-update/` with `no/thanks`.) Effective, but it freezes users on a Spotify version — bad advice to give paying Premium users, and it leaves them stranded when Spicetify's compatibility lags.
- **Community auto-reappliers (thin, low-adoption, Windows-heavy).** `Israleche/SpicetifyManager` (21★, pushed 2026-09-12, PowerShell), `itsgoog/Spicetify-Autoupdater` (7★, 2026-08-16), `nelvismyname/Spicetify-AutoUpdate` (3★, 2026-06-18), `mezzi003e/auto-spicetify` (2★, 2026-10-22), `DhakadG/spicetify-guardian` (0★, 2026-09-15), `L3Lunee/spicetify-auto-updater` (0★, 2026-10-11) — all from the GitHub API on 2026-11-12. Two patterns: run a `spicetify update`-style chain at every login (wasteful, and `spicetify clear backup apply` at the wrong moment can corrupt the backup, per guardian's README), or watch the app bundle and re-apply only when it flips to stock. **Nothing on macOS with any adoption** — a LaunchAgent that runs `spicetify auto`-equivalent logic (`backup apply` when the app folder is stock, `--no-restart` then relaunch) is the obvious gap and is entirely within one developer's reach.

---

## 4. Prior art: how the popular themes actually ship and update

All counts/dates from the GitHub API, read 2026-11-12.

| Theme | Repo | ★ | Last push | How it ships | How it updates |
|---|---|---|---|---|---|
| **Comfy** | `Comfy-Themes/Spicetify` | 806 | 2026-10-25 | Marketplace (topic + manifest, `branch: "main"`, raw `include`) **and** `install.sh`/`install.ps1` that `curl` three files into `Themes/Comfy` | Bundle is a loader + `@import` → live from `comfy-themes.github.io`; no reinstall |
| **Bloom** | `nimsandu/spicetify-bloom` | 682 | 2025-05-20 (stale ~18 mo) | Marketplace manifest with all-absolute URLs; `install/install.sh` downloads `master.zip` and copies `src/`; PowerShell + Debian variants | `src/` is served from `nimsandu.github.io`; `remote/theme.js` loader for manual installs; has a `dist` branch |
| **Lucid** | `sanoojes/spicetify-lucid` | 493 | 2026-11-06 (active) | Marketplace manifest (two entries: current + "Lucid V2 (Legacy)" for Spotify v1.2.45–v1.2.60) | Everything served from `spicetify-lucid.sanooj.uk`; `remote/theme.js` loader; bundle is 1.08 MB |
| **Dribbblish** | inside `spicetify/spicetify-themes` | — | 2026-11-09 (collection) | Collection + Windows-only `install.ps1`/`uninstall.ps1` that copy files into `Themes/` | None — re-run the installer, or Marketplace |
| **text** | inside `spicetify/spicetify-themes` | — | 2026-11-09 | Collection only (`user.css` + `color.ini`, no JS) | Marketplace only |
| **spicetify-themes** | `spicetify/spicetify-themes` | 6,147 | 2026-11-09 | One root `manifest.json` **array** with 14 entries (`SharkBlue`, `BurntSienna`, `Default`, `Dreary`, `Dribbblish`, `Matte`, `Onepunch`, `Sleek`, `text`, `Turntable`, `Ziro`, `Flow`, `Blossom`, `StarryNight`; the `Nightlight` folder exists but is not in the manifest) | Its own branch; every field is a relative path, so updates only reach users through Marketplace re-reading the branch |

What this says about the field:

- **The old model (copy files into `Themes/`) is dead among actively maintained themes.** Comfy, Bloom and Lucid all moved their *content* behind a URL. The ones still copying (`Dribbblish`'s `.ps1`, `Bloom`'s zip installer as a fallback) are either unmaintained or treated as an offline fallback.
- **Nobody pins versions.** All three use a moving branch (Bloom/Lucid via `@main`-equivalent, Comfy via `branch: "main"` + jsDelivr conversion). Users get HEAD. There is no rollback story in any of them — a bad push reaches everyone within 12 h.
- **Hosting split:** GitHub Pages (Comfy, Bloom) vs own domain (Lucid). Both bypass the jsDelivr branch-cache question; Pages gives you near-immediate propagation, jsDelivr gives you 12 h but better global latency and survives GitHub outages.
- **The collection is not a directory of everything.** `spicetify/spicetify-themes` holds 14 listed themes; the biggest themes live in their own repos and are found purely by the topic tag. There is no approval step, which is both the opportunity (Tess can be listed today) and the risk (nobody will review your code, and `resources/blacklist.json` is the only moderation).

---

## 5. Risk: what Spotify's terms actually say

**User Guidelines** (<https://www.spotify.com/us/legal/user-guidelines/>, read 2026-11-12):

> "The following is not permitted for any reason whatsoever in relation to the Services and the material or content made available through the Services, or any part thereof: reverse-engineering, decompiling, disassembling, modifying, or creating derivative works, except where such restriction is expressly prohibited by applicable law."

> "Violating the User Guidelines or Platform Rules may result in removal of any content or material you've contributed to the Services and/or termination or suspension of your account."

That clause is about the *client software*: Spicetify decompiles and rewrites Spotify's shipped `xpui` bundle, so a Spicetify user is squarely inside "modifying / creating derivative works", and a theme author distributing modifications is arguably further in. The mitigation that matters practically is that a *theme* changes CSS and reads the DOM; it does not touch entitlements, ads, or playback, which is what enforcement has historically targeted.

**Terms of Use** (<https://www.spotify.com/us/legal/end-user-agreement/>, "Last Updated: September 4, 2026", read 2026-11-12): I searched the full text for "reverse engineer", "decompile", "modify", "unauthorized applications" — there is **no standalone clause prohibiting client modification or third-party clients**. The closest text is the general licence/breach-termination machinery and the "your use of Third-Party Applications and Devices may be subject to additional terms" paragraph. So the concrete prohibition lives in the User Guidelines, not the Terms.

**Documented enforcement against Spicetify or theme authors: none found.** Searched Spotify's newsroom, support site, and the Spicetify repos/issues on 2026-11-12; no Spotify statement, DMCA, or account action aimed at Spicetify or a Spicetify theme surfaced. What exists is:

- **March 2018**: Spotify emailed users of modified clients with a warning and a threat of suspension. Press-reported at the time (Newsweek, HotHardware, 2018-03-05) — **anecdotal/secondary**; I did not find the email reproduced by Spotify itself.
- **A 451 on a piracy mod**: `whoeevee/EeveeSpotify` returns HTTP 451 (legal takedown) — **adjacent but not the same category** (it unlocks Premium features on mobile, i.e. entitlement circumvention, not theming).
- **The de-facto enforcement that does happen** is technical, not legal: Spotify ships a new `xpui` every few weeks and breaks Spicetify until its maintainers catch up. That is the real risk to plan for, and it is why pinning users to an old Spotify via `spotify-updates block` is a bad idea.

Label the rest as **anecdotal**: forum/Reddit reports of warnings for modded clients exist for most years and are unverifiable; I found no 2025–2026 primary source. Nothing I read suggests a theming-only user or theme author has been actioned. This is a "low but non-zero, and not something you can promise users" risk — say so in the README rather than pretending otherwise.

---

## Recommendation: how one developer should ship Tess with self-served updates

1. **Make the installed `theme.js` a loader, not the bundle.** Move the 141 KB build to `dist/theme.js` (or a `dist` branch) and reduce `theme/Tess/theme.js` to the ~5-line `document.createElement("script")` shim pointing at it — the Comfy/Bloom/Lucid pattern, so local `Themes/Tess` installs self-update the same way Marketplace installs do.
2. **Ship the CSS the same way:** make `theme/Tess/user.css` a one-line `@import url("https://…/user.css")` (Comfy's trick) and keep `color.ini` local, so palettes stay under your control while layout/CSS changes land live within 12 h.
3. **List on Marketplace with absolute URLs** — repo topic `spicetify-themes`, root `manifest.json` with `usercss`/`schemes`/`include` pointing at your host (GitHub Pages is enough), `preview`, `readme`, `authors`, `tags`; no submission or review is required.
4. **Version with tags, promote with one pointer.** Build → tag `vX.Y.Z` → point the loader at that tag (jsDelivr serves repo files at tags, immutably); keep a `@main` pointer so a rollback is a one-line revert rather than a rebroadcast, and never serve a moving branch straight to users if you can't revert fast.
5. **Own the re-apply problem, because Marketplace doesn't.** Ship a macOS `LaunchAgent` (and a Windows scheduled task) that runs `spicetify backup apply --no-restart` only when the app folder is stock, then relaunches Spotify — i.e. `spicetify auto`'s logic on a timer — and document `spicetify auto` as the manual fallback. Never recommend `spotify-updates block` to Premium users.
6. **State the deal honestly in the README:** Tess restyles the local client via Spicetify, Spotify's User Guidelines forbid modifying the client, no enforcement against theme authors is documented, and every Spotify update removes the theme until Spicetify re-applies. Ship a `spicetify restore` one-liner, a link to the official install script, and a `Tess: vX.Y.Z` badge read from the loader so support requests can be triaged in one question.
