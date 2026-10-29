import AVFoundation
import ExpoModulesCore

public final class PhoneDisplayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PhoneDisplay")
    View(PhoneDisplayView.self) {
      Events("onReady", "onNeedsKeyframe")
      AsyncFunction("reset") { (view: PhoneDisplayView, epoch: String) in view.reset(epoch) }
      AsyncFunction("decode") { (view: PhoneDisplayView, frame: FramePacket) -> Bool in
        view.decode(epoch: frame.epoch, base64: frame.data, width: frame.width, height: frame.height, pts: frame.pts, key: frame.key, replayed: frame.replayed)
      }
    }
  }
}

struct FramePacket: Record {
  @Field var epoch: String = ""
  @Field var data: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var pts: Double = 0
  @Field var key: Bool = false
  @Field var replayed: Bool = false
}

final class PhoneDisplayView: ExpoView {
  let onReady = EventDispatcher()
  let onNeedsKeyframe = EventDispatcher()
  private let display = AVSampleBufferDisplayLayer()
  private var epoch = ""
  private var format: CMVideoFormatDescription?
  private var announced = false
  private var background: NSObjectProtocol?
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    display.videoGravity = .resizeAspect
    layer.addSublayer(display)
    background = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.reset("") }
  }
  deinit { if let background { NotificationCenter.default.removeObserver(background) } }
  override func layoutSubviews() { super.layoutSubviews(); display.frame = bounds }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { reset(epoch) } else { onNeedsKeyframe(["epoch": epoch]) }
  }
  func reset(_ next: String) {
    epoch = next
    display.flushAndRemoveImage()
    format = nil
    announced = false
  }
  private func nals(_ bytes: [UInt8]) -> [[UInt8]] {
    var starts: [(Int, Int)] = []
    var i = 0
    while i + 2 < bytes.count {
      if bytes[i] == 0 && bytes[i + 1] == 0 {
        if bytes[i + 2] == 1 { starts.append((i, i + 3)); i += 3; continue }
        if i + 3 < bytes.count && bytes[i + 2] == 0 && bytes[i + 3] == 1 { starts.append((i, i + 4)); i += 4; continue }
      }
      i += 1
    }
    return starts.enumerated().compactMap { index, start in
      let end = index + 1 < starts.count ? starts[index + 1].0 : bytes.count
      return start.1 < end ? Array(bytes[start.1..<end]) : nil
    }
  }
  func decode(epoch wanted: String, base64: String, width: Int, height: Int, pts: Double, key: Bool, replayed: Bool) -> Bool {
    guard wanted == epoch, window != nil, UIApplication.shared.applicationState == .active,
      base64.utf8.count <= 5_592_408, let bytes = Data(base64Encoded: base64) else { return false }
    if display.status == .failed { reset(wanted); return false }
    let units = nals(Array(bytes))
    if key {
      guard let sps = units.first(where: { $0[0] & 31 == 7 }), let pps = units.first(where: { $0[0] & 31 == 8 }) else { return false }
      let result = sps.withUnsafeBufferPointer { spsBuffer in
        pps.withUnsafeBufferPointer { ppsBuffer in
          let pointers = [spsBuffer.baseAddress!, ppsBuffer.baseAddress!]
          let sizes = [sps.count, pps.count]
          return pointers.withUnsafeBufferPointer { pointerBuffer in
            sizes.withUnsafeBufferPointer { sizeBuffer in
              CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: pointerBuffer.baseAddress!, parameterSetSizes: sizeBuffer.baseAddress!, nalUnitHeaderLength: 4, formatDescriptionOut: &format)
            }
          }
        }
      }
      guard result == noErr else { return false }
    }
    guard let format, display.isReadyForMoreMediaData, display.status != .failed else { return false }
    var packet = Data()
    for nal in units where nal[0] & 31 != 7 && nal[0] & 31 != 8 {
      var length = UInt32(nal.count).bigEndian
      withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }
      packet.append(contentsOf: nal)
    }
    guard !packet.isEmpty else { return false }
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: packet.count, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: packet.count, flags: 0, blockBufferOut: &block) == noErr, let block else { return false }
    let copied = packet.withUnsafeBytes { buffer in CMBlockBufferReplaceDataBytes(with: buffer.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: packet.count) }
    guard copied == noErr else { return false }
    var size = packet.count
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(value: Int64(pts), timescale: 1_000_000), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample) == noErr, let sample else { return false }
    // Reference pictures must be decoded, but replay never exposes an older image.
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) {
      let item = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(item, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
      if replayed { CFDictionarySetValue(item, Unmanaged.passUnretained(kCMSampleAttachmentKey_DoNotDisplay).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()) }
    }
    display.enqueue(sample)
    if !replayed && !announced { announced = true; onReady(["epoch": wanted, "width": width, "height": height]) }
    return true
  }
}
