#!/bin/sh
# Release gate: no release ships unless these pass (CI runs this before building; run it locally before pushing).
# The rule they protect: Spotify's interface folder is never deleted and then refilled. It is only ever replaced by
# switching in a complete, checked copy, so a failure at any point leaves Spotify exactly as it was.
set -e
cd "$(dirname "$0")/.."
fail() { echo "SAFETY CHECK FAILED: $1"; exit 1; }

# Stable is still the build from before Release B, so it has no dist/install.sh and the public
# install line refuses a new install. Promoting is paused. Failing here would turn every pull
# request red, so this is a notice. tools/promote.mjs is what refuses a beta that lacks the pair.
stable_installer_notice() {
  _repo=${1:-.}
  if git -C "$_repo" rev-parse -q --verify refs/remotes/origin/stable >/dev/null 2>&1; then
    if ! git -C "$_repo" cat-file -e refs/remotes/origin/stable:dist/install.sh 2>/dev/null; then
      echo "notice: origin/stable has no dist/install.sh; new installs are refused until the first promote"
    fi
  fi
}

if [ "${1:-}" = "--stable-notice" ]; then
  stable_installer_notice "${2:-.}"
  exit 0
fi

# Quoted words are not commands: the install line's own messages mention a shell inside quotes.
# A downloaded file may be run only as sh of the installer, and only after a tess-verify of that
# same file whose failure exits. Any fetch from main is refused. The one exception is the pinned
# verifier download written to $D/tess-verify. A variable set to main counts as main.
forwarder_problem() {
  awk '
    function continued(s,   k) {
      if (substr(s, length(s), 1) != "\\") return 0
      k = 0
      while (k < length(s) && substr(s, length(s) - k, 1) == "\\") k++
      return k % 2
    }
    function line_aborts(s) {
      return s ~ /[$]D\/tess-verify/ && s ~ /[$]D\/install\.sh/ && s ~ /\|\|[[:space:]]*(fail|exit)/
    }
    function note_main_vars(   i, tok, name) {
      for (i = 1; i <= nt; i++) {
        tok = TW[i]
        if (tok ~ /^[A-Za-z_][A-Za-z0-9_]*=main$/) {
          name = tok
          sub(/=main$/, "", name)
          main_vars[name] = 1
        }
      }
    }
    function forbidden(s,   name) {
      # The pinned verifier is the only download that may name main, and only as tess-verify.
      if (s ~ /\/main\// || s ~ /main\/installer\/verify\//) {
        if (s ~ /main\/installer\/verify\// && s ~ /\$D\/tess-verify/ && s !~ /install\.sh/) return 0
        return 1
      }
      if (s ~ /[?&]ref=main([^A-Za-z0-9_-]|$)/) return 1
      if (s ~ /main\/installer\/(tess-install|legacy|install)([^A-Za-z0-9_-]|$)/) return 1
      if (s ~ /main\/dist\/install/) return 1
      for (name in main_vars) {
        if (s ~ ("[?&]ref=\\$" name "([^A-Za-z0-9_]|$)")) return 1
        if (s ~ ("[?&]ref=\\$\\{" name "\\}")) return 1
        if (s ~ ("[/]\\$" name "[/]")) return 1
        if (s ~ ("[/]\\$\\{" name "\\}[/]")) return 1
      }
      return 0
    }
    function tokenize(s,   i, n, c, q, w) {
      nt = 0
      w = ""
      q = ""
      delete TW
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (q != "") {
          if (c == q) q = ""
          else w = w c
          continue
        }
        if (c == " " || c == "\t") {
          if (w != "") { nt++; TW[nt] = w; w = "" }
          continue
        }
        if (c == "\"" || c == sprintf("%c", 39)) { q = c; continue }
        if (c == ";" || c == "|" || c == "&" || c == "(" || c == ")" || c == "{" || c == "}") {
          if (w != "") { nt++; TW[nt] = w; w = "" }
          nt++; TW[nt] = c
          continue
        }
        w = w c
      }
      if (w != "") { nt++; TW[nt] = w }
    }
    function next_arg(i,   tok) {
      if (i + 1 > nt) return ""
      tok = TW[i + 1]
      if (tok == ";" || tok == "|" || tok == "&" || tok == "(" || tok == ")" || tok == "{" || tok == "}" || tok == "then" || tok == "else" || tok == "do") return ""
      return tok
    }
    function scan_execs(   i, cmdpos, tok, arg, piped, runs_download) {
      cmdpos = 1
      for (i = 1; i <= nt; i++) {
        tok = TW[i]
        # Between `in` and `)`, and after `;;`, words are case patterns. `eval|eval:*` is not a command.
        if (in_pat) {
          if (tok == "esac") { in_case = 0; in_pat = 0; cmdpos = 1; continue }
          if (tok == ")") { in_pat = 0; cmdpos = 1 }
          continue
        }
        if (tok == "esac") { in_case = 0; in_pat = 0; cmdpos = 1; continue }
        if (tok == ";" || tok == "|" || tok == "&" || tok == "(" || tok == "{" || tok == "then" || tok == "else" || tok == "do") {
          if (tok == ";" && in_case && i > 1 && TW[i - 1] == ";") in_pat = 1
          cmdpos = 1
          continue
        }
        if (tok == ")" || tok == "}" || tok == "fi" || tok == "done") continue
        if (!cmdpos) {
          if (in_case && tok == "in") in_pat = 1
          continue
        }
        if (tok == "!") { cmdpos = 1; continue }
        if (tok ~ /^[A-Za-z_][A-Za-z0-9_]*=/) continue
        if (tok == "case") in_case = 1
        # Count a shell only when it is aimed at a downloaded file, a pipe, or `sh -c`.
        arg = next_arg(i)
        piped = (i > 1 && TW[i - 1] == "|")
        runs_download = (tok == "sh" || tok == "bash" || tok == "zsh") && (arg ~ /^[$]D\// || piped || arg ~ /^-l?c$/)
        runs_download = runs_download || ((tok == "source" || tok == "." || tok == "eval") && (arg ~ /[$]D\// || piped))
        if (runs_download) {
          exec_n++
          EX_ARG[exec_n] = tok " " arg
          EX_OK[exec_n] = (tok == "sh" && arg == "$D/install.sh" && !piped) ? 1 : 0
        }
        cmdpos = 0
      }
    }
    function take(s,   exec_before, i) {
      if (s ~ /^[[:space:]]*#/ || s ~ /^[[:space:]]*$/) return
      tokenize(s)
      note_main_vars()
      if (forbidden(s)) problems = problems "installer fetched from main\n"
      exec_before = exec_n
      scan_execs()
      for (i = exec_before + 1; i <= exec_n; i++) {
        if (!seen) problems = problems "shell runs a download before tess-verify exits: " EX_ARG[i] "\n"
        else if (!EX_OK[i]) problems = problems "shell runs " EX_ARG[i] "\n"
        else allowed++
      }
      if (line_aborts(s)) seen = 1
    }
    BEGIN { seen = 0; allowed = 0; exec_n = 0; problems = ""; in_case = 0; in_pat = 0 }
    {
      if (!cont) buf = $0
      else buf = buf $0
      cont = 0
      if (continued(buf)) { buf = substr(buf, 1, length(buf) - 1); cont = 1; next }
      take(buf)
    }
    END {
      if (cont) take(buf)
      if (allowed != 1) problems = problems "expected one sh of the verified installer, found " allowed "\n"
      if (problems != "") printf "%s", problems
    }
  ' "$1"
}

if [ "${1:-}" = "--forwarder-fixture" ]; then
  [ -n "${2:-}" ] && [ -f "$2" ] || fail "--forwarder-fixture needs a file"
  out=$(forwarder_problem "$2" || true)
  if [ -n "$out" ]; then
    echo "forwarder-blocked: $out"
    exit 1
  fi
  echo "forwarder-ok"
  exit 0
fi

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
# A channel without a signed installer refuses. The public line's only shell of a downloaded file is
# the installer tess-verify accepted. A main fallback under any name fails the gate.
if out=$(forwarder_problem installer/install.sh) && [ -n "$out" ]; then
  echo "$out"
  fail "installer/install.sh runs a download tess-verify did not accept, or fetches an installer from main"
fi
forwarder_fixture() {
  fixture=$(mktemp)
  printf '%s\n' "$2" > "$fixture"
  out=$(forwarder_problem "$fixture" || true)
  rm -f "$fixture"
  if [ "$1" = blocked ]; then
    [ -n "$out" ] || fail "the install-line gate lets this through: $3"
  else
    [ -z "$out" ] || fail "the install-line gate rejects the verified installer: $3 ($out)"
  fi
}
forwarder_ok='"$D/tess-verify" "$D/install.sh" "sig" || fail "no"
sh "$D/install.sh"'
forwarder_fixture ok "$forwarder_ok" "verified installer"
forwarder_fixture blocked 'sh "$D/install.sh"' "shell before tess-verify"
forwarder_fixture blocked 'curl -fsSL "$BASE/main/dist/install.sh" -o "$D/install.sh"
'"$forwarder_ok" "installer from main/dist"
forwarder_fixture blocked 'curl -fsSL "$BASE/main/installer/legacy.sh" -o "$D/x"
'"$forwarder_ok" "legacy fallback"
forwarder_fixture blocked 'curl -fsSL "$BASE/main/installer/tess-install.sh" -o "$D/x"
'"$forwarder_ok" "tess-install fallback"
forwarder_fixture blocked 'curl -fsSL "$API/contents/dist/install.sh?ref=main" -o "$D/install.sh"
'"$forwarder_ok" "ref=main"
forwarder_fixture blocked 'curl -fsSL "$BASE/$CH/dist/install.sh" | sh
'"$forwarder_ok" "pipe into a shell"
forwarder_fixture blocked 'curl "$BASE/main/installer/verify/x" -o "$D/install.sh"
'"$forwarder_ok" "verifier path written over the installer"
forwarder_fixture blocked 'M=main
curl -fsSL "$API/contents/dist/install.sh?ref=$M" -o "$D/install.sh"
'"$forwarder_ok" "ref variable set to main"
stable_installer_notice

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
      VERBS = "rm mv cp ditto mkdir rmdir install ln touch chmod chown tee truncate rsync dd unlink sed find tar"
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
    # becomes `$APPS`; `//` becomes `/`; a comment is cut at its `#`. Quoted `(`, `)` (outside `$(...)`) and single-quoted
    # backticks are escaped so literal characters like `"("` cannot unbalance subshell depth.
    function norm_line(s,   i, n, c, nextc, q, o, name, sp, dollar, QSTACK) {
      o = ""; q = ""; sp = 0; dollar = 0
      delete QSTACK
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (q != "") {
          if (c == q) { q = ""; dollar = 0; continue }
          if (q == QUOTE) {
            if (c == "(" || c == ")" || c == "`") o = o "\\" c
            else o = o c
            dollar = 0
            continue
          }
          if (c == "\\" && i < n) {
            nextc = substr(s, i + 1, 1)
            if (nextc == "\"" || nextc == "\\" || nextc == "$" || nextc == "`") {
              o = o c nextc; i++; dollar = 0; continue
            }
          }
          if (c == "(") {
            if (dollar) { QSTACK[++sp] = q; q = ""; o = o c }
            else o = o "\\("
            dollar = 0
            continue
          }
          if (c == ")") { o = o "\\)"; dollar = 0; continue }
          dollar = (c == "$")
          o = o c
          continue
        }
        if (c == "\\" && i < n) {
          o = o c substr(s, i + 1, 1); i++; dollar = 0; continue
        }
        if (c == "\"" || c == QUOTE) { q = c; dollar = 0; continue }
        if (c == "#" && (o == "" || o ~ /[ \t;&|]$/)) break
        if (c == "(") { QSTACK[++sp] = ""; o = o c; dollar = 0; continue }
        if (c == ")") { if (sp > 0) q = QSTACK[sp--]; o = o c; dollar = 0; continue }
        dollar = (c == "$")
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
    # `>`, `>>`, `>|`, `>!` (zsh clobber) and `>&` are all redirects, a space may follow, and the path may start with a slash or `./`.
    function redirect_writes(s,   i, n, j, t) {
      n = length(s)
      for (i = 1; i <= n; i++) {
        if (substr(s, i, 1) != ">") continue
        j = i + 1
        while (j <= n && substr(s, j, 1) ~ /[>|&!]/) j++
        while (j <= n && substr(s, j, 1) ~ /[ \t]/) j++
        while (j <= n) {
          if (substr(s, j, 1) == "/") { j++; continue }
          if (substr(s, j, 2) == "./") { j += 2; continue }
          break
        }
        if (j <= n && is_folder(substr(s, j))) return 1
        if (substr(s, j, 2) == "$(" || substr(s, j, 1) == "`") {
          t = substr(s, j)
          if (match(t, /^([$][(][^)]*[)]|`[^`]*`)/) && substr(t, 1, RLENGTH) ~ /[$](APPS|A0)([^A-Za-z0-9_]|$)/) return 1
        }
      }
      return 0
    }
    # One logical line is several statements: `rm -rf "$bak"; ditto "$APPS" "$bak"` reads the folder and is fine. The
    # operators split it, including `(`, `)` and backticks so `(ditto ...)` and `$(cp ...)` expose their verbs; escaped
    # operators like `\;` and `\(` stay intact so `find ... -exec ... \; -delete` keeps its trailing flags.
    function tokenise(s,   i, n, c, nextc, cur, nt) {
      delete TOK
      nt = 0; cur = ""
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c == "\\" && i < n) {
          nextc = substr(s, i + 1, 1)
          if (nextc == "\\" || index(";|&<>()`", nextc) > 0) {
            cur = cur c nextc
            i++
            continue
          }
        }
        if (c == " " || c == "\t") {
          if (cur != "") { TOK[++nt] = cur; cur = "" }
          continue
        }
        if (index(";|&<>()`", c) > 0) {
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
    # The words after a verb up to the next operator at the same nesting level. Nested `$(...)` and backticks are
    # skipped except when a nested word names the folder (which adds a `$APPS` placeholder so the outer verb still sees
    # it), and only parens with a matching `)` enter depth > 0 so an unmatched `(` cannot hide trailing words.
    function command_writes(verb, from, nt, bt_start,   k, w, nw, depth, in_bt, sp, open_exec, bverb, src, ok, hit, m, mode, pending, ch, idx, val, opt, c_hits, f_hits, stop_opts, rm_src, STACK, MATCHED, FV) {
      delete STACK
      delete MATCHED
      delete FV
      sp = 0
      for (k = from + 1; k <= nt; k++) {
        w = TOK[k]
        if (w == "(") STACK[++sp] = k
        else if (w == ")") {
          if (sp == 0) break
          MATCHED[STACK[sp--]] = 1
          MATCHED[k] = 1
        }
      }
      nw = 0; depth = 0; in_bt = 0; open_exec = 0
      bverb = verb
      sub(/.*\//, "", bverb)
      for (k = from + 1; k <= nt; k++) {
        w = TOK[k]
        if (w == "`") {
          if (bt_start && !in_bt) break
          in_bt = !in_bt
          continue
        }
        if (w == "(" && MATCHED[k]) { depth++; continue }
        if (w == ")") {
          if (depth == 0) break
          if (MATCHED[k]) { depth--; continue }
        }
        if (depth > 0 || in_bt) {
          if (is_folder(strip_prefix(w))) WARGS[++nw] = "$APPS"
          continue
        }
        if (w == ";" && bverb == "find" && open_exec) { open_exec = 0; WARGS[++nw] = "\\;"; continue }
        if (w == ";" || w == "|" || w == "&" || w == "<" || w == ">") break
        WARGS[++nw] = w
        if (bverb == "find" && w ~ /^-(exec|execdir|ok|okdir)$/) open_exec = 1
        if (w == "\\;" || w == "+") open_exec = 0
      }
      if (bverb == "dd") {
        for (k = 1; k <= nw; k++) {
          w = WARGS[k]
          if (substr(w, 1, 3) == "of=" && is_folder(strip_prefix(substr(w, 4)))) return 1
          if (is_folder(strip_prefix(w))) return 1
        }
        return 0
      }
      if (bverb == "tar") {
        mode = ""; pending = ""; c_hits = 0; f_hits = 0; stop_opts = 0; rm_src = 0
        for (k = 1; k <= nw; k++) {
          w = WARGS[k]
          if (pending != "") {
            opt = substr(pending, 1, 1)
            pending = substr(pending, 2)
            if (opt == "C" && (is_folder(strip_prefix(w)) || (w == "$" && k < nw && WARGS[k + 1] == "$APPS"))) c_hits = 1
            if (opt == "f") {
              FV[k] = 1
              if (is_folder(strip_prefix(w)) || (w == "$" && k < nw && WARGS[k + 1] == "$APPS")) f_hits = 1
            }
            continue
          }
          if (!stop_opts && w == "--") { stop_opts = 1; continue }
          if (!stop_opts && substr(w, 1, 2) == "--") {
            if (w == "--extract" || w == "--get") mode = "x"
            else if (w == "--create" || w == "--append" || w == "--update") mode = "c"
            else if (w == "--delete" || w == "--concatenate" || w == "--catenate") mode = "c"
            else if (w == "--remove-files") rm_src = 1
            else if (w == "--list") mode = "t"
            else if (w == "--diff" || w == "--compare") mode = "d"
            else if (w ~ /^--(cd|dir[a-z]*)$/) pending = pending "C"
            else if (w ~ /^--(cd|dir[a-z]*)=/) {
              val = substr(w, index(w, "=") + 1)
              if (is_folder(strip_prefix(val)) || (val == "$" && k < nw && WARGS[k + 1] == "$APPS")) c_hits = 1
            } else if (w == "--file") pending = pending "f"
            else if (w ~ /^--file=/) {
              val = substr(w, 8)
              if (is_folder(strip_prefix(val)) || (val == "$" && k < nw && WARGS[k + 1] == "$APPS")) f_hits = 1
            }
            continue
          }
          if (!stop_opts && k == 1 && w ~ /^[A-Za-z]+$/ && w ~ /[xtcrudA]/) {   # old-style group: each f/C takes the next word, in order
            for (idx = 1; idx <= length(w); idx++) {
              ch = substr(w, idx, 1)
              if (ch == "x") mode = "x"
              else if (ch == "c" || ch == "r" || ch == "u" || ch == "A") mode = "c"
              else if (ch == "t") mode = "t"
              else if (ch == "d") mode = "d"
              else if (ch == "C" || ch == "f") pending = pending ch
            }
            continue
          }
          if (!stop_opts && substr(w, 1, 1) == "-" && length(w) > 1) {
            for (idx = 2; idx <= length(w); idx++) {
              ch = substr(w, idx, 1)
              if (ch == "x") mode = "x"
              else if (ch == "c" || ch == "r" || ch == "u" || ch == "A") mode = "c"
              else if (ch == "t") mode = "t"
              else if (ch == "d") mode = "d"
              else if (ch == "C" || ch == "f") {
                if (idx < length(w)) {           # getopt: the rest of the word is the value
                  val = substr(w, idx + 1)
                  if (is_folder(strip_prefix(val)) || (val == "$" && k < nw && WARGS[k + 1] == "$APPS")) { if (ch == "C") c_hits = 1; else f_hits = 1 }
                  if (val ~ /^[A-Za-z]+$/) pending = pending ch   # `-xCf "$APPS"`: also read the next word
                  break
                }
                pending = pending ch
              }
            }
            continue
          }
        }
        if (mode == "c") {
          if (rm_src) {
            if (c_hits) return 1
            for (k = 1; k <= nw; k++) if (is_folder(strip_prefix(WARGS[k]))) return 1
          }
          return f_hits
        }
        if (mode == "x") {
          if (c_hits) return 1
          for (k = 1; k <= nw; k++) if (!FV[k] && is_folder(strip_prefix(WARGS[k]))) return 1
          return 0
        }
        if (mode == "t" || mode == "d") return 0
        return c_hits || f_hits
      }
      hit = 0
      for (k = 1; k <= nw; k++) if (is_folder(strip_prefix(WARGS[k]))) { hit = 1; break }
      if (!hit) return 0
      if (bverb == "find") {
        for (k = 1; k <= nw; k++) {
          w = WARGS[k]
          if (w == "-delete") return 1
          if ((w == "-fprint" || w == "-fprint0" || w == "-fprintf" || w == "-fls") && k < nw) {
            val = strip_prefix(WARGS[k + 1])
            if (is_folder(val) || (val == "$" && k + 1 < nw && WARGS[k + 2] == "$APPS")) return 1
          }
          if (w == "-exec" || w == "-execdir" || w == "-ok" || w == "-okdir") {
            for (m = k + 1; m <= nw && WARGS[m] != "\\;" && WARGS[m] != "+"; m++)
              if (is_verb(WARGS[m]) || WARGS[m] ~ /(^|\/)(sh|zsh|bash|dash)$/) return 1
          }
        }
        return 0
      }
      # ditto is the one verb allowed to name the folder, and only as a source with nothing after it that names the
      # folder too: `ditto "$APPS" "$APPS/xpui"` and `ditto "$APPS/xpui" "$APPS"` write the live interface in place,
      # which a kill halfway leaves half-updated.
      if (bverb == "ditto") {
        src = 0
        for (k = 1; k <= nw; k++) if (substr(WARGS[k], 1, 1) != "-") { src = k; break }
        ok = (src > 0 && is_folder(strip_prefix(WARGS[src])))
        for (k = src + 1; ok && k <= nw; k++) if (is_folder(strip_prefix(WARGS[k]))) ok = 0
        if (ok) return 0
      }
      return 1
    }
    function line_writes(s,   nt, i, w, bt) {
      s = norm_line(s)
      if (redirect_writes(s)) return 1
      nt = tokenise(s)
      bt = 0
      for (i = 1; i <= nt; i++) {
        w = TOK[i]
        if (w == "`") { bt = !bt; continue }
        if (w == ";" || w == "|" || w == "&" || w == "<" || w == ">" || w == "(" || w == ")") continue
        if (is_verb(w) && command_writes(w, i, nt, bt)) return 1
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
# Rare write paths (#111): glued subshells/command substitutions, dd of=, find -delete/-exec rm, tar -C, and zsh >! / >|.
apps_write_fixture caught '(ditto x "$APPS")'
apps_write_fixture caught '$(cp a "$APPS/x")'
apps_write_fixture caught 'out=$(ditto "$1" "$APPS")'
apps_write_fixture caught 'out=$(cp -R "$1/." "$APPS/")'
apps_write_fixture caught '`ditto "$1" "$APPS"`'
apps_write_fixture caught 'out=`cp a "$APPS/x"`'
apps_write_fixture caught 'cp "$(dirname "$0")/foo" "$APPS/bar"'
apps_write_fixture allowed '(ditto "$APPS" "$TMP/a")'
apps_write_fixture allowed 'out=$(ditto "$APPS" "$TMP/a")'
apps_write_fixture allowed '`ditto "$APPS" "$TMP/a"`'
apps_write_fixture caught 'ditto "$APPS" "$(dirname "$APPS")/Apps.bak"'
apps_write_fixture caught 'rm -rf "$(dirname "$APPS")"'
apps_write_fixture caught 'ditto "$1" "$(dirname "$APPS")/Apps"'
apps_write_fixture caught 'find "$(dirname "$APPS")" -delete'
apps_write_fixture caught 'mv "$(dirname "$APPS")" x'
apps_write_fixture caught 'rm -rf "(" "$APPS"'
apps_write_fixture caught 'find "$APPS" -name "(" -delete'
apps_write_fixture caught 'tar -xf "(" -C "$APPS"'
apps_write_fixture caught 'ditto "(" "$APPS"'
apps_write_fixture caught 'find "$APPS" -name "$(echo "(")" -delete'
apps_write_fixture allowed 'ditto "$APPS" "$(dirname "$TMP")/Apps.bak"'
apps_write_fixture allowed 'ditto "$APPS" "("'
apps_write_fixture caught 'dd if=src of="$APPS/xpui.spa"'
apps_write_fixture caught 'dd if=src of=/"$APPS/xpui.spa"'
apps_write_fixture caught 'dd bs=4096 of="${APPS}/xpui.spa" < src'
apps_write_fixture caught 'dd if="$APPS/xpui.spa" of="$APPS/other.spa"'
apps_write_fixture allowed 'dd if="$APPS/xpui.spa" of="$TMP/out.spa"'
apps_write_fixture allowed 'dd if="$APPS/xpui.spa"'
apps_write_fixture caught 'find "$APPS" -delete'
apps_write_fixture caught 'find "$APPS" -name "*.spa" -delete'
apps_write_fixture caught 'find "$APPS" \( -name "*.js" -o -name "*.css" \) -delete'
apps_write_fixture caught 'find "$APPS" -exec rm {} \;'
apps_write_fixture caught 'find "$APPS" -exec rm -rf {} +'
apps_write_fixture caught 'find "$APPS" -exec /bin/rm -f {} \;'
apps_write_fixture caught 'find "$APPS" -exec nice rm {} \;'
apps_write_fixture caught 'find "$TMP" -exec rm "$APPS/xpui.spa" \;'
apps_write_fixture caught 'find "$APPS" -exec grep -l foo {} \; -delete'
apps_write_fixture caught 'find "$APPS" -exec true {} '"';'"' -delete'
apps_write_fixture caught 'find "$APPS" -exec true {} ";" -delete'
apps_write_fixture caught 'find "$TMP" -fprint "$APPS/list"'
apps_write_fixture caught 'find "$TMP" -fprint0 "$APPS/list"'
apps_write_fixture caught 'find "$TMP" -fprintf "$APPS/list" "%p\n"'
apps_write_fixture caught 'find "$TMP" -fls "$APPS/list"'
apps_write_fixture allowed 'find "$APPS" -exec ls -la {} '"';'"''
apps_write_fixture allowed 'find "$APPS" -exec ls -la {} '"';'"'; rm -rf "$TMP"'
apps_write_fixture allowed 'find "$APPS" -name "*.spa"'
apps_write_fixture allowed 'find "$APPS" -type f -print'
apps_write_fixture allowed 'find "$APPS" -fprint "$TMP/list"'
apps_write_fixture allowed 'find "$APPS" -exec ls -la {} +'
apps_write_fixture allowed 'find "$STATE" \( -name ".reapply-*" -o -name ".asked-*" \) -delete'
apps_write_fixture caught 'tar -xf a.tar -C "$APPS"'
apps_write_fixture caught 'tar -xzf "$TMP/p.tgz" -C "$APPS/xpui"'
apps_write_fixture caught 'tar -C "$APPS" -xf a.tar'
apps_write_fixture caught 'tar -xf - -C "$APPS"'
apps_write_fixture caught 'tar -xzf a.tgz -C/"$APPS"'
apps_write_fixture caught 'tar --extract --file=a.tar --directory="$APPS"'
apps_write_fixture caught 'tar --extract --file=a.tar --dir="$APPS"'
apps_write_fixture caught 'tar -xf a.tar --cd="$APPS"'
apps_write_fixture caught 'tar -xCf "$APPS" a.tar'
apps_write_fixture caught 'tar -xfa.tar -C "$APPS"'
apps_write_fixture caught 'tar -xvfarchive -C "$APPS"'
apps_write_fixture caught 'tar xzf a.tgz -C "$APPS"'
apps_write_fixture caught 'tar Cxf "$APPS" a.tar'
apps_write_fixture caught 'tar fxC a.tar "$APPS"'
apps_write_fixture caught 'tar -cf "$APPS/bak.tar" "$TMP/x"'
apps_write_fixture caught 'tar -Af "$APPS/a.tar" b.tar'
apps_write_fixture caught 'tar --delete -f "$APPS/a.tar" x'
apps_write_fixture caught 'tar --concatenate -f "$APPS/a.tar" b.tar'
apps_write_fixture caught 'tar --catenate -f "$APPS/a.tar" b.tar'
apps_write_fixture caught 'tar -czf "$TMP/b.tgz" --remove-files "$APPS"'
apps_write_fixture caught 'tar -czf "$TMP/b.tgz" --remove-files --directory="$APPS" .'
apps_write_fixture allowed 'tar -czf "$TMP/bak.tgz" "$APPS"'
apps_write_fixture allowed 'tar -czf "$TMP/bak.tgz" -C "$APPS" .'
apps_write_fixture allowed 'tar -C "$APPS" -czf "$TMP/bak.tgz" .'
apps_write_fixture allowed 'tar cfC "$TMP/b.tar" "$APPS" .'
apps_write_fixture allowed 'tar -xf "$APPS/bak.tar" -C "$TMP/out"'
apps_write_fixture allowed 'tar -tf "$APPS/bak.tar"'
apps_write_fixture caught 'printf pwned >!"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >! "$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >! /"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >>!"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >&!"$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >| "$APPS/xpui.spa"'
apps_write_fixture caught 'printf pwned >| /"$APPS/xpui.spa"'
apps_write_fixture caught 'printf x >"$(dirname "$APPS")/Apps/xpui.spa"'
apps_write_fixture caught 'printf x >`dirname "$APPS"`/Apps/xpui.spa'
apps_write_fixture allowed 'printf x >"$(dirname "$TMP")/x"'
apps_write_fixture allowed 'printf pwned >!"$TMP/x"'
apps_write_fixture allowed 'printf pwned >|"$TMP/x"'
apps_write_fixture allowed 'cat <"$APPS/xpui.spa" >!"$TMP/x"'
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
if grep -nE 'spicetify-2\.46\.4-darwin|check-spicetify-upstream' tools/release.mjs .github/workflows/release.yml; then
  fail "the release downloads Spicetify or runs the maintainer upstream check; vendor the files"
fi

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
