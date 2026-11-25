import SwiftUI
import AppKit

// The Tess Liquid Glass cards, drawn in the same look as Tess's "What's New" sheet (theme core.css, .twn-*). It
// replaces grey system alerts and banners for both Tess Support invites/progress and the macOS App Management
// permission prompt, and is the only thing in this file that talks to a person; every decision it reports is an exit
// code, nothing else.
//
//   tess-invite ask [--timeout 900]
//       0 = Add Tess Support (install)   1 = Not now (decline)   2 = closed with x / Escape, timed out, or could
//       not be shown. Only 0 and 1 are answers; 2 (and anything else a crash produces) never spends the invite.
//
//   tess-invite progress --status-file <path> [--timeout 900]
//       Shows "Setting up Tess Support..." while <path> says `installing`, then moves the same card to `done` or
//       `failed` when the updater writes that word there. Exit 0 = Open Tess Support, 1 = Done / Close, 2 = timed out,
//       the file went away, or the card could not be shown.
//
//   tess-invite permission [--timeout 900]
//       Floating prominent App Management prompt: "Open App Management" opens System Settings to Privacy & Security ->
//       App Management and slides the companion card to the upper-right corner. Exit 0 = I turned it on — Apply Tess,
//       1 = Later / Close / Escape, 2 = timed out or could not be shown.
//
//   tess-invite --snapshot <ask|installing|done|failed|permission|permissionWait> <out.png>
//       Renders one state to a PNG with no window at all, so every state can be checked without opening anything.
//   tess-invite --check
//       Prints the helper's name and version ("tess-invite 2") and exits 0; the updater runs it before trusting it.
//
// No arguments, files or environment here carry a token, a name or an install id: the status file holds one word.

let toolName = "tess-invite"
let toolVersion = "2"
let spotifyBundleID = "com.spotify.client"

func spotifyIsFront() -> Bool {
  NSWorkspace.shared.frontmostApplication?.bundleIdentifier == spotifyBundleID
}

func spotifyWindowFrame() -> NSRect? {
  guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
        let primaryH = (NSScreen.screens.first(where: { $0.frame.origin == .zero }) ?? NSScreen.main)?.frame.height else {
    return nil
  }
  var best: NSRect?
  var bestArea: CGFloat = 0
  for row in rows {
    guard (row[kCGWindowOwnerName as String] as? String) == "Spotify",
          (row[kCGWindowLayer as String] as? Int) == 0,
          let bounds = row[kCGWindowBounds as String] as? [String: Any],
          let x = (bounds["X"] as? NSNumber)?.doubleValue,
          let y = (bounds["Y"] as? NSNumber)?.doubleValue,
          let w = (bounds["Width"] as? NSNumber)?.doubleValue,
          let h = (bounds["Height"] as? NSNumber)?.doubleValue,
          w >= 200, h >= 150 else { continue }
    let area = CGFloat(w * h)
    if area > bestArea {
      bestArea = area
      best = NSRect(x: x, y: Double(primaryH) - (y + h), width: w, height: h)
    }
  }
  return best
}

enum Phase: String { case ask, installing, done, failed, permission, permissionWait }

enum Choice { case primary, secondary, dismiss, reopenSettings }

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(("\(toolName): \(message)\n").data(using: .utf8) ?? Data())
  exit(2)
}

// MARK: - Look (every value below is taken from .twn-* in theme/Tess/src/core.css)

