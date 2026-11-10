import Foundation
import CoreFoundation

public enum BrowserWireNumber {
  public static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite else { return nil }
    return Int(exactly: number.doubleValue)
  }
}
