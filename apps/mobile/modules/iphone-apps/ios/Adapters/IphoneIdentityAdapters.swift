import Foundation
import Security

public enum IphoneStorageError: Error { case protectedDataUnavailable, keychain(OSStatus), unreadableRecord }

final class IphoneKeychainVault: IdentityVault {
  private let service = "com.opensteer.mobile.iphone-apps"
  private func query(_ account: IdentityAccount) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: account.rawValue,
     kSecAttrSynchronizable as String: false]
  }
  func read(_ account: IdentityAccount) throws -> Data? {
    var q = query(account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var output: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &output)
    if status == errSecItemNotFound { return nil }
    try check(status)
    guard let data = output as? Data else { throw IphoneStorageError.keychain(errSecDecode) }
    return data
  }
  func write(_ value: Data, account: IdentityAccount) throws {
    try remove(account)
    var q = query(account)
    q[kSecValueData as String] = value
    q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    try check(SecItemAdd(q as CFDictionary, nil))
  }
  func remove(_ account: IdentityAccount) throws {
    let status = SecItemDelete(query(account) as CFDictionary)
    if status != errSecItemNotFound { try check(status) }
  }
  private func check(_ status: OSStatus) throws {
    if status == errSecSuccess { return }
    if status == errSecInteractionNotAllowed || status == errSecNotAvailable {
      throw IphoneStorageError.protectedDataUnavailable
    }
    throw IphoneStorageError.keychain(status)
  }
}

final class IphoneSandboxRecord: IdentityRecordStore {
  private let url: URL
  init() throws {
    let support = try FileManager.default.url(for: .applicationSupportDirectory,
      in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = support.appendingPathComponent("iphone-apps", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    url = directory.appendingPathComponent("enrollment.json")
  }
  func read() throws -> Data? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    do { return try Data(contentsOf: url) }
    catch CocoaError.fileReadNoSuchFile { return nil }
    catch CocoaError.fileReadNoPermission { throw IphoneStorageError.protectedDataUnavailable }
    // A present but corrupt/unreadable marker must take the same cleanup path
    // as a malformed record. Protected data unavailability is distinct above.
    catch { return Data() }
  }
  func write(_ value: Data) throws {
    try value.write(to: url, options: .atomic)
    var resource = URLResourceValues()
    resource.isExcludedFromBackup = true
    var markedURL = url
    try markedURL.setResourceValues(resource)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
  }
  func remove() throws {
    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
  }
}
