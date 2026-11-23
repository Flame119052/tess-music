// Tess Mini — a native floating miniplayer for Spotify.
//
// A small glass panel that floats above every app, on every Space and over full-screen apps. It reads and controls
// the Spotify app through its AppleScript interface (so it works with or without Tess), and shows the current lyric
// line when Tess's theme sends it (POST http://127.0.0.1:38411/lyric?k=…). Tess's theme toggles it with
// GET /toggle?k=…. The token is minted at launch and only Spotify's page can read it. Drag anywhere to move;
// resize to switch between the square tile and the slim strip.

import AppKit
import SwiftUI
import Network

// MARK: - Spotify bridge

struct Track: Equatable {
  var id = "", name = "", artist = "", album = "", artURL = ""
  var duration: Double = 1, position: Double = 0, playing = false
}

final class Spotify: ObservableObject {
  @Published var track = Track()
  @Published var art: NSImage?
  @Published var lyric = ""
  /// sung lines as (start, end) in ms, from Tess, for the lyric ribbon
  @Published var lines: [(Double, Double)] = []
  @Published var linesDuration: Double = 1
  @Published var running = false
  private var lastPoll = Date()
  private var artFor = ""

  private func run(_ source: String) -> NSAppleEventDescriptor? {
    var err: NSDictionary?
    return NSAppleScript(source: source)?.executeAndReturnError(&err)
  }

  func poll() {
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.spotify.client").isEmpty == false
    DispatchQueue.main.async { self.running = running }
    guard running else { return }
    let s = """
    tell application "Spotify"
      set t to current track
      return {id of t, name of t, artist of t, album of t, artwork url of t, (duration of t) / 1000, player position, (player state is playing)}
    end tell
    """
    guard let r = run(s), r.numberOfItems >= 8 else { return }
    func str(_ i: Int) -> String { r.atIndex(i)?.stringValue ?? "" }
    var t = Track()
    t.id = str(1); t.name = str(2); t.artist = str(3); t.album = str(4); t.artURL = str(5)
    t.duration = max(1, Double(str(6)) ?? 1)
    t.position = Double(str(7)) ?? 0
    t.playing = r.atIndex(8)?.booleanValue ?? false
    lastPoll = Date()
    DispatchQueue.main.async {
      if t.id != self.track.id { self.lyric = ""; self.lines = [] }
      self.track = t
    }
    if t.artURL != artFor, let url = URL(string: t.artURL) {
      artFor = t.artURL
      URLSession.shared.dataTask(with: url) { data, _, _ in
        if let data, let img = NSImage(data: data) { DispatchQueue.main.async { self.art = img } }
      }.resume()
    }
  }

  /// position between polls, so the scrubber moves smoothly
  var livePosition: Double {
    track.playing ? min(track.duration, track.position + Date().timeIntervalSince(lastPoll)) : track.position
  }

  func playPause() { _ = run("tell application \"Spotify\" to playpause"); refreshSoon() }
  func next() { _ = run("tell application \"Spotify\" to next track"); refreshSoon() }
  func previous() { _ = run("tell application \"Spotify\" to previous track"); refreshSoon() }
  func seek(_ seconds: Double) { _ = run("tell application \"Spotify\" to set player position to \(seconds)"); refreshSoon() }
  func openSpotify() { NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Spotify.app")) }
  private func refreshSoon() { DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) { self.poll() } }
}

// MARK: - Liquid glass view

struct Glass: ViewModifier {
  var radius: CGFloat
  func body(content: Content) -> some View {
    content
      .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: radius, style: .continuous)
          .strokeBorder(LinearGradient(colors: [.white.opacity(0.55), .white.opacity(0.08), .white.opacity(0.22)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1)
      )
      .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
  }
}
extension View { func glass(_ r: CGFloat) -> some View { modifier(Glass(radius: r)) } }

final class UIState: ObservableObject {
  @Published var hover = false
  @Published var now = Date()
}

struct MiniView: View {
  @ObservedObject var sp: Spotify
  var close: () -> Void
  @ObservedObject var ui: UIState
  private let clock = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

