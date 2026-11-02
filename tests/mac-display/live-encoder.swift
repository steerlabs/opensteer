// Offscreen only: synthetic pixels, no windows or capture permissions.
import AppKit
import CoreImage
import VideoToolbox
import CoreMedia

// Each stdout record is a BE body length, a JSON header, newline, then Annex-B.
func emit(_ header: [String: Any], _ payload: Data = Data()) {
    var body = try! JSONSerialization.data(withJSONObject: header)
    body.append(10)
    body.append(payload)
    var size = UInt32(body.count).bigEndian
    var packet = Data(bytes: &size, count: 4)
    packet.append(body)
    FileHandle.standardOutput.write(packet)
}
func checked(_ status: OSStatus) {
    precondition(status == noErr, "VideoToolbox failed: \(status)")
}
let width = 1512, height = 982
let duration = Double(CommandLine.arguments.dropFirst().first ?? "20")!
let font = NSFont.monospacedSystemFont(ofSize: 17, weight: .regular)
let queue = DispatchQueue(label: "live-encoder")
final class Encoder {
    var rate = MacVideoRate(maxFps: 60, mode: .negotiated(cap: nil))
    var plan = MacVideoRate.Plan(bitrate: 1, fps: 60)
    var session: VTCompressionSession?
    var timer: DispatchSourceTimer?
    var slot: DispatchWorkItem?
    var origin = 0.0
    var last = -Double.infinity
    var pts: Int64 = -1
    var picture: CVPixelBuffer?
    var captureUs: Int64 = 0
    var inFlight = 0
    var tick = 0
    var pending = false
    var key = true
    let ci = CIContext(options: [.cacheIntermediates: false])
    func retarget() {
        let next = rate.plan(width: width, height: height)
        if next != plan, let session {
            checked(MacVideoEncoder.retarget(session, next) ? noErr : -1)
            plan = next
        }
    }
    func start(_ command: [String: Any]) {
        precondition(session == nil)
        let mode: MacVideoRate.Mode = command.keys.contains("maxBitrate")
            ? .negotiated(cap: command["maxBitrate"] as? Int) : .legacy
        rate = MacVideoRate(maxFps: mode == .legacy ? 30 : command["maxFps"] as! Int, mode: mode)
        plan = rate.plan(width: width, height: height)
        for configuration in MacVideoEncoder.configurations(mode) {
            session = MacVideoEncoder.make(width: width, height: height, plan: plan,
                configuration: configuration, output: { pointer, refcon, status, flags, sample in
                    let submission = Int(bitPattern: refcon)
                    let encoder = Unmanaged<Encoder>.fromOpaque(pointer!).takeUnretainedValue()
                    queue.async { encoder.output(status, flags, sample, submission) }
                }, refcon: Unmanaged.passUnretained(self).toOpaque())
            if session != nil { break }
        }
        precondition(session != nil, "No supported production hardware encoder")
        origin = ProcessInfo.processInfo.systemUptime
        emit(["clock": 0])
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 1.0 / Double(rate.maxFps), leeway: .microseconds(100))
        timer.setEventHandler { self.capture() }
        self.timer = timer
        timer.resume()
    }
    func capture() {
        autoreleasepool {
            let now = ProcessInfo.processInfo.systemUptime
            let time = Double(tick) / Double(rate.maxFps)
            tick += 1
            var pixel: CVPixelBuffer?
            checked(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32ARGB,
                [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &pixel))
            let buffer = pixel!
            CVPixelBufferLockBaseAddress(buffer, [])
            let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
            let cut = time >= duration * 0.8
            context.setFillColor(NSColor(calibratedWhite: cut ? 0.18 : 0.07, alpha: 1).cgColor)
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
            let idle = time >= duration * 0.55 && time < duration * 0.8
            let scroll = idle ? duration * 0.55 * 90 : time * 90
            for line in 0..<65 {
                let row = line + Int(scroll / 24)
                let text = String(format: "%04d  ", row) + (cut ? "const paint = (frame: VideoFrame) => canvas.drawImage(frame, 0, 0);" : "export async function renderWindow(target: WindowTarget, sequence: number) {")
                (text as NSString).draw(at: NSPoint(x: 28 + (line % 4) * 12, y: height - 35 - line * 24 + Int(scroll.truncatingRemainder(dividingBy: 24))), withAttributes: [.font: font, .foregroundColor: line % 3 == 0 ? NSColor.systemTeal : NSColor.lightGray])
            }
            let typed = idle ? 24 : Int(time * 12) % 100
            (String(repeating: "x", count: typed) as NSString).draw(at: NSPoint(x: 900, y: 80), withAttributes: [.font: font, .foregroundColor: NSColor.systemYellow])
            NSGraphicsContext.restoreGraphicsState()
            // Deterministic video-like region, frozen during the idle segment.
            let motion = idle ? duration * 0.55 : time
            for tile in 0..<32 {
                context.setFillColor(NSColor(calibratedHue: CGFloat((Double(tile) / 32 + motion * 0.1).truncatingRemainder(dividingBy: 1)), saturation: 0.7, brightness: 0.8, alpha: 1).cgColor)
                context.fill(CGRect(x: 1000 + tile % 8 * 55, y: 180 + tile / 8 * 55, width: 55, height: 55))
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            var nv12: CVPixelBuffer?
            checked(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &nv12))
            ci.render(CIImage(cvPixelBuffer: buffer), to: nv12!)
            picture = nv12
            captureUs = Int64((now - origin) * 1_000_000)
            pending = true
            submit()
        }
    }
    func submit() {
        guard pending, inFlight < 3, let session, let picture else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let interval = rate.mode == .legacy ? 0 : 1 / Double(plan.fps)
        let wait = last + interval - min(interval / 4, 1.0 / 120) - now
        if wait > 0 {
            if slot == nil {
                let work = DispatchWorkItem { self.slot = nil; self.submit() }
                slot = work
                queue.asyncAfter(deadline: .now() + wait, execute: work)
            }
            return
        }
        inFlight += 1
        last = now
        pts = max(pts + 1, captureUs)
        pending = false
        let force = key
        key = false
        checked(VTCompressionSessionEncodeFrame(session, imageBuffer: picture,
            presentationTimeStamp: CMTime(value: pts, timescale: 1_000_000), duration: .invalid,
            frameProperties: force ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil,
            sourceFrameRefcon: UnsafeMutableRawPointer(bitPattern: (Int(captureUs) << 1) | (force ? 1 : 0)), infoFlagsOut: nil))
    }
    func output(_ status: OSStatus, _ flags: VTEncodeInfoFlags, _ sample: CMSampleBuffer?, _ submission: Int) {
        inFlight -= 1
        checked(status)
        guard session != nil else { return }
        if flags.contains(.frameDropped) {
            emit(["drop": true])
            key = key || submission & 1 == 1
            pending = true
            let work = DispatchWorkItem { self.slot = nil; self.submit() }
            slot?.cancel()
            slot = work
            queue.asyncAfter(deadline: .now() + 1 / Double(plan.fps), execute: work)
            return
        }
        guard let sample, let block = CMSampleBufferGetDataBuffer(sample),
            let format = CMSampleBufferGetFormatDescription(sample) else { fatalError("Missing encoded frame") }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]]
        let key = attachments?.first?[kCMSampleAttachmentKey_NotSync as String] == nil
        var bytes = Data()
        var codec = ""
        if key {
            for index in 0..<2 {
                var parameter: UnsafePointer<UInt8>?
                var size = 0, count = 0
                var length: Int32 = 0
                checked(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index,
                    parameterSetPointerOut: &parameter, parameterSetSizeOut: &size,
                    parameterSetCountOut: &count, nalUnitHeaderLengthOut: &length))
                bytes.append(contentsOf: [0, 0, 0, 1])
                bytes.append(parameter!, count: size)
                if index == 0 { codec = String(format: "avc1.%02X%02X%02X", parameter![1], parameter![2], parameter![3]) }
            }
        }
        var length = 0, total = 0
        var pointer: UnsafeMutablePointer<Int8>?
        checked(CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &length, totalLengthOut: &total, dataPointerOut: &pointer))
        let avcc = Data(bytes: pointer!, count: total)
        var offset = 0
        while offset + 4 <= total {
            let size = avcc[offset..<offset+4].reduce(0) { ($0 << 8) | Int($1) }
            offset += 4
            precondition(offset + size <= total)
            bytes.append(contentsOf: [0, 0, 0, 1])
            bytes.append(avcc[offset..<offset+size])
            offset += size
        }
        emit(["key": key, "codec": codec, "captureUs": submission >> 1, "ptsUs": CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1_000_000,
            "width": width, "height": height], bytes)
        submit()
    }
    func command(_ value: [String: Any]) {
        if let start = value["start"] as? [String: Any] { self.start(start) }
        if value.keys.contains("cap") { rate.setLinkCap(value["cap"] as? Int); retarget() }
        if value["refresh"] as? Bool == true { key = true; pending = true; submit() }
        if let ack = value["ack"] as? [String: Double], let delay = ack["delayMs"] {
            if rate.acknowledged(delay: delay / 1000, now: ProcessInfo.processInfo.systemUptime, width: width, height: height) { retarget() }
        }
        if value["stop"] as? Bool == true {
            timer?.cancel()
            slot?.cancel()
            if let session { VTCompressionSessionInvalidate(session) }
            session = nil
        }
    }
}
@main struct LiveEncoder {
    static func main() {
        let encoder = Encoder()
        while let line = readLine() {
            let command = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
            queue.sync { encoder.command(command) }
            if command["stop"] as? Bool == true { return }
        }
        queue.sync { encoder.command(["stop": true]) }
    }
}
