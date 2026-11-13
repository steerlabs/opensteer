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

  /// The browser module JavaScript advertises (`descriptor.ts`), admitted only as the native
  /// qualification allows; `phone-descriptors.v1.json` keeps both sides on one wire. Returns its storage.
  static func descriptor(_ descriptor: [String: Any], qualification: [String: Any]) throws -> String {
    guard qualification["browser"] as? Bool == true, qualification["sharedControl"] as? Bool == true,
      qualification["platform"] as? String == "ios",
      descriptor["runtimeId"] as? String == qualification["runtimeId"] as? String,
      let storage = descriptor["localProfileStorage"] as? [String: Any], storage["engine"] as? String == "wkwebview",
      Set(storage.keys) == Set(["storageInstanceId", "engine"]),
      storage["storageInstanceId"] as? String == qualification["storageInstanceId"] as? String,
      let storageId = storage["storageInstanceId"] as? String, UUID(uuidString: storageId) != nil else { throw PhoneBrowserFailure.forbidden }
    let expected = ["wireVersion", "navigationVersion", "navigationAttributionVersion", "tabRestoreVersion", "popupFollowVersion", "sharedControl", "targetControl", "rasterDemand", "basicInput", "surfaceState"]
    guard Set(descriptor.keys).isSubset(of: Set(expected + ["runtimeId", "localProfileStorage", "fileStaging", "agentActions"])) else { throw PhoneBrowserFailure.forbidden }
    for field in expected { _ = try WireField.int(descriptor, field, range: field == "wireVersion" ? 2...2 : 1...1) }
    if descriptor["agentActions"] != nil {
      guard qualification["agentActions"] as? Bool == true else { throw PhoneBrowserFailure.forbidden }
      _ = try WireField.int(descriptor, "agentActions", range: 1...1)
    }
    if descriptor["fileStaging"] != nil {
      guard #available(iOS 18.4, *), qualification["fileStaging"] as? Bool == true,
        boolean(descriptor["fileStaging"]), descriptor["fileStaging"] as? Bool == true else { throw PhoneBrowserFailure.forbidden }
    }
    return storageId
  }
}
