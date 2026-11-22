import Foundation

@main
struct MiniGateTestMain {
  static func main() {
    let token = String(repeating: "ab", count: 32)
    let spotify = "https://xpui.app.spotify.com"

    let web = miniHandle(raw: "POST /toggle HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: https://evil.example\r\n\r\n", token: token)
    expect(web.effect == .none, "a website toggle is ignored")
    expect(!web.head.contains("Access-Control-Allow-Origin"), "a website gets no CORS header")
    expect(!web.head.contains("Access-Control-Allow-Private-Network"), "a website gets no private-network opt-in")
    expect(!web.head.contains("*"), "a website response names no star origin")

    let steal = miniHandle(raw: "GET /token HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: https://evil.example\r\n\r\n", token: token)
    expect(!steal.body.contains(token), "a website is not given the token")
    expect(!steal.head.contains(token), "a website's headers do not carry the token")
    expect(steal.effect == .none, "a token request from a website has no effect")

    let hello = miniHandle(raw: "GET /token HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n", token: token)
    expect(hello.body.contains(token), "Spotify's page can read the token")
    expect(hello.head.contains("Access-Control-Allow-Origin: \(spotify)"), "CORS names only Spotify's page")
    expect(hello.head.contains("Access-Control-Allow-Private-Network: true"), "Spotify's page may call localhost")
    expect(!hello.head.contains("*"), "Spotify's answer is not every origin")

    let optIn = miniHandle(raw: "OPTIONS /token HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\nAccess-Control-Request-Private-Network: true\r\n\r\n", token: token)
    expect(optIn.head.contains("Access-Control-Allow-Private-Network: true"), "Spotify's preflight may reach localhost")
    expect(optIn.head.contains("Access-Control-Allow-Origin: \(spotify)"), "the preflight names only Spotify's page")
    let optOut = miniHandle(raw: "OPTIONS /toggle HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: https://evil.example\r\n\r\n", token: token)
    expect(!optOut.head.contains("Access-Control-Allow-Private-Network"), "a website's preflight is not opted in")
    expect(optOut.effect == .none, "a preflight does nothing")

    let toggle = miniHandle(raw: "GET /toggle?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n", token: token)
    expect(toggle.effect == .toggle, "the right token toggles")
    expect(!toggle.head.contains("Access-Control-Allow-Origin"), "the action response has no CORS header")

    let wrong = miniHandle(raw: "GET /toggle?k=nope HTTP/1.1\r\nHost: 127.0.0.1:38411\r\n\r\n", token: token)
    expect(wrong.effect == .none, "a wrong token does not toggle")

    let missing = miniHandle(raw: "POST /lyric HTTP/1.1\r\nHost: 127.0.0.1:38411\r\n\r\nsecret lyric", token: token)
    expect(missing.effect == .none, "a lyric with no token is dropped")

    let lyric = miniHandle(raw: "POST /lyric?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\n\r\nline", token: token)
    expect(lyric.effect == .lyric("line"), "a lyric is kept only with the token")

    let lines = miniHandle(raw: "POST /lines?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\n\r\n{\"d\":1}", token: token)
    expect(lines.effect == .lines("{\"d\":1}"), "lyric timings are kept only with the token")

    let supportWeb = miniHandle(raw: "GET /support?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: https://evil.example\r\n\r\n", token: token, supportState: { "invited" })
    expect(supportWeb.status == 404 && !supportWeb.body.contains("invited"), "a website cannot read support invite state")

    let supportNoTok = miniHandle(raw: "GET /support HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n", token: token, supportState: { "invited" })
    expect(supportNoTok.status == 404, "support state requires the token")

    let supportOk = miniHandle(raw: "GET /support?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n", token: token, supportState: { "invited" })
    expect(supportOk.status == 200 && supportOk.body == "{\"state\":\"invited\"}", "Spotify can read support invite state with the token")

    let supportAct = miniHandle(raw: "POST /support?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n", token: token, supportState: { "invited" })
    expect(supportAct.effect == .support, "POST /support triggers support action with the token")

    let supportBadAct = miniHandle(raw: "POST /support?k=nope HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n", token: token, supportState: { "invited" })
    expect(supportBadAct.effect == .none, "POST /support without valid token is refused")

    let chatWeb = miniHandle(raw: "POST /support/chat/send?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: https://evil.example\r\n\r\n{\"message\":\"hi\"}", token: token)
    expect(chatWeb.status == 404 && chatWeb.effect == .none, "a website cannot send chat messages to Pi")

    let chatSend = miniHandle(raw: "POST /support/chat/send?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n{\"message\":\"hi\"}", token: token)
    expect(chatSend.status == 200 && chatSend.effect == .supportSend("{\"message\":\"hi\"}"), "Spotify can send chat messages with token")

    let chatEvents = miniHandle(raw: "GET /support/chat/events?k=\(token)&after=3 HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n", token: token, supportEventsJSON: { after in "{\"after\":\(after)}" })
    expect(chatEvents.status == 200 && chatEvents.body == "{\"after\":3}", "Spotify can poll chat events with after cursor")

    let chatDecline = miniHandle(raw: "POST /support/decline?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n", token: token)
    expect(chatDecline.status == 200 && chatDecline.effect == .supportDecline, "Spotify can decline invite cleanly")

    let chatReset = miniHandle(raw: "POST /support/chat/reset?k=\(token) HTTP/1.1\r\nHost: 127.0.0.1:38411\r\nOrigin: \(spotify)\r\n\r\n", token: token)
    expect(chatReset.status == 200 && chatReset.effect == .supportReset, "Spotify can reset chat session")

    fputs("mini gate tests passed\n", stdout)
  }
}

func expect(_ cond: Bool, _ name: String) {
  if !cond {
    fputs("FAIL \(name)\n", stderr)
    exit(1)
  }
}
