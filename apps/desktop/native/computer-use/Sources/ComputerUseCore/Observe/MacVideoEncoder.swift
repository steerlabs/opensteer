import CoreMedia
import Foundation
import VideoToolbox

/// The window encoder's configuration, apart from capture and publication, so
/// the Mac display benchmark (`tests/mac-display`) compiles exactly what ships.
enum MacVideoEncoder {
  struct Configuration: Equatable {
    let lowLatency: Bool
    let profile: CFString
  }

  /// Preferred first. A negotiated stream prefers low-latency rate control,
  /// which tracks the budget by skipping frames rather than blurring text and
  /// needs Constrained High. An encoder without either, as in a virtual machine,
  /// keeps the next configuration it fully supports.
  static func configurations(_ mode: MacVideoRate.Mode) -> [Configuration] {
    guard mode != .legacy else {
      return [Configuration(lowLatency: false, profile: kVTProfileLevel_H264_Baseline_AutoLevel)]
    }
    return [
      Configuration(lowLatency: true, profile: kVTProfileLevel_H264_ConstrainedHigh_AutoLevel),
      Configuration(lowLatency: false, profile: kVTProfileLevel_H264_ConstrainedHigh_AutoLevel),
      Configuration(lowLatency: false, profile: kVTProfileLevel_H264_Baseline_AutoLevel),
    ]
  }

  /// One fully configured hardware session, or nil when this encoder lacks it.
  static func make(
    width: Int, height: Int, plan: MacVideoRate.Plan, configuration: Configuration,
    output: @escaping VTCompressionOutputCallback, refcon: UnsafeMutableRawPointer?
  ) -> VTCompressionSession? {
    var created: VTCompressionSession?
    guard VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault, width: Int32(width), height: Int32(height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: [
        kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
        kVTVideoEncoderSpecification_EnableLowLatencyRateControl: configuration.lowLatency,
      ] as CFDictionary,
      imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: output, refcon: refcon, compressionSessionOut: &created) == noErr,
      let session = created
    else { return nil }
    var properties: [(CFString, CFTypeRef)] = [
      (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue as CFTypeRef),
      (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse as CFTypeRef),
      (kVTCompressionPropertyKey_ProfileLevel, configuration.profile as CFTypeRef),
      (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: plan.fps)),
      (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: plan.bitrate)),
    ]
    // Low-latency keys come only on demand (start, refresh, loss): a periodic
    // key on a scarce budget costs seconds of skipped frames.
    if !configuration.lowLatency {
      properties.append((kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: plan.fps * 2)))
    }
    var hardware: Unmanaged<CFTypeRef>?
    guard properties.allSatisfy({ VTSessionSetProperty(session, key: $0.0, value: $0.1) == noErr }),
      VTCompressionSessionPrepareToEncodeFrames(session) == noErr,
      withUnsafeMutablePointer(to: &hardware, { pointer in
        VTSessionCopyProperty(
          session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
          allocator: kCFAllocatorDefault, valueOut: UnsafeMutableRawPointer(pointer))
      }) == noErr,
      hardware?.takeRetainedValue() as? Bool == true
    else {
      VTCompressionSessionInvalidate(session)
      return nil
    }
    return session
  }

  /// Retargets a live session; both properties change without a new session.
  static func retarget(_ session: VTCompressionSession, _ plan: MacVideoRate.Plan) -> Bool {
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate,
      value: NSNumber(value: plan.bitrate)) == noErr
      && VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate,
        value: NSNumber(value: plan.fps)) == noErr
  }
}