func rgb(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> Color {
  Color(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: a)
}

struct Tint {
  let ink: Color, hi: Color, lo: Color, edge: Color, glow: Color
  static let green = Tint(ink: rgb(111, 240, 160), hi: rgb(30, 215, 96, 0.32), lo: rgb(30, 215, 96, 0.12), edge: rgb(30, 215, 96, 0.22), glow: rgb(30, 215, 96, 0.14))
  static let blue = Tint(ink: rgb(143, 198, 255), hi: rgb(64, 156, 255, 0.34), lo: rgb(64, 156, 255, 0.12), edge: rgb(64, 156, 255, 0.24), glow: rgb(64, 156, 255, 0.14))
  static let violet = Tint(ink: rgb(196, 176, 255), hi: rgb(167, 139, 250, 0.34), lo: rgb(167, 139, 250, 0.12), edge: rgb(167, 139, 250, 0.24), glow: rgb(167, 139, 250, 0.14))
  static let amber = Tint(ink: rgb(255, 205, 122), hi: rgb(255, 176, 56, 0.34), lo: rgb(255, 176, 56, 0.12), edge: rgb(255, 176, 56, 0.26), glow: rgb(255, 176, 56, 0.14))
}

let cardWidth: CGFloat = 480
let cardRadius: CGFloat = 30
let softWhite = Color.white.opacity(0.7)

func cardWidth(for phase: Phase) -> CGFloat {
  switch phase {
  case .permission: return 500
  case .permissionWait: return 436
  default: return cardWidth
  }
}

func isProminent(_ phase: Phase) -> Bool {
  phase == .permission || phase == .permissionWait
}

/// A tinted glass well holding one symbol, like the icon wells in the What's New rows.
struct Badge<Content: View>: View {
  let tint: Tint
  let size: CGFloat
  let radius: CGFloat
  let content: Content
  init(tint: Tint, size: CGFloat, radius: CGFloat, @ViewBuilder content: () -> Content) {
    self.tint = tint; self.size = size; self.radius = radius; self.content = content()
  }
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
    ZStack { content }
      .frame(width: size, height: size)
      .background(shape.fill(LinearGradient(colors: [tint.hi, tint.lo], startPoint: .top, endPoint: .bottom)))
      .overlay(shape.strokeBorder(tint.edge, lineWidth: 1))
      .overlay(
        shape.strokeBorder(LinearGradient(colors: [Color.white.opacity(0.4), Color.white.opacity(0)], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.45)), lineWidth: 1)
          .blendMode(.plusLighter)
      )
      .shadow(color: tint.glow, radius: 7, x: 0, y: 4)
  }
}

func symbol(_ name: String, _ tint: Tint, _ size: CGFloat) -> some View {
  Image(systemName: name)
    .font(.system(size: size, weight: .semibold))
    .foregroundColor(tint.ink)
}

/// The rounded square emblem at the top of feature cards, with a glass sheen across its upper half.
struct Emblem: View {
  var colors: [Color] = [rgb(30, 215, 96), rgb(110, 231, 249), rgb(167, 139, 250), rgb(244, 114, 182), rgb(30, 215, 96)]
  var glow: Color = rgb(30, 215, 96, 0.32)
  var icon: String = "lifepreserver"

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
    ZStack {
      shape.fill(AngularGradient(colors: colors, center: .center, angle: .degrees(210)))
      shape.fill(LinearGradient(stops: [.init(color: Color.white.opacity(0.45), location: 0), .init(color: Color.white.opacity(0), location: 0.52)], startPoint: .top, endPoint: .bottom))
      Image(systemName: icon)
        .font(.system(size: 29, weight: .semibold))
        .foregroundColor(.white.opacity(0.96))
        .shadow(color: .black.opacity(0.22), radius: 3, x: 0, y: 1)
    }
    .frame(width: 68, height: 68)
    .overlay(shape.strokeBorder(Color.white.opacity(0.35), lineWidth: 0.5))
    .shadow(color: glow, radius: 18, x: 0, y: 12)
    .shadow(color: .black.opacity(0.3), radius: 3, x: 0, y: 2)
  }
}

/// A spinner drawn by hand: the system one does not draw outside a live window, and this one matches the badge tints.
struct Spinner: View {
  let tint: Tint
  var body: some View {
    // Drawn from the clock rather than from stored state: no animation state to keep, and a snapshot just shows it still.
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)) { ctx in
      Circle()
        .trim(from: 0.06, to: 0.72)
        .stroke(tint.ink, style: StrokeStyle(lineWidth: 3.6, lineCap: .round))
        .frame(width: 30, height: 30)
        .rotationEffect(.degrees(ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.95) / 0.95 * 360))
    }
  }
}

struct PillStyle: ButtonStyle {
  let primary: Bool
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .foregroundColor(primary ? rgb(16, 16, 18) : Color.white.opacity(0.88))
      .padding(.horizontal, 22)
      .padding(.vertical, 12)
      .frame(minWidth: primary ? 120 : 0)
      .background(
        Capsule().fill(primary
          ? AnyShapeStyle(LinearGradient(colors: [.white, rgb(232, 232, 238)], startPoint: .top, endPoint: .bottom))
          : AnyShapeStyle(Color.white.opacity(configuration.isPressed ? 0.18 : 0.1)))
      )
      .overlay(Capsule().strokeBorder(primary ? Color.white.opacity(0) : Color.white.opacity(0.1), lineWidth: 1))
      .shadow(color: primary ? Color.white.opacity(0.16) : .clear, radius: 9, x: 0, y: 6)
      .scaleEffect(configuration.isPressed ? 0.96 : 1)
      .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
      .contentShape(Capsule())
  }
}

