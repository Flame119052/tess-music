import Foundation

func miniNewToken() -> String {
  var bytes = [UInt8](repeating: 0, count: 32)
  for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
  return bytes.map { String(format: "%02x", $0) }.joined()
}

// What one request to the miniplayer is allowed to do. A website on the same Mac can open 127.0.0.1; the token is
// how Tess's page is told apart from that website. Only Spotify's own page may read the token. Later calls carry it
// and need no CORS headers, which is how the theme already talks to Mini.
enum MiniEffect: Equatable {
  case none
  case toggle
  case show
  case hide
  case lyric(String)
  case lines(String)
}

struct MiniReply: Equatable {
  var status: Int
  var head: String
  var body: String
  var effect: MiniEffect
}

private let miniSpotifyOrigin = "https://xpui.app.spotify.com"

func miniHandle(raw: String, token: String) -> MiniReply {
  let parts = raw.components(separatedBy: "\r\n\r\n")
  let headerText = parts.first ?? ""
  let body = parts.dropFirst().joined(separator: "\r\n\r\n")
  let lines = headerText.components(separatedBy: "\r\n")
  let request = lines.first?.split(separator: " ", omittingEmptySubsequences: true) ?? []
  let method = request.count > 0 ? String(request[0]) : ""
  let target = request.count > 1 ? String(request[1]) : "/"
  var origin = ""
  for line in lines.dropFirst() {
    let pair = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    if pair.count == 2, pair[0].trimmingCharacters(in: .whitespaces).lowercased() == "origin" {
      origin = pair[1].trimmingCharacters(in: .whitespaces)
    }
  }
  let cut = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
  let path = String(cut[0])
  var given = ""
  if cut.count == 2 {
    for pair in cut[1].split(separator: "&") {
      let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      if kv.first == "k" {
        given = kv.count > 1 ? (String(kv[1]).removingPercentEncoding ?? "") : ""
      }
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
    lines.append("Vary: Origin")
  }
  if privateNetwork { lines.append("Access-Control-Allow-Private-Network: true") }
  lines.append("Connection: close")
  lines.append("")
  lines.append("")
  return lines.joined(separator: "\r\n")
}
