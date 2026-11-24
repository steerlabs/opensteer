import CoreFoundation
import Foundation

/// Whole-number decoding for untyped bridge dictionaries where JavaScript hands numbers over as
/// `Double` (and tests as `Int`).
enum RemoteInputNumber {
  static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double == double.rounded(), abs(double) < 9_007_199_254_740_992 else { return nil }
    return Int(exactly: double)
  }
}