struct Row: View {
  let tint: Tint
  var icon: String = ""
  var step: String? = nil
  let title: String
  let detail: String
  var body: some View {
    HStack(alignment: .top, spacing: 16) {
      Badge(tint: tint, size: 42, radius: 13) {
        if let step {
          Text(step).font(.system(size: 17, weight: .bold, design: .rounded)).foregroundColor(tint.ink)
        } else {
          symbol(icon, tint, 19)
        }
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.system(size: 15.5, weight: .semibold)).foregroundColor(.white)
        Text(detail).font(.system(size: 13.5)).foregroundColor(softWhite).lineSpacing(2.5)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}

/// The glass itself. In a live window the real blur sits behind it (see Blur); in a snapshot there is no window to
/// blur, so the fill is a little denser to read the same over the fixed backdrop.
struct CardChrome: View {
  let live: Bool
  var prominent: Bool = false
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: cardRadius, style: .continuous)
    ZStack(alignment: .top) {
      Color(red: 22 / 255, green: 22 / 255, blue: 28 / 255).opacity(live ? (prominent ? 0.72 : 0.5) : (prominent ? 0.90 : 0.78))
      LinearGradient(stops: [.init(color: Color.white.opacity(prominent ? 0.14 : 0.11), location: 0), .init(color: Color.white.opacity(0.03), location: 0.38)], startPoint: .top, endPoint: .bottom)
      // soft ambient light behind the emblem
      ZStack {
        if prominent {
          RadialGradient(colors: [rgb(255, 176, 56, 0.34), .clear], center: UnitPoint(x: 0.5, y: 0.16), startRadius: 0, endRadius: 230)
          RadialGradient(colors: [rgb(30, 215, 96, 0.22), .clear], center: UnitPoint(x: 0.16, y: 0.12), startRadius: 0, endRadius: 170)
          RadialGradient(colors: [rgb(64, 156, 255, 0.22), .clear], center: UnitPoint(x: 0.84, y: 0.12), startRadius: 0, endRadius: 170)
        } else {
          RadialGradient(colors: [rgb(30, 215, 96, 0.26), .clear], center: UnitPoint(x: 0.5, y: 0.2), startRadius: 0, endRadius: 190)
          RadialGradient(colors: [rgb(167, 139, 250, 0.2), .clear], center: UnitPoint(x: 0.22, y: 0.1), startRadius: 0, endRadius: 150)
          RadialGradient(colors: [rgb(110, 231, 249, 0.16), .clear], center: UnitPoint(x: 0.78, y: 0.12), startRadius: 0, endRadius: 150)
        }
      }
      .frame(height: prominent ? 340 : 300)
      .frame(maxHeight: .infinity, alignment: .top)
    }
    .clipShape(shape)
    // a hairline rim: bright where light lands (top left), plus a warm amber edge on action-needed permission cards
    .overlay(
      shape.strokeBorder(
        LinearGradient(stops: [
          .init(color: prominent ? rgb(255, 205, 122, 0.72) : Color.white.opacity(0.55), location: 0),
          .init(color: Color.white.opacity(prominent ? 0.22 : 0.1), location: 0.32),
          .init(color: Color.white.opacity(prominent ? 0.12 : 0.04), location: 0.65),
          .init(color: prominent ? rgb(111, 240, 160, 0.36) : Color.white.opacity(0.22), location: 1),
        ], startPoint: .topLeading, endPoint: .bottomTrailing),
        lineWidth: prominent ? 1.5 : 1)
    )
  }
}

// MARK: - The card

final class Model: ObservableObject {
  @Published var phase: Phase
  init(_ phase: Phase) { self.phase = phase }
}

struct InviteCard: View {
  @ObservedObject var model: Model
  let live: Bool
  let choose: (Choice) -> Void

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Group {
        switch model.phase {
        case .ask: ask
        case .installing: installing
        case .done: done
        case .failed: failed
        case .permission: permission
        case .permissionWait: permissionWait
        }
      }
      .transition(.opacity)
      .id(model.phase)

