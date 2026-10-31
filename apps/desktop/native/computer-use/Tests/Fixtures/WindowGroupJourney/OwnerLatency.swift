import AppKit
import CoreMedia

@MainActor enum OwnerLatencyEvidence {
  static func run(
    wire: WireJourney, media: WireJourney, stream: String, generation: Int,
    window: CGWindowID, person: PersonCover, out: URL,
    send: @MainActor ([[String: Any]]) async throws -> [String: Any]
  ) async throws -> [String: Any] {
    try await Contracts.command(out, "owner-latency")
    try await Contracts.command(out, "owner-state")
    let initialState = try JSONSerialization.jsonObject(
      with: Data(contentsOf: out.appendingPathComponent("owner-state.json"))) as! [String: Any]
    let initialText = try (initialState["text"] as? String).unwrap("latency initial text")
    let point = try JSONSerialization.jsonObject(
      with: Data(contentsOf: out.appendingPathComponent("owner-latency-point.json"))) as! [String: Any]
    let markerX = try (point["x"] as? NSNumber).unwrap("latency marker x").doubleValue
    let markerY = try (point["y"] as? NSNumber).unwrap("latency marker y").doubleValue
    let crop = try KeyWindow.currentFrame(window).unwrap("latency crop")
    let beforeClock = Int64(DispatchTime.now().uptimeNanoseconds / 1000)
    let hostClock = CMTimeConvertScale(CMClockGetTime(CMClockGetHostTimeClock()),
      timescale: 1_000_000, method: .default).value
    let afterClock = Int64(DispatchTime.now().uptimeNanoseconds / 1000)
    let offset = (beforeClock + afterClock) / 2 - hostClock
    let uncertainty = afterClock - beforeClock
    var samples: [[String: Any]] = []
    defer {
      try? JSONSerialization.data(withJSONObject: samples, options: [.prettyPrinted, .sortedKeys])
        .write(to: out.appendingPathComponent("owner-latency-samples.json"))
    }
    func diagnostics() throws -> [[String: Any]] {
      try String(contentsOf: out.appendingPathComponent("owner-video.jsonl"), encoding: .utf8)
        .split(separator: "\n").map {
          try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any]
        }
    }
    for index in 0..<60 {
      let eventAt = Int64(DispatchTime.now().uptimeNanoseconds / 1000)
      let deadline = UInt64(eventAt) * 1000 + 1_000_000_000
      let receipt = try await send([
        ["kind": "key", "action": "down", "code": "KeyL", "key": "l", "modifiers": [], "text": "l"],
        ["kind": "key", "action": "up", "code": "KeyL", "key": "l", "modifiers": []],
      ])
      try require(receipt["outcome"] as? String == "dispatched", "Latency key was refused")
      let sequence = try (receipt["sequence"] as? NSNumber).unwrap("latency input sequence").intValue
      var measured = false
      var refreshedPTS: Int64?
      while DispatchTime.now().uptimeNanoseconds < deadline,
        let frame = try await media.nextMediaFrame(until: deadline) {
        let geometry = try (frame.header["generation"] as? NSNumber).unwrap("latency frame generation").intValue
        try require(geometry == generation, "Stable latency typing changed capture generation")
        let pts = try (frame.header["ptsUs"] as? NSNumber).unwrap("latency frame PTS").int64Value
        guard pts + offset - uncertainty >= eventAt else { continue }
        if frame.header["key"] as? Bool != true {
          // The fixture decodes independent keys. Request one only after a new
          // capture arrives: refreshing a warm picture cannot make it fresh.
          if refreshedPTS != pts {
            refreshedPTS = pts
            _ = try await wire.request("display.refresh", ["streamId": stream], timeoutMs: 1000, until: deadline)
          }
          continue
        }
        let image = try await VideoEvidence.decode(frame.annex)
        let decodedAt = Int64(DispatchTime.now().uptimeNanoseconds / 1000)
        let bitmap = NSBitmapImageRep(cgImage: image)
        let x = Int((markerX - crop.minX) / crop.width * Double(image.width))
        let y = Int((markerY - crop.minY) / crop.height * Double(image.height))
        try require(x >= 0 && y >= 0 && x < image.width && y < image.height, "Latency marker is outside the decoded frame")
        let color = try (bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB)).unwrap("decoded latency marker")
        let green = (index + 1) % 2 == 1
        guard green ? color.greenComponent > color.redComponent + 0.4
          : color.redComponent > color.greenComponent + 0.4 else { continue }
        let drawnAt = Int64(try person.drawDecoded(image))
        try require(UInt64(drawnAt) * 1000 <= deadline, "Changed latency marker missed its one-second deadline")
        let rows = try diagnostics()
        let dispatch = try rows.first(where: {
          $0["event"] as? String == "owner-input-dispatch" && $0["streamId"] as? String == stream
            && ($0["inputSequence"] as? NSNumber)?.intValue == sequence
        }).unwrap("native dispatch timestamp")
        let capture = try rows.first(where: {
          $0["event"] as? String == "capture-sample" && $0["streamId"] as? String == stream
            && ($0["generation"] as? NSNumber)?.intValue == generation
            && ($0["ptsUs"] as? NSNumber)?.int64Value == pts
        }).unwrap("capture timestamp for decoded frame")
        let dispatchedAt = try (dispatch["uptimeUs"] as? NSNumber).unwrap("dispatch uptime").int64Value
        let capturedAt = try (capture["uptimeUs"] as? NSNumber).unwrap("capture uptime").int64Value
        try require(eventAt <= dispatchedAt && dispatchedAt <= capturedAt
          && capturedAt <= decodedAt && decodedAt <= drawnAt, "Latency timestamps are not causally ordered")
        let name = "owner-latency-\(index).png"
        try bitmap.representation(using: .png, properties: [:]).unwrap("latency PNG")
          .write(to: out.appendingPathComponent(name))
        samples.append(["sequence": sequence, "generation": generation, "eventUs": eventAt,
          "dispatchUs": dispatchedAt, "capturePTSUs": pts, "captureCallbackUs": capturedAt,
          "decodeUs": decodedAt, "drawUs": drawnAt, "latencyMs": Double(drawnAt - eventAt) / 1000,
          "png": name])
        measured = true
        break
      }
      try require(measured, "No causally fresh changed marker reached the native latency viewer within one second")
    }
    try await Contracts.command(out, "owner-latency-end")
    try await Contracts.command(out, "owner-state")
    let state = try JSONSerialization.jsonObject(
      with: Data(contentsOf: out.appendingPathComponent("owner-state.json"))) as! [String: Any]
    try require(state["latencyChanges"] as? Int == 60, "Latency input did not change the application exactly once per sample")
    try require(state["text"] as? String == initialText + String(repeating: "l", count: 60),
      "Latency typing changed, lost or duplicated native text")
    let values = samples.map { $0["latencyMs"] as! Double }.sorted()
    func percentile(_ fraction: Double) -> Double { values[Int(ceil(Double(values.count) * fraction)) - 1] }
    let result: [String: Any] = ["passed": true, "samples": samples.count,
      "boundary": "native helper wire, changed fixture pixels, VideoToolbox decode, AppKit draw; excludes Host/Runner/shipping viewer",
      "clockOffsetUs": offset, "clockUncertaintyUs": uncertainty,
      "p50Ms": percentile(0.5), "p95Ms": percentile(0.95), "p99Ms": percentile(0.99)]
    try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
      .write(to: out.appendingPathComponent("owner-latency.json"))
    return result
  }
}
