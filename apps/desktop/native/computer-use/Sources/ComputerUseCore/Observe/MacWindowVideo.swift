import AppKit
import CoreMedia
import CoreVideo
import Foundation
@preconcurrency import ScreenCaptureKit
import VideoToolbox

// Opt-in VM evidence. No timers, authority changes or capture configuration changes.
enum MacVideoDiagnostic {
  static let path = ProcessInfo.processInfo.environment["OPENSTEER_VIDEO_DIAGNOSTICS"]
    ?? UserDefaults.standard.string(forKey: "OpensteerVideoDiagnosticsPath")
  static let sink: Locked<FileHandle?> = Locked({
    guard let path else { return nil }
    FileManager.default.createFile(atPath: path, contents: nil)
    return FileHandle(forWritingAtPath: path)
  }())
  static func write(_ row: [String: Any]) {
    sink.withLock { handle in
      guard let handle, let data = try? JSONSerialization.data(withJSONObject: row) else { return }
      try? handle.write(contentsOf: data + Data([10]))
    }
  }
  static func members(_ entries: [AppWindows.Entry]) -> [[String: Any]] {
    entries.map { ["id": $0.window.windowID, "frame": NSStringFromRect($0.window.frame),
      "layer": $0.layer, "visible": $0.onScreen, "alpha": $0.alpha] }
  }
}

struct MacVideoSource: Codable, Sendable, Equatable {
  let kind: String
  let sessionId: String?
  let appKey: String?
  let viewId: String?
  let generation: Int?

  var key: String {
    kind == "task-session"
      ? "task:\(sessionId ?? ""):\(appKey ?? "")"
      : "owner:\(viewId ?? ""):\(generation ?? 0)"
  }
}

struct MacVideoTarget: Codable, Sendable {
  let kind: String
  let bindingId: String
  var editingVersion: Int? = nil
}

struct MacVideoState: Encodable, Sendable {
  let streamId: String
  let state: String
  let reason: String?
  let generation: Int
  let width: Int
  let height: Int
}

struct MacVideoLifecycleDiagnostic: Encodable, Sendable {
  let streamId: String
  let event: String
  let generation: Int
  var operation: String? = nil
  var domain: String? = nil
  var code: Int? = nil
  var helperCode: String? = nil
  var inFlight: Int? = nil
  var outstanding: Int? = nil
  var outstandingBytes: Int? = nil
  var oldestAckAgeMs: Double? = nil
  var noSubmissionMs: Double? = nil
}

/// Encoder submission and peer delivery credit for one producer.
struct MacVideoCredit {
  enum Admission: Equatable {
    case submit(key: Bool)
    case withheld(String)
  }

  static let maxInFlight = 3
  static let maxOutstandingBytes = 1_048_576
  static let maxAckAge: TimeInterval = 0.5

  private(set) var inFlight = 0
  var needsKey = true
  private(set) var outstanding: [(sequence: Int, bytes: Int, sentAt: TimeInterval)] = []

  var outstandingBytes: Int { outstanding.reduce(0) { $0 + $1.bytes } }

  mutating func admit(now: TimeInterval) -> Admission {
    let reason: String? =
      inFlight >= Self.maxInFlight ? "inFlight"
      : outstandingBytes >= Self.maxOutstandingBytes ? "bytes"
      : outstanding.first.map({ now - $0.sentAt >= Self.maxAckAge }) == true ? "ack-age" : nil
    // A withheld sample never reaches the encoder, so the reference chain is intact.
    if let reason { return .withheld(reason) }
    inFlight += 1
    defer { needsKey = false }
    return .submit(key: needsKey)
  }

  /// The encoder returned (or never accepted) a submitted sample.
  mutating func returned() { inFlight = max(0, inFlight - 1) }
  mutating func drained() { inFlight = 0 }

  /// Reserves peer credit before enqueueing: the media peer can acknowledge immediately.
  mutating func reserve(sequence: Int, bytes: Int, now: TimeInterval) -> Bool {
    guard outstandingBytes + bytes <= Self.maxOutstandingBytes else {
      needsKey = true
      return false
    }
    outstanding.append((sequence, bytes, now))
    return true
  }

  /// Encoded output that will not reach the peer breaks its reference chain.
  mutating func lost(_ sequence: Int? = nil) {
    if let sequence { outstanding.removeAll { $0.sequence == sequence } }
    needsKey = true
  }

  mutating func acknowledge(_ sequence: Int) -> Bool {
    guard outstanding.first?.sequence == sequence else { return false }
    outstanding.removeFirst()
    return true
  }

  /// A new generation or closed publication starts over from a key.
  mutating func reset() {
    outstanding.removeAll()
    needsKey = true
  }
}

/// A static window may never send another complete sample after admission
/// withholds its last change. Credit return retries only this newest sample.
struct MacVideoPendingSample<Sample> {
  private(set) var current: Sample?
  private var withheld = false
  private var scheduled = false

  mutating func replace(_ sample: Sample) { current = sample; withheld = false }
  mutating func hold() { withheld = current != nil }
  mutating func schedule() -> Bool {
    guard withheld, !scheduled else { return false }
    scheduled = true
    return true
  }
  mutating func take() -> Sample? {
    scheduled = false
    return withheld ? current : nil
  }
  mutating func clear(keepingCurrent: Bool = false) {
    withheld = false
    if !keepingCurrent { current = nil }
    // A queued task still owns the scheduling slot. It reads current state
    // when it runs rather than retaining a retired buffer in its closure.
  }
}

final class MacVideoLease: @unchecked Sendable {
  private let expiry: Locked<TimeInterval>
  init(expiresAt: TimeInterval) { expiry = Locked(expiresAt) }
  var allowed: Bool { expiry.current > ProcessInfo.processInfo.systemUptime }
  func renew(_ next: TimeInterval) { expiry.withLock { if $0 > 0 { $0 = max($0, next) } } }
  func close() { expiry.withLock { $0 = 0 } }
}

/// One canonical window lifetime. Observation IDs are deliberately absent.
final class MacVideoBinding: @unchecked Sendable {
  let id = UUID().uuidString
  let target: CaptureTarget
  let window: OwnerViewWindow.Binding

  init(_ window: OwnerViewWindow.Binding) {
    self.window = window
    target = window.target
  }

  func matches(_ other: CaptureTarget) -> Bool {
    target.matchesWindow(other)
  }

  var unavailable: String? {
    window.unavailableReason
  }
}

/// The registry owns demand and authority; capture lifetime remains replaceable.
protocol MacVideoProducing: AnyObject, Sendable {
  var id: String { get }
  var binding: MacVideoBinding { get }
  var ended: Bool { get }
  var resourcesSettled: Bool { get }
  var hasFrame: Bool { get }
  var needsResume: Bool { get }
  var canResume: Bool { get }
  var inputMap: MacOwnerInputMap? { get }
  var inputVisible: Bool { get }
  func start(maxLongSide: Int, maxFps: Int) async
  func resume(maxLongSide: Int, maxFps: Int) async
  func attach(_ connection: IPCConnection) throws
  func acknowledge(_ sequence: Int)
  func refresh()
  func setVisible(_ visible: Bool)
  func setDiagnosticHandler(_ handler: @escaping @Sendable (MacVideoLifecycleDiagnostic) -> Void)
  func checkLifecycle()
  func invalidateProfile()
  func suppress(reason: String)
  func fail(_ reason: String)
  func stop(reason: String, failed: Bool)
}

