#!/bin/sh
T="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
LA="${TESS_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
channel() {
  CH=$(sed -n "s/^TESS_PARTS_CHANNEL='\(.*\)'$/\1/p" "$T/updater.env" 2>/dev/null)
  echo "${CH:-stable}"
}
case "$1" in
  update) /usr/bin/env TESS_FORCE=1 /bin/zsh "$T/updater.sh" ;;
  repair) /usr/bin/env TESS_CHANNEL="$(channel)" /bin/sh "$T/installer.sh" ;;
  uninstall) /bin/sh "$T/uninstall.sh" ;;
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
        launchctl disable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        launchctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        rm -f "$LA/music.tess.rescue.plist"
        echo "The Tess rescue line is off. Updates will not turn it back on." ;;
      on)
        rm -f "$T/rescue-off"
        launchctl enable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        [ -f "$LA/music.tess.rescue.plist" ] || /usr/bin/env TESS_FORCE=1 /bin/zsh "$T/updater.sh" >/dev/null 2>&1
        [ -x "$T/rescue/rescue.sh" ] && /bin/zsh "$T/rescue/rescue.sh" --adopt >/dev/null 2>&1
        launchctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        launchctl bootstrap "gui/$(id -u)" "$LA/music.tess.rescue.plist" >/dev/null 2>&1 \
          && echo "The Tess rescue line is on. Orders sent while it was off will not run." || echo "The rescue line could not start; run tess doctor."
        ;;
      log) tail -100 "$T/rescue/rescue.log" 2>/dev/null || echo "No rescue orders have run." ;;
      *) [ -f "$T/rescue-off" ] && echo "The Tess rescue line is off. (tess rescue on)" || echo "The Tess rescue line is on. (tess rescue off)" ;;
    esac ;;
  status)
    VERSION=$(cat "$T/state/version" 2>/dev/null || echo unknown)
    echo "Tess $VERSION ($(channel))"
    launchctl print "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 && echo "Updater: running" || echo "Updater: stopped"
    launchctl print "gui/$(id -u)/music.tess.wake" >/dev/null 2>&1 && echo "Wake check: running" || echo "Wake check: stopped"
    FP=$(shasum -a 256 "$T/rescue/tess-rescue-verify" 2>/dev/null | cut -d' ' -f1)
    [ -n "$FP" ] || FP=not-installed
    if [ -f "$T/rescue-off" ]; then
      echo "Rescue: off (verifier SHA-256 $FP)"
    elif launchctl print "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1; then
      echo "Rescue: on, running (verifier SHA-256 $FP)"
    else
      echo "Rescue: on, stopped (verifier SHA-256 $FP)"
    fi
    [ -f "$T/reports-off" ] && echo "Reports: off" || echo "Reports: on"
    ;;
  *) echo "usage: tess doctor | report | reports on|off | rescue on|off|log | status | update | repair | uninstall" ;;
esac