      if model.phase != .installing {
        Button { choose(.dismiss) } label: {
          Image(systemName: "xmark")
            .font(.system(size: 10.5, weight: .bold))
            .foregroundColor(Color.white.opacity(0.72))
            .frame(width: 28, height: 28)
            .background(Circle().fill(Color.white.opacity(0.1)))
            .overlay(Circle().strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
        .padding(.top, 18)
        .padding(.trailing, 18)
      }
    }
    .frame(width: cardWidth(for: model.phase))
    .fixedSize(horizontal: true, vertical: true)
    .background(CardChrome(live: live, prominent: isProminent(model.phase)))
  }

  // MARK: states

  func title(_ text: String, size: CGFloat) -> some View {
    Text(text)
      .font(.system(size: size, weight: .heavy))
      .tracking(-size * 0.025)
      .foregroundColor(.white)
      .multilineTextAlignment(.center)
      .fixedSize(horizontal: false, vertical: true)
  }

  func sub(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 14.5))
      .foregroundColor(softWhite)
      .lineSpacing(3)
      .multilineTextAlignment(.center)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: 380)
  }

  var foot: some View { Rectangle().fill(LinearGradient(colors: [.clear, Color.white.opacity(0.12), .clear], startPoint: .leading, endPoint: .trailing)).frame(height: 1).padding(.horizontal, 36) }

  func pillTag(_ text: String, tint: Tint? = nil) -> some View {
    Text(text)
      .font(.system(size: 12, weight: .semibold))
      .foregroundColor(tint?.ink ?? Color.white.opacity(0.86))
      .padding(.horizontal, 13).padding(.vertical, 5)
      .background(Capsule().fill(tint?.lo ?? Color.white.opacity(0.1)))
      .overlay(Capsule().strokeBorder(tint?.edge ?? Color.white.opacity(0.09), lineWidth: 1))
  }

  var ask: some View {
    VStack(spacing: 0) {
      VStack(spacing: 0) {
        Emblem().padding(.bottom, 20)
        pillTag("Personal invite from Krish").padding(.bottom, 14)
        title("Want a hand with Tess?", size: 30).padding(.bottom, 10)
        sub("Add a private helper you can click\nanytime Spotify looks off.")
      }
      .padding(.top, 40)
      .padding(.horizontal, 44)

      VStack(alignment: .leading, spacing: 20) {
        Row(tint: .green, icon: "wand.and.stars", title: "Fixes things with you", detail: "Checks why Tess looks off and explains it in plain words.")
        Row(tint: .blue, icon: "hand.raised.fill", title: "Always asks first", detail: "Never takes a screenshot or shares anything without your okay.")
        Row(tint: .violet, icon: "moon.zzz.fill", title: "Stays out of your way", detail: "Only runs when you click it.")
      }
      .padding(.horizontal, 40)
      .padding(.top, 28)
      .padding(.bottom, 26)

      foot
      HStack(spacing: 10) {
        Spacer(minLength: 0)
        Button("Not now") { choose(.secondary) }.buttonStyle(PillStyle(primary: false))
        Button("Add Tess Support") { choose(.primary) }.buttonStyle(PillStyle(primary: true))
      }
      .padding(.horizontal, 36)
      .padding(.top, 18)
      .padding(.bottom, 28)
    }
  }

  func statusBody(badge: AnyView, heading: String, detail: String) -> some View {
    VStack(spacing: 0) {
      badge.padding(.bottom, 22)
      title(heading, size: 26).padding(.bottom, 10)
      sub(detail)
    }
    .padding(.top, 46)
    .padding(.horizontal, 44)
  }

  var installing: some View {
    statusBody(
      badge: AnyView(Badge(tint: .green, size: 72, radius: 22) { Spinner(tint: .green) }),
      heading: "Setting up Tess Support…",
      detail: "This takes about a minute.")
      .padding(.bottom, 50)
  }

  var done: some View {
    VStack(spacing: 0) {
      statusBody(
        badge: AnyView(Badge(tint: .green, size: 72, radius: 22) { symbol("checkmark", .green, 31) }),
        heading: "You're all set!",
        detail: "Click Tess Support in your Dock anytime something in Spotify looks off.")
        .padding(.bottom, 30)
      foot
      HStack(spacing: 10) {
        Spacer(minLength: 0)
        Button("Done") { choose(.secondary) }.buttonStyle(PillStyle(primary: false))
        Button("Open Tess Support") { choose(.primary) }.buttonStyle(PillStyle(primary: true))
      }
      .padding(.horizontal, 36)
      .padding(.top, 18)
      .padding(.bottom, 28)
    }
  }

  var failed: some View {
    VStack(spacing: 0) {
      statusBody(
        badge: AnyView(Badge(tint: .amber, size: 72, radius: 22) { symbol("exclamationmark.triangle.fill", .amber, 29) }),
        heading: "Couldn't finish setting up",
        detail: "Some parts may have been left behind. Ask Krish and he can tidy them up.")
        .padding(.bottom, 30)
      foot
      HStack(spacing: 10) {
        Spacer(minLength: 0)
        Button("Close") { choose(.primary) }.buttonStyle(PillStyle(primary: true))
      }
      .padding(.horizontal, 36)
      .padding(.top, 18)
      .padding(.bottom, 28)
    }
  }

  var permission: some View {
    VStack(spacing: 0) {
      VStack(spacing: 0) {
        Emblem(
          colors: [rgb(255, 190, 68), rgb(255, 122, 89), rgb(244, 114, 182), rgb(167, 139, 250), rgb(255, 190, 68)],
          glow: rgb(255, 176, 56, 0.36),
          icon: "checkmark.shield.fill"
        ).padding(.bottom, 20)
        pillTag("Spotify updated · Action needed", tint: .amber).padding(.bottom, 14)
        title("Let Tess update Spotify", size: 29).padding(.bottom, 10)
        sub("Spotify updated cleanly. Turn on one macOS toggle and Tess will bring your look right back.")
      }
      .padding(.top, 38)
      .padding(.horizontal, 40)

      VStack(alignment: .leading, spacing: 18) {
        Row(tint: .blue, step: "1", title: "Open App Management", detail: "Click the bright button below to jump straight to that setting.")
        Row(tint: .amber, step: "2", title: "Turn on tess-patcher", detail: "Flip the switch next to tess-patcher, then confirm with Touch ID or your Mac password.")
        Row(tint: .green, step: "3", title: "Tess comes right back", detail: "Click \"I turned it on\" — Spotify and all your playlists stay completely safe.")
      }
      .padding(.horizontal, 40)
      .padding(.top, 26)
      .padding(.bottom, 26)

      foot
      HStack(spacing: 10) {
        Spacer(minLength: 0)
        Button("Later") { choose(.secondary) }.buttonStyle(PillStyle(primary: false))
        Button("Open App Management") { choose(.primary) }.buttonStyle(PillStyle(primary: true))
      }
      .padding(.horizontal, 36)
      .padding(.top, 18)
      .padding(.bottom, 28)
    }
  }

  var permissionWait: some View {
    VStack(spacing: 0) {
      VStack(spacing: 0) {
        Badge(tint: .blue, size: 64, radius: 19) { symbol("switch.2", .blue, 27) }
          .padding(.bottom, 18)
        pillTag("Waiting in System Settings", tint: .blue).padding(.bottom, 12)
        title("Turn on tess-patcher", size: 24).padding(.bottom, 10)
        Text("Flip the switch next to tess-patcher in System Settings, confirm with Touch ID or your Mac password, then click below.")
          .font(.system(size: 14))
          .foregroundColor(softWhite)
          .lineSpacing(3)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: 344)
        Button { choose(.reopenSettings) } label: {
          HStack(spacing: 5) {
            Image(systemName: "gearshape.fill").font(.system(size: 11, weight: .semibold))
            Text("Open Settings again").font(.system(size: 12.5, weight: .semibold))
          }
          .foregroundColor(Tint.blue.ink)
          .padding(.horizontal, 12).padding(.vertical, 6)
          .background(Capsule().fill(Tint.blue.lo))
          .overlay(Capsule().strokeBorder(Tint.blue.edge, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .padding(.top, 14)
      }
      .padding(.top, 38)
      .padding(.horizontal, 32)
      .padding(.bottom, 24)

      foot
      HStack(spacing: 10) {
        Spacer(minLength: 0)
        Button("Not now") { choose(.secondary) }.buttonStyle(PillStyle(primary: false))
        Button("I turned it on — Apply Tess") { choose(.primary) }.buttonStyle(PillStyle(primary: true))
      }
      .padding(.horizontal, 28)
      .padding(.top, 18)
      .padding(.bottom, 26)
    }
  }
}

// MARK: - Live window

/// Real behind-the-window blur, clipped to the card's rounded shape.
struct Blur: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let v = NSVisualEffectView()
    v.material = .hudWindow
    v.blendingMode = .behindWindow
    v.state = .active
    v.appearance = NSAppearance(named: .darkAqua)
    let r = cardRadius
    let mask = NSImage(size: NSSize(width: r * 2 + 1, height: r * 2 + 1), flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
      return true
    }
    mask.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r)
    mask.resizingMode = .stretch
    v.maskImage = mask
    return v
  }
  func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}

