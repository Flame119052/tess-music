import Foundation

func miniSanitizeSupportError(_ raw: String) -> String {
  let fallback = "Something went wrong. Please try again."
  func plainMessage(_ value: Any?) -> String? {
    guard let value = value as? String else { return nil }
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !text.contains("{"), !text.contains("}") else { return nil }
    let payload = text.replacingOccurrences(of: #"^[0-9]{3}:\s*"#, with: "", options: .regularExpression)
    if payload.hasPrefix("[") || (try? JSONSerialization.jsonObject(with: Data(payload.utf8), options: .fragmentsAllowed)) != nil {
      return nil
    }
    return String(text.prefix(240))
  }
  let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  if let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end {
    let data = Data(text[start...end].utf8)
    guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return fallback }
    let error = body["error"] as? [String: Any]
    return plainMessage(error?["message"]) ?? plainMessage(body["message"]) ?? fallback
  }
  return plainMessage(text) ?? fallback
}

struct MiniSupportErrors {
  private var last: String?

  mutating func next(_ raw: String) -> String? {
    let text = miniSanitizeSupportError(raw)
    guard text != last else { return nil }
    last = text
    return text
  }

  mutating func reset() { last = nil }
}

func miniNewToken() -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
  return bytes.map { String(format: "%02x", $0) }.joined()
}

// What one request to the miniplayer is allowed to do. A website on the same Mac can open 127.0.0.1; the token is
// how Tess's page is told apart from that website. Only Spotify's own page may read the token or use Support routes.
enum MiniEffect: Equatable {
  case none
  case toggle
  case show
  case hide
  case lyric(String)
  case lines(String)
  case support
  case supportDecline
  case supportSend(String)
  case supportAbort
  case supportReset
  case supportCmdResult(String)
}

struct MiniReply: Equatable {
  var status: Int
  var head: String
  var body: String
  var effect: MiniEffect
}

private let miniSpotifyOrigin = "https://xpui.app.spotify.com"