extension MacVideoProducing {
  var inputMap: MacOwnerInputMap? { nil }
  var inputVisible: Bool { false }
  func setDiagnosticHandler(_ handler: @escaping @Sendable (MacVideoLifecycleDiagnostic) -> Void) {}
  func stop() { stop(reason: "sharing-stopped", failed: false) }
}

/// Encodes buffers on one small serial queue. Every asynchronous output carries
/// the publication generation of its input, and checks the gate again at write.
final class MacWindowVideoProducer: NSObject, MacVideoProducing, SCStreamOutput, SCStreamDelegate,
  @unchecked Sendable
{
  private struct CapturedSample {
    let buffer: CVPixelBuffer
    let pts: CMTime
    let generation: Int
    let incarnation: OwnerSampleFence.Incarnation
  }
  private struct Publication {
    var suspendedRevision: Int?
    var profileDirty = false
    var visible = true
    var verified = false
    var bindingRevision = 0
    var open = false
    var ended = false
    var generation = 1
    var sequence = 0
    var lastKeyGeneration = 0
    var lastSubmissionAt: TimeInterval = 0
    var lastCompleteAt: TimeInterval = 0
    var completeSince: TimeInterval = 0
    var stallReported = false
    var credit = MacVideoCredit()
    var width = 0
    var height = 0
    var samples = MacVideoPendingSample<CapturedSample>()
    var geometry: KeyWindow.CaptureState?
    var topology: WindowGroup?
    var topologyDirty = false
    var composition: WindowCapture.Composition?
    var fps = 0
    var sourceRect = CGRect.zero
  }

  let id: String
  let binding: MacVideoBinding
  private let operations: SerialTaskChain
  private let queue: DispatchQueue
  private let publication = Locked(Publication())
  private let onState: @Sendable (MacVideoState) -> Void
  private let authority: @Sendable () -> Bool
  private let lifecycleDiagnostic = Locked<(@Sendable (MacVideoLifecycleDiagnostic) -> Void)?>(nil)
  private let output = Locked<IPCConnection?>(nil)
  private struct Resources {
    var stream: SCStream?
    var incarnation: OwnerSampleFence.Incarnation?
    var startComplete = false
    var updating = false
    var stopping = false
    var osStopped = false
    var encoderStopped = false
  }
  private let resources = Locked(Resources())
  private let sampleFence = OwnerSampleFence()
  private var encoder: VTCompressionSession?
  private var nextCheck: TimeInterval = 0
  private let topologyReadPending = Locked(false)
  private let queueHealth = Locked(ProcessInfo.processInfo.systemUptime)

  init(
    id: String, binding: MacVideoBinding, operations: SerialTaskChain,
    authority: @escaping @Sendable () -> Bool,
    onState: @escaping @Sendable (MacVideoState) -> Void
  ) {
    self.operations = operations
    self.id = id
    self.binding = binding
    self.authority = authority
    self.onState = onState
    queue = DispatchQueue(label: "com.opensteer.window-video.\(id)", qos: .utility)
  }

  var ended: Bool { publication.withLock { $0.ended } }
  var resourcesSettled: Bool {
    resources.withLock { $0.startComplete && $0.osStopped && $0.encoderStopped }
  }
  var hasFrame: Bool { publication.withLock { $0.lastKeyGeneration == $0.generation } }
  var needsResume: Bool {
    publication.withLock { !$0.ended && ($0.topologyDirty || (!$0.open && $0.geometry != nil)) }
  }

  var inputVisible: Bool { publication.withLock { $0.visible && !$0.ended } }

  var inputMap: MacOwnerInputMap? {
    guard eligible() else { return nil }
    return publication.withLock { value in
      guard value.visible, !value.topologyDirty, value.bindingRevision == binding.window.lifecycleRevision,
        value.lastKeyGeneration == value.generation, let composition = value.composition,
        let group = value.topology, group.blockedBy.isEmpty else { return nil }
      return MacOwnerInputMap(
        generation: value.generation, crop: composition.crop,
        windows: group.members.map { ObservedWindow(windowID: $0.window.windowID, frame: $0.window.frame) },
        revision: value.bindingRevision)
    }
  }

  func attach(_ connection: IPCConnection) throws {
    guard
      output.withLock({ current in
        guard current == nil, !ended else { return false }
        current = connection
        return true
      })
    else { throw HelperError(.noSession, "That video attachment has ended or was already used.") }
  }

  func setDiagnosticHandler(_ handler: @escaping @Sendable (MacVideoLifecycleDiagnostic) -> Void) {
    lifecycleDiagnostic.withLock { $0 = handler }
  }

  private func startupFailure(_ error: NSError, operation: String, helperCode: String) {
    let generation = publication.withLock { $0.generation }
    lifecycleDiagnostic.current?(MacVideoLifecycleDiagnostic(
      streamId: id, event: "native-start-error", generation: generation,
      operation: operation, domain: error.domain, code: error.code, helperCode: helperCode))
  }

  private func completeSample() {
    let now = ProcessInfo.processInfo.systemUptime
    let row: MacVideoLifecycleDiagnostic? = publication.withLock { state in
      guard state.open, state.visible, !state.ended else {
        state.completeSince = 0
        state.stallReported = false
        return nil
      }
      // A lone complete sample after a capture pause does not prove ongoing input.
      if state.completeSince == 0 || now - state.lastCompleteAt > 2 {
        state.completeSince = now
      }
      state.lastCompleteAt = now
      let since = max(state.lastSubmissionAt, state.completeSince)
      guard now - since >= 5, !state.stallReported else { return nil }
      state.stallReported = true
      return MacVideoLifecycleDiagnostic(
        streamId: id, event: "producer-stalled", generation: state.generation,
        inFlight: state.credit.inFlight, outstanding: state.credit.outstanding.count,
        outstandingBytes: state.credit.outstandingBytes,
        oldestAckAgeMs: state.credit.outstanding.first.map { max(0, now - $0.sentAt) * 1000 } ?? 0,
        noSubmissionMs: (now - since) * 1000)
    }
    if let row {
      Log.observe.warning("Window video producer stalled: stream=\(self.id, privacy: .public)")
      lifecycleDiagnostic.current?(row)
    }
  }

  private func diagnostic(_ event: String, _ state: Publication, reason: String = "") {
    guard MacVideoDiagnostic.path != nil else { return }
    MacVideoDiagnostic.write(["time": Date().timeIntervalSince1970 * 1000, "event": event,
      "streamId": id, "generation": state.generation, "sequence": state.sequence,
      "inFlight": state.credit.inFlight, "outstanding": state.credit.outstanding.count,
      "outstandingBytes": state.credit.outstandingBytes,
      "oldestAckAge": state.credit.outstanding.first.map { ProcessInfo.processInfo.systemUptime - $0.sentAt } ?? 0,
      "visible": state.visible, "open": state.open, "ended": state.ended, "reason": reason])
  }

  func acknowledge(_ sequence: Int) {
    let accepted = publication.withLock { state in
      guard state.credit.acknowledge(sequence) else { diagnostic("ack-rejected", state); return false }
      diagnostic("ack", state)
      return true
    }
    if accepted { schedulePendingSample() }
  }

  private func schedulePendingSample() {
    guard publication.withLock({ $0.samples.schedule() }) else { return }
    queue.async { [self] in
      guard let sample = publication.withLock({ $0.samples.take() }) else { return }
      encode(sample)
    }
  }

  /// The startup lane retains this call until the OS settles, even if the
  /// first-frame deadline has already retired this producer.
  func start(maxLongSide: Int, maxFps: Int) async {
    defer {
      resources.withLock { $0.startComplete = true }
      settleCapture()
    }
    guard !ended, authority() else { return }
    var operation = "plan"
    do {
      let nextTopology = try await binding.window.group()
      let geometry = KeyWindow.CaptureState(
        frame: nextTopology.root.frame, isOnScreen: !nextTopology.alone)
      let plan = try await WindowCapture.plan(
        processIdentifier: binding.target.process.processIdentifier,
        keyWindow: WindowIdentity(
          windowID: binding.target.windowID, title: nil, frame: geometry.frame),
        outputMaxLongSide: maxLongSide, group: nextTopology)
      guard !ended, valid() else { return }
      let config = plan.configuration
      config.width = max(2, config.width / 2 * 2)
      config.height = max(2, config.height / 2 * 2)
      config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(maxFps))
      config.queueDepth = 3
      config.showsCursor = false
      config.capturesAudio = false
      config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      if #available(macOS 15.0, *) { config.captureDynamicRange = .SDR }
      operation = "encoder"
      try await prepareEncoder(width: config.width, height: config.height, fps: maxFps)
      guard !ended, valid() else { return }
      let afterPlan = try await binding.window.group()
      publication.withLock {
        $0.geometry = geometry
        $0.topology = nextTopology
        $0.topologyDirty = afterPlan.captureLayout != nextTopology.captureLayout
        if $0.topologyDirty {
          MacVideoDiagnostic.write(["event": "capture-changed-during-plan", "streamId": id,
            "generation": $0.generation, "lifecycleChanged": afterPlan.signature.lifecycle != nextTopology.signature.lifecycle,
            "membersChanged": afterPlan.members != nextTopology.members,
            "focusChanged": afterPlan.signature.focused != nextTopology.signature.focused,
            "blockersChanged": afterPlan.blockedBy != nextTopology.blockedBy])
        }
        $0.fps = maxFps
        $0.sourceRect = config.sourceRect
        $0.composition = plan.composition
        $0.suspendedRevision = nil
        $0.profileDirty = false
        $0.bindingRevision = binding.window.lifecycleRevision
        $0.verified = true
        $0.open = true
      }
      let capture = SCStream(filter: plan.filter, configuration: config, delegate: self)
      resources.withLock { $0.stream = capture; $0.incarnation = sampleFence.current }
      try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
      operation = "start"
      try await capture.startCapture()

    } catch {
      let nativeError = error as NSError
      let helperCode = (error as? HelperError)?.code.rawValue ?? "none"
      startupFailure(nativeError, operation: operation, helperCode: helperCode)
      publication.withLock { diagnostic("native-start-error", $0, reason: "\(operation):\(nativeError.domain):\(nativeError.code):\(helperCode)") }
      if error as? HelperError == WindowCapture.membershipChanged {
        // The registry's existing lifecycle pass re-plans under the original
        // first-frame deadline. No mismatched filter or input map is published.
        publication.withLock { if !$0.ended { $0.topologyDirty = true } }
        suppress(reason: "target-unavailable")
        sampleFence.retire()
        return
      }
      Log.observe.error("Window video operation failed: stream=\(self.id, privacy: .public) operation=\(operation, privacy: .public) domain=\(nativeError.domain, privacy: .public) code=\(nativeError.code, privacy: .public) helperCode=\(helperCode, privacy: .public)")
      if !ended { fail(error is EncoderFailure ? "encoder-failed" : "capture-failed") }
    }
  }

  var canResume: Bool {
    authority() && binding.unavailable == nil && CGPreflightScreenCaptureAccess()
      && (try? HelperRuntime.requireUnlocked()) != nil
  }

  func resume(maxLongSide: Int, maxFps: Int) async {
    var capture: SCStream?
    guard !ended, canResume,
      resources.withLock({ state in
        guard state.startComplete, !state.stopping, !state.updating
        else { return false }
        state.updating = true
        capture = state.stream
        state.stream = nil
        return true
      }) else { return }
    defer { resources.withLock { $0.updating = false }; settleCapture() }
    // An update completion does not identify queued samples' crop/filter.
    // Close publication, stop the old SCStream and drain its encoder before
    // creating a different stream identity for the next display generation.
    suppress(reason: "target-unavailable")
    if let capture {
      do { try await capture.stopCapture() }
      catch { if !ended { fail("capture-failed") }; return }
      try? capture.removeStreamOutput(self, type: .screen)
    }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      queue.async { [self] in
        if let encoder {
          VTCompressionSessionCompleteFrames(encoder, untilPresentationTimeStamp: .invalid)
          VTCompressionSessionInvalidate(encoder)
        }
        encoder = nil
        publication.withLock { $0.credit.drained(); $0.samples.clear() }
        continuation.resume()
      }
    }
    guard !ended, canResume else { return }
    _ = sampleFence.start()
    await start(maxLongSide: maxLongSide, maxFps: maxFps)
  }

  private struct EncoderFailure: Error {}

  private func prepareEncoder(width: Int, height: Int, fps: Int, advanceGeneration: Bool = false) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async { [self] in
        do {
          guard !ended else {
            continuation.resume()
            return
          }
          if advanceGeneration {
            publication.withLock {
              $0.generation += 1
              $0.samples.clear()
              $0.credit.reset()
            }
          }
          if let encoder { VTCompressionSessionInvalidate(encoder) }
          encoder = nil
          var session: VTCompressionSession?
          let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault, width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [
              kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true
            ] as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { context, generation, status, flags, sample in
              guard let context, let generation else { return }
              let producer = Unmanaged<MacWindowVideoProducer>.fromOpaque(context)
                .takeUnretainedValue()
              defer {
                // Keep the submission charged until its output has reserved
                // peer bytes or recorded loss, including the next key decision.
                producer.publication.withLock { $0.credit.returned() }
                producer.schedulePendingSample()
              }
              let inputGeneration = Int(bitPattern: generation)
              guard producer.publication.withLock({ !$0.ended && $0.generation == inputGeneration })
              else { return }
              guard status == noErr else {
                producer.fail("encoder-failed")
                return
              }
              guard !flags.contains(.frameDropped), let sample else {
                producer.publication.withLock { $0.credit.lost() }
                return
              }
              producer.encoded(sample, generation: inputGeneration)
            },
            refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &session)
          publication.withLock { diagnostic("encoder-create", $0, reason: String(status)) }
          guard status == noErr, let session else {
            throw EncoderFailure()
          }
          encoder = session
          for (key, value) in [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue as CFTypeRef),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse as CFTypeRef),
            (
              kVTCompressionPropertyKey_ProfileLevel,
              kVTProfileLevel_H264_Baseline_AutoLevel as CFTypeRef
            ),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: 2_500_000)),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: fps * 2)),
          ] {
            guard VTSessionSetProperty(session, key: key, value: value) == noErr else {
              throw EncoderFailure()
            }
          }
          guard VTCompressionSessionPrepareToEncodeFrames(session) == noErr else {
            throw EncoderFailure()
          }
          var hardware: Unmanaged<CFTypeRef>?
          let hardwareStatus = withUnsafeMutablePointer(to: &hardware) { pointer in
            VTSessionCopyProperty(
              session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
              allocator: kCFAllocatorDefault, valueOut: UnsafeMutableRawPointer(pointer))
          }
          let usingHardware = hardware?.takeRetainedValue() as? Bool
          guard hardwareStatus == noErr, usingHardware == true else { throw EncoderFailure() }
          publication.withLock {
            $0.width = width
            $0.height = height
          }
          continuation.resume()
        } catch { continuation.resume(throwing: error) }
      }
    }
  }

  private func valid() -> Bool {
    authority() && binding.unavailable == nil
      && (try? HelperRuntime.requireUnlocked()) != nil
      && CGPreflightScreenCaptureAccess()
  }

  /// Presentation changes stay within the app grant; root/authority gates are independent.
  func eligible() -> Bool {
    authority() && binding.target.process.isCurrent && binding.window.unavailableReason == nil
      && publication.withLock {
        $0.open && !$0.ended && $0.verified
      }
  }

  /// Discovery is coalesced on the control plane, never on the sample/encoder/write queues.
  func checkLifecycle() {
    let now = ProcessInfo.processInfo.systemUptime
    let changed = publication.withLock { $0.bindingRevision != binding.window.lifecycleRevision }
    guard changed || binding.window.needsDiscovery || now >= nextCheck else { return }
    if changed { suppress(reason: "target-unavailable") }
    nextCheck = now + 0.5
    if now - queueHealth.current > 5 {
      fail("encoder-failed")
      return
    }
    queue.async { [queueHealth] in
      queueHealth.withLock { $0 = ProcessInfo.processInfo.systemUptime }
    }
    guard !ended else { return }
    if let reason = binding.unavailable {
      if reason == "minimized" { suppress(reason: reason) }
      else { fail(reason) }
      return
    }
    guard authority(), CGPreflightScreenCaptureAccess(),
      (try? HelperRuntime.requireUnlocked()) != nil
    else {
      fail(CGPreflightScreenCaptureAccess() ? "locked-screen" : "permission-required")
      return
    }
    guard topologyReadPending.withLock({ pending in
      guard !pending else { return false }; pending = true; return true
    }) else { return }
    // AX discovery is always on WorkActor. The main actor and encoder consume
    // only immutable groups; one slow AX app cannot hold the control plane.
    Task { @WorkActor [weak self] in
      guard let self else { return }
      defer { self.topologyReadPending.withLock { $0 = false } }
      guard !self.ended else { return }
      do {
        let next = try self.binding.window.group()
        self.publication.withLock {
          if self.sampleFence.retireIfLayoutChanged(
            from: $0.topology?.captureLayout, to: next.captureLayout, restartPending: $0.topologyDirty)
          {
            MacVideoDiagnostic.write(["event": "capture-topology-changed", "streamId": self.id,
              "generation": $0.generation, "bindingChanged": changed,
              "membersChanged": $0.topology?.members != next.members,
              "cropChanged": $0.topology?.crop != next.crop,
              "displayChanged": $0.topology?.displayID != next.displayID,
              "aloneChanged": $0.topology?.alone != next.alone,
              "scaleChanged": $0.topology?.nativeScale != next.nativeScale,
              "previousMembers": MacVideoDiagnostic.members($0.topology?.members ?? []),
              "nextMembers": MacVideoDiagnostic.members(next.members),
              "blockersChanged": $0.topology?.blockedBy != next.blockedBy])
            $0.topologyDirty = true
          } else {
            $0.topology = next
          }
        }
        if self.publication.withLock({ $0.topologyDirty }) {
          self.suppress(reason: "target-unavailable")
        }
      } catch {
        if self.binding.window.liveness.isClosed {
          self.fail("window-closed")
        } else {
          self.suppress(reason: "target-unavailable")
        }
      }
    }
  }

  func invalidateProfile() {
    suppress(reason: "target-unavailable")
    publication.withLock {
      guard !$0.ended else { return }
      $0.profileDirty = true
      $0.topologyDirty = true
    }
  }

  func setVisible(_ visible: Bool) {
    let state: MacVideoState? = publication.withLock { state in
      guard !state.ended, state.visible != visible else { return nil }
      state.visible = visible
      state.completeSince = 0
      state.stallReported = false
      if !visible {
        state.generation += 1
        state.credit.reset()
        state.samples.clear(keepingCurrent: true)
      }
      return MacVideoState(
        streamId: id, state: visible ? "starting" : "warming", reason: nil,
        generation: state.generation, width: state.width, height: state.height)
    }
    if let state {
      onState(state)
      if visible { refresh() }
    }
  }

  func stream(
    _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of type: SCStreamOutputType
  ) {
    guard type == .screen, sampleBuffer.isValid,
      let incarnation = resources.withLock({ $0.stream === stream ? $0.incarnation : nil }),
      sampleFence.accepts(incarnation)
    else { return }
    guard eligible() else {
      if publication.withLock({ $0.open }) {
        Log.observe.debug("Window video publication invalidated: stream=\(self.id, privacy: .public) authority=\(self.authority(), privacy: .public) revision=\(self.binding.window.lifecycleRevision, privacy: .public)")
      }
      suppress(reason: "target-unavailable")
      return
    }
    let attachments =
      CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
      as? [[SCStreamFrameInfo: Any]]
    guard let status = attachments?.first?[.status] as? Int else { return }
    if status == SCFrameStatus.idle.rawValue || status == SCFrameStatus.started.rawValue { return }
    if status == SCFrameStatus.stopped.rawValue {
      fail("sharing-stopped")
      return
    }
    if status == SCFrameStatus.suspended.rawValue {
      Log.observe.debug("Window video suspended: stream=\(self.id, privacy: .public)")
      publication.withLock { $0.suspendedRevision = binding.window.lifecycleRevision }
      suppress(reason: "target-unavailable")
      return
    }
    guard status == SCFrameStatus.complete.rawValue,
      let buffer = CMSampleBufferGetImageBuffer(sampleBuffer)
    else {
      if publication.withLock({ $0.open }) {
        Log.observe.debug("Window video noncomplete sample: stream=\(self.id, privacy: .public) status=\(status, privacy: .public)")
      }
      suppress(reason: "target-unavailable")
      return
    }
    completeSample()
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard
      publication.withLock({
        CVPixelBufferGetWidth(buffer) == $0.width
          && CVPixelBufferGetHeight(buffer) == $0.height
      })
    else { return }
    MacVideoDiagnostic.write(["event": "capture-sample", "streamId": id,
      "generation": publication.withLock { $0.generation },
      "ptsUs": CMTimeConvertScale(pts, timescale: 1_000_000, method: .default).value,
      "uptimeUs": DispatchTime.now().uptimeNanoseconds / 1000])
    encode(CapturedSample(buffer: buffer, pts: pts,
      generation: publication.withLock { $0.generation }, incarnation: incarnation))
  }

  private func encode(_ sample: CapturedSample) {
    guard sampleFence.accepts(sample.incarnation), eligible(), let encoder else { return }
    let admitted: (Int, Bool)? = publication.withLock { state in
      guard state.open, !state.ended, state.generation == sample.generation,
        sampleFence.accepts(sample.incarnation)
      else { diagnostic("encode-rejected", state, reason: "closed"); return nil }
      state.samples.replace(sample)
      guard state.visible else { diagnostic("encode-rejected", state, reason: "warm"); return nil }
      let admission = state.credit.admit(now: ProcessInfo.processInfo.systemUptime)
      guard case .submit(let key) = admission else {
        state.samples.hold()
        if case .withheld(let reason) = admission { diagnostic("encode-rejected", state, reason: reason) }
        return nil
      }
      if state.stallReported {
        lifecycleDiagnostic.current?(MacVideoLifecycleDiagnostic(
          streamId: id, event: "producer-resumed", generation: state.generation))
        state.stallReported = false
      }
      state.lastSubmissionAt = ProcessInfo.processInfo.systemUptime
      diagnostic("encode-submitted", state)
      return (state.generation, key)
    }
    guard let (generation, key) = admitted else { return }
    let properties = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let status = VTCompressionSessionEncodeFrame(
      encoder, imageBuffer: sample.buffer,
      presentationTimeStamp: sample.pts, duration: .invalid, frameProperties: properties,
      sourceFrameRefcon: UnsafeMutableRawPointer(bitPattern: generation), infoFlagsOut: nil)
    if status != noErr {
      publication.withLock { $0.credit.returned() }
      fail("encoder-failed")
    }
  }

  func refresh() {
    queue.async { [self] in
      guard eligible() else { return }
      let sample = publication.withLock { state -> CapturedSample? in
        state.credit.needsKey = true
        guard state.open, state.visible, !state.ended, let current = state.samples.current,
          sampleFence.accepts(current.incarnation) else { return nil }
        // Warming changes the presentation generation, not the capture source.
        // An explicit refresh can reuse that source as a new keyframe; an
        // ordinary credit retry always retains its original generation.
        return CapturedSample(buffer: current.buffer, pts: current.pts,
          generation: state.generation, incarnation: current.incarnation)
      }
      if let sample {
        encode(sample)
      }
    }
  }

  private struct Header: Encodable {
    let streamId: String
    let generation: Int
    let sequence: Int
    let ptsUs: Int64
    let key: Bool
    let codec: String?
    let width: Int
    let height: Int
  }

  private func encoded(_ sample: CMSampleBuffer, generation: Int) {
    var sent = false
    defer {
      if !sent { publication.withLock { if $0.generation == generation { $0.credit.lost() } } }
    }
    guard eligible(), CMSampleBufferDataIsReady(sample),
      let format = CMSampleBufferGetFormatDescription(sample),
      let block = CMSampleBufferGetDataBuffer(sample)
    else { return }
    let attachments =
      CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
      as? [[CFString: Any]]
    let key = (attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) != true
    var annex = Data()
    var codec: String?
    var lengthBytes: Int32 = 0
    if key {
      for index in 0...1 {
        var pointer: UnsafePointer<UInt8>?
        var length = 0
        guard
          CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: index,
            parameterSetPointerOut: &pointer, parameterSetSizeOut: &length,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: &lengthBytes) == noErr,
          let pointer, length > 0
        else {
          fail("encoder-failed")
          return
        }
        annex.append(contentsOf: [0, 0, 0, 1])
        annex.append(pointer, count: length)
        if index == 0 && length >= 4 {
          codec = String(format: "avc1.%02X%02X%02X", pointer[1], pointer[2], pointer[3])
        }
      }
    } else {
      guard
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format, parameterSetIndex: 0,
          parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: nil,
          nalUnitHeaderLengthOut: &lengthBytes) == noErr
      else { return }
    }
    guard lengthBytes == 4 else {
      fail("encoder-failed")
      return
    }
    let count = CMBlockBufferGetDataLength(block)
    guard count > 0, count <= 4 * 1_024 * 1_024 else {
      fail("encoder-failed")
      return
    }
    var avcc = Data(count: count)
    guard
      avcc.withUnsafeMutableBytes({
        CMBlockBufferCopyDataBytes(
          block, atOffset: 0, dataLength: count, destination: $0.baseAddress!)
      }) == noErr
    else { return }
    var offset = 0
    while offset + 4 <= avcc.count {
      let length = avcc[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) }
      offset += 4
      guard length > 0, length <= avcc.count - offset else {
        fail("encoder-failed")
        return
      }
      annex.append(contentsOf: [0, 0, 0, 1])
      annex.append(avcc[offset..<(offset + length)])
      offset += length
    }
    guard offset == avcc.count, annex.count <= 4 * 1_024 * 1_024 else {
      fail("encoder-failed")
      return
    }
    let dimensions = CMVideoFormatDescriptionGetDimensions(format)
    let header: Header? = publication.withLock { state in
      guard state.open, state.visible, !state.ended, state.generation == generation else {
        return nil
      }
      state.sequence += 1
      return Header(
        streamId: id, generation: generation, sequence: state.sequence,
        ptsUs: CMTimeConvertScale(
          CMSampleBufferGetPresentationTimeStamp(sample), timescale: 1_000_000, method: .default
        ).value,
        key: key, codec: codec, width: Int(dimensions.width), height: Int(dimensions.height))
    }
    guard let header, let json = try? JSONEncoder().encode(header), json.count <= 16 * 1_024 else {
      return
    }
    var envelope = Data()
    var size = UInt32(json.count).bigEndian
    withUnsafeBytes(of: &size) { envelope.append(contentsOf: $0) }
    envelope.append(json)
    envelope.append(annex)
    let reserved = publication.withLock { state in
      guard state.open, state.visible, !state.ended, state.generation == generation else {
        return false
      }
      return state.credit.reserve(
        sequence: header.sequence, bytes: envelope.count, now: ProcessInfo.processInfo.systemUptime)
    }
    guard reserved else { return }
    guard let output = output.current,
      output.sendMedia(
        envelope,
        allowed: { [weak self] in
          guard let self else { return false }
          return self.eligible()
            && self.publication.withLock {
              $0.open && $0.visible && !$0.ended && $0.generation == generation
            }
        })
    else {
      publication.withLock { $0.credit.lost(header.sequence) }
      return
    }
    sent = true
    publication.withLock { state in
      diagnostic("encoded-sent", state)
      guard state.open, state.generation == generation else { return }
      if key { state.lastKeyGeneration = generation }
    }
    if key {
      onState(
        MacVideoState(
          streamId: id, state: "live", reason: nil,
          generation: generation, width: header.width, height: header.height))
    }
  }

  func suppress(reason: String) {
    let next: MacVideoState? = publication.withLock { state in
      guard !state.ended, state.open else { return nil }
      state.open = false
      state.verified = false
      state.samples.clear()
      state.credit.reset()
      let withheld = state.generation
      state.generation += 1
      return MacVideoState(
        streamId: id, state: "protected", reason: reason,
        generation: withheld, width: 0, height: 0)
    }
    if let next { sampleFence.retire(); onState(next) }
  }

  func fail(_ reason: String) { stop(reason: reason, failed: true) }

  func stop(reason: String = "sharing-stopped", failed: Bool = false) {
    let final: MacVideoState? = publication.withLock { state in
      guard !state.ended else { return nil }
      state.ended = true
      state.open = false
      state.samples.clear()
      state.credit.reset()
      return MacVideoState(
        streamId: id, state: failed ? "failed" : "stopped", reason: reason,
        generation: state.generation, width: 0, height: 0)
    }
    guard let final else { return }
    onState(final)
    output.withLock {
      $0?.close()
      $0 = nil
    }
    queue.async { [self] in
      if let encoder { VTCompressionSessionInvalidate(encoder) }
      encoder = nil
      resources.withLock { $0.encoderStopped = true }
    }
    settleCapture()
  }

  /// A stop request closes publication synchronously. OS teardown waits for a
  /// late start to settle, and keeps its capacity slot until that teardown ends.
  private func settleCapture() {
    guard ended else { return }
    let capture: SCStream? = resources.withLock { state in
      guard state.startComplete, !state.stopping, !state.updating else { return nil }
      state.stopping = true
      guard let stream = state.stream else {
        state.osStopped = true
        return nil
      }
      return stream
    }
    guard let capture else { return }
    operations.enqueue { [self] in
      try? await capture.stopCapture()
      resources.withLock {
        $0.stream = nil
        $0.osStopped = true
      }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    let stopped = resources.withLock { state in
      guard state.stream === stream else { return false }
      state.osStopped = true
      state.stream = nil
      return true
    }
    guard stopped else { return }
    let nativeError = error as NSError
    Log.observe.error("Window video stream stopped: stream=\(self.id, privacy: .public) domain=\(nativeError.domain, privacy: .public) code=\(nativeError.code, privacy: .public)")
    fail("sharing-stopped")
  }
}