/// A borderless window answers no key events unless it says it may become key.
final class GlassWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

final class Controller {
  let model: Model
  let window: GlassWindow
  let host: NSHostingView<AnyView>
  var timer: Timer?
  var monitor: Any?
  var appObserver: NSObjectProtocol?
  var statusFile: String?
  var seenStatus = false
  var started = Date()
  var terminalSince: Date?
  let timeout: TimeInterval
  let spotifyOnly: Bool
  let floating: Bool

  init(phase: Phase, statusFile: String?, timeout: TimeInterval, spotifyOnly: Bool) {
    model = Model(phase)
    self.statusFile = statusFile
    self.timeout = timeout
    self.spotifyOnly = spotifyOnly
    self.floating = isProminent(phase)
    window = GlassWindow(contentRect: NSRect(x: 0, y: 0, width: cardWidth(for: phase), height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
    host = NSHostingView(rootView: AnyView(EmptyView()))
    host.rootView = AnyView(
      ZStack {
        Blur().clipShape(RoundedRectangle(cornerRadius: cardRadius, style: .continuous))
        InviteCard(model: model, live: true) { [unowned self] in self.choose($0) }
      }
      .clipShape(RoundedRectangle(cornerRadius: cardRadius, style: .continuous))
    )
    host.wantsLayer = true
    host.layer?.backgroundColor = NSColor.clear.cgColor
    host.layer?.cornerRadius = cardRadius
    host.layer?.cornerCurve = .continuous
    host.layer?.masksToBounds = true
    window.contentView = host
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = true
    window.level = floating ? .floating : .normal
    window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false
    window.collectionBehavior = floating ? [.canJoinAllSpaces, .fullScreenAuxiliary] : [.moveToActiveSpace, .fullScreenAuxiliary]
    window.title = floating ? "Tess Music" : "Tess Support"
  }

  func openAppManagementSettings() {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles") {
      NSWorkspace.shared.open(url)
    }
  }

  func choose(_ c: Choice) {
    switch model.phase {
    case .ask: finish(c == .primary ? 0 : c == .secondary ? 1 : 2)
    case .done: finish(c == .primary ? 0 : 1)
    case .failed: finish(1)
    case .installing: break
    case .permission:
      if c == .primary {
        openAppManagementSettings()
        shownAt = Date()
        withAnimation(.easeInOut(duration: 0.25)) { model.phase = .permissionWait }
        DispatchQueue.main.async { self.moveCorner(animated: true) }
      } else if c != .reopenSettings {
        finish(1)
      }
    case .permissionWait:
      if c == .reopenSettings {
        openAppManagementSettings()
      } else {
        finish(c == .primary ? 0 : 1)
      }
    }
  }

  func finish(_ code: Int32) -> Never {
    exit(code)
  }

  var placed = false
  var everShown = false
  var shownAt: Date?

  func presentOverSpotify(animated: Bool) {
    placed = false
    fit(animated: false)
    if animated {
      window.alphaValue = 0
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.01 : 0.18
        window.animator().alphaValue = 1
      }
    } else {
      window.alphaValue = 1
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }
    if !everShown {
      everShown = true
      shownAt = Date()
    }
  }