  var body: some View {
    GeometryReader { geo in
      let strip = geo.size.height < 170
      ZStack {
        // artwork fills the panel; a blurred copy behind for the strip
        if let art = sp.art {
          Image(nsImage: art).resizable().aspectRatio(contentMode: .fill)
            .frame(width: geo.size.width, height: geo.size.height).clipped()
            .blur(radius: strip ? 30 : 0).overlay(Color.black.opacity(strip ? 0.25 : 0))
        } else {
          LinearGradient(colors: [Color(white: 0.18), Color(white: 0.08)], startPoint: .top, endPoint: .bottom)
        }
        LinearGradient(colors: [.black.opacity(0.35), .clear, .clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom)

        if strip { stripBody } else { tileBody(geo.size) }

        // close + open-Spotify, shown on hover
        VStack {
          HStack(spacing: 6) {
            CircleButton(symbol: "xmark", action: close)
            Spacer()
            CircleButton(symbol: "arrow.up.left.and.arrow.down.right", action: sp.openSpotify)
          }
          Spacer()
        }
        .padding(8)
        .opacity(ui.hover ? 1 : 0)
      }
      .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
      .onHover { h in withAnimation(.easeOut(duration: 0.18)) { ui.hover = h } }
    }
    .onReceive(clock) { ui.now = $0 }
  }

  @ViewBuilder func tileBody(_ size: CGSize) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(sp.lyric.isEmpty ? " " : sp.lyric)
        .font(.system(size: 17, weight: .heavy)).foregroundStyle(.white)
        .shadow(color: .black.opacity(0.6), radius: 8).lineLimit(3)
        .padding(.top, 40).padding(.horizontal, 16)
        .animation(.easeOut(duration: 0.3), value: sp.lyric)
      Spacer()
      VStack(alignment: .leading, spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text(sp.track.name).font(.system(size: 15, weight: .bold)).lineLimit(1)
          Text(sp.track.artist).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
        }
        Scrubber(sp: sp, now: ui.now)
        HStack(spacing: 34) {
          IconButton(symbol: "backward.fill", size: 18, action: sp.previous)
          IconButton(symbol: sp.track.playing ? "pause.fill" : "play.fill", size: 24, action: sp.playPause)
          IconButton(symbol: "forward.fill", size: 18, action: sp.next)
        }.frame(maxWidth: .infinity)
      }
      .foregroundStyle(.white)
      .padding(.horizontal, 14).padding(.vertical, 12)
      .glass(20)
      .padding(10)
    }
  }

  var stripBody: some View {
    HStack(spacing: 12) {
      if let art = sp.art {
        Image(nsImage: art).resizable().aspectRatio(contentMode: .fill).frame(width: 46, height: 46)
          .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(sp.lyric.isEmpty ? sp.track.name : sp.lyric).font(.system(size: 13.5, weight: .bold)).lineLimit(1)
        Text(sp.track.artist).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
        Scrubber(sp: sp, now: ui.now)
      }
      HStack(spacing: 16) {
        IconButton(symbol: "backward.fill", size: 14, action: sp.previous)
        IconButton(symbol: sp.track.playing ? "pause.fill" : "play.fill", size: 18, action: sp.playPause)
        IconButton(symbol: "forward.fill", size: 14, action: sp.next)
      }
    }
    .foregroundStyle(.white)
    .padding(.horizontal, 12).padding(.vertical, 10)
    .glass(16)
    .padding(8)
  }
}

struct Scrubber: View {
  @ObservedObject var sp: Spotify
  var now: Date
  @GestureState private var dragging: Double? = nil
  var body: some View {
    GeometryReader { g in
      let p = dragging ?? (sp.livePosition / sp.track.duration)
      ZStack(alignment: .leading) {
        Capsule().fill(.white.opacity(0.25))
        Capsule().fill(.white).frame(width: max(4, g.size.width * CGFloat(min(1, p))))
      }
      .frame(height: dragging == nil ? 4 : 7)
      .frame(maxHeight: .infinity)
      .contentShape(Rectangle())
      .gesture(DragGesture(minimumDistance: 0)
        .updating($dragging) { v, state, _ in state = Double(max(0, min(1, v.location.x / g.size.width))) }
        .onEnded { v in sp.seek(Double(max(0, min(1, v.location.x / g.size.width))) * sp.track.duration) })
      .animation(.easeOut(duration: 0.15), value: dragging == nil)
    }
    .frame(height: 14)
  }
}