struct MacVideoResolved {
  let binding: MacVideoBinding
  let allowed: @Sendable () -> Bool
}

/// Control-plane ownership stays on the helper's main actor. The admission
/// lane holds at most one unsettled OS start across all watched windows.
@MainActor
final class MacWindowVideoRegistry {
  final class Entry {
    let producer: any MacVideoProducing
    let control: IPCConnection
    let token = UUID().uuidString
    let valid: Locked<[@Sendable () -> Bool]>
    var sources: [MacVideoSource]
    var revision = 0
    var deadline: TimeInterval?
    let updates = SerialTaskChain()
    var warmUntil: TimeInterval?
    var warmOrder: TimeInterval = 0
    var updating = false
    var startupSettled = false
    var maxLongSide: Int
    let maxFps: Int

    init(
      id: String, resolved: MacVideoResolved, sources: [MacVideoSource], control: IPCConnection,
      maxLongSide: Int, maxFps: Int, deadline: TimeInterval, sleeping: Locked<Bool>, makeProducer: ProducerFactory
    ) {
      self.deadline = deadline
      self.sources = sources
      self.control = control
      self.maxLongSide = maxLongSide
      self.maxFps = maxFps
      let valid = Locked<[@Sendable () -> Bool]>([])
      self.valid = valid
      producer = makeProducer(
        id, resolved.binding,
        { !sleeping.current && !control.closedFlag && valid.withLock { $0.contains { $0() } } },
        { state in
          control.send(event: EventEnvelope(event: "display.state", params: state))
        })
      producer.setDiagnosticHandler { diagnostic in
        control.send(event: EventEnvelope(event: "display.diagnostic", params: diagnostic))
      }
    }
  }
  typealias ProducerFactory = (
    String, MacVideoBinding, @escaping @Sendable () -> Bool,
    @escaping @Sendable (MacVideoState) -> Void
  ) -> any MacVideoProducing
  private let makeProducer: ProducerFactory
  private let sleeping = Locked(false)
  private var bindings: [String: MacVideoBinding] = [:]
  private var streams: [String: Entry] = [:]
  private var attachments: [Int: Entry] = [:]
  private var tokens: [String: Entry] = [:]
  private let starts = SerialTaskChain()
  private let retainBinding: (CaptureTarget) -> Bool
  private let resolve: (MacVideoSource, IPCConnection) throws -> MacVideoResolved

