#!/bin/sh
# Release gate: no release ships unless these pass (CI runs this before building; run it locally before pushing).
# The rule they protect: Spotify's interface folder is never deleted and then refilled. It is only ever replaced by
# switching in a complete, checked copy, so a failure at any point leaves Spotify exactly as it was.
set -e
cd "$(dirname "$0")/.."
fail() { echo "SAFETY CHECK FAILED: $1"; exit 1; }

# 1. no delete-then-copy of Spotify's folder anywhere
if grep -nE 'rm -rf "?\$(APPS|A0)"?( |;|$)' installer/*.sh; then fail "a script deletes Spotify's interface folder directly; use tess-patcher swap-apps"; fi
if grep -rn 'RemoveAll(appDestPath)' patcher/src; then fail "the patcher deletes Spotify's interface folder directly; use swapApps"; fi

# 2. every script parses
for f in installer/install.sh installer/tess-install.sh installer/uninstall.sh installer/tess-command.sh installer/redact.sh; do sh -n "$f" || fail "$f does not parse"; done
for f in installer/updater.sh installer/doctor.sh installer/rescue.sh installer/wake.sh; do zsh -n "$f" || fail "$f does not parse"; done
# The support bot's setup script runs on a server before anything else does, so it is held to the same bar.
sh -n support/setup.sh || fail "support/setup.sh does not parse"
node --check theme/loader/loader.js || fail "theme/loader/loader.js does not parse"

# 3. nothing a user's Mac may lack (python3 only opens an "install developer tools" prompt there)
if grep -nE '(^|[^#])\b(python3?|node|ruby|perl) ' installer/*.sh | grep -v '^\s*#'; then fail "an installer script needs a tool macOS doesn't always have"; fi

# 4. a command substitution that can fail must not stop the installer under set -e
if grep -nE '^[A-Za-z_]+=\$\((cat|grep|awk|find|ls) [^)]*\)$' installer/tess-install.sh | grep -v '|| true'; then fail "an assignment in tess-install.sh can stop it under set -e; add || true"; fi

# 5. the folder swap itself: Spotify untouched when copying fails, the result is incomplete, macOS blocks writing,
#    or an earlier run stopped halfway. can-write probes without touching a file that is already there.
(cd patcher && go test ./src/cmd/ -run 'Swap|CanWrite' -count=1) || fail "swapApps and can-write tests"

# 5b. one privacy filter and one plist escape. Every report path carries the same filter byte for byte (SEC-10: the
#     installer leaked the account name while the doctor removed it), and every plist is escaped the same way, so a
#     folder name with & or < cannot make one launchd file unreadable and another fine.
redact_hashes=$(
  for f in installer/redact.sh installer/tess-install.sh installer/doctor.sh installer/rescue.sh; do
    awk '/^tess_redact\(\) \{/{copy=1} copy{print} copy && /^\}/{exit}' "$f" | shasum -a 256 | cut -d' ' -f1
  done | sort -u | wc -l | tr -d ' '
)
[ "$redact_hashes" = 1 ] || fail "the report privacy filter differs between scripts; edit installer/redact.sh and copy it"
for f in installer/tess-install.sh installer/doctor.sh installer/rescue.sh; do
  grep -q 'tess_redact' "$f" || fail "$f reports to the inbox without the shared privacy filter"
done
esc_lines=$(grep -h '^xml_esc() {' installer/tess-install.sh installer/updater.sh installer/wake.sh installer/tess-command.sh | sort -u | wc -l | tr -d ' ')
esc_files=$(grep -l '^xml_esc() {' installer/tess-install.sh installer/updater.sh installer/wake.sh installer/tess-command.sh | wc -l | tr -d ' ')
[ "$esc_lines" = 1 ] && [ "$esc_files" = 4 ] || fail "the plist escape differs between scripts or is missing from one"

# 6. installed code reads promoted channels only. The public stub may live on main, but nothing it installs may read it.
installed="installer/tess-install.sh installer/updater.sh installer/doctor.sh installer/rescue.sh installer/uninstall.sh installer/wake.sh installer/tess-command.sh theme/loader/loader.js"
if grep -nE '(raw\.githubusercontent\.com/.*/main/|[?&]ref=main([^[:alnum:]_-]|$)|@main/)' $installed; then
  fail "installed code reads main; use the Mac's promoted channel"