  func moveCorner(animated: Bool) {
    let size = host.fittingSize
    guard size.width > 0, size.height > 0 else { return }
    guard let area = (window.screen ?? NSScreen.main)?.visibleFrame else { return }
    let frame = NSRect(x: area.maxX - size.width - 24, y: area.maxY - size.height - 24, width: size.width, height: size.height)
    window.setFrame(frame, display: true, animate: animated)
    window.invalidateShadow()
    window.makeFirstResponder(nil)
    placed = true
  }

  func fit(animated: Bool) {
    let size = host.fittingSize
    guard size.width > 0, size.height > 0 else { return }
    var frame: NSRect
    if !placed {
      if let sp = spotifyWindowFrame() {
        let hostScreen = NSScreen.screens.first(where: { $0.frame.intersects(sp) }) ?? NSScreen.main
        let area = hostScreen?.visibleFrame ?? sp
        var x = sp.midX - size.width / 2
        var y = sp.midY - size.height / 2
        x = min(max(x, area.minX + 16), area.maxX - size.width - 16)
        y = min(max(y, area.minY + 16), area.maxY - size.height - 16)
        frame = NSRect(x: x, y: y, width: size.width, height: size.height)
      } else if let screen = NSScreen.main {
        let area = screen.visibleFrame
        frame = NSRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2 + area.height * 0.04, width: size.width, height: size.height)
      } else {
        return
      }
      placed = true
    } else if model.phase == .permissionWait {
      moveCorner(animated: animated)
      return
    } else {
      // later (installing -> done): grow or shrink around the card's own middle
      let old = window.frame
      frame = NSRect(x: old.midX - size.width / 2, y: old.midY - size.height / 2, width: size.width, height: size.height)
    }
    window.setFrame(frame, display: true, animate: animated)
    window.invalidateShadow()
    window.makeFirstResponder(nil)
    window.invalidateShadow()
  }

  func show() {
    guard NSScreen.main != nil else { fail("there is no screen to show this on") }
    NSApp.setActivationPolicy(.accessory)
    if spotifyOnly {
      let myPID = ProcessInfo.processInfo.processIdentifier
      appObserver = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didActivateApplicationNotification,
        object: nil,
        queue: .main
      ) { [unowned self] note in
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        if app.processIdentifier == myPID { return }
        if app.bundleIdentifier == spotifyBundleID {
          self.presentOverSpotify(animated: !self.everShown)
        } else {
          self.window.orderOut(nil)
        }
      }
      if spotifyIsFront() {
        presentOverSpotify(animated: true)
      } else {
        // Wait quietly without intruding on other apps; appears instantaneously the moment Spotify is focused.
        window.orderOut(nil)
      }
    } else {
      fit(animated: false)
      window.alphaValue = 0
      if floating { window.orderFrontRegardless() }
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.01 : 0.28
        window.animator().alphaValue = 1
      }
      everShown = true
      shownAt = Date()
    }
    // Return is the bright button, Escape closes without answering. A local monitor sees them whatever has focus.
    monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [unowned self] e in
      switch e.keyCode {
      case 36, 76: self.choose(.primary); return nil
      case 53: self.choose(.dismiss); return nil
      default: return e
      }
    }
    started = Date()
    timer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [unowned self] _ in self.tick() }
  }

  /// One word in the status file moves the card on. A word it does not know changes nothing.
  func readStatus() -> String? {
    guard let path = statusFile, let h = FileHandle(forReadingAtPath: path) else { return nil }
    defer { try? h.close() }
    let data = (try? h.read(upToCount: 32)) ?? Data()
    return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func tick() {
    if statusFile != nil, model.phase == .installing {
      let word = readStatus()
      if word == nil {
        // The updater writes the file before it starts this card; a file that is gone means the run is over.
        if seenStatus || Date().timeIntervalSince(started) > 5 { finish(2) }
      } else {
        seenStatus = true
        let next: Phase? = word == "done" ? .done : word == "failed" ? .failed : nil
        if let next {
          withAnimation(.easeInOut(duration: 0.35)) { model.phase = next }
          terminalSince = Date()
          DispatchQueue.main.async { self.fit(animated: true) }
          return
        }
      }
    }
    // Every card gives up on its own: while waiting invisibly for Spotify, allow up to max(timeout, 1500s) so
    // switching into Spotify later still shows it instantaneously; once shown, give the user `timeout` seconds.
    if spotifyOnly && !everShown {
      if Date().timeIntervalSince(started) > max(timeout, 1500) { finish(2) }
      return
    }
    let since = terminalSince ?? shownAt ?? started
    if Date().timeIntervalSince(since) > timeout { finish(2) }
  }
}