  init(
    makeProducer: ProducerFactory? = nil,
    retainBinding: @escaping (CaptureTarget) -> Bool = { _ in true },
    resolve: @escaping (MacVideoSource, IPCConnection) throws -> MacVideoResolved
  ) {
    let operations = starts
    self.makeProducer =
      makeProducer ?? { id, binding, authority, onState in
        MacWindowVideoProducer(
          id: id, binding: binding, operations: operations, authority: authority, onState: onState)
      }
    self.retainBinding = retainBinding
    self.resolve = resolve
  }

  func register(_ window: OwnerViewWindow.Binding) -> MacVideoBinding {
    pruneBindings()
    if let current = bindings.values.first(where: { $0.matches(window.target) && $0.unavailable != "window-closed" }) { return current }
    let binding = MacVideoBinding(window)
    bindings[binding.id] = binding
    return binding
  }

  private func pruneBindings() {
    let retained = Set(streams.values.map { $0.producer.binding.id })
    bindings = bindings.filter {
      retained.contains($0.key)
        || (retainBinding($0.value.target) && $0.value.window.unavailableReason != "window-closed")
    }
  }

  func binding(for target: CaptureTarget) -> MacVideoBinding? {
    bindings.values.first { $0.matches(target) && $0.unavailable != "window-closed" }
  }

