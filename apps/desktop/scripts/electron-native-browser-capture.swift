import AppKit
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import Darwin

@main struct OwnedCompositeCapture {
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count == 4, let pid = Int32(args[1]), let windowId = UInt32(args[2]),
                  NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.github.Electron" else { exit(2) }
            var ancestor = pid
            var owned = false
            for _ in 0..<32 {
                var info = proc_bsdinfo()
                guard proc_pidinfo(ancestor, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { break }
                ancestor = Int32(info.pbi_ppid)
                if ancestor == getppid() { owned = true; break }
                if ancestor <= 1 { break }
            }
            guard owned else { exit(2) }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let target = content.windows.first(where: { $0.windowID == windowId && $0.owningApplication?.processID == pid }),
                  let display = content.displays.first(where: { $0.frame.contains(target.frame) }) else { exit(3) }
            // Include the owned glass as well as the app window. A rectangular
            // desktop capture also includes unrelated windows and their shadows.
            let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.frame.intersects(target.frame) }
            let filter = SCContentFilter(display: display, including: windows)
            let configuration = SCStreamConfiguration()
            configuration.sourceRect = target.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
            configuration.width = Int((target.frame.width * Double(filter.pointPixelScale)).rounded())
            configuration.height = Int((target.frame.height * Double(filter.pointPixelScale)).rounded())
            configuration.showsCursor = false
            configuration.ignoreShadowsDisplay = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(4) }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { exit(5) }
            let result: [String: Any] = ["method": "owned-composite", "pid": pid, "windowId": windowId, "includedWindowIds": windows.map { $0.windowID }, "width": image.width, "height": image.height]
            print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
        } catch {
            fputs(String(describing: error) + "\n", stderr)
            exit(6)
        }
    }
}
