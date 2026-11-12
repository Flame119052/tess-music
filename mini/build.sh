#!/bin/zsh
# Build "Tess Mini.app" into ~/Applications and run it at login (hidden until Tess asks for it).
set -e
cd "$(dirname "$0")"
APP="$HOME/Applications/Tess Mini.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -parse-as-library TessMini.swift -o "$APP/Contents/MacOS/TessMini" -framework AppKit -framework SwiftUI 2>&1 | grep -v "^$" || true
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>music.tess.mini</string>
<key>CFBundleName</key><string>Tess Mini</string>
<key>CFBundleExecutable</key><string>TessMini</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSAppleEventsUsageDescription</key><string>Tess Mini shows what Spotify is playing and controls it.</string>
</dict></plist>
PL
codesign --force --sign - "$APP" 2>/dev/null || true
PLIST="$HOME/Library/LaunchAgents/music.tess.mini.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.mini</string>
<key>ProgramArguments</key><array><string>$APP/Contents/MacOS/TessMini</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
PL
launchctl bootout gui/$(id -u)/music.tess.mini 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
echo "Tess Mini built and running"
