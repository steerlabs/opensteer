// Offscreen screen-like content only: no windows, screen capture, or privacy grants.
import AppKit
import VideoToolbox
import CoreMedia

let args = CommandLine.arguments
let output = args[1]
let fps = Int(args[2])!
let seconds = Int(args[3])!
let bitrate = Int(args[4])!
let profile = args[5] == "main" ? kVTProfileLevel_H264_Main_AutoLevel : kVTProfileLevel_H264_Baseline_AutoLevel
let gop = Int(args[6])!
let phase = Int(args[7])!
let width = 1512, height = 982
func checked(_ status: OSStatus) {
    precondition(status == noErr, "VideoToolbox failed: \(status)")
}
final class Sink {
    var frames: [[String: Any]] = []
    var failure: OSStatus = noErr
}
let sink = Sink()
var session: VTCompressionSession?
checked(VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: { pointer, _, status, _, sample in
    let sink = Unmanaged<Sink>.fromOpaque(pointer!).takeUnretainedValue()
    guard status == noErr, let sample, let block = CMSampleBufferGetDataBuffer(sample), let format = CMSampleBufferGetFormatDescription(sample) else { sink.failure = status; return }
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
    let key = attachments?.first?[kCMSampleAttachmentKey_NotSync as String] == nil
    var bytes = Data()
    var codec = ""
    if key {
        for index in 0..<2 {
            var parameter: UnsafePointer<UInt8>?
            var size = 0, count = 0
            var length: Int32 = 0
            let result = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &parameter, parameterSetSizeOut: &size, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &length)
            guard result == noErr, let parameter else { sink.failure = result; return }
            bytes.append(contentsOf: [0, 0, 0, 1])
            bytes.append(parameter, count: size)
            if index == 0 { codec = String(format: "avc1.%02X%02X%02X", parameter[1], parameter[2], parameter[3]) }
        }
    }
    var length = 0
    var total = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &length, totalLengthOut: &total, dataPointerOut: &pointer) == noErr, let pointer else { sink.failure = -1; return }
    let avcc = Data(bytes: pointer, count: total)
    var offset = 0
    while offset + 4 <= total {
        let size = avcc[offset..<offset+4].reduce(0) { ($0 << 8) | Int($1) }
        offset += 4
        guard offset + size <= total else { sink.failure = -1; return }
        bytes.append(contentsOf: [0, 0, 0, 1])
        bytes.append(avcc[offset..<offset+size])
        offset += size
    }
    sink.frames.append(["key": key, "codec": codec, "data": bytes.base64EncodedString()])
}, refcon: Unmanaged.passUnretained(sink).toOpaque(), compressionSessionOut: &session))
let encoder = session!
checked(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue))
checked(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse))
checked(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_ProfileLevel, value: profile))
checked(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber))
checked(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber))
checked(VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: gop as CFNumber))
checked(VTCompressionSessionPrepareToEncodeFrames(encoder))
let font = NSFont.monospacedSystemFont(ofSize: 17, weight: .regular)
for frame in 0..<(fps * seconds) {
    autoreleasepool {
        var pixel: CVPixelBuffer?
        checked(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32ARGB, [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &pixel))
        let buffer = pixel!
        CVPixelBufferLockBaseAddress(buffer, [])
        let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
        let time = Double(frame) / Double(fps)
        let cut = time >= Double(seconds) * 0.8
        context.setFillColor(NSColor(calibratedWhite: cut ? 0.18 : 0.07, alpha: 1).cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        let idle = time >= Double(seconds) * 0.55 && time < Double(seconds) * 0.8
        let scroll = idle ? Double(seconds) * 0.55 * 90 : time * 90
        for line in 0..<65 {
            let row = line + Int(scroll / 24)
            let text = String(format: "%04d  ", row) + (cut ? "const paint = (frame: VideoFrame) => canvas.drawImage(frame, 0, 0);" : "export async function renderWindow(target: WindowTarget, sequence: number) {")
            (text as NSString).draw(at: NSPoint(x: 28 + (line % 4) * 12, y: height - 35 - line * 24 + Int(scroll.truncatingRemainder(dividingBy: 24))), withAttributes: [.font: font, .foregroundColor: line % 3 == 0 ? NSColor.systemTeal : NSColor.lightGray])
        }
        let typed = idle ? 24 : Int(time * 12) % 100
        (String(repeating: "x", count: typed) as NSString).draw(at: NSPoint(x: 900, y: 80), withAttributes: [.font: font, .foregroundColor: NSColor.systemYellow])
        NSGraphicsContext.restoreGraphicsState()
        CVPixelBufferUnlockBaseAddress(buffer, [])
        checked(VTCompressionSessionEncodeFrame(encoder, imageBuffer: buffer, presentationTimeStamp: CMTime(value: Int64(frame), timescale: Int32(fps)), duration: CMTime(value: 1, timescale: Int32(fps)), frameProperties: (frame % gop == phase ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil), sourceFrameRefcon: nil, infoFlagsOut: nil))
    }
}
checked(VTCompressionSessionCompleteFrames(encoder, untilPresentationTimeStamp: .invalid))
VTCompressionSessionInvalidate(encoder)
checked(sink.failure)
precondition(sink.frames.count == fps * seconds, "Encoder dropped frames")
try JSONSerialization.data(withJSONObject: sink.frames).write(to: URL(fileURLWithPath: output), options: .atomic)