  struct ResolveParams: Decodable { let source: MacVideoSource; let ownerInputVersion: Int? }
  struct ResolveResult: Encodable { let target: MacVideoTarget }
  struct StartParams: Decodable {
    let streamId: String
    let target: MacVideoTarget
    let sources: [MacVideoSource]
    let maxLongSide: Int
    let maxFps: Int
  }
  struct StartResult: Encodable { let attachmentToken: String }
  struct WarmDemand: Decodable {
    let sources: [MacVideoSource]
    let durationMs: Int
  }
  struct DemandParams: Decodable {
    let streamId: String
    let revision: Int
    let sources: [MacVideoSource]
    let warm: WarmDemand?
    let maxLongSide: Int?
  }
  struct StreamParams: Decodable { let streamId: String }
  struct AttachParams: Decodable { let token: String }
  struct Ack: Decodable {
    let type: String
    let sequence: Int
  }
  struct SourceEvent: Encodable {
    let streamId: String
    let source: MacVideoSource
    let reason: String
  }

  private final class Pending {
    let params: StartParams
    let control: IPCConnection
    let deadline: TimeInterval
    let continuation: CheckedContinuation<StartResult, Error>
    var sources: [MacVideoSource]
    var maxLongSide: Int
    var revision = 0
    init(_ params: StartParams, _ control: IPCConnection, _ deadline: TimeInterval,
         _ continuation: CheckedContinuation<StartResult, Error>) {
      self.params = params
      self.control = control
      self.deadline = deadline
      self.continuation = continuation
      sources = params.sources
      maxLongSide = params.maxLongSide
    }
  }
  private var pending: Pending?

