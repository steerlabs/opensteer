import AVFoundation
import ExpoModulesCore
import MetalKit
import VideoToolbox

private final class BrowserVideoOutputs {
  private let lock = NSLock()
  private var frames: [Int: FrameMetadata] = [:]
  let output: (CVPixelBuffer, FrameMetadata) -> Void
  let lost: (FrameMetadata) -> Void
  init(_ output: @escaping (CVPixelBuffer, FrameMetadata) -> Void, lost: @escaping (FrameMetadata) -> Void) { self.output = output; self.lost = lost }
  func insert(_ frame: FrameMetadata) -> Int? {
    lock.lock(); defer { lock.unlock() }
    let id = Int(frame.pts) + 1
    guard frames.count < 8, frames[id] == nil else { return nil }
    frames[id] = frame
    return id
  }
  func remove(_ id: Int) -> FrameMetadata? { lock.lock(); defer { lock.unlock() }; return frames.removeValue(forKey: id) }
}

/// The VT callback's token survives asynchronous decode. A reset destroys its own
/// session on the decoder queue before releasing the callback context.
private final class BrowserVideoDecoder {
  private let queue = DispatchQueue(label: "com.opensteer.browser.video.decode", qos: .userInteractive)
  private var session: VTDecompressionSession?
  private var context: UnsafeMutableRawPointer?
  private var format: CMVideoFormatDescription?
  private var epoch = ""
  private var keyRequired = true
  private let output: (CVPixelBuffer, FrameMetadata) -> Void
  private let lost: (FrameMetadata) -> Void
  init(output: @escaping (CVPixelBuffer, FrameMetadata) -> Void, lost: @escaping (FrameMetadata) -> Void) { self.output = output; self.lost = lost }
  func reset(_ next: String) {
    queue.async { self.destroy(); self.epoch = next }
  }
  func close() { queue.async { self.destroy() } }
  private func destroy() {
    if let session { VTDecompressionSessionWaitForAsynchronousFrames(session); VTDecompressionSessionInvalidate(session) }
    session = nil; format = nil; keyRequired = true
    if let context { Unmanaged<BrowserVideoOutputs>.fromOpaque(context).release() }
    context = nil
  }
  func decode(_ data: Data, _ frame: FrameMetadata, done: @escaping (Bool) -> Void) {
    queue.async {
      guard frame.epoch == self.epoch, !data.isEmpty, data.count <= 4_194_304,
            frame.width > 0, frame.height > 0, frame.width <= 3840, frame.height <= 2160,
            frame.width * frame.height <= 3840 * 2160,
            frame.pts.isFinite, frame.pts >= 0, frame.pts < Double(Int.max - 1),
            !self.keyRequired || frame.key else { done(false); return }
      let accepted = data.withUnsafeBytes { self.submit($0, frame) }
      if !accepted { self.destroy() }
      done(accepted)
    }
  }
  private func submit(_ bytes: UnsafeRawBufferPointer, _ frame: FrameMetadata) -> Bool {
    let unit = H264AccessUnit(bytes)
    if frame.key {
      guard BrowserVideoSPS.valid(bytes,width:frame.width,height:frame.height) else {return false}
      guard let sps = unit.sps, let pps = unit.pps, let base = bytes.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return false }
      let pointers = [UnsafePointer(base + sps.lowerBound), UnsafePointer(base + pps.lowerBound)]
      let sizes = [sps.count, pps.count]
      var next: CMVideoFormatDescription?
      guard CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: pointers, parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &next) == noErr, let next else { return false }
      let size = CMVideoFormatDescriptionGetDimensions(next)
      guard size.width == frame.width, size.height == frame.height else { return false }
      if format == nil || !CMFormatDescriptionEqual(format!, otherFormatDescription: next) {
        destroy()
        format = next
        let outputs = BrowserVideoOutputs(output, lost: lost)
        context = Unmanaged.passRetained(outputs).toOpaque()
        var callback = VTDecompressionOutputCallbackRecord(decompressionOutputCallback: { ref, source, status, flags, image, _, _ in
          guard let ref, let source else { return }
          let outputs = Unmanaged<BrowserVideoOutputs>.fromOpaque(ref).takeUnretainedValue()
          guard let frame = outputs.remove(Int(bitPattern: source)) else { return }
          guard status == noErr, !flags.contains(.frameDropped), let image else { outputs.lost(frame); return }
          outputs.output(image, frame)
        }, decompressionOutputRefCon: context)
        let attributes: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelBufferMetalCompatibilityKey as String: true, kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        guard VTDecompressionSessionCreate(allocator: kCFAllocatorDefault, formatDescription: next, decoderSpecification: nil, imageBufferAttributes: attributes as CFDictionary, outputCallback: &callback, decompressionSessionOut: &session) == noErr else { destroy(); return false }
        if let session { VTSessionSetProperty(session, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue) }
      }
    }
    guard let session, let format, let context else { return false }
    let outputs = Unmanaged<BrowserVideoOutputs>.fromOpaque(context).takeUnretainedValue()
    guard let id = outputs.insert(frame) else { return false }
    var length = unit.sampleLength
    guard length > 0, length <= 4_194_304 else { _ = outputs.remove(id); return false }
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: length, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: length, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr, let block else { _ = outputs.remove(id); return false }
    var pointer: UnsafeMutablePointer<CChar>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: nil, dataPointerOut: &pointer) == noErr, let pointer else { _ = outputs.remove(id); return false }
    unit.writeSample(from: bytes, into: UnsafeMutableRawBufferPointer(start: pointer, count: length))
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(value: Int64(frame.pts), timescale: 1_000_000), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &length, sampleBufferOut: &sample) == noErr, let sample else { _ = outputs.remove(id); return false }
    let status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [._EnableAsynchronousDecompression], frameRefcon: UnsafeMutableRawPointer(bitPattern: id), infoFlagsOut: nil)
    guard status == noErr else { _ = outputs.remove(id); return false }
    keyRequired = false
    return true
  }
}