struct Press: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.scaleEffect(configuration.isPressed ? 0.86 : 1)
      .animation(.spring(response: 0.25, dampingFraction: 0.6), value: configuration.isPressed)
  }
}

struct IconButton: View {
  var symbol: String, size: CGFloat, action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: size, weight: .semibold))
        .frame(width: size + 18, height: size + 14).contentShape(Rectangle())
    }.buttonStyle(Press())
  }
}

struct CircleButton: View {
  var symbol: String, action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
        .frame(width: 22, height: 22).glass(11)
    }.buttonStyle(.plain)
  }
}

// MARK: - Window

final class Panel: NSPanel {
  override var canBecomeKey: Bool { true }
}

final class App: NSObject, NSApplicationDelegate {
  let sp = Spotify()
  let miniToken = miniNewToken()
  var panel: Panel!
  var listener: NWListener?
  var pollTimer: Timer?

  func applicationDidFinishLaunching(_ n: Notification) {
    let frame = savedFrame() ?? NSRect(x: (NSScreen.main?.visibleFrame.maxX ?? 1400) - 360, y: 120, width: 320, height: 340)
    panel = Panel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.isMovableByWindowBackground = true
    panel.hidesOnDeactivate = false
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    panel.minSize = NSSize(width: 260, height: 70)
    panel.maxSize = NSSize(width: 640, height: 640)
    let host = NSHostingView(rootView: MiniView(sp: sp, close: { [weak self] in self?.hide() }, ui: UIState()))
    host.wantsLayer = true
    host.layer?.cornerRadius = 18
    host.layer?.masksToBounds = true
    panel.contentView = host
    NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: .main) { [weak self] _ in self?.saveFrame() }
    NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: panel, queue: .main) { [weak self] _ in self?.saveFrame() }

    pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
      guard let self, self.panel.isVisible else { return }
      DispatchQueue.global(qos: .userInitiated).async { self.sp.poll() }
    }
    startServer()
    if CommandLine.arguments.contains("--show") { show() }
  }

  func show() { DispatchQueue.global().async { self.sp.poll() }; panel.orderFrontRegardless() }
  func hide() { panel.orderOut(nil) }
  func toggle() { panel.isVisible ? hide() : show() }

  func savedFrame() -> NSRect? {
    guard let s = UserDefaults.standard.string(forKey: "frame") else { return nil }
    let r = NSRectFromString(s)
    return r.width > 0 ? r : nil
  }
  func saveFrame() { UserDefaults.standard.set(NSStringFromRect(panel.frame), forKey: "frame") }

  let piBridge = PiSupportBridge()

  func supportState() -> String {
    piBridge.supportState()
  }

  // Tess's theme talks to the miniplayer over localhost. The gate checks the token before any of these run.
  func startServer() {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 38411)
    guard let l = try? NWListener(using: params) else { return }
    l.newConnectionHandler = { [weak self] c in
      c.start(queue: .global())
      self?.readHTTP(c, acc: Data())
    }
    l.start(queue: .global())
    listener = l
  }

  private func readHTTP(_ c: NWConnection, acc: Data) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, _ in
      guard let self else { c.cancel(); return }
      var buf = acc
      if let data { buf.append(data) }
      if !isComplete && buf.count < 131072, let sep = buf.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: buf[..<sep.lowerBound], as: UTF8.self)
        var need = 0
        for line in head.components(separatedBy: "\r\n").dropFirst() {
          let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
          if parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length",
             let n = Int(parts[1].trimmingCharacters(in: .whitespaces)) {
            need = min(max(n, 0), 131072)
          }
        }
        if buf.count - sep.upperBound < need {
          self.readHTTP(c, acc: buf)
          return
        }
      }
      let req = String(decoding: buf, as: UTF8.self)
      let reply = miniHandle(
        raw: req,
        token: self.miniToken,
        supportState: { self.piBridge.supportState() },
        supportStatusJSON: { self.piBridge.statusJSON() },
        supportEventsJSON: { after in self.piBridge.eventsJSON(after: after) },
        bridgeSecret: self.piBridge.bridgeSecret,
        bridgeHandler: { body in self.piBridge.handleBridgeCommand(rawBody: body) }
      )
      DispatchQueue.main.async {
        switch reply.effect {
        case .toggle: self.toggle()
        case .show: self.show()
        case .hide: self.hide()
        case .support: self.piBridge.triggerInstall()
        case .supportDecline: self.piBridge.declineInvite()
        case .supportSend(let body): self.piBridge.send(rawBody: body)
        case .supportAbort: self.piBridge.abort()
        case .supportReset: self.piBridge.reset()
        case .supportCmdResult(let body): self.piBridge.resolveSpotifyCommand(rawBody: body)
        case .lyric(let text): self.sp.lyric = text
        case .lines(let body):
          if let d = body.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
             let lines = o["l"] as? [[Double]], let dur = o["d"] as? Double {
            self.sp.lines = lines.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
            self.sp.linesDuration = max(1, dur)
          }
        case .none: break
        }
      }
      c.send(content: (reply.head + reply.body).data(using: .utf8), completion: .contentProcessed { _ in c.cancel() })
    }
  }
}

