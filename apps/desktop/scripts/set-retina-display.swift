import CoreGraphics
import Foundation

// A guest keeps the small default mode of a 2x display; the app needs room.
let display = CGMainDisplayID()
let options = [kCGDisplayShowDuplicateLowResolutionModes as String: kCFBooleanTrue!] as CFDictionary
let modes = (CGDisplayCopyAllDisplayModes(display, options) as? [CGDisplayMode]) ?? []
guard let mode = modes.filter({ $0.pixelWidth == $0.width * 2 && $0.height >= 900 }).max(by: { $0.width < $1.width }) else { exit(0) }
var configuration: CGDisplayConfigRef?
guard CGBeginDisplayConfiguration(&configuration) == .success,
      CGConfigureDisplayWithDisplayMode(configuration, display, mode, nil) == .success,
      CGCompleteDisplayConfiguration(configuration, .permanently) == .success else { exit(1) }
