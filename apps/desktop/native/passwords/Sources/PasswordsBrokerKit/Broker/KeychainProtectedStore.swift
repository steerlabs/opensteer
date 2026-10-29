import Foundation
import PasswordsCore
import Security

/// The release build's `ProtectedStore`: generic-password items in the
/// broker's own data-protection keychain access group, which only an app
/// signed with the Developer ID provisioning profile that grants the group
/// can read or roll back. Items stay on this Mac (not synchronizable, this
/// device only) and are readable after the first unlock, so an allowed
/// account signs in while the screen is locked. Before that first unlock
/// every call fails with `NotUnlockedSinceRestart`.
///
/// It cannot run in tests or development builds: without the
/// `keychain-access-groups` entitlement every call fails with
/// `errSecMissingEntitlement`. That is why it is only these four calls.
public final class KeychainProtectedStore: ProtectedStore {
  public struct Failure: Error, Equatable {
    public let status: OSStatus
  }

  private static let service = "com.opensteer.passwords"
  private let accessGroup: String

  /// `accessGroup` is `<TeamID>.com.opensteer.passwords`, compiled in.
  public init(accessGroup: String) {
    self.accessGroup = accessGroup
  }

  public func read(_ name: ProtectedName) throws -> Data? {
    var query = item(name)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw Self.failure(status) }
    return data
  }

  public func write(_ name: ProtectedName, _ data: Data) throws {
    let status = SecItemUpdate(item(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecSuccess { return }
    guard status == errSecItemNotFound else { throw Self.failure(status) }
    var attributes = item(name)
    attributes[kSecValueData as String] = data
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let added = SecItemAdd(attributes as CFDictionary, nil)
    guard added == errSecSuccess else { throw Self.failure(added) }
  }

  public func delete(_ name: ProtectedName) throws {
    let status = SecItemDelete(item(name) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.failure(status) }
  }

  /// `errSecInteractionNotAllowed` is how the keychain says the Mac has not
  /// been unlocked since it started; nothing is wrong with the item.
  private static func failure(_ status: OSStatus) -> Error {
    status == errSecInteractionNotAllowed ? NotUnlockedSinceRestart() : Failure(status: status)
  }

  private func item(_ name: ProtectedName) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecUseDataProtectionKeychain as String: true,
      kSecAttrAccessGroup as String: accessGroup,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: name.rawValue,
      kSecAttrSynchronizable as String: false,
    ]
  }
}
