import AppKit
import CoreImage
import CoreMedia
import CoreVideo
import Darwin
import VideoToolbox

/// Records the production task-video producer's authenticated-media payload,
/// decodes its IDR with VideoToolbox and retains both bitstream and pixels.
@WorkActor enum VideoEvidence {
  static func capture(bound: SessionWindow, observation: Observation, out: URL, recover: Bool = false) async throws {
    let states = Locked<[MacVideoState]>([])
    defer { try? JSONCoding.encoder.encode(states.current).write(to: out.appendingPathComponent("video-states.json")) }
    let peer = try await VideoPeer(out: out, states: states)
    do {
      try await capture(bound: bound, observation: observation, out: out, recover: recover, peer: peer)
    } catch {
      await peer.close()
      throw error
    }
    await peer.close()
  }

  private static func capture(bound: SessionWindow, observation: Observation, out: URL,
                              recover: Bool, peer: VideoPeer) async throws {
    let producer = try await peer.start(app: observation.app, window: bound.windowID)
    defer { producer.stop() }
    let binding = producer.binding
    let owner = binding.window
    let frame = try await peer.nextGeneration()
    let (headerData, header, annex) = try media(frame)
    try require(header["key"] as? Bool == true, "First task-video sample is not an IDR")
    try annex.write(to: out.appendingPathComponent("N1-task.h264"))
    try headerData.write(to: out.appendingPathComponent("N1-video-header.json"))
    let image = try decode(annex)
    let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    try png.unwrap("decoded PNG").write(to: out.appendingPathComponent("N1-decoded.png"))
    let group = try owner.group()
    let aspect = group.crop.width / group.crop.height
    try require(
      abs(CGFloat(image.width) / CGFloat(image.height) - aspect) < 0.01,
      "Decoded video crop differs from A group")
    guard let jpeg = observation.screenshot, let bytes = Data(base64Encoded: jpeg.base64),
      let screenshot = NSImage(data: bytes)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { throw JourneyFailure.failed("N1 screenshot missing") }
    let error = try pixelDifference(screenshot, image)
    try require(error < 0.047, "Decoded H.264 differs from screenshot pixels: \(error)")
    try JSONSerialization.data(
      withJSONObject: [
        "meanAbsoluteRGBError": error, "width": image.width, "height": image.height, "passed": true,
      ], options: [.prettyPrinted]
    ).write(to: out.appendingPathComponent("N1-video-comparison.json"))
    if recover {
      var generation = try (header["generation"] as? Int).unwrap("Initial video generation")
      for (name, message) in [
        ("association", "This window's ownership changed; observe again."),
        ("membership", "This app changed while it was being observed."),
      ] {
        producer.startFailed(HelperError(.staleObservation, message), operation: "plan")
        try require(!producer.ended && producer.needsResume && producer.inputMap == nil,
          "A stale \(name) plan ended the view or kept old input available")
        let (data, header, annex) = try media(try await peer.nextGeneration(after: generation))
        generation = try (header["generation"] as? Int).unwrap("Recovered video generation")
        try require(producer.binding === binding && !producer.ended,
          "Recovery replaced the selected window or ended its view")
        try require(try pixelDifference(screenshot, decode(annex)) < 0.047,
          "Recovered \(name) video differs from the selected window")
        try data.write(to: out.appendingPathComponent("N1-recovered-\(name)-header.json"))
        try annex.write(to: out.appendingPathComponent("N1-recovered-\(name).h264"))
      }
    }
    producer.stop()
    let end = Date().addingTimeInterval(10)
    while !producer.resourcesSettled, Date() < end { try await Task.sleep(nanoseconds: 20_000_000) }
    try require(producer.resourcesSettled, "Video resources did not settle after stop")
  }

  nonisolated private static func media(_ frame: Data) throws -> (Data, [String: Any], Data) {
    try require(frame.count > 4, "Media envelope truncated")
    let length = frame.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
    try require(length > 0 && length < frame.count - 4, "Invalid media header")
    let data = frame.subdata(in: 4..<(4 + length))
    let header = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    return (data, header, frame.subdata(in: (4 + length)..<frame.count))
  }

