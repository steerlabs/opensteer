import Foundation
import Security

public final class PreviewKeyStore {
  public static let group = "group.com.opensteer.mobile.notifications"
  private let service = "com.opensteer.mobile.notification-preview"
  private let lock = NSLock()
  public init() {}
  private func query(_ deployment: String? = nil) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccessGroup as String: Self.group,
    ]
    if let deployment { q[kSecAttrAccount as String] = deployment }
    return q
  }
  public func marker() throws -> String {
    guard
      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.group)
    else { throw PreviewError.invalid }
    let file = root.appendingPathComponent("installation")
    if FileManager.default.fileExists(atPath: file.path) {
      return try String(contentsOf: file, encoding: .utf8)
    }
    let marker = UUID().uuidString
    try Data(marker.utf8).write(to: file, options: .atomic)
    var url = file
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    return marker
  }
  public func read(_ deployment: String) throws -> [String: String]? {
    var q = query(deployment)
    q[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data,
      let record = try JSONSerialization.jsonObject(with: data) as? [String: String],
      record["marker"] == (try marker())
    else { return nil }
    return record
  }
  public func erase(_ deployment: String?) throws {
    let status = SecItemDelete(query(deployment) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw PreviewError.invalid
    }
  }
  public func prepare() throws {
    let current = try marker()
    var q = query()
    q[kSecReturnAttributes as String] = true
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw PreviewError.invalid
    }
    for item in result as? [[String: Any]] ?? [] {
      guard let dep = item[kSecAttrAccount as String] as? String else { throw PreviewError.invalid }
      let record = (item[kSecValueData as String] as? Data).flatMap {
        try? JSONSerialization.jsonObject(with: $0) as? [String: String]
      }
      if record?["marker"] != current { try erase(dep) }
    }
  }
  public func key(_ deployment: String) throws -> [String: String] {
    lock.lock()
    defer { lock.unlock() }
    if let record = try read(deployment) { return record }
    func random(_ count: Int) throws -> String {
      var bytes = [UInt8](repeating: 0, count: count)
      guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
        throw PreviewError.invalid
      }
      return Preview.encode(Data(bytes))
    }
    let record = ["marker": try marker(), "keyId": try random(16), "key": try random(32)]
    var q = query(deployment)
    q[kSecValueData as String] = try Preview.json(record)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw PreviewError.invalid }
    return record
  }
}
