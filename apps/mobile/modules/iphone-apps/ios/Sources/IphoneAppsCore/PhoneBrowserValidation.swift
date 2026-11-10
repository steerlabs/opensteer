import CoreFoundation
import Foundation

enum PhoneBrowserValidation {
  static let safeInteger = 9_007_199_254_740_991

  static func identifier(_ value: String, prefix: String) -> Bool {
    value.range(of: "^\(prefix)_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: [.regularExpression, .caseInsensitive]) != nil
  }

  static func boolean(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
  }

  static func number(_ object: [String: Any], _ field: String, range: ClosedRange<Double>) throws -> Double {
    guard let number = object[field] as? NSNumber, !boolean(number), number.doubleValue.isFinite,
      range.contains(number.doubleValue) else { throw PhoneBrowserFailure.forbidden }
    return number.doubleValue
  }

  static func surface(_ value: Any?) -> Bool {
    guard let text = value as? String else { return false }
    return (1...512).contains(text.utf16.count)
  }

  static func uuid(_ value: Any?) -> Bool {
    guard let text = value as? String else { return false }
    return identifier("uuid_" + text, prefix: "uuid")
  }

  static func binding(_ object: [String: Any]) throws {
    guard Set(object.keys) == Set(["version", "deploymentId", "profileId", "runnerId", "storageInstanceId", "bindingId", "engine"]),
      identifier(try WireField.string(object, "deploymentId"), prefix: "dep"),
      identifier(try WireField.string(object, "profileId"), prefix: "bpr"),
      identifier(try WireField.string(object, "runnerId"), prefix: "rnr"),
      uuid(object["storageInstanceId"]), uuid(object["bindingId"]),
      ["electron", "chromium", "wkwebview", "android-webview"].contains(object["engine"] as? String ?? "") else { throw PhoneBrowserFailure.forbidden }
    _ = try WireField.int(object, "version", range: 1...1)
  }

  static func fence(_ object: [String: Any]) throws {
    for (field, prefix) in [("runnerId", "rnr"), ("bootId", "rbt"), ("connectionId", "rcn"), ("connectionLeaseId", "rls"), ("auxiliaryStreamId", "rax")] {
      guard identifier(try WireField.string(object, field), prefix: prefix) else { throw PhoneBrowserFailure.forbidden }
    }
    _ = try WireField.int(object, "connectionGeneration", range: 1...safeInteger)
  }
}
