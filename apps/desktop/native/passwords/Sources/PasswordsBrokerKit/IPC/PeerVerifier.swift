import Darwin
import Foundation
import Security

/// Who may be on the other end of a socket. The value a build uses is
/// compiled into the executable by `build-passwords-broker.ts`; nothing
/// reads it from a file, a default or the environment at run time.
public enum PeerRule: Sendable, Equatable {
  /// A code-signing requirement, checked against the peer's audit token.
  case codeRequirement(String)
  /// A development build: any process running as this same user.
  case sameUser
}

/// Checks a connected Unix socket's peer before a byte is read from it.
///
/// The audit token, not the pid, identifies the peer: a pid can be reused
/// between the moment the kernel reports it and the moment its code is
/// looked up, and the token names the exact process the socket came from.
public struct PeerVerifier: Sendable {
  /// `SOL_LOCAL`, `LOCAL_PEERCRED` and `LOCAL_PEERTOKEN` from `<sys/un.h>`,
  /// spelled out so a change in how Darwin's macros import cannot silently
  /// change which option this asks for.
  private static let solLocal: Int32 = 0
  private static let localPeerCred: Int32 = 0x001
  private static let localPeerToken: Int32 = 0x006

  public let rule: PeerRule

  public init(rule: PeerRule) {
    self.rule = rule
  }

  public func verify(fileDescriptor: Int32) -> Bool {
    switch rule {
    case .sameUser: return Self.isSameUser(fileDescriptor)
    case .codeRequirement(let text): return Self.satisfies(fileDescriptor, requirement: text)
    }
  }

  private static func isSameUser(_ descriptor: Int32) -> Bool {
    var credentials = xucred()
    var size = socklen_t(MemoryLayout<xucred>.size)
    let status = withUnsafeMutablePointer(to: &credentials) { pointer in
      getsockopt(descriptor, solLocal, localPeerCred, pointer, &size)
    }
    guard status == 0, credentials.cr_version == UInt32(XUCRED_VERSION) else {
      Log.peer.error("Could not read the peer's credentials.")
      return false
    }
    guard credentials.cr_uid == getuid() else {
      Log.peer.error("Refused a connection from another user.")
      return false
    }
    return true
  }

  private static func satisfies(_ descriptor: Int32, requirement text: String) -> Bool {
    var token = audit_token_t()
    var size = socklen_t(MemoryLayout<audit_token_t>.size)
    let status = withUnsafeMutablePointer(to: &token) { pointer in
      getsockopt(descriptor, solLocal, localPeerToken, pointer, &size)
    }
    guard status == 0, size == socklen_t(MemoryLayout<audit_token_t>.size) else {
      Log.peer.error("Could not read the peer's audit token.")
      return false
    }
    let tokenData = withUnsafeBytes(of: &token) { Data($0) }
    let attributes = [kSecGuestAttributeAudit: tokenData as CFData] as CFDictionary
    var guest: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess, let guest else {
      Log.peer.error("Refused a peer whose code could not be identified.")
      return false
    }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else {
      // A requirement the broker cannot compile is a broken build; it refuses
      // every peer rather than accepting any.
      Log.peer.fault("The compiled peer requirement is not a valid requirement string.")
      return false
    }
    guard SecCodeCheckValidity(guest, [], requirement) == errSecSuccess else {
      Log.peer.error("Refused a peer that does not satisfy the requirement.")
      return false
    }
    return true
  }
}

/// `--verify-peer`: the desktop's reverse check. The desktop connects to the
/// broker's socket and runs the broker sealed inside its own app with that
/// connection as descriptor 3; this exits 0 only when the process serving the
/// socket is this build's broker. Neither a path nor a requirement can be
/// supplied by the process being checked.
public enum InheritedSocketVerifier {
  public static let argument = "--verify-peer"
  public static let descriptor: Int32 = 3

  public static func verify(rule: PeerRule, descriptor: Int32 = descriptor) -> Bool {
    var information = stat()
    guard fstat(descriptor, &information) == 0, information.st_mode & S_IFMT == S_IFSOCK else {
      Log.peer.error("The inherited descriptor is not a socket.")
      return false
    }
    return PeerVerifier(rule: rule).verify(fileDescriptor: descriptor)
  }
}
