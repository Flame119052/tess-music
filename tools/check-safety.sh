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
for f in installer/install.sh installer/tess-install.sh installer/uninstall.sh; do sh -n "$f" || fail "$f does not parse"; done
for f in installer/updater.sh installer/doctor.sh installer/rescue.sh; do zsh -n "$f" || fail "$f does not parse"; done

# 3. nothing a user's Mac may lack (python3 only opens an "install developer tools" prompt there)
if grep -nE '(^|[^#])\b(python3?|node|ruby|perl) ' installer/*.sh | grep -v '^\s*#'; then fail "an installer script needs a tool macOS doesn't always have"; fi

# 4. a command substitution that can fail must not stop the installer under set -e
if grep -nE '^[A-Za-z_]+=\$\((cat|grep|awk|find|ls) [^)]*\)$' installer/tess-install.sh | grep -v '|| true'; then fail "an assignment in tess-install.sh can stop it under set -e; add || true"; fi

# 5. the folder swap itself: Spotify untouched when copying fails, the result is incomplete, macOS blocks writing,
#    or an earlier run stopped halfway
(cd patcher && go test ./src/cmd/ -run Swap -count=1) || fail "swapApps tests"

# 6. installed code reads promoted channels only. The public stub may live on main, but nothing it installs may read it.
installed="installer/tess-install.sh installer/updater.sh installer/doctor.sh installer/rescue.sh installer/uninstall.sh installer/wake.sh theme/loader/loader.js"
if grep -nE '(raw\.githubusercontent\.com/.*/main/|[?&]ref=main([^[:alnum:]_-]|$)|@main/)' $installed; then
  fail "installed code reads main; use the Mac's promoted channel"
fi

# REPO may be repeated because each installed script is standalone, but every copy must name the same repository.
repo_values=$(sed -n 's/^REPO="\([^"]*\)".*/\1/p' installer/*.sh | sort -u | wc -l | tr -d ' ')
[ "$repo_values" -le 1 ] || fail "installer scripts have more than one REPO value"

# Network bytes are downloaded to a file and checked before execution. Only the public one-line stub may show curl | sh.
if grep -nE 'curl[^|]*\|[[:space:]]*([^[:space:]]+[[:space:]]+)*(sh|zsh)([[:space:];]|$)' installer/tess-install.sh installer/updater.sh installer/doctor.sh installer/rescue.sh installer/uninstall.sh installer/wake.sh; then
  fail "an installed script pipes a download into a shell"
fi
if grep -nE '\|\|[[:space:]]*curl' installer/install.sh; then fail "the public stub falls back to another installer"; fi

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

echo "safety checks passed"