  static func decode(_ annex: Data) throws -> CGImage {
    let bytes = [UInt8](annex)
    let starts = (0..<max(0, bytes.count - 3)).filter {
      Array(bytes[$0..<($0 + 4)]) == [0, 0, 0, 1]
    }
    let nals: [Data] = starts.enumerated().map { i, start in
      Data(bytes[(start + 4)..<(i + 1 < starts.count ? starts[i + 1] : bytes.count)])
    }
    let sps = try nals.first(where: { $0.first.map { $0 & 31 == 7 } == true }).unwrap("SPS")
    let pps = try nals.first(where: { $0.first.map { $0 & 31 == 8 } == true }).unwrap("PPS")
    var format: CMFormatDescription?
    let formatStatus = sps.withUnsafeBytes { a in
      pps.withUnsafeBytes { b in
        let pointers = [
          a.bindMemory(to: UInt8.self).baseAddress!, b.bindMemory(to: UInt8.self).baseAddress!,
        ]
        let sizes = [sps.count, pps.count]
        return CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: nil, parameterSetCount: 2,
          parameterSetPointers: pointers, parameterSetSizes: sizes, nalUnitHeaderLength: 4,
          formatDescriptionOut: &format)
      }
    }
    try require(formatStatus == noErr, "Invalid H.264 parameter sets")
    let output = Locked<CVPixelBuffer?>(nil)
    var callback = VTDecompressionOutputCallbackRecord(
      decompressionOutputCallback: { context, _, status, _, image, _, _ in
        guard let context, status == noErr, let image else { return }
        Unmanaged<Locked<CVPixelBuffer?>>.fromOpaque(context).takeUnretainedValue().withLock {
          $0 = image
        }
      }, decompressionOutputRefCon: Unmanaged.passUnretained(output).toOpaque())
    var session: VTDecompressionSession?
    try require(
      VTDecompressionSessionCreate(
        allocator: nil, formatDescription: try format.unwrap("format"), decoderSpecification: nil,
        imageBufferAttributes: [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA]
          as CFDictionary,
        outputCallback: &callback, decompressionSessionOut: &session) == noErr,
      "H.264 decoder unavailable")
    let decoder = try session.unwrap("decoder")
    defer { VTDecompressionSessionInvalidate(decoder) }
    var avcc = Data()
    for nal in nals where nal.first.map({ $0 & 31 != 7 && $0 & 31 != 8 }) == true {
      var length = UInt32(nal.count).bigEndian
      withUnsafeBytes(of: &length) { avcc.append(contentsOf: $0) }
      avcc.append(nal)
    }
    var block: CMBlockBuffer?
    try require(
      CMBlockBufferCreateWithMemoryBlock(
        allocator: nil, memoryBlock: nil, blockLength: avcc.count, blockAllocator: nil,
        customBlockSource: nil, offsetToData: 0, dataLength: avcc.count, flags: 0,
        blockBufferOut: &block) == noErr, "AVCC buffer")
    let data = try block.unwrap("block")
    try require(
      avcc.withUnsafeBytes {
        CMBlockBufferReplaceDataBytes(
          with: $0.baseAddress!, blockBuffer: data, offsetIntoDestination: 0, dataLength: avcc.count
        )
      } == noErr, "AVCC copy")
    var sample: CMSampleBuffer?
    var size = avcc.count
    try require(
      CMSampleBufferCreateReady(
        allocator: nil, dataBuffer: data, formatDescription: format, sampleCount: 1,
        sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1,
        sampleSizeArray: &size, sampleBufferOut: &sample) == noErr, "H.264 sample")
    try require(
      VTDecompressionSessionDecodeFrame(
        decoder, sampleBuffer: try sample.unwrap("sample"), flags: [], frameRefcon: nil,
        infoFlagsOut: nil) == noErr, "H.264 decode")
    VTDecompressionSessionWaitForAsynchronousFrames(decoder)
    let image = CIImage(cvPixelBuffer: try output.current.unwrap("decoded buffer"))
    return try CIContext().createCGImage(image, from: image.extent).unwrap("decoded image")
  }

  private static func pixelDifference(_ left: CGImage, _ right: CGImage) throws -> Double {
    func pixels(_ image: CGImage) throws -> [UInt8] {
      var bytes = [UInt8](repeating: 0, count: 320 * 240 * 4)
      try bytes.withUnsafeMutableBytes { raw in
        let context = try CGContext(
          data: raw.baseAddress, width: 320, height: 240, bitsPerComponent: 8,
          bytesPerRow: 320 * 4, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ).unwrap("pixel context")
        context.draw(image, in: CGRect(x: 0, y: 0, width: 320, height: 240))
      }
      return bytes
    }
    let a = try pixels(left)
    let b = try pixels(right)
    let sum = stride(from: 0, to: a.count, by: 4).reduce(0) { total, i in
      total + (0..<3).reduce(0) { $0 + abs(Int(a[i + $1]) - Int(b[i + $1])) }
    }
    return Double(sum) / Double(320 * 240 * 3 * 255)
  }
}