func miniHandle(
  raw: String,
  token: String,
  supportState: () -> String = { "none" },
  supportStatusJSON: (() -> String)? = nil,
  supportEventsJSON: ((Int) -> String)? = nil,
  bridgeSecret: String = "",
  bridgeHandler: ((String) -> String)? = nil
) -> MiniReply {
  let parts = raw.components(separatedBy: "\r\n\r\n")
  let headerText = parts.first ?? ""
  let body = parts.dropFirst().joined(separator: "\r\n\r\n")
  let lines = headerText.components(separatedBy: "\r\n")
  let request = lines.first?.split(separator: " ", omittingEmptySubsequences: true) ?? []
  let method = request.count > 0 ? String(request[0]) : ""
  let target = request.count > 1 ? String(request[1]) : "/"
  var origin = ""
  var bridgeHeader = ""
  for line in lines.dropFirst() {
    let pair = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    if pair.count == 2 {
      let name = pair[0].trimmingCharacters(in: .whitespaces).lowercased()
      let val = pair[1].trimmingCharacters(in: .whitespaces)
      if name == "origin" { origin = val }
      else if name == "x-tess-bridge" { bridgeHeader = val }
    }
  }
  let cut = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
  let path = String(cut[0])
  // Internal Pi-to-Mini bridge: never accepts a browser Origin header and requires the per-launch bridge secret.
  if method == "POST", path == "/internal/spotify-cmd" {
    if origin.isEmpty, !bridgeSecret.isEmpty, miniTokenMatches(bridgeHeader, bridgeSecret), let handler = bridgeHandler {
      let resp = handler(body)
      return miniReply(200, origin: nil, privateNetwork: false, body: resp, json: true, effect: .none)
    }
    return miniReply(404, origin: nil, privateNetwork: false, body: "", effect: .none)
  }
  var given = ""
  var afterSeq = 0
  if cut.count == 2 {
    for pair in cut[1].split(separator: "&") {
      let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      let val = kv.count > 1 ? (String(kv[1]).removingPercentEncoding ?? "") : ""
      if kv.first == "k" { given = val }
      if kv.first == "after", let n = Int(val), n >= 0 { afterSeq = n }
    }
  }
  let fromSpotify = origin == miniSpotifyOrigin
  if method == "OPTIONS" {
    if fromSpotify {
      return miniReply(204, origin: origin, privateNetwork: true, body: "", effect: .none)
    }
    return miniReply(404, origin: nil, privateNetwork: false, body: "", effect: .none)
  }
  if method == "GET", path == "/token" {
    if fromSpotify {
      let json = "{\"k\":\"\(token)\"}"
      return miniReply(200, origin: origin, privateNetwork: true, body: json, json: true, effect: .none)
    }
    return miniReply(404, origin: nil, privateNetwork: false, body: "", effect: .none)
  }
  guard miniTokenMatches(given, token) else {
    return miniReply(404, origin: nil, privateNetwork: false, body: "", effect: .none)
  }
  // Support routes require Spotify's exact origin AND the valid per-launch token.
  if path == "/support" || path.hasPrefix("/support/") {
    guard fromSpotify else {
      return miniReply(404, origin: nil, privateNetwork: false, body: "", effect: .none)
    }
    if method == "GET", path == "/support" {
      if let custom = supportStatusJSON {
        return miniReply(200, origin: origin, privateNetwork: true, body: custom(), json: true, effect: .none)
      }
      let state = supportState()
      let safe = (state == "invited" || state == "installed") ? state : "none"
      return miniReply(200, origin: origin, privateNetwork: true, body: "{\"state\":\"\(safe)\"}", json: true, effect: .none)
    }
    if method == "POST", path == "/support" || path == "/support/install" {
      return miniReply(200, origin: origin, privateNetwork: true, body: "{\"ok\":true}", json: true, effect: .support)
    }
    if method == "POST", path == "/support/decline" {
      return miniReply(200, origin: origin, privateNetwork: true, body: "{\"ok\":true}", json: true, effect: .supportDecline)
    }
    if method == "GET", path == "/support/chat/events" {
      let payload = supportEventsJSON?(afterSeq) ?? "{\"busy\":false,\"running\":false,\"seq\":0,\"events\":[]}"
      return miniReply(200, origin: origin, privateNetwork: true, body: payload, json: true, effect: .none)
    }
    if method == "POST", path == "/support/chat/send" {
      return miniReply(200, origin: origin, privateNetwork: true, body: "{\"ok\":true}", json: true, effect: .supportSend(body))
    }
    if method == "POST", path == "/support/chat/abort" {
      return miniReply(200, origin: origin, privateNetwork: true, body: "{\"ok\":true}", json: true, effect: .supportAbort)
    }
    if method == "POST", path == "/support/chat/reset" {
      return miniReply(200, origin: origin, privateNetwork: true, body: "{\"ok\":true}", json: true, effect: .supportReset)
    }
    if method == "POST", path == "/support/chat/cmd-result" {
      return miniReply(200, origin: origin, privateNetwork: true, body: "{\"ok\":true}", json: true, effect: .supportCmdResult(body))
    }
    return miniReply(404, origin: nil, privateNetwork: false, body: "", effect: .none)
  }
  let effect: MiniEffect
  switch path {
  case "/toggle": effect = .toggle
  case "/show": effect = .show
  case "/hide": effect = .hide
  case "/lyric": effect = .lyric(body.trimmingCharacters(in: .whitespacesAndNewlines))
  case "/lines": effect = .lines(body)
  default: effect = .none
  }
  if effect == .none {
    return miniReply(404, origin: nil, privateNetwork: false, body: "", effect: .none)
  }
  return miniReply(204, origin: nil, privateNetwork: false, body: "", effect: effect)
}

private func miniReply(_ status: Int, origin: String?, privateNetwork: Bool, body: String, json: Bool = false, effect: MiniEffect) -> MiniReply {
  MiniReply(status: status, head: miniHead(status, origin: origin, privateNetwork: privateNetwork, json: json, bytes: body.utf8.count), body: body, effect: effect)
}

private func miniTokenMatches(_ got: String, _ want: String) -> Bool {
  let a = Array(got.utf8)
  let b = Array(want.utf8)
  if a.count != b.count || a.isEmpty { return false }
  var diff: UInt8 = 0
  for i in a.indices { diff |= a[i] ^ b[i] }
  return diff == 0
}

private func miniHead(_ status: Int, origin: String?, privateNetwork: Bool, json: Bool = false, bytes: Int = 0) -> String {
  let text = status == 200 ? "OK" : status == 204 ? "No Content" : "Not Found"
  var lines = ["HTTP/1.1 \(status) \(text)"]
  if json { lines.append("Content-Type: application/json") }
  if bytes > 0 { lines.append("Content-Length: \(bytes)") }
  if let origin {
    lines.append("Access-Control-Allow-Origin: \(origin)")
    lines.append("Access-Control-Allow-Methods: GET, POST, OPTIONS")
    lines.append("Access-Control-Allow-Headers: Content-Type")
    lines.append("Vary: Origin")
  }
  if privateNetwork { lines.append("Access-Control-Allow-Private-Network: true") }
  lines.append("Connection: close")
  lines.append("")
  lines.append("")
  return lines.joined(separator: "\r\n")
}
