#!/bin/sh
T="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
LA="${TESS_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
channel() {
  CH=$(sed -n "s/^TESS_PARTS_CHANNEL='\(.*\)'$/\1/p" "$T/updater.env" 2>/dev/null)
  echo "${CH:-stable}"
}
# A launchd label is per user. Under TESS_TEST, /bin/launchctl is the owner's real jobs.
real_launchctl() { [ -n "$TESS_TEST" ] && [ "$(command -v launchctl)" = /bin/launchctl ]; }
lctl() { real_launchctl && return 1; command launchctl "$@"; }
case "$1" in
  update) /usr/bin/env TESS_FORCE=1 /bin/zsh "$T/updater.sh" ;;
  repair) exec /usr/bin/env TESS_CHANNEL="$(channel)" /bin/sh "$T/installer.sh" ;;
  uninstall) exec /bin/sh "$T/uninstall.sh" ;;
  doctor) /bin/zsh "$T/doctor.sh" ;;
  report) /bin/zsh "$T/doctor.sh" --report ;;
  reports)
    case "$2" in
      off) touch "$T/reports-off"; echo "Health reports are off." ;;
      on) rm -f "$T/reports-off"; echo "Health reports are on." ;;
      *) [ -f "$T/reports-off" ] && echo "Health reports are off." || echo "Health reports are on. (tess reports off)" ;;
    esac ;;
  rescue)
    case "$2" in
      off)
        touch "$T/rescue-off"
        lctl disable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        lctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        rm -f "$LA/music.tess.rescue.plist"
        echo "The Tess rescue line is off. Updates will not turn it back on." ;;
      on)
        if [ ! -x "$T/rescue/rescue.sh" ] || ! /bin/zsh "$T/rescue/rescue.sh" --adopt >/dev/null 2>&1; then
          touch "$T/rescue-off"
          lctl disable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
          lctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
          rm -f "$LA/music.tess.rescue.plist"
          echo "Couldn't read the current rescue order; the rescue line stays off. Try again when online."
          exit 1
        fi
        mkdir -p "$LA"
        RESCUE_PATH=$(printf '%s' "$T/rescue/rescue.sh" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
          '<plist version="1.0"><dict><key>Label</key><string>music.tess.rescue</string>' \
          "<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$RESCUE_PATH</string></array>" \
          '<key>StartInterval</key><integer>21600</integer><key>RunAtLoad</key><true/><key>AbandonProcessGroup</key><true/></dict></plist>' > "$LA/music.tess.rescue.plist" || exit 1
        rm -f "$T/rescue-off"
        lctl enable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        lctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        if lctl bootstrap "gui/$(id -u)" "$LA/music.tess.rescue.plist" >/dev/null 2>&1; then
          echo "The Tess rescue line is on. A current, unexpired order may run, including one sent while it was off."
        else
          touch "$T/rescue-off"
          lctl disable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
          rm -f "$LA/music.tess.rescue.plist"
          echo "The rescue line could not start; it stays off. Run tess doctor."
          exit 1
        fi
        ;;
      log) tail -100 "$T/rescue/rescue.log" 2>/dev/null || echo "No rescue orders have run." ;;
      *) if [ -f "$T/rescue-off" ]; then echo "The Tess rescue line is off. (tess rescue on)"
         elif [ ! -x "$T/rescue/tess-rescue-verify" ]; then echo "The Tess rescue line is not installed on this Mac."
         else echo "The Tess rescue line is on. (tess rescue off)"; fi ;;
    esac ;;
  status)
    VERSION=$(cat "$T/state/version" 2>/dev/null || echo unknown)
    echo "Tess $VERSION ($(channel))"
    lctl print "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 && echo "Updater: running" || echo "Updater: stopped"
    lctl print "gui/$(id -u)/music.tess.wake" >/dev/null 2>&1 && echo "Wake check: running" || echo "Wake check: stopped"
    FP=$(shasum -a 256 "$T/rescue/tess-rescue-verify" 2>/dev/null | cut -d' ' -f1)
    [ -n "$FP" ] || FP=not-installed
    if [ -f "$T/rescue-off" ]; then
      if lctl print "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1; then
        echo "Rescue: off, but the agent is still loaded; run: tess rescue off (verifier SHA-256 $FP)"
      else
        echo "Rescue: off (verifier SHA-256 $FP)"
      fi
    elif lctl print "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1; then
      echo "Rescue: on, running (verifier SHA-256 $FP)"
    else
      echo "Rescue: on, stopped (verifier SHA-256 $FP)"
    fi
    [ -f "$T/reports-off" ] && echo "Reports: off" || echo "Reports: on"
    ;;
  *) echo "usage: tess doctor | report | reports on|off | rescue on|off|log | status | update | repair | uninstall" ;;
esac