/// Uses the real owner lease, media attachment and helper lifecycle scheduler.
@MainActor private final class VideoPeer {
  private let control: WireJourney
  private let media: WireJourney
  private let producer = Locked<MacWindowVideoProducer?>(nil)

  init(out: URL, states: Locked<[MacVideoState]>) throws {
    let control = try WireJourney(out: out.appendingPathComponent("wire"))
    self.control = control
    do {
      media = try WireJourney(out: out.appendingPathComponent("media"), helper: control.helper)
    } catch {
      control.close()
      throw error
    }
    let selected = producer
    control.helper.videoProducerFactory = { id, binding, authority, onState in
      let value = MacWindowVideoProducer(id: id, binding: binding,
        operations: SerialTaskChain(), authority: authority, onState: { state in
          states.withLock { $0.append(state) }
          onState(state)
        })
      selected.withLock { $0 = value }
      return value
    }
    do { try control.helper.start(socketURL: control.out.appendingPathComponent("helper.sock")) }
    catch { media.close(); control.close(); throw error }
  }

  func start(app: AppIdentity, window: CGWindowID) async throws -> MacWindowVideoProducer {
    let identity = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(app))
    let view = "cvw_" + UUID().uuidString.lowercased()
    let source: [String: Any] = ["kind": "owner-view", "viewId": view, "generation": 1]
    try await control.hello()
    _ = try await control.request("view.open", ["viewId": view, "generation": 1,
      "leaseDurationMs": 300_000, "target": ["kind": "app", "app": identity, "window": window]])
    let resolved = try await control.request("display.resolve", ["source": source])
    let target = try (resolved["target"] as? [String: Any]).unwrap("video target")
    let started = try await control.request("display.start", ["streamId": "dsp_" + UUID().uuidString.lowercased(),
      "target": target, "sources": [source], "maxLongSide": 1280, "maxFps": 15])
    try await media.hello()
    _ = try await media.request("display.attach", ["token": started["attachmentToken"]!])
    return try producer.current.unwrap("production video producer")
  }

  func nextGeneration(after generation: Int = 0) async throws -> Data {
    let deadline = DispatchTime.now().uptimeNanoseconds + 12_000_000_000
    while let frame = try await media.nextMediaFrame(until: deadline) {
      if (frame.header["generation"] as? Int ?? 0) > generation {
        try require(frame.header["key"] as? Bool == true,
          "First task-video sample after generation \(generation) is not an IDR")
        return frame.frame
      }
    }
    throw JourneyFailure.failed("No H.264 key frame after generation \(generation) from production producer")
  }

  func close() { media.close(); control.close() }
}
