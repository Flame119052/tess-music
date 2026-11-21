import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreGraphics

// A short silent recording of the Spotify window, and nothing else.
//
//   tess-record <window id> <out.mov> [seconds]
//
// The support visit hands over the same window id its still capture already
// found. This helper checks that id itself before it records: the window must
// be owned by Spotify, on screen, at layer 0. Any other id stops here, so the
// tool can never be pointed at a different window. The only filter it can
// build is one window: there is no display-wide path to fall back to.
// Seconds is capped at 10 so a mistake stays a short clip.

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(("tess-record: \(message)\n").data(using: .utf8) ?? Data())
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: tess-record <window id> <out.mov> [seconds]") }
guard let wid = UInt32(args[1]), wid != 0 else { fail("that is not the Spotify window") }
let outPath = args[2]
var seconds = 8.0
if args.count > 3 {
  guard let parsed = Double(args[3]), parsed >= 2, parsed <= 10 else { fail("seconds must be between 2 and 10") }
  seconds = parsed
}

guard #available(macOS 13.0, *) else { fail("recording the window needs macOS 13 or newer") }

// The same rule the still uses: Spotify-owned and layer 0. The list is not
// limited to on-screen windows on purpose — a window another app fully covers
// is still the Spotify window, and the capture composites it either way.
guard let rows = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
      let hit = rows.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == wid }),
      (hit[kCGWindowOwnerName as String] as? String) == "Spotify",
      (hit[kCGWindowLayer as String] as? Int) == 0 else {
  fail("that is not the Spotify window")
}

// Frames arrive on a queue; the writer is only ever fed .screen buffers, so no
// audio sample can end up in the file even if the stream offered one.
final class Sink: NSObject, SCStreamOutput {
  let input: AVAssetWriterInput
  let writer: AVAssetWriter
  var started = false
  var frames = 0

  init(writer: AVAssetWriter, input: AVAssetWriterInput) {
    self.writer = writer
    self.input = input
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, buffer.isValid, input.isReadyForMoreMediaData else { return }
    if !started {
      writer.startSession(atSourceTime: buffer.presentationTimeStamp)
      started = true
    }
    if input.append(buffer) { frames += 1 }
  }
}

let done = DispatchSemaphore(value: 0)
var failure: String?

Task {
  defer { done.signal() }
  do {
    // Screen Recording permission is asked for by this call itself; without it
    // the content list comes back empty or the capture refuses.
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == wid }) else {
      failure = "the Spotify window is not shareable; turn on Screen Recording for Tess Support"
      return
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    // pointPixelScale is macOS 14; the floor here is 13, so the scale comes from
    // whichever screen the window sits on.
    let scale = NSScreen.screens.first(where: { $0.frame.intersects(window.frame) })?.backingScaleFactor ?? 2
    let config = SCStreamConfiguration()
    config.width = Int(window.frame.width * scale)
    config.height = Int(window.frame.height * scale)
    config.capturesAudio = false
    config.showsCursor = false
    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    config.queueDepth = 6
    config.pixelFormat = kCVPixelFormatType_32BGRA

    let url = URL(fileURLWithPath: outPath)
    let writer = try AVAssetWriter(url: url, fileType: .mov)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: config.width,
      AVVideoHeightKey: config.height,
    ])
    input.expectsMediaDataInRealTime = true
    guard writer.canAdd(input) else {
      failure = "the recording file cannot take video"
      return
    }
    writer.add(input)

    let sink = Sink(writer: writer, input: input)
    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
    try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "tess-record.frames"))
    try await stream.startCapture()
    guard writer.startWriting() else {
      failure = writer.error?.localizedDescription ?? "the recording file could not start"
      try? await stream.stopCapture()
      return
    }

    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    try await stream.stopCapture()
    input.markAsFinished()
    await writer.finishWriting()
    if writer.status != .completed {
      failure = writer.error?.localizedDescription ?? "the recording did not finish"
      return
    }
    if sink.frames == 0 {
      failure = "nothing was recorded; the window may be fully hidden"
      return
    }
  } catch {
    failure = error.localizedDescription
  }
}
done.wait()
if let failure {
  try? FileManager.default.removeItem(atPath: outPath)
  fail(failure)
}