/// Identity commits at the Metal drawable's presentation callback. During a
/// transition no new touch can claim that either the old or new frame is visible.
final class BrowserVideoView: ExpoView, MTKViewDelegate {
  let onReady = EventDispatcher()
  let onNeedsKeyframe = EventDispatcher()
  let onVideoPresented = EventDispatcher()
  let onVideoGesture = EventDispatcher()
  let onVideoTap = EventDispatcher()
  let onVideoScroll = EventDispatcher()
  private var metal: MTKView?
  private var commandQueue: MTLCommandQueue?
  private var pipeline: MTLRenderPipelineState?
  private var textureCache: CVMetalTextureCache?
  private var epoch = ""
  private var zoom:Double=1
  private var version = 0
  private var decoderGeneration = 0
  private var rendering: UUID?
  private var committed: FrameMetadata?
  private var latest: (CVPixelBuffer, FrameMetadata)?
  private struct Gesture { let frame: FrameMetadata; let id: String; let point: CGPoint; let local: CGPoint; let bounds: CGRect; var last: CGPoint; var scrolling = false }
  private var gesture: Gesture?
  private var observer: NSObjectProtocol?
  private lazy var decoder = BrowserVideoDecoder(output: { [weak self] image, frame in DispatchQueue.main.async { self?.accept(image, frame) } }, lost: { [weak self] frame in
    DispatchQueue.main.async {
      guard let self, frame.epoch == self.epoch, frame.presentationVersion == self.decoderGeneration else { return }
      self.reset(frame.epoch); self.onNeedsKeyframe(["epoch": frame.epoch])
    }
  })
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    #if targetEnvironment(simulator)
    // Simulator Metal lacks drawable presentation receipts; completion cannot authorize a touch.
    return
    #else
    addGestureRecognizer(UIPinchGestureRecognizer(target:self,action:#selector(pinch(_:))))
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return }
    let view = MTKView(frame: bounds, device: device)
    view.isUserInteractionEnabled = false; view.isPaused = true; view.enableSetNeedsDisplay = true
    view.framebufferOnly = true; view.colorPixelFormat = .bgra8Unorm; view.delegate = self
    (view.layer as? CAMetalLayer)?.colorspace = CGColorSpace(name: CGColorSpace.itur_709)
    view.clearColor = MTLClearColorMake(0, 0, 0, 1); view.isHidden = true
    addSubview(view); metal = view; commandQueue = queue
    CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &textureCache)
    let source = """
    #include <metal_stdlib>
    using namespace metal;
    struct V { float4 position [[position]]; float2 uv; };
    vertex V videoVertex(uint id [[vertex_id]]) {
      float2 p[4] = {float2(-1,-1),float2(1,-1),float2(-1,1),float2(1,1)};
      float2 uv[4] = {float2(0,1),float2(1,1),float2(0,0),float2(1,0)};
      return {float4(p[id],0,1),uv[id]};
    }
    fragment float4 videoFragment(V in [[stage_in]], texture2d<float> y [[texture(0)]], texture2d<float> uv [[texture(1)]], constant float4 &crop [[buffer(0)]]) {
      constexpr sampler s(filter::linear, address::clamp_to_edge);
      float2 at=crop.xy+in.uv*crop.zw;
      float l=(y.sample(s,at).r-16.0/255.0)*(255.0/219.0);
      float2 c=(uv.sample(s,at).rg-float2(128.0/255.0))*(255.0/224.0);
      return float4(l+1.5748*c.y,l-0.187324*c.x-0.468124*c.y,l+1.8556*c.x,1);
    }
    """
    do {
      let library = try device.makeLibrary(source: source, options: nil)
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = library.makeFunction(name: "videoVertex")
      descriptor.fragmentFunction = library.makeFunction(name: "videoFragment")
      descriptor.colorAttachments[0].pixelFormat = view.colorPixelFormat
      pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
    } catch { metal = nil; view.removeFromSuperview() }
    observer = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in guard let self else { return }; self.reset(self.epoch) }
    #endif
  }
  @objc private func pinch(_ recognizer:UIPinchGestureRecognizer){cancelGesture();zoom=min(4,max(1,zoom*recognizer.scale));recognizer.scale=1;version+=1;committed=nil;metal?.setNeedsDisplay()}
  deinit { if let observer { NotificationCenter.default.removeObserver(observer) }; decoder.close() }
  override func layoutSubviews() {
    super.layoutSubviews()
    if metal?.frame != bounds { cancelGesture(); committed = nil; version += 1; metal?.frame = bounds; metal?.setNeedsDisplay() }
  }
  override func didMoveToWindow() { super.didMoveToWindow(); if window == nil { reset(epoch) } else { onNeedsKeyframe(["epoch":epoch]) } }
  func reset(_ next: String) {
    cancelGesture(); epoch = next; version += 1; decoderGeneration += 1; committed = nil; latest = nil; rendering = nil; metal?.isHidden = true
    decoder.reset(next)
  }
  func decode(_ bytes: Data, _ frame: FrameMetadata, done: @escaping (Bool) -> Void) {
    guard metal != nil, frame.epoch == epoch, window != nil, UIApplication.shared.applicationState == .active, frame.identity.utf8.count <= 16_384 else { done(false); return }
    var submitted = frame; submitted.presentationVersion = decoderGeneration
    decoder.decode(bytes, submitted) { [weak self] admitted in
      DispatchQueue.main.async { if !admitted, self?.epoch == frame.epoch { self?.reset(frame.epoch); self?.onNeedsKeyframe(["epoch": frame.epoch]) }; done(admitted) }
    }
  }
  private func accept(_ buffer: CVPixelBuffer, _ frame: FrameMetadata) {
    guard frame.epoch == epoch, frame.presentationVersion == decoderGeneration, window != nil, UIApplication.shared.applicationState == .active, !frame.replayed else { return }
    latest = (buffer, frame); metal?.isHidden = false; metal?.setNeedsDisplay()
  }
  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) { cancelGesture(); committed = nil; version += 1 }
  func draw(in view: MTKView) {
    guard rendering == nil, let (buffer, source) = latest, source.epoch == epoch, let pipeline, let cache = textureCache,
          let drawable = view.currentDrawable, let pass = view.currentRenderPassDescriptor, let command = commandQueue?.makeCommandBuffer(),
          CVPixelBufferGetPlaneCount(buffer) == 2 else { return }
    var frame=source
    let contentWidth=source.contentWidth, contentHeight=source.contentHeight
    frame.cropX=source.cropX+(contentWidth-contentWidth/zoom)/2;frame.cropY=source.cropY+(contentHeight-contentHeight/zoom)/2
    frame.cropWidth=contentWidth/zoom;frame.cropHeight=contentHeight/zoom
    let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
    guard width == frame.width, height == frame.height, let rect = frame.videoRect(in: bounds.size) else { return }
    var luma: CVMetalTexture?, chroma: CVMetalTexture?
    guard CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, cache, buffer, nil, .r8Unorm, width, height, 0, &luma) == kCVReturnSuccess,
          CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, cache, buffer, nil, .rg8Unorm, width / 2, height / 2, 1, &chroma) == kCVReturnSuccess,
          let luma, let chroma, let y = CVMetalTextureGetTexture(luma), let uv = CVMetalTextureGetTexture(chroma), let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
    let ticket = UUID(); rendering = ticket; committed = nil; let revision = version; let size = bounds.size
    let scale = view.drawableSize.width / max(1, size.width)
    encoder.setViewport(MTLViewport(originX: rect.minX * scale, originY: rect.minY * scale, width: rect.width * scale, height: rect.height * scale, znear: 0, zfar: 1))
    encoder.setRenderPipelineState(pipeline); encoder.setFragmentTexture(y, index: 0); encoder.setFragmentTexture(uv, index: 1)
    var crop = SIMD4<Float>(Float(frame.cropX / Double(width)), Float(frame.cropY / Double(height)), Float(frame.contentWidth / Double(width)), Float(frame.contentHeight / Double(height)))
    encoder.setFragmentBytes(&crop, length: MemoryLayout<SIMD4<Float>>.size, index: 0)
    encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4); encoder.endEncoding()
    #if !targetEnvironment(simulator)
    drawable.addPresentedHandler { [weak self] drawable in
      // These references keep both IOSurface textures alive through GPU presentation.
      _ = (buffer, luma, chroma)
      DispatchQueue.main.async {
        guard let self, self.rendering == ticket else { return }; self.rendering = nil
        if drawable.presentedTime > 0, self.epoch == frame.epoch, self.version == revision, self.bounds.size == size, self.window != nil, UIApplication.shared.applicationState == .active {
          self.committed = frame; view.isHidden = false
          self.onReady(["epoch": frame.epoch, "width": frame.width, "height": frame.height])
          self.onVideoPresented(["epoch": frame.epoch, "identity": frame.identity])
        }
        if self.latest?.1.pts != frame.pts || self.version != revision { self.metal?.setNeedsDisplay() }
      }
    }
    #endif
    command.addCompletedHandler { [weak self] command in
      if command.status == .error { DispatchQueue.main.async { self?.presentationLost(ticket) } }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.presentationLost(ticket) }
    command.present(drawable); command.commit()
  }
  private func presentationLost(_ ticket: UUID) {
    guard rendering == ticket else { return }
    rendering = nil; committed = nil; latest = nil; metal?.isHidden = true; cancelGesture()
    decoder.reset(epoch); onNeedsKeyframe(["epoch": epoch])
  }
  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    if gesture != nil || event?.allTouches?.count != 1 {cancelGesture();return}
    guard touches.count == 1, rendering == nil, let frame = committed, !frame.identity.isEmpty, let touch = touches.first, let rect = frame.videoRect(in: bounds.size) else { return }
    let local = touch.location(in: self); guard rect.contains(local) else { return }
    let point = CGPoint(x: frame.cropX + (local.x - rect.minX) * frame.contentWidth / rect.width, y: frame.cropY + (local.y - rect.minY) * frame.contentHeight / rect.height)
    let id = UUID().uuidString.lowercased(); gesture = Gesture(frame:frame,id:id,point:point,local:local,bounds:bounds,last:local)
    onVideoGesture(["epoch": epoch, "identity": frame.identity, "gestureId": id, "phase": "begin"])
  }
  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard var gesture, let touch = touches.first else { return }; let point = touch.location(in: self)
    if hypot(point.x - gesture.local.x, point.y - gesture.local.y) > 8 && !gesture.scrolling {gesture.scrolling=true;emitCancel(gesture)}
    if gesture.scrolling, let rect=gesture.frame.videoRect(in:bounds.size) {onVideoScroll(["epoch":gesture.frame.epoch,"identity":gesture.frame.identity,"x":gesture.point.x,"y":gesture.point.y,"dx":(gesture.last.x-point.x)*gesture.frame.contentWidth/rect.width,"dy":(gesture.last.y-point.y)*gesture.frame.contentHeight/rect.height])}
    gesture.last=point;self.gesture=gesture
  }
  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let gesture else { return }; self.gesture = nil
    if gesture.scrolling{return}
    guard gesture.bounds == bounds, gesture.frame.epoch == epoch else { emitCancel(gesture); return }
    onVideoTap(["epoch": epoch, "identity": gesture.frame.identity, "gestureId": gesture.id, "x": gesture.point.x, "y": gesture.point.y])
  }
  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { cancelGesture() }
  private func emitCancel(_ gesture: Gesture) { onVideoGesture(["epoch": gesture.frame.epoch, "identity": gesture.frame.identity, "gestureId": gesture.id, "phase": "cancel"]) }
  private func cancelGesture() { if let gesture { self.gesture = nil; if !gesture.scrolling {emitCancel(gesture)} } }
}

extension FrameMetadata {
  var contentWidth: Double { cropWidth > 0 ? cropWidth : Double(width) }
  var contentHeight: Double { cropHeight > 0 ? cropHeight : Double(height) }
  func videoRect(in size: CGSize) -> CGRect? {
    guard contentWidth > 0, contentHeight > 0, cropX >= 0, cropY >= 0, cropX + contentWidth <= Double(width), cropY + contentHeight <= Double(height), size.width > 0, size.height > 0 else { return nil }
    let scale = min(size.width / contentWidth, size.height / contentHeight)
    return CGRect(x: (size.width - contentWidth * scale) / 2, y: (size.height - contentHeight * scale) / 2, width: contentWidth * scale, height: contentHeight * scale)
  }
}
