#!/bin/sh
# The one privacy filter for everything Tess sends off a Mac: a failed install, the doctor's report, and a rescue
# order's report. Nothing personal survives it:
#   - home folders, of this account and of any other account on the Mac (/Users/<name> -> ~)
#   - this account's short name, where it stands alone (-> user)
#   - this Mac's computer and local host names (-> this-mac)
#   - email addresses (-> (email))
# It is one function copied byte for byte into each script that reports, because every installed script is standalone
# and may run before the others exist. tools/check-safety.sh fails if a copy drifts, so a report path cannot grow a
# weaker filter than its neighbours (that is how the installer used to leak the account name while the doctor did not).
#   body | tess_redact
# Written for sh, zsh, awk and nothing else: it runs on a Mac with no developer tools installed.
tess_redact() {
  _rh="$HOME"
  # `|| true` because the installer runs under set -e and a missing scutil must not stop a report
  _ru=$(id -un 2>/dev/null || true)
  _rc=$(scutil --get ComputerName 2>/dev/null || true)
  _rl=$(scutil --get LocalHostName 2>/dev/null || true)
  LC_ALL=C awk -v home="$_rh" -v acct="$_ru" -v host="$_rc" -v lhost="$_rl" '
    # Literal replacement. sed and gsub would read a path containing . or & as a pattern, or a & in the replacement.
    function lit(s, from, to,   out, p) {
      if (from == "") return s
      out = ""
      while ((p = index(s, from)) > 0) { out = out substr(s, 1, p - 1) to; s = substr(s, p + length(from)) }
      return out s
    }
    # A bare account name means a person only where no letter or digit touches it, so "mac" cannot turn "macOS" into
    # "userOS" and a file called "sam.jones.bak" is still replaced.
    function word(s, w, to,   out, p, b, a) {
      if (w == "") return s
      out = ""
      while ((p = index(s, w)) > 0) {
        b = (p > 1) ? substr(s, p - 1, 1) : ""
        a = substr(s, p + length(w), 1)
        if (b ~ /[A-Za-z0-9]/ || a ~ /[A-Za-z0-9]/) { out = out substr(s, 1, p); s = substr(s, p + 1) }
        else { out = out substr(s, 1, p - 1) to; s = substr(s, p + length(w)) }
      }
      return out s
    }
    {
      line = $0
      # a home folder of any account on the Mac, including one whose name starts like this one
      while (match(line, /\/Users\/[A-Za-z0-9._-]+/)) line = substr(line, 1, RSTART - 1) "~" substr(line, RSTART + RLENGTH)
      line = lit(line, home, "~")
      gsub(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "(email)", line)
      line = lit(line, host, "this-mac")
      line = lit(line, lhost, "this-mac")
      if (length(acct) >= 3) line = word(line, acct, "user")
      print line
    }'
}