// Manages the stripped Pi standalone binary (--mode rpc) for Tess Support inside Spotify.
// TESS_SUPPORT_TOKEN is read only from chmod-600 support/token into Pi's process environment and never sent over HTTP.
final class PiSupportBridge {
  let bridgeSecret = miniNewToken()
  private let lock = NSLock()
  private var proc: Process?
  private var stdinPipe: Pipe?
  private var stdoutBuf = Data()
  private var seq = 0
  private var cmdSeq = 0
  private var busy = false
  private var supportErrors = MiniSupportErrors()
  private var lastActive = Date()
  private var events: [[String: Any]] = []
  private var idleTimer: Timer?
  private var pendingCmds: [String: (sem: DispatchSemaphore, result: String?)] = [:]

  private let questionStill = "May I take one still of the Spotify window? It can show your Spotify name, your picture, your friends' activity, and your playlist names."
  private let questionVideo = "May I record a short clip of just the Spotify window, about ten seconds? It can show your Spotify name, your picture, your friends' activity, and your playlist names. No other window and no sound are in it."

  private var tessDir: String { "\(FileManager.default.homeDirectoryForCurrentUser.path)/Library/Application Support/Tess" }
  private var supportRoot: String { "\(tessDir)/support" }
  private var currentDir: String { "\(supportRoot)/current" }
  private var stateDir: String { "\(tessDir)/state" }

  func supportState() -> String {
    let fm = FileManager.default
    if fm.isExecutableFile(atPath: "\(currentDir)/bin/pi"),
       fm.fileExists(atPath: "\(currentDir)/extensions/tess-visit.ts"),
       fm.fileExists(atPath: "\(supportRoot)/token") {
      return "installed"
    }
    if fm.fileExists(atPath: "\(stateDir)/.support-invited") { return "invited" }
    return "none"
  }

