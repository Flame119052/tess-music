#!/bin/sh
# Release gate: no release ships unless these pass (CI runs this before building; run it locally before pushing).
# The rule they protect: Spotify's interface folder is never deleted and then refilled. It is only ever replaced by
# switching in a complete, checked copy, so a failure at any point leaves Spotify exactly as it was.
set -e
cd "$(dirname "$0")/.."
fail() { echo "SAFETY CHECK FAILED: $1"; exit 1; }

# 1. no delete-then-copy of Spotify's folder anywhere
if grep -nE 'rm -rf "?\$(APPS|A0)"?( |;|$)' installer/*.sh; then fail "a script deletes Spotify's interface folder directly; use swap_apps"; fi
if grep -rn 'RemoveAll(appDestPath)' patcher/src; then fail "the patcher deletes Spotify's interface folder directly; use swapApps"; fi

# 2. every script parses
for f in installer/install.sh installer/tess-install.sh installer/uninstall.sh installer/tess-command.sh installer/redact.sh; do sh -n "$f" || fail "$f does not parse"; done
for f in installer/updater.sh installer/doctor.sh installer/rescue.sh installer/wake.sh; do zsh -n "$f" || fail "$f does not parse"; done
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

# The three shell swaps protect the same precious folder and must not drift.
swap_hashes=$(
  for f in installer/tess-install.sh installer/updater.sh installer/doctor.sh; do
    awk '/^swap_apps\(\) \{/{copy=1} copy{print} copy && /^\}/{exit}' "$f" | shasum -a 256 | cut -d' ' -f1
  done | sort -u | wc -l | tr -d ' '
)
[ "$swap_hashes" = 1 ] || fail "the three swap_apps bodies differ"
recovery_count=$(grep -lF 'if [ ! -d "$APPS" ] && [ -d "$_old" ]; then mv "$_old" "$APPS" || return 1; fi' \
  installer/tess-install.sh installer/updater.sh installer/doctor.sh | wc -l | tr -d ' ')
[ "$recovery_count" = 3 ] || fail "every swap_apps must restore an interrupted .tess-old swap first"
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
