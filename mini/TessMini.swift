// Tess Mini — a native floating miniplayer for Spotify.
//
// A small glass panel that floats above every app, on every Space and over full-screen apps. It reads and controls
// the Spotify app through its AppleScript interface (so it works with or without Tess), and shows the current lyric
// line when Tess's theme sends it (POST http://127.0.0.1:38411/lyric). Tess's theme toggles it with
// GET /toggle. Drag anywhere to move; resize to switch between the square tile and the slim strip.

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
      if t.id != self.track.id { self.lyric = "" }
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

  // Tess's theme talks to the miniplayer over localhost: /toggle, /show, /hide, /lyric (body = the line)
  func startServer() {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 38411)
    guard let l = try? NWListener(using: params) else { return }
    l.newConnectionHandler = { [weak self] c in
      c.start(queue: .global())
      c.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, _ in
        let req = String(decoding: data ?? Data(), as: UTF8.self)
        let line = req.split(separator: "\r\n", omittingEmptySubsequences: false).first ?? ""
        let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        let body = req.components(separatedBy: "\r\n\r\n").dropFirst().joined(separator: "\r\n\r\n")
        DispatchQueue.main.async {
          switch path {
          case "/toggle": self?.toggle()
          case "/show": self?.show()
          case "/hide": self?.hide()
          case "/lyric": self?.sp.lyric = body.trimmingCharacters(in: .whitespacesAndNewlines)
          default: break
          }
        }
        let ok = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n"
        c.send(content: ok.data(using: .utf8), completion: .contentProcessed { _ in c.cancel() })
      }
    }
    l.start(queue: .global())
    listener = l
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