  private func validate(_ params: StartParams, sources: [MacVideoSource],
                        connection: IPCConnection) throws -> [MacVideoResolved] {
    guard !sleeping.current, !connection.closedFlag else {
      throw HelperError(.noSession, "Window sharing authority ended.")
    }
    let resolved = try sources.map { try resolve($0, connection) }
    guard !resolved.isEmpty,
      resolved.allSatisfy({ $0.binding.id == params.target.bindingId && $0.allowed()
        && $0.binding.unavailable == nil })
    else { throw HelperError(.noSession, "The demanded sources no longer name that exact window.") }
    return resolved
  }

  func start(_ envelope: RequestEnvelope, connection: IPCConnection, budget: WorkBudget)
    async throws -> StartResult {
    let params = try envelope.decodeParams(StartParams.self, method: envelope.method)
    guard params.target.kind == "mac-window",
      (320...MacVideoLimits.maxLongSide).contains(params.maxLongSide),
      (1...MacVideoLimits.maxFps).contains(params.maxFps), !params.sources.isEmpty,
      params.sources.count <= 8, params.streamId.hasPrefix("dsp_"),
      UUID(uuidString: String(params.streamId.dropFirst(4))) != nil
    else { throw HelperError(.failed, "That window-video request is invalid.") }
    let deadline = ProcessInfo.processInfo.systemUptime
      + min(MacVideoLimits.startupSeconds, max(0, budget.remaining()))
    _ = try validate(params, sources: params.sources, connection: connection)
    guard pending == nil, streams[params.streamId] == nil,
      !streams.values.contains(where: {
        $0.producer.binding.id == params.target.bindingId
          && !$0.producer.ended
      })
    else { throw HelperError(.busy, "This window already has an active or pending video producer.") }
    guard deadline > ProcessInfo.processInfo.systemUptime else {
      timeout(params.streamId, connection)
      throw WorkBudget.requestExpired
    }
    let occupied = streams.values.filter { !$0.producer.resourcesSettled }.count
    let retiringBinding = streams.values.contains {
      $0.producer.binding.id == params.target.bindingId
        && $0.producer.ended && !$0.producer.resourcesSettled
    }
    if occupied >= MacVideoLimits.maxWindows && !retiringBinding {
      guard let warm = streams.values.filter({ $0.warmUntil != nil && !$0.producer.resourcesSettled })
        .min(by: { $0.warmOrder < $1.warmOrder })
      else { throw HelperError(.busy, "Two windows are already visible.") }
      // Publication ends once; the physical slot remains occupied until OS cleanup settles.
      warm.producer.stop(reason: "capacity", failed: false)
    }
    return try await withCheckedThrowingContinuation { continuation in
      pending = Pending(params, connection, deadline, continuation)
      admitPending()
    }
  }

