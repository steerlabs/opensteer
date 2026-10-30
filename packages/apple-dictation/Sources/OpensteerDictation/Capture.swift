import AVFoundation
import AudioToolbox
import Foundation

/// Owns the microphone and observes only changes to the captured input.
final class MicrophoneCapture: AudioCapture, @unchecked Sendable {
  private var engine: AVAudioEngine?
  private var tapped = false
  #if os(iOS)
    private var audioSessionActive = false
  #endif
  private var inputChanges: InputChanges?
  private var observers: [NSObjectProtocol] = []
  func permission() -> DictationMicrophone {
    #if os(macOS)
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized: return .granted
      case .notDetermined: return .undetermined
      default: return .denied
      }
    #else
      let permission: AVAudioSession.RecordPermission
      if #available(iOS 17, *) {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .undetermined: return .undetermined
        default: return .denied
        }
      }
      permission = AVAudioSession.sharedInstance().recordPermission
      switch permission {
      case .granted: return .granted
      case .undetermined: return .undetermined
      default: return .denied
      }
    #endif
  }
  func restricted() -> Bool {
    #if os(macOS)
      return AVCaptureDevice.authorizationStatus(for: .audio) == .restricted
    #else
      return false
    #endif
  }
  func requestPermission() async -> Bool {
    if permission() != .undetermined { return permission() == .granted }
    #if os(macOS)
      return await AVCaptureDevice.requestAccess(for: .audio)
    #else
      if #available(iOS 17, *) { return await AVAudioApplication.requestRecordPermission() }
      return await withCheckedContinuation { c in
        AVAudioSession.sharedInstance().requestRecordPermission { c.resume(returning: $0) }
      }
    #endif
  }
  func start(queue: AudioQueue, changed: @escaping @Sendable (DictationEndReason) -> Void) throws {
    #if os(iOS)
      guard #available(iOS 26, *) else { throw DictationError.microphoneUnavailable }
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
      try session.setActive(true)
      audioSessionActive = true
    #endif
    let engine = AVAudioEngine()
    self.engine = engine
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw DictationError.microphoneUnavailable
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength)
      else {
        queue.fail()
        return
      }
      copy.frameLength = buffer.frameLength
      let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
      let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
      for (src, dst) in zip(source, destination) {
        if let s = src.mData, let d = dst.mData { memcpy(d, s, Int(src.mDataByteSize)) }
      }
      queue.append(copy)
    }
    tapped = true
    try engine.start()
    let center = NotificationCenter.default
    inputChanges = InputChanges(center: center, object: engine, read: { Self.identity(engine) }) {
      changed(.deviceChanged)
    }
    #if os(iOS)
      observers.append(
        center.addObserver(
          forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil
        ) { _ in changed(.interrupted) })
      observers.append(
        center.addObserver(
          forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
        ) { note in
          if let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            raw == AVAudioSession.InterruptionType.began.rawValue
          {
            changed(.interrupted)
          }
        })
    #endif
  }
  private static func identity(_ engine: AVAudioEngine) -> AudioInputIdentity {
    let format = engine.inputNode.outputFormat(forBus: 0)
    #if os(iOS)
      let devices = AVAudioSession.sharedInstance().currentRoute.inputs.map {
        "\($0.uid):\($0.selectedDataSource?.dataSourceID.stringValue ?? "")"
      }
    #else
      var device = AudioDeviceID(0)
      var size = UInt32(MemoryLayout<AudioDeviceID>.size)
      if let unit = engine.inputNode.audioUnit {
        AudioUnitGetProperty(
          unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, &size)
      }
      let devices = [String(device)]
    #endif
    return AudioInputIdentity(
      devices: devices, sampleRate: format.sampleRate, channels: format.channelCount)
  }
  func stop() {
    inputChanges = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    if let engine {
      engine.stop()
      if tapped { engine.inputNode.removeTap(onBus: 0) }
    }
    engine = nil
    tapped = false
    #if os(iOS)
      if audioSessionActive {
        audioSessionActive = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      }
    #endif
  }
}

/// Output/category notifications are harmless when input identity and format agree.
struct AudioInputIdentity: Equatable, Sendable {
  let devices: [String]
  let sampleRate: Double
  let channels: UInt32
}

/// Installed after capture starts, so activation/category changes cannot end admission.
/// A configuration notification alone is insufficient: the input must actually differ.
final class InputChanges {
  private let center: NotificationCenter
  private var observer: NSObjectProtocol?

  init(
    center: NotificationCenter, object: AnyObject,
    read: @escaping @Sendable () -> AudioInputIdentity,
    changed: @escaping @Sendable () -> Void
  ) {
    self.center = center
    let captured = read()
    observer = center.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: object, queue: nil
    ) { _ in
      if captured != read() { changed() }
    }
  }

  deinit {
    if let observer { center.removeObserver(observer) }
  }
}
