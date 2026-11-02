import AVFoundation
import ExpoModulesCore

public final class PhoneDisplayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PhoneDisplay")
    Constant("decoderRecoveryVersion") { 1 }
    // JavaScript reads this before using decodeBytes or the picture view: an
    // older binary has neither, and keeps the base64 and Image paths.
    Constant("binaryPresentationVersion") { 1 }
    // The first view stays the module's default view, which older JavaScript requires by module name.
    View(PhoneDisplayView.self) {
      Events("onReady", "onNeedsKeyframe")
      AsyncFunction("reset") { (view: PhoneDisplayView, epoch: String) in view.reset(epoch) }
      AsyncFunction("decode") { (view: PhoneDisplayView, frame: FramePacket) -> Bool in
        guard frame.data.utf8.count <= 5_592_408, let bytes = Data(base64Encoded: frame.data) else { view.lost(frame.epoch); return false }
        return view.decode(bytes, FrameMetadata(frame))
      }
      // Expo copies the Uint8Array into Data once, on the JavaScript thread.
      AsyncFunction("decodeBytes") { (view: PhoneDisplayView, bytes: Data, metadata: FrameMetadata) -> Bool in
        view.decode(bytes, metadata)
      }
    }
    View(PhoneDisplayPictureView.self) {
      ViewName("PhoneDisplayPicture")
      Events("onCleared")
      AsyncFunction("clear") { (view: PhoneDisplayPictureView, generation: Int) in view.clear(generation) }
      AsyncFunction("present") { (view: PhoneDisplayPictureView, bytes: Data, metadata: PictureMetadata, promise: Promise) in
        view.present(bytes, metadata.request) { promise.resolve($0.rawValue) }
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

struct FrameMetadata: Record {
  @Field var epoch: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var pts: Double = 0
  @Field var key: Bool = false
  @Field var replayed: Bool = false

  init() {}
  init(_ packet: FramePacket) {
    epoch = packet.epoch
    width = packet.width
    height = packet.height
    pts = packet.pts
    key = packet.key
    replayed = packet.replayed
  }
}

struct PictureMetadata: Record {
  @Field var generation: Int = 0
  @Field var fence: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var regionWidth: Double = 0
  @Field var regionHeight: Double = 0
  @Field var upscale: Bool = true
  @Field var cornerRadius: Double = 0

  var request: PictureRequest {
    PictureRequest(generation: generation, fence: fence, width: width, height: height, regionWidth: regionWidth, regionHeight: regionHeight, upscale: upscale, cornerRadius: cornerRadius)
  }
}

final class PhoneDisplayView: ExpoView {
  let onReady = EventDispatcher()
  let onNeedsKeyframe = EventDispatcher()
  private let display = AVSampleBufferDisplayLayer()
  private var epoch = ""
  private var format: CMVideoFormatDescription?
  private var announced = false
  private var fence = KeyframeFence()
  private var recovering = false
  private var statusObservation: NSKeyValueObservation?
  /// The size of the first picture this epoch enqueued for display, awaiting the layer's readiness.
  private var awaiting: (width: Int, height: Int)?
  private var observers: [NSObjectProtocol] = []
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    display.videoGravity = .resizeAspect
    layer.addSublayer(display)
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.recover() })
    for name in [NSNotification.Name.AVSampleBufferDisplayLayerFailedToDecode, NSNotification.Name.AVSampleBufferDisplayLayerRequiresFlushToResumeDecodingDidChange] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: display, queue: .main) { [weak self] _ in
        guard let self else { return }
        if name == NSNotification.Name.AVSampleBufferDisplayLayerFailedToDecode || self.display.requiresFlushToResumeDecoding { self.recover() }
      })
    }
    statusObservation = display.observe(\.status, options: [.new]) { [weak self] layer, _ in
      guard layer.status == .failed else { return }
      DispatchQueue.main.async {
        guard let self, self.display.status == .failed else { return }
        self.recover()
      }
    }
    if #available(iOS 17.4, *) {
      observers.append(NotificationCenter.default.addObserver(forName: .AVSampleBufferDisplayLayerReadyForDisplayDidChange, object: display, queue: .main) { [weak self] _ in self?.announceIfReady() })
    }
  }
  deinit { observers.forEach(NotificationCenter.default.removeObserver) }
  override func layoutSubviews() { super.layoutSubviews(); display.frame = bounds }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { recover() } else { onNeedsKeyframe(["epoch": epoch]) }
  }
  func reset(_ next: String) {
    epoch = next
    fence.lost()
    display.flushAndRemoveImage()
    format = nil
    announced = false
    awaiting = nil
  }
  func lost(_ wanted: String) { if wanted == epoch { fence.lost() } }
  private func recover() {
    guard !recovering else { return }
    recovering = true
    reset(epoch)
    onNeedsKeyframe(["epoch": epoch, "pictureGone": true])
    recovering = false
  }
  /// Enqueueing admits a sample; it does not show it. Where the layer reports
  /// readiness, the picture is announced only once it can be seen.
  private func announceIfReady() {
    guard !announced, let size = awaiting, window != nil else { return }
    if #available(iOS 17.4, *), !display.isReadyForDisplay { return }
    announced = true
    awaiting = nil
    onReady(["epoch": epoch, "width": size.width, "height": size.height])
  }
  func decode(_ bytes: Data, _ frame: FrameMetadata) -> Bool {
    guard frame.epoch == epoch else { return false }
    var admitted = false
    defer { if !admitted { fence.lost() } }
    guard fence.allows(key: frame.key), window != nil, UIApplication.shared.applicationState == .active, bytes.count <= 4_194_306 else { return false }
    if display.status == .failed || display.requiresFlushToResumeDecoding { recover(); return false }
    let loss = fence.captureLoss()
    admitted = bytes.withUnsafeBytes { enqueue($0, frame) }
    if admitted { fence.enqueued(key: frame.key, lossAtAdmission: loss) }
    return admitted
  }
  private func enqueue(_ bytes: UnsafeRawBufferPointer, _ frame: FrameMetadata) -> Bool {
    let unit = H264AccessUnit(bytes)
    if frame.key {
      guard let sps = unit.sps, let pps = unit.pps else { return false }
      let base = bytes.baseAddress!.assumingMemoryBound(to: UInt8.self)
      let pointers = [UnsafePointer(base + sps.lowerBound), UnsafePointer(base + pps.lowerBound)]
      let sizes = [sps.count, pps.count]
      let result = CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: pointers, parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &format)
      guard result == noErr else { return false }
    }
    guard let format, display.isReadyForMoreMediaData, display.status != .failed else { return false }
    var size = unit.sampleLength
    guard size > 0 else { return false }
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: size, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: size, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr, let block else { return false }
    var pointer: UnsafeMutablePointer<CChar>?
    var contiguous = 0
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &contiguous, totalLengthOut: nil, dataPointerOut: &pointer) == noErr, let pointer, contiguous == size else { return false }
    unit.writeSample(from: bytes, into: UnsafeMutableRawBufferPointer(start: pointer, count: size))
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(value: Int64(frame.pts), timescale: 1_000_000), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample) == noErr, let sample else { return false }
    // Reference pictures must be decoded, but replay never exposes an older image.
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) {
      let item = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(item, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
      if frame.replayed { CFDictionarySetValue(item, Unmanaged.passUnretained(kCMSampleAttachmentKey_DoNotDisplay).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()) }
    }
    let loss = fence.captureLoss()
    display.enqueue(sample)
    guard loss == fence.captureLoss() else { return false }
    guard display.status != .failed, !display.requiresFlushToResumeDecoding else { recover(); return false }
    if !frame.replayed && !announced && awaiting == nil {
      awaiting = (frame.width, frame.height)
      announceIfReady()
    }
    return true
  }
}