  func statusJSON() -> String {
    let fm = FileManager.default
    let state = supportState()
    var obj: [String: Any] = ["state": state]
    if state == "invited",
       let raw = try? String(contentsOfFile: "\(stateDir)/.support-invited", encoding: .utf8) {
      let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if !id.isEmpty, id.allSatisfy(\.isNumber) {
        obj["inviteId"] = id
        obj["asked"] = fm.fileExists(atPath: "\(stateDir)/.support-invite-asked-\(id)")
      }
    }
    let statusPath = "\(stateDir)/.support-invite-status"
    if let raw = try? String(contentsOfFile: statusPath, encoding: .utf8) {
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if let d = trimmed.data(using: .utf8),
         let parsed = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
        obj["install"] = parsed
      } else if trimmed == "installing" || trimmed == "done" || trimmed == "failed" {
        obj["install"] = ["phase": trimmed, "progress": trimmed == "done" ? 1.0 : 0.0, "step": trimmed == "installing" ? "Setting up Tess Support" : "", "detail": ""]
      }
    }
    if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
      return s
    }
    return "{\"state\":\"\(state)\"}"
  }

  func declineInvite() {
    let fm = FileManager.default
    if let raw = try? String(contentsOfFile: "\(stateDir)/.support-invited", encoding: .utf8) {
      let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if !id.isEmpty, id.allSatisfy(\.isNumber) {
        fm.createFile(atPath: "\(stateDir)/.support-invite-asked-\(id)", contents: nil)
      }
    }
  }

  func triggerInstall() {
    let fm = FileManager.default
    guard supportState() == "invited" else { return }
    if let raw = try? String(contentsOfFile: "\(stateDir)/.support-invited", encoding: .utf8) {
      let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if !id.isEmpty, id.allSatisfy(\.isNumber) {
        try? fm.removeItem(atPath: "\(stateDir)/.support-invite-asked-\(id)")
        try? fm.removeItem(atPath: "\(stateDir)/.support-invite-retry-\(id)")
      }
    }
    let statusPath = "\(stateDir)/.support-invite-status"
    let initStatus = "{\"phase\":\"installing\",\"progress\":0.01,\"step\":\"Starting setup\",\"detail\":\"Checking invite…\"}\n"
    try? initStatus.write(toFile: statusPath, atomically: true, encoding: .utf8)
    let updater = "\(tessDir)/updater.sh"
    guard fm.fileExists(atPath: updater) else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = [updater]
    var env = ProcessInfo.processInfo.environment
    env["TESS_FORCE"] = "1"
    env["TESS_SUPPORT_ACTION"] = "install"
    env["TMPDIR"] = "/tmp"
    p.environment = env
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
  }

  func eventsJSON(after: Int) -> String {
    lock.lock()
    let slice = events.filter { ($0["seq"] as? Int ?? 0) > after }
    let payload: [String: Any] = [
      "busy": busy,
      "running": proc?.isRunning ?? false,
      "seq": seq,
      "events": slice,
    ]
    lock.unlock()
    if let data = try? JSONSerialization.data(withJSONObject: payload), let s = String(data: data, encoding: .utf8) {
      return s
    }
    return "{\"busy\":false,\"running\":false,\"seq\":0,\"events\":[]}"
  }

  func send(rawBody: String) {
    guard supportState() == "installed" else {
      pushEvent(["type": "error", "text": "Tess Support is not installed yet."])
      return
    }
    guard let data = rawBody.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let msg = (obj["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !msg.isEmpty else { return }

    lock.lock()
    lastActive = Date()
    let isBusy = busy
    if !isBusy { supportErrors.reset() }
    lock.unlock()

    guard ensureRunning() else {
      pushEvent(["type": "error", "text": "Could not start Tess Support. Try resetting the chat."])
      return
    }

    var cmd: [String: Any] = ["type": "prompt", "message": msg]
    if isBusy { cmd["streamingBehavior"] = "followUp" }
    if let line = try? JSONSerialization.data(withJSONObject: cmd) {
      lock.lock()
      busy = true
      let handle = stdinPipe?.fileHandleForWriting
      lock.unlock()
      handle?.write(line + Data("\n".utf8))
    }
  }

  func handleBridgeCommand(rawBody: String) -> String {
    guard let data = rawBody.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let action = obj["action"] as? String else {
      return "{\"ok\":false,\"error\":\"invalid bridge command\"}"
    }
    if action == "request_screen_permission" {
      var granted = false
      if Thread.isMainThread {
        granted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
      } else {
        DispatchQueue.main.sync {
          granted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
        }
      }
      return "{\"ok\":true,\"granted\":\(granted ? "true" : "false")}"
    }
    guard action == "state" || action == "navigate" else {
      return "{\"ok\":false,\"error\":\"unknown bridge action\"}"
    }
    let sem = DispatchSemaphore(value: 0)
    lock.lock()
    cmdSeq += 1
    let id = "cmd_\(cmdSeq)"
    pendingCmds[id] = (sem: sem, result: nil)
    lock.unlock()

    var ev: [String: Any] = ["type": "spotify_cmd", "id": id, "action": action]
    if let target = obj["target"] as? String { ev["target"] = target }
    pushEvent(ev)

    let waited = sem.wait(timeout: .now() + 6.0)
    lock.lock()
    let entry = pendingCmds.removeValue(forKey: id)
    lock.unlock()
    if waited == .success, let res = entry?.result {
      return res
    }
    return "{\"ok\":false,\"error\":\"Spotify did not answer in time\"}"
  }

  func resolveSpotifyCommand(rawBody: String) {
    guard let data = rawBody.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = obj["id"] as? String else { return }
    let resObj = obj["result"] ?? ["ok": true]
    let encoded: String
    if let d = try? JSONSerialization.data(withJSONObject: resObj), let s = String(data: d, encoding: .utf8) {
      encoded = s
    } else {
      encoded = "{\"ok\":true}"
    }
    lock.lock()
    if var entry = pendingCmds[id] {
      entry.result = encoded
      pendingCmds[id] = entry
      let sem = entry.sem
      lock.unlock()
      sem.signal()
      return
    }
    lock.unlock()
  }

  func abort() {
    lock.lock()
    let handle = stdinPipe?.fileHandleForWriting
    lock.unlock()
    if let line = "{\"type\":\"abort\"}\n".data(using: .utf8) {
      handle?.write(line)
    }
  }

  func reset() {
    lock.lock()
    let old = proc
    proc = nil
    stdinPipe = nil
    stdoutBuf.removeAll()
    busy = false
    supportErrors.reset()
    events.removeAll()
    seq += 1
    let resetSeq = seq
    events.append(["seq": resetSeq, "type": "reset"])
    lock.unlock()
    if let old, old.isRunning { old.terminate() }
  }

  private func pushEvent(_ ev: [String: Any]) {
    lock.lock()
    appendEventLocked(ev)
    lock.unlock()
  }

  private func appendEventLocked(_ ev: [String: Any]) {
    var item = ev
    switch ev["type"] as? String {
    case "error":
      guard let text = supportErrors.next(ev["text"] as? String ?? "") else { return }
      item["text"] = text
    case "settled":
      busy = false
      supportErrors.reset()
    case "delta", "message", "tool_start":
      supportErrors.reset()
    default:
      break
    }
    seq += 1
    item["seq"] = seq
    events.append(item)
    if events.count > 400 { events.removeFirst(events.count - 400) }
    lastActive = Date()
  }

  private func ensureRunning() -> Bool {
    lock.lock()
    if let p = proc, p.isRunning {
      lock.unlock()
      return true
    }
    lock.unlock()

    let piBin = "\(currentDir)/bin/pi"
    let ext = "\(currentDir)/extensions/tess-visit.ts"
    let soul = "\(currentDir)/SOUL.md"
    let agentDir = "\(currentDir)/agent"
    guard FileManager.default.isExecutableFile(atPath: piBin),
          let tok = try? String(contentsOfFile: "\(supportRoot)/token", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
          !tok.isEmpty else { return false }

    let p = Process()
    p.executableURL = URL(fileURLWithPath: piBin)
    p.arguments = [
      "--mode", "rpc",
      "--no-session",
      "--tools", "+grep,+find,+ls,-write,-edit",
      "--no-extensions",
      "--extension", ext,
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--provider", "tess-gate",
      "--model", "deepseek-v4.1-flash",
      "--system-prompt", soul,
    ]
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    p.environment = [
      "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:\(home)/.local/bin",
      "HOME": home,
      "TMPDIR": "/tmp",
      "LANG": "en_US.UTF-8",
      "PI_CODING_AGENT_DIR": agentDir,
      "PI_OFFLINE": "1",
      "PI_TELEMETRY": "0",
      "TESS_SUPPORT_DIR": currentDir,
      "TESS_SESSION_ROOT": "\(supportRoot)/cache/sessions",
      "TESS_SUPPORT_TOKEN": tok,
      "TESS_BRIDGE_URL": "http://127.0.0.1:38411/internal/spotify-cmd",
      "TESS_BRIDGE_SECRET": bridgeSecret,
    ]
    let inPipe = Pipe()
    let outPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    p.standardError = FileHandle.nullDevice

    outPipe.fileHandleForReading.readabilityHandler = { [weak self] fh in
      let chunk = fh.availableData
      if chunk.isEmpty {
        fh.readabilityHandler = nil
        return
      }
      self?.consumeStdout(chunk)
    }
    p.terminationHandler = { [weak self] _ in
      guard let self else { return }
      self.lock.lock()
      if self.busy {
        self.appendEventLocked(["type": "settled"])
      } else {
        self.supportErrors.reset()
      }
      self.proc = nil
      self.stdinPipe = nil
      self.lock.unlock()
    }

    do {
      try p.run()
    } catch {
      return false
    }

    lock.lock()
    proc = p
    stdinPipe = inPipe
    stdoutBuf.removeAll()
    lastActive = Date()
    lock.unlock()

    DispatchQueue.main.async { [weak self] in
      guard let self, self.idleTimer == nil else { return }
      self.idleTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
        self?.reapIfIdle()
      }
    }
    return true
  }

  private func reapIfIdle() {
    lock.lock()
    let shouldStop = !busy && proc != nil && Date().timeIntervalSince(lastActive) > 600
    let old = shouldStop ? proc : nil
    if shouldStop {
      proc = nil
      stdinPipe = nil
    }
    lock.unlock()
    if let old, old.isRunning { old.terminate() }
  }

  private func consumeStdout(_ chunk: Data) {
    lock.lock()
    stdoutBuf.append(chunk)
    var lines: [Data] = []
    while let nl = stdoutBuf.firstIndex(of: 0x0A) {
      var line = stdoutBuf[..<nl]
      if line.last == 0x0D { line = line.dropLast() }
      lines.append(Data(line))
      stdoutBuf.removeSubrange(...nl)
    }
    lock.unlock()

    for line in lines where !line.isEmpty {
      guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let type = obj["type"] as? String else { continue }
      handleRPCEvent(type: type, obj: obj)
    }
  }

  private func toolLabel(_ name: String) -> String {
    switch name {
    case "read": return "Reading Tess file"
    case "grep": return "Searching Tess logs"
    case "find", "ls": return "Checking Tess files"
    case "bash": return "Running diagnostic check"
    case "tess_visit_start": return "Starting check-up"
    case "tess_read_skill": return "Loading support guide"
    case "tess_doctor": return "Checking Tess health"
    case "tess_guard_log": return "Reading helper log"
    case "tess_ask_consent": return "Preparing screenshot request"
    case "tess_ask_consent_video": return "Preparing clip request"
    case "tess_still": return "Capturing Spotify window"
    case "tess_record": return "Recording Spotify window"
    case "tess_save_note": return "Writing down notes"
    case "tess_open_issues": return "Checking known issues"
    case "tess_triage": return "Scrubbing personal info"
    case "tess_post": return "Sending report to Krish"
    case "tess_amend_report": return "Updating filed report"
    case "tess_handoff": return "Cleaning up temporary files"
    case "tess_spotify_state": return "Checking Spotify page"
    case "tess_spotify_navigate": return "Navigating Spotify"
    default: return "Working…"
    }
  }

  private func handleRPCEvent(type: String, obj: [String: Any]) {
    switch type {
    case "message_update":
      guard let ev = obj["assistantMessageEvent"] as? [String: Any],
            let et = ev["type"] as? String else { return }
      if et == "text_delta", let delta = ev["delta"] as? String, !delta.isEmpty {
        pushEvent(["type": "delta", "text": delta])
      } else if et == "error", let msg = ev["error"] as? String {
        pushEvent(["type": "error", "text": msg])
      }
    case "message_end":
      guard let msg = obj["message"] as? [String: Any], (msg["role"] as? String) == "assistant" else { return }
      if let errMsg = msg["errorMessage"] as? String, !errMsg.isEmpty {
        pushEvent(["type": "error", "text": errMsg])
        return
      }
      var text = ""
      if let content = msg["content"] as? [[String: Any]] {
        text = content.compactMap { ($0["type"] as? String) == "text" ? ($0["text"] as? String) : nil }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
      } else if let s = msg["content"] as? String {
        text = s.trimmingCharacters(in: .whitespacesAndNewlines)
      }
      if !text.isEmpty {
        var ev: [String: Any] = ["type": "message", "text": text]
        if text.contains(questionStill) { ev["consent"] = "still" }
        else if text.contains(questionVideo) { ev["consent"] = "video" }
        pushEvent(ev)
      }
    case "tool_execution_start":
      let name = obj["toolName"] as? String ?? ""
      pushEvent(["type": "tool_start", "name": name, "label": toolLabel(name)])
    case "tool_execution_end":
      let name = obj["toolName"] as? String ?? ""
      let isErr = obj["isError"] as? Bool ?? false
      pushEvent(["type": "tool_end", "name": name, "isError": isErr])
    case "response":
      if (obj["success"] as? Bool) == false {
        let err = obj["error"] as? String ?? "Support request failed."
        lock.lock(); busy = false; lock.unlock()
        pushEvent(["type": "error", "text": err])
      }
    case "agent_settled":
      pushEvent(["type": "settled"])
    default:
      break
    }
  }
}

@main
enum Main {
  static let delegate = App()
  static func main() {
    let app = NSApplication.shared
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }
}