// MARK: - Snapshot (no window)

func snapHeight(for phase: Phase) -> CGFloat {
  switch phase {
  case .ask, .permission: return 760
  case .permissionWait: return 520
  case .installing, .done, .failed: return 460
  }
}

/// What stands behind the card in a snapshot: a dark, slightly colourful stand-in for Spotify.
struct SnapshotBackdrop: View {
  let phase: Phase
  var body: some View {
    ZStack {
      LinearGradient(colors: [rgb(14, 15, 20), rgb(24, 22, 34)], startPoint: .topLeading, endPoint: .bottomTrailing)
      if isProminent(phase) {
        RadialGradient(colors: [rgb(255, 176, 56, 0.32), .clear], center: UnitPoint(x: 0.5, y: 0.14), startRadius: 0, endRadius: 380)
      }
      RadialGradient(colors: [rgb(30, 215, 96, 0.34), .clear], center: UnitPoint(x: 0.1, y: 0.95), startRadius: 0, endRadius: 360)
      RadialGradient(colors: [rgb(167, 139, 250, 0.3), .clear], center: UnitPoint(x: 0.95, y: 0.05), startRadius: 0, endRadius: 360)
      HStack(spacing: 24) {
        ForEach(0..<6, id: \.self) { i in
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(Color.white.opacity(0.06 + Double(i % 3) * 0.02))
            .frame(width: 120, height: 120)
        }
      }
      .fixedSize()
      .offset(y: (phase == .ask || phase == .permission) ? -300 : -170)
    }
  }
}