fi

# REPO may be repeated because each installed script is standalone, but every copy must name the same repository.
repo_values=$(sed -n 's/^REPO="\([^"]*\)".*/\1/p' installer/*.sh | sort -u | wc -l | tr -d ' ')
[ "$repo_values" -le 1 ] || fail "installer scripts have more than one REPO value"

# Network bytes are downloaded to a file and checked before execution. Only the public one-line stub may show curl | sh.
if grep -nE 'curl[^|]*\|[[:space:]]*([^[:space:]]+[[:space:]]+)*(sh|zsh)([[:space:];]|$)' installer/tess-install.sh installer/updater.sh installer/doctor.sh installer/rescue.sh installer/uninstall.sh installer/wake.sh installer/tess-command.sh; then
  fail "an installed script pipes a download into a shell"
fi
# The public forwarder's main fallback is allowed only while stable lacks dist/install.sh (temporary, #77).
# A channel without a signed installer refuses; the public line never runs an installer from main.
if grep -nE 'main/installer/(tess-install|legacy)' installer/install.sh; then
  fail "installer/install.sh has a fallback installer; a channel must publish a signed installer"
fi

# The folder swap runs inside tess-patcher, never in a shell: macOS's App Management protection denies /usr/bin/ditto
# when launchd starts a script under /bin/zsh, so a background theme update could never reach Spotify that way. Each
# script that swaps must call the patcher's swap-apps, and no script may build or move Spotify's folder itself.
grep -q 'case "swap-apps":' patcher/spicetify.go || fail "the patcher has no swap-apps command"
for f in installer/tess-install.sh installer/updater.sh installer/doctor.sh; do
  awk '/^swap_apps\(\) \{/{copy=1} copy{print} copy && /^\}/{exit}' "$f" | grep -q 'swap-apps "\$APPS"' \
    || fail "$f's swap_apps does not run the swap inside tess-patcher"
done
if grep -nE '\$(APPS|A0)\.tess-(new|old)' installer/*.sh; then
  fail "a shell script swaps Spotify's interface folder itself; use tess-patcher swap-apps"
fi
# A script may only read Spotify's folder out (ditto "$APPS" "$TMP/…"). A write, a move or a delete of it must stay
# inside tess-patcher: a fallback added to any one of the three swap_apps bodies would pass the checks above and still
# be the copy that macOS denies, or the delete-then-copy that leaves Spotify with no interface at all.
#
# Any use of the folder counts, not just the bare quoted name: `rm -rf "$APPS/xpui"` and `ditto "$1" "${APPS}"` write
# the live interface in place exactly as `ditto "$1" "$APPS"` does, and a kill halfway leaves Spotify half-updated.
# So each statement is split out and a write verb in it that names the folder fails the gate. The one allowed write
# shape is a copy whose *source* is the folder and whose later words do not name it (a read out); ditto is the only
# verb that may do that.
#
# A line now means one *logical* line: a trailing backslash joins the next physical line first, and the gate remembers
# the line where the statement started, because `ditto "$src" \` / `"$APPS"` is one command and the installer scripts
# already break long lines this way. Each logical line is normalised once — quotes taken off, `${APPS}` written as
# `$APPS`, slashes collapsed, a leading `/` or `./` dropped in front of a variable and after a redirect — and every rule
# below runs on that one text. Positions, not "the character before the verb", decide a word boundary: BSD awk answers
# `substr(s, 0, 1)` with the first character, so a check written that way skips a command at column 0, and
# `installer/tess-install.sh:396` is a `ditto` at column 0 today.
apps_write() {
  awk '
    BEGIN {
      QUOTE = sprintf("%c", 39)
      VERBS = "rm mv cp ditto mkdir rmdir install ln touch chmod chown tee truncate rsync dd unlink sed"
    }
    function is_folder(t) { return t ~ /^[$][{]?(APPS|A0)([^A-Za-z0-9_]|$)/ }
    # Strip what the shell ignores in front of a path word: `/`, `//` and `./` all name the same folder as the bare
    # name, so `ditto "$APPS/xpui" /"$APPS"` must read as a write into the folder, not as some other word.
    function strip_prefix(w,   p) {
      while (1) {
        p = w
        sub(/^\/+/, "", w)
        sub(/^\.\/+/, "", w)
        if (w == p) return w
      }
    }
    # One normal form per logical line. Quotes come off, so `>"$APPS/x"` and `>"$APPS"/x` are the same text; `${APPS}`
    # becomes `$APPS`; `//` becomes `/`; a comment is cut at its `#`. Everything after this matches the same way.
    function norm_line(s,   i, n, c, q, o, name) {
      o = ""; q = ""
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (q != "") { if (c == q) q = ""; else o = o c; continue }
        if (c == "\"" || c == QUOTE) { q = c; continue }
        if (c == "#" && (o == "" || o ~ /[ \t;&|]$/)) break
        o = o c
      }
      while (match(o, /[$][{][A-Za-z_][A-Za-z0-9_]*[}]/)) {
        name = substr(o, RSTART + 2, RLENGTH - 3)
        o = substr(o, 1, RSTART - 1) "$" name substr(o, RSTART + RLENGTH)
      }
      gsub(/\/+/, "/", o)
      return o
    }
    # A redirect writes the folder with no verb at all: `printf x >/"$APPS/xpui.spa"` replaced the live file in a probe.
    # `>`, `>>`, `>|` and `>&` are all redirects, a space may follow, and the path may start with a slash or `./`.
    function redirect_writes(s,   i, n, j) {
      n = length(s)
      for (i = 1; i <= n; i++) {
        if (substr(s, i, 1) != ">") continue
        j = i + 1
        while (j <= n && substr(s, j, 1) ~ /[>|&]/) j++
        while (j <= n && substr(s, j, 1) ~ /[ \t]/) j++
        while (j <= n) {
          if (substr(s, j, 1) == "/") { j++; continue }
          if (substr(s, j, 2) == "./") { j += 2; continue }
          break
        }
        if (j <= n && is_folder(substr(s, j))) return 1
      }
      return 0
    }
    # One logical line is several statements: `rm -rf "$bak"; ditto "$APPS" "$bak"` reads the folder and is fine. The
    # operators split it; nothing here looks at the character before a word, so column 0 is an ordinary boundary.
    function tokenise(s,   i, n, c, cur, nt) {
      delete TOK
      nt = 0; cur = ""
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c == " " || c == "\t") {
          if (cur != "") { TOK[++nt] = cur; cur = "" }
          continue
        }
        if (c == ";" || c == "|" || c == "&" || c == "<" || c == ">") {
          if (cur != "") { TOK[++nt] = cur; cur = "" }
          TOK[++nt] = c
          continue
        }
        cur = cur c
      }
      if (cur != "") TOK[++nt] = cur
      return nt
    }
    function is_verb(w,   n, verbs, k) {
      n = split(VERBS, verbs, " ")
      for (k = 1; k <= n; k++) {
        if (w == verbs[k]) return 1
        if (w ~ ("/" verbs[k] "$")) return 1    # /usr/bin/ditto is still ditto
      }
      return 0
    }
    # The words after a verb up to the next operator. A source is a read and a destination is a write, so positions
    # matter: `ditto "$APPS" "$TMP/a"` reads the folder out.
    function command_writes(verb, from, nt,   k, w, nw, src, ok, hit) {
      nw = 0
      for (k = from + 1; k <= nt; k++) {
        w = TOK[k]
        if (w == ";" || w == "|" || w == "&" || w == "<" || w == ">") break
        WARGS[++nw] = w
      }
      hit = 0
      for (k = 1; k <= nw; k++) if (is_folder(strip_prefix(WARGS[k]))) { hit = 1; break }
      if (!hit) return 0
      # ditto is the one verb allowed to name the folder, and only as a source with nothing after it that names the
      # folder too: `ditto "$APPS" "$APPS/xpui"` and `ditto "$APPS/xpui" "$APPS"` write the live interface in place,
      # which a kill halfway leaves half-updated.
      if (verb == "ditto") {
        src = 0
        for (k = 1; k <= nw; k++) if (substr(WARGS[k], 1, 1) != "-") { src = k; break }
        ok = (src > 0 && is_folder(strip_prefix(WARGS[src])))
        for (k = src + 1; ok && k <= nw; k++) if (is_folder(strip_prefix(WARGS[k]))) ok = 0
        if (ok) return 0
      }
      return 1
    }
    function line_writes(s,   nt, i, w) {
      s = norm_line(s)
      if (redirect_writes(s)) return 1
      nt = tokenise(s)
      for (i = 1; i <= nt; i++) {
        w = TOK[i]
        if (w == ";" || w == "|" || w == "&" || w == "<" || w == ">") continue
        if (is_verb(w) && command_writes(w, i, nt)) return 1
      }
      return 0
    }
    # A backslash at the end of a line joins the next one before anything is read. Two backslashes are an escaped
    # backslash and end the line, so only an odd run continues it.
    function continued(s,   k) {
      if (substr(s, length(s), 1) != "\\") return 0
      k = 0
      while (k < length(s) && substr(s, length(s) - k, 1) == "\\") k++
      return k % 2
    }
    {
      if (!cont) { buf = $0; start = FNR }
      else buf = buf $0
      cont = 0
      if (continued(buf)) { buf = substr(buf, 1, length(buf) - 1); cont = 1; next }
      if (line_writes(buf)) print FILENAME ":" start ": " buf
    }
    END {
      if (cont && line_writes(buf)) print FILENAME ":" start ": " buf
    }' "$@"
}
if out=$(apps_write installer/*.sh) && [ -n "$out" ]; then
  echo "$out"; fail "a script would write, move or delete Spotify's interface folder; use tess-patcher swap-apps"
fi
# The rule is only worth having if it still catches a write and still allows a read out.
apps_write_check() { # caught|allowed <fixture> <label>
  found=$(apps_write "$2")
  rm -f "$2"
  if [ "$1" = caught ]; then
    [ -n "$found" ] || fail "the Apps write check lets this through: $3"
  else
    [ -z "$found" ] || fail "the Apps write check rejects this: $3"
  fi
}
apps_write_fixture() { # the shape most installer lines have: indented inside a function
  fixture=$(mktemp)
  printf 'thing() {\n  %s\n}\n' "$2" > "$fixture"
  apps_write_check "$1" "$fixture" "$2"
}
apps_write_line0() { # the verb is the first character of the line, as at installer/tess-install.sh:396
  fixture=$(mktemp)
  printf 'fail() { exit 1; }\n%s\n' "$2" > "$fixture"
  apps_write_check "$1" "$fixture" "$2 (at column 0)"
}
apps_write_joined() { # one command written over two lines with a trailing backslash
  fixture=$(mktemp)
  printf 'thing() {\n%b\n}\n' "$2" > "$fixture"
  apps_write_check "$1" "$fixture" "$2"
}
apps_write_fixture caught 'ditto "$1" "$APPS"'
apps_write_fixture caught 'rm -rf "$APPS/xpui"'
apps_write_fixture caught 'ditto "$1" "${APPS}"'
apps_write_fixture caught 'ditto "$1" $APPS'
apps_write_fixture caught 'cp -R "$1" "$APPS/"'
apps_write_fixture caught 'mv "$APPS" "$TMP/a"'
apps_write_fixture caught 'touch "$A0/xpui.spa"'
# A copy is only a read out when the folder is the source and nothing after it names the folder: these four write the
# live interface in place, so a run killed halfway leaves Spotify half-updated.
apps_write_fixture caught 'ditto "$APPS" "$APPS"'
apps_write_fixture caught 'ditto "$APPS" "$APPS/xpui"'
apps_write_fixture caught 'ditto "$APPS/xpui" "$APPS"'
apps_write_fixture caught 'ditto "$APPS/xpui" "$APPS/other"'
apps_write_fixture caught 'ditto "$1" "$APPS"/.'
apps_write_fixture caught 'ditto "$1" "$APPS"/../Apps'
# A slash glued in front of the quotes is still the same folder to the shell. `ditto "$APPS/xpui" /"$APPS"` rewrote
# xpui.spa inside the live folder (measured), so every way of writing that prefix has to be seen through here too.
apps_write_fixture caught 'ditto "$APPS" /"$APPS"'
apps_write_fixture caught 'ditto "$APPS" /"$APPS/xpui"'
apps_write_fixture caught 'ditto "$APPS/xpui" /"$APPS"'
apps_write_fixture caught 'ditto "$1" /"$APPS"'
apps_write_fixture caught 'ditto "$APPS" /"${APPS}"'
apps_write_fixture caught 'cp -R "$1" //"$APPS"'
apps_write_fixture caught 'mv /"$APPS" "$TMP/a"'
apps_write_fixture caught 'rm -rf /"$APPS"/xpui'
apps_write_fixture caught 'touch .//"$APPS"/xpui.spa'
apps_write_fixture caught 'ditto "$APPS" ./"$APPS"'
apps_write_fixture caught 'mkdir -p /"$A0"'
apps_write_fixture allowed 'ditto "$APPS" "$TMP/a"'
apps_write_fixture allowed 'ditto "$APPS/" "$TMP/a"'
apps_write_fixture allowed 'ditto /"$APPS" "$TMP/a"'
apps_write_fixture allowed 'ditto "$APPS" /"$TMP/a"'
apps_write_fixture allowed 'ditto "$APPS" "$bak/Apps"'
apps_write_fixture allowed 'ditto "$APPS" "$ORIG.new"'
apps_write_fixture allowed 'ditto -x -k "$APPS/x.zip" "$TMP/mini"'
apps_write_fixture allowed '"$PATCHER" swap-apps "$APPS" "$1"'
apps_write_fixture allowed '"$PATCHER" can-write "$APPS"'
apps_write_fixture allowed '[ -f "$APPS/xpui.spa" ] || fail "Spotify is incomplete"'
apps_write_fixture allowed 'rm -rf "$bak"; ditto "$APPS" "$bak" || return 0'
apps_write_fixture allowed 'if grep -q spicetifyWrapper "$APPS/xpui/index.html"; then'
apps_write_fixture allowed 'ls -la "$APPS" 2>&1; ls "$T" 2>&1'
# A command at column 0 is where the installer already writes one (`installer/tess-install.sh:396`), and BSD awk
# answers "the character before position 1" with the verb's own first letter, so the old check skipped every one of
# these. A word boundary is the start of the line. The near-twin of line 396 is a read out and stays allowed.
apps_write_line0 caught 'ditto "$1" "$APPS"'
apps_write_line0 caught 'rm -rf "$APPS/xpui"'
apps_write_line0 caught 'ditto "$APPS/xpui" /"$APPS"'
apps_write_line0 caught 'cp -R "$1" "$APPS"'
apps_write_line0 allowed 'ditto "$APPS" "$ORIG.new"'
apps_write_line0 allowed 'ditto "$APPS" "$TMP/a"'
# A backslash at the end of a line joins the next one, and the installer scripts already break long lines this way. Each
# of these changed the folder in a probe while it read as two harmless lines.
apps_write_joined caught 'ditto "$src" \\\n  "$APPS"'
apps_write_joined caught 'cp -R "$src/." \\\n  "$APPS/"'
apps_write_joined caught 'rsync -a "$src/" \\\n  "$APPS/"'
apps_write_joined caught 'mv "$src/xpui.spa" \\\n  "$APPS/xpui.spa"'
apps_write_joined caught 'rm -rf \\\n  "$APPS"'
apps_write_joined caught 'rm -rf \\\n  /"$APPS"/xpui'
apps_write_joined caught 'ditto "$1" \\\n"$APPS"'
apps_write_joined allowed 'ditto "$APPS" \\\n  "$TMP/a"'
apps_write_joined allowed 'cp -R "$src/." \\\n  "$TMP/a/"'
# A redirect writes the folder with no verb at all, and a slash, a `./`, a `>|` or a `>&` in front of the quotes is
# still the same file to the shell.
apps_write_fixture caught 'printf pwned >"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >/"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned > /"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >|"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >&"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >>"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >>//"$APPS"/xpui.spa'
apps_write_fixture caught 'printf pwned >./"$APPS"/xpui.spa'
apps_write_fixture allowed 'printf pwned >"$TMP/x"'
apps_write_fixture allowed 'printf pwned >/dev/null'
apps_write_fixture allowed 'printf pwned 2>&1'
# 8. the install line pins the committed verifier, and the verifier is stored under its own hash
pin=$(sed -n "s/^VERIFY_SHA='\([0-9a-f]\{64\}\)'$/\1/p" installer/install.sh)
[ -n "$pin" ] || fail "installer/install.sh has no VERIFY_SHA pin"
[ -f "installer/verify/$pin" ] || fail "installer/verify/$pin is missing"
[ "$(shasum -a 256 "installer/verify/$pin" | cut -d' ' -f1)" = "$pin" ] || fail "installer/verify/$pin does not match its name"

# 9. Spicetify's prebuilt files are vendored; the release never downloads them, and the committed bytes match
for f in patcher/prebuilt/spicetify-2.46.4/css-map.json patcher/prebuilt/spicetify-2.46.4/jsHelper/spicetifyWrapper.js; do
  [ -s "$f" ] || fail "$f is missing; vendor Spicetify's prebuilt files"
done
(cd patcher/prebuilt/spicetify-2.46.4 && shasum -a 256 -c SHA256SUMS >/dev/null) || fail "the vendored Spicetify files do not match SHA256SUMS"
(cd patcher/prebuilt/spicetify-2.46.4 && [ "$(find css-map.json jsHelper -type f | sort)" = "$(awk '{print $2}' SHA256SUMS | sort)" ]) || fail "the vendored Spicetify files and SHA256SUMS list differ"
if grep -q 'spicetify-2.46.4-darwin' tools/release.mjs; then fail "release.mjs downloads Spicetify; use patcher/prebuilt"; fi

# 10. no script can act on a real Mac by accident (issue #107). Every entry point refuses to do anything when it is
#     sourced, and refuses to run from a git checkout or worktree outside a sandbox, where TESS_TEST=1 marks the sandbox
#     and TESS_REAL_INSTALL=1 is a person deliberately letting this exact copy act. A checkout's copy is for developing.
#     The block is byte-identical in every script, so one cannot be fixed while another is left open.
#     installer/redact.sh is a library other scripts copy a function from, not an entry point, so it is not listed here.
entry_points="installer/install.sh installer/tess-install.sh installer/uninstall.sh installer/tess-command.sh installer/updater.sh installer/doctor.sh installer/rescue.sh installer/wake.sh"
for f in $entry_points; do
  # The guard must be the first code in the file: a comment, a blank line or the shebang may come before it, nothing else.
  guard_line=$(awk -v mark='# >>> tess script guard' '
    /^[[:space:]]*$/ { next }
    /^#!/ { next }
    index($0, mark) == 1 { print NR; exit }
    /^[[:space:]]*#/ { next }
    { print "code:" NR; exit }
  ' "$f")
  case "$guard_line" in
    '') fail "$f has no source/checkout guard (issue #107); copy the block from installer/install.sh" ;;
    code:*) fail "$f runs code before its source/checkout guard (line ${guard_line#code:}, issue #107)" ;;
  esac
  grep -q '^# <<< tess script guard <<<$' "$f" || fail "$f's guard block never closes"
  # The way through is the exact value 1, compared in code. A comment or a message that names it is not enough: any
  # non-empty value, `0` and `false` included, used to let a checkout's copy act on a real Mac.
  grep -qF '[ "${TESS_REAL_INSTALL-}" != 1 ]' "$f" || fail "$f's guard lets any TESS_REAL_INSTALL value through; it must require exactly 1"
  if grep -qF '[ -z "${TESS_REAL_INSTALL-}" ]' "$f"; then fail "$f's guard accepts any non-empty TESS_REAL_INSTALL; it must require exactly 1"; fi
  # The body handed to a shell (`sh -c "$(cat …)"`, `eval`) must be refused too, not only a sourced file and a checkout.
  grep -qF '_tess_embedded' "$f" || fail "$f's guard does not refuse its text handed to a shell (sh -c, eval); issue #107"
  grep -q 'TESS_REAL_INSTALL=1' "$f" || fail "$f's guard has no TESS_REAL_INSTALL=1 way through"
done
guard_hashes=$(
  for f in $entry_points; do
    awk '/^# >>> tess script guard/{copy=1} copy{print} copy && /^# <<< tess script guard <<</{exit}' "$f" | shasum -a 256 | cut -d' ' -f1
  done | sort -u | wc -l | tr -d ' '
)
[ "$guard_hashes" = 1 ] || fail "the source/checkout guard differs between scripts; copy it across byte for byte"

echo "safety checks passed"