/// A browser picture surface: JPEG deliveries decode off the main thread and
/// only the newest finished image replaces the one shown. Pixels live only in
/// this view, and clear before anything else may aim input at them.
final class PhoneDisplayPictureView: ExpoView {
  let onCleared = EventDispatcher()
  private static let decoder = DispatchQueue(label: "com.opensteer.display.picture", qos: .userInteractive)
  private let picture = CALayer()
  private let queue = PictureQueue<Data>()
  private var shown: PictureRequest?
  /// Counts every change of what is shown, so a commit learns whether its picture is still the one on screen.
  private var shownVersion = 0
  /// The shown picture's receipt until its commit completes. Anything that
  /// replaces or removes the picture settles it at once: a commit's completion
  /// may wait indefinitely while the view is off screen or the app is inactive.
  private var undrawn: PictureReceipt?
  private var observer: NSObjectProtocol?
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    picture.contentsGravity = .resize
    picture.masksToBounds = true
    layer.addSublayer(picture)
    observer = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.blank() }
  }
  deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    queue.clear(queue.generation)
    undrawn?(.dropped)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    place()
    CATransaction.commit()
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { blank() }
  }
  private var showing: Bool { window != nil && UIApplication.shared.applicationState == .active }
  func clear(_ generation: Int) {
    queue.clear(generation)
    remove()
  }
  /// Leaves the generation alone: the same deliveries may draw once the view is shown again.
  private func blank() {
    queue.clear(queue.generation)
    guard shown != nil else { return }
    remove()
    onCleared(["generation": queue.generation])
  }
  private func remove() {
    undrawn?(.dropped)
    undrawn = nil
    shown = nil
    shownVersion += 1
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    picture.contents = nil
    CATransaction.commit()
  }
  func present(_ bytes: Data, _ request: PictureRequest, settle: @escaping (PictureOutcome) -> Void) {
    let receipt = PictureReceipt(settle)
    guard showing else { receipt(.dropped); return }
    if let job = queue.submit(request, bytes, receipt) { decode(job) }
  }
  private func decode(_ job: PictureQueue<Data>.Job) {
    Self.decoder.async { [weak self] in
      let image = PictureDecoder.decode(job.payload, width: job.request.width, height: job.request.height)
      DispatchQueue.main.async {
        guard let self else { job.receipt(.dropped); return }
        let result = self.queue.complete(decoded: image != nil)
        if let shown = result.shown, let image {
          if self.showing { self.draw(image, shown.request, shown.receipt) } else { shown.receipt(.dropped) }
        }
        if let next = result.next { self.decode(next) }
      }
    }
  }
  /// Settles as presented only once the picture's transaction has committed
  /// and it is still the one shown, so input never aims at a picture that was
  /// replaced or cleared before it reached the screen.
  private func draw(_ image: CGImage, _ request: PictureRequest, _ receipt: PictureReceipt) {
    undrawn?(.dropped)
    undrawn = receipt
    shown = request
    shownVersion += 1
    let version = shownVersion
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    CATransaction.setCompletionBlock { [weak self] in
      receipt(self?.shownVersion == version && self?.showing == true ? .presented : .dropped)
      if self?.undrawn === receipt { self?.undrawn = nil }
    }
    picture.contents = image
    picture.cornerRadius = request.cornerRadius
    place()
    CATransaction.commit()
  }
  private func place() {
    guard let shown, let rect = shown.rect(in: bounds.size) else {
      picture.isHidden = true
      return
    }
    picture.isHidden = false
    picture.frame = rect
  }
}
