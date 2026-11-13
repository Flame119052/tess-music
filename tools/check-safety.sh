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
for f in installer/install.sh installer/uninstall.sh; do sh -n "$f" || fail "$f does not parse"; done
for f in installer/updater.sh installer/doctor.sh installer/rescue.sh; do zsh -n "$f" || fail "$f does not parse"; done

# 3. nothing a user's Mac may lack (python3 only opens an "install developer tools" prompt there)
if grep -nE '(^|[^#])\b(python3?|node|ruby|perl) ' installer/*.sh | grep -v '^\s*#'; then fail "an installer script needs a tool macOS doesn't always have"; fi

# 4. a command substitution that can fail must not stop the installer under set -e
if grep -nE '^[A-Za-z_]+=\$\((cat|grep|awk|find|ls) [^)]*\)$' installer/install.sh | grep -v '|| true'; then fail "an assignment in install.sh can stop it under set -e; add || true"; fi

# 5. the folder swap itself: Spotify untouched when copying fails, the result is incomplete, macOS blocks writing,
#    or an earlier run stopped halfway
(cd patcher && go test ./src/cmd/ -run Swap -count=1) || fail "swapApps tests"

echo "safety checks passed"