  private func timeout(_ id: String, _ connection: IPCConnection) {
    connection.send(event: EventEnvelope(event: "display.state", params: MacVideoState(
      streamId: id, state: "failed", reason: "capture-timeout", generation: 1, width: 0, height: 0)))
  }

  private func cancelPending(_ error: Error) {
    guard let current = pending else { return }
    pending = nil
    current.continuation.resume(throwing: error)
  }

  private func admitPending() {
    guard let current = pending else { return }
    if ProcessInfo.processInfo.systemUptime >= current.deadline {
      timeout(current.params.streamId, current.control)
      cancelPending(WorkBudget.requestExpired)
      return
    }
    let resolved: [MacVideoResolved]
    do { resolved = try validate(current.params, sources: current.sources, connection: current.control) }
    catch { cancelPending(error); return }
    guard streams.values.filter({ !$0.producer.resourcesSettled }).count < MacVideoLimits.maxWindows,
      !streams.values.contains(where: {
        $0.producer.binding.id == current.params.target.bindingId && !$0.producer.resourcesSettled
      }),
      let first = resolved.first else { return }
    pending = nil
    let entry = Entry(
      id: current.params.streamId, resolved: first, sources: current.sources,
      control: current.control, maxLongSide: current.maxLongSide, maxFps: current.params.maxFps,
      deadline: current.deadline, sleeping: sleeping, makeProducer: makeProducer)
    entry.revision = current.revision
    entry.valid.withLock { $0 = resolved.map(\.allowed) }
    streams[current.params.streamId] = entry
    tokens[entry.token] = entry
    let producer = entry.producer
    let registry = self
    let size = current.maxLongSide
    let fps = current.params.maxFps
    starts.enqueue {
      // Control and authority can end while another native start occupies the lane.
      guard await registry.authorizeStart(producer.id) else { return }
      await producer.start(maxLongSide: size, maxFps: fps)
      await registry.settled(producer.id, maxLongSide: size)
    }
    current.continuation.resume(returning: StartResult(attachmentToken: entry.token))
  }

  private func authorizeStart(_ id: String) -> Bool {
    guard let entry = streams[id] else { return false }
    reconcile(entry)
    if let deadline = entry.deadline, ProcessInfo.processInfo.systemUptime >= deadline {
      entry.producer.fail("capture-timeout")
    }
    // A stopped producer must still settle its unstarted resource bookkeeping.
    return true
  }

  func perform(_ envelope: RequestEnvelope, connection: IPCConnection) throws -> any Encodable {
    switch envelope.method {
    case "display.resolve":
      let params = try envelope.decodeParams(ResolveParams.self, method: envelope.method)
      let resolved = try resolve(params.source, connection)
      guard resolved.allowed(), resolved.binding.unavailable == nil else {
        throw HelperError(.noSession, "That window is no longer available.")
      }
      return ResolveResult(
        target: MacVideoTarget(kind: "mac-window", bindingId: resolved.binding.id,
          editingVersion: params.ownerInputVersion == 2 && connection.negotiatedOwnerInputVersion == 2 ? 1 : nil))
    case "display.demand":
      let params = try envelope.decodeParams(DemandParams.self, method: envelope.method)
      if let current = pending, current.params.streamId == params.streamId,
        current.control === connection {
        guard params.revision > current.revision, params.sources.count <= 8 else { return Wire.EmptyResult() }
        if let size = params.maxLongSide {
          guard (320...MacVideoLimits.maxLongSide).contains(size) else {
            throw HelperError(.failed, "Invalid video size.")
          }
          current.maxLongSide = size
        }
        current.sources = params.sources
        current.revision = params.revision
        admitPending()
        return Wire.EmptyResult()
      }
      let entry = try require(params.streamId, connection)
      guard params.revision > entry.revision, params.sources.count <= 8 else {
        return Wire.EmptyResult()
      }
      entry.revision = params.revision
      if params.sources.isEmpty, let warm = params.warm {
        guard (1...MacVideoLimits.warmMs).contains(warm.durationMs), !warm.sources.isEmpty,
          warm.sources.count <= 8
        else {
          throw HelperError(.failed, "Invalid warm retention.")
        }
        // Warming can retain only authorities already admitted to this producer.
        guard warm.sources.allSatisfy({ entry.sources.contains($0) }) else {
          throw HelperError(.noSession, "Warm retention cannot create authority.")
        }
        entry.sources = warm.sources
        let now = ProcessInfo.processInfo.systemUptime
        let until = now + Double(warm.durationMs) / 1_000
        if let current = entry.warmUntil { entry.warmUntil = min(current, until) }
        else {
          entry.warmUntil = until
          entry.warmOrder = now
        }
        entry.producer.setVisible(false)
        let warmEntries = streams.values.filter { $0.warmUntil != nil && !$0.producer.ended }.sorted
        { $0.warmOrder < $1.warmOrder }
        for old in warmEntries.prefix(max(0, warmEntries.count - MacVideoLimits.maxWarmWindows)) {
          old.producer.stop(reason: "capacity", failed: false)
        }
      } else {
        entry.warmUntil = nil
        entry.sources = params.sources
        entry.producer.setVisible(!params.sources.isEmpty)
        if params.sources.isEmpty {
          entry.producer.stop()
        }
      }
      if let size = params.maxLongSide, size != entry.maxLongSide {
        guard (320...MacVideoLimits.maxLongSide).contains(size) else {
          throw HelperError(.failed, "Invalid video size.")
        }
        entry.maxLongSide = size
        entry.producer.invalidateProfile()
      }
      reconcile(entry)
      return Wire.EmptyResult()
    case "display.refresh":
      let params = try envelope.decodeParams(StreamParams.self, method: envelope.method)
      try require(params.streamId, connection).producer.refresh()
      return Wire.EmptyResult()
    case "display.stop":
      let params = try envelope.decodeParams(StreamParams.self, method: envelope.method)
      if let current = pending, current.params.streamId == params.streamId, current.control === connection {
        cancelPending(HelperError(.noSession, "That pending video was stopped."))
      }
      if let entry = streams[params.streamId], entry.control === connection {
        entry.producer.stop()
      }
      return Wire.EmptyResult()
    case "display.attach":
      let params = try envelope.decodeParams(AttachParams.self, method: envelope.method)
      guard let entry = tokens.removeValue(forKey: params.token), !entry.control.closedFlag,
        !entry.producer.ended
      else { throw HelperError(.noSession, "That one-use video attachment has ended.") }
      try entry.producer.attach(connection)
      attachments[connection.id] = entry
      let producer = entry.producer
      connection.receiveMedia { frame in
        guard let ack = try? JSONDecoder().decode(Ack.self, from: frame), ack.type == "display.ack"
        else {
          connection.close()
          return
        }
        producer.acknowledge(ack.sequence)
      }
      return Wire.EmptyResult()
    default: throw HelperError(.unsupported, "That video operation is unsupported.")
    }
  }