@MainActor
func renderSnapshot(_ phase: Phase, to path: String) {
  let model = Model(phase)
  let view = ZStack {
    SnapshotBackdrop(phase: phase)
    InviteCard(model: model, live: false) { _ in }
      .shadow(color: .black.opacity(0.5), radius: 40, x: 0, y: 22)
      .shadow(color: .black.opacity(0.25), radius: 3, x: 0, y: 2)
  }
  .frame(width: cardWidth(for: phase) + 160, height: snapHeight(for: phase))
  .clipped()
  .environment(\.colorScheme, .dark)
  let renderer = ImageRenderer(content: view)
  renderer.scale = 2
  guard let image = renderer.cgImage else { fail("could not draw the \(phase.rawValue) card") }
  let rep = NSBitmapImageRep(cgImage: image)
  guard let png = rep.representation(using: .png, properties: [:]) else { fail("could not encode the picture") }
  do { try png.write(to: URL(fileURLWithPath: path)) } catch { fail("could not write \(path)") }
}

// MARK: - Entry

func value(_ flag: String, in args: [String]) -> String? {
  guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
  return args[i + 1]
}

func seconds(in args: [String]) -> TimeInterval {
  guard let raw = value("--timeout", in: args) else { return 900 }
  guard let n = Double(raw), n >= 1, n <= 7200 else { fail("--timeout must be between 1 and 7200 seconds") }
  return n
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: tess-invite ask | progress --status-file <path> | permission | --snapshot <state> <out.png> | --check") }

switch command {
case "--check", "--version":
  print("\(toolName) \(toolVersion)")
  exit(0)

case "--snapshot":
  guard args.count == 3, let phase = Phase(rawValue: args[1]) else { fail("usage: tess-invite --snapshot <ask|installing|done|failed|permission|permissionWait> <out.png>") }
  MainActor.assumeIsolated { renderSnapshot(phase, to: args[2]) }
  exit(0)

case "ask", "progress", "status", "permission":
  let isAsk = command == "ask"
  let isPerm = command == "permission"
  var file: String?
  if !isAsk && !isPerm {
    file = value("--status-file", in: args) ?? value("--file", in: args)
    guard let f = file, !f.isEmpty else { fail("progress needs --status-file <path>") }
  }
  let initial: Phase = isPerm ? .permission : isAsk ? .ask : .installing
  let spotifyOnly = isAsk && !args.contains("--any-app")
  let controller = MainActor.assumeIsolated { () -> Controller in
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    return Controller(phase: initial, statusFile: file, timeout: seconds(in: args), spotifyOnly: spotifyOnly)
  }
  MainActor.assumeIsolated { controller.show() }
  NSApplication.shared.run()

default:
  fail("unknown command \(command)")
}