  func acknowledge(connection: IPCConnection, frame: Data) -> Bool {
    guard let entry = attachments[connection.id] else { return false }
    guard let ack = try? JSONDecoder().decode(Ack.self, from: frame), ack.type == "display.ack"
    else {
      connection.close()
      return true
    }
    entry.producer.acknowledge(ack.sequence)
    return true
  }

  func attachmentReady(_ connection: IPCConnection) {
    attachments[connection.id]?.producer.refresh()
  }

  private func require(_ id: String, _ connection: IPCConnection) throws -> Entry {
    guard let entry = streams[id], entry.control === connection, !entry.producer.ended else {
      throw HelperError(.noSession, "That video producer has ended.")
    }
    return entry
  }

  func ownerInputTarget(streamID: String, source: MacVideoSource, connection: IPCConnection)
    throws -> (MacVideoBinding, any MacVideoProducing) {
    let entry = try require(streamID, connection)
    guard source.kind == "owner-view", entry.warmUntil == nil, entry.sources.contains(source) else {
      throw HelperError(.noSession, "That owner source is not visible on this stream.")
    }
    let resolved = try resolve(source, connection)
    guard resolved.allowed(), resolved.binding.id == entry.producer.binding.id,
      entry.producer.inputMap != nil else { throw HelperError(.noSession, "That picture is not current.") }
    return (resolved.binding, entry.producer)
  }

  private func reconcile(_ entry: Entry) {
    var live: [MacVideoSource] = []
    var allowed: [@Sendable () -> Bool] = []
    for source in entry.sources {
      let current = try? resolve(source, entry.control)
      if let current, current.allowed(), current.binding.id == entry.producer.binding.id {
        live.append(source)
        allowed.append(current.allowed)
      } else {
        let moved = current != nil && current?.binding.id != entry.producer.binding.id
        entry.control.send(
          event: EventEnvelope(
            event: moved ? "display.source-changed" : "display.source-ended",
            params: SourceEvent(
              streamId: entry.producer.id, source: source,
              reason: source.kind == "task-session" ? "session-ended" : "owner-ended")))
      }
    }
    entry.sources = live
    entry.valid.withLock { $0 = allowed }
    if live.isEmpty { entry.producer.stop(reason: "owner-ended", failed: false) }
  }

  func tick() {
    for entry in streams.values {
      reconcile(entry)
      entry.producer.checkLifecycle()
      if let until = entry.warmUntil, ProcessInfo.processInfo.systemUptime >= until {
        entry.producer.stop(reason: "capacity", failed: false)
      }
      if entry.producer.hasFrame { entry.deadline = nil }
      else if entry.warmUntil == nil && entry.deadline == nil {
        entry.deadline = ProcessInfo.processInfo.systemUptime + MacVideoLimits.startupSeconds
      }
      if entry.startupSettled, !entry.updating, !entry.sources.isEmpty,
        entry.producer.needsResume, entry.producer.canResume
      {
        entry.updating = true
        let producer = entry.producer
        let longSide = entry.maxLongSide
        let fps = entry.maxFps
        let registry = self
        entry.updates.enqueue {
          await producer.resume(maxLongSide: longSide, maxFps: fps)
          await registry.updated(producer.id, maxLongSide: longSide)
        }
      }
      if entry.warmUntil == nil, !entry.producer.hasFrame, let deadline = entry.deadline,
        ProcessInfo.processInfo.systemUptime >= deadline
      {
        entry.producer.fail("capture-timeout")
      }
    }
    streams = streams.filter { !$0.value.producer.ended || !$0.value.producer.resourcesSettled }
    attachments = attachments.filter { !$0.value.producer.resourcesSettled }
    tokens = tokens.filter { !$0.value.producer.ended }
    admitPending()
    pruneBindings()
  }

  private func updated(_ id: String, maxLongSide: Int) {
    guard let entry = streams[id] else { return }
    entry.updating = false
    if entry.maxLongSide != maxLongSide, !entry.producer.ended {
      entry.producer.invalidateProfile()
    }
  }

  private func settled(_ id: String, maxLongSide: Int) {
    guard let entry = streams[id] else { return }
    entry.startupSettled = true
    if entry.maxLongSide != maxLongSide, !entry.producer.ended {
      entry.producer.invalidateProfile()
    }
  }

  func setSleeping(_ sleeping: Bool) {
    self.sleeping.withLock { $0 = sleeping }
    if sleeping { cancelPending(HelperError(.noSession, "This Mac is locked or asleep.")) }
    if sleeping { for entry in streams.values { entry.producer.fail("locked-screen") } }
  }

  func disconnected(_ connection: IPCConnection) {
    if pending?.control === connection { cancelPending(HelperError(.noSession, "Connection ended.")) }
    if let entry = attachments.removeValue(forKey: connection.id) {
      entry.producer.fail("data-socket-failed")
    }
    for entry in streams.values where entry.control === connection { entry.producer.stop() }
  }

  func close() {
    cancelPending(HelperError(.noSession, "Window sharing stopped."))
    for entry in streams.values { entry.producer.stop() }
    tokens.removeAll()
  }
}
