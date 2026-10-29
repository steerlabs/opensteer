import MacOSSigning
import Darwin
import Foundation
import Security

/// Invariant 2: the helper trusts one peer, **by audit token**. Verification
/// runs on the accepted socket before the first frame — including `hello` — is
/// read, and a peer that fails it is closed without a response, because an
/// answer is itself information.
///
/// The audit token, not the pid, is what identifies the peer: a pid can be
/// reused between the moment the kernel reports it and the moment the code is
/// looked up, and the token names the exact process the socket came from.
public struct PeerVerifier: Sendable {
  /// `SOL_LOCAL`, `LOCAL_PEERCRED` and `LOCAL_PEERTOKEN` from `<sys/un.h>`,
  /// spelled out so a change in how Darwin's macros import cannot silently
  /// change which option this asks for.
  private static let solLocal: Int32 = 0
  private static let localPeerCred: Int32 = 0x001
  private static let localPeerToken: Int32 = 0x006

  private let mode: PeerRequirementMode

  public init(mode: PeerRequirementMode) {
    self.mode = mode
  }

  public func verify(fileDescriptor: Int32) -> Bool {
    switch mode {
    case .refuse: return false
    case .sameUser:
      return verifySameUser(fileDescriptor: fileDescriptor)
    case .codeRequirement(let text):
      return verifyCode(fileDescriptor: fileDescriptor, requirement: text)
    }
  }

  /// A development build accepts only a process running as this same user.
  private func verifySameUser(fileDescriptor: Int32) -> Bool {
    var credentials = xucred()
    var size = socklen_t(MemoryLayout<xucred>.size)
    let status = withUnsafeMutablePointer(to: &credentials) { pointer in
      getsockopt(fileDescriptor, Self.solLocal, Self.localPeerCred, pointer, &size)
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

  /// A release build requires the peer's *code* to satisfy the designated
  /// requirement compiled in at build time. Process ancestry and "signed by our
  /// team" are both explicitly not enough (invariant 2).
  private func verifyCode(fileDescriptor: Int32, requirement text: String) -> Bool {
    var token = audit_token_t()
    var size = socklen_t(MemoryLayout<audit_token_t>.size)
    let status = withUnsafeMutablePointer(to: &token) { pointer in
      getsockopt(fileDescriptor, Self.solLocal, Self.localPeerToken, pointer, &size)
    }
    guard status == 0, size == socklen_t(MemoryLayout<audit_token_t>.size) else {
      Log.peer.error("Could not read the peer's audit token.")
      return false
    }

    let tokenData = withUnsafeBytes(of: &token) { Data($0) }
    let attributes = [kSecGuestAttributeAudit: tokenData as CFData] as CFDictionary
    var guest: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
      let guest
    else {
      Log.peer.error("Refused a connection whose code could not be identified.")
      return false
    }

    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
      let requirement
    else {
      // A requirement the helper cannot even compile is a broken build; it
      // refuses every peer rather than accepting any.
      Log.peer.fault("The compiled peer requirement is not a valid requirement string.")
      return false
    }

    guard SecCodeCheckValidity(guest, [], requirement) == errSecSuccess else {
      Log.peer.error("Refused a connection that does not satisfy the peer requirement.")
      return false
    }
    return true
  }
}

/// The desktop's reverse check of the already-connected helper socket. The
/// requirement is compiled here and the descriptor is inherited, so neither a
/// path nor a requirement string can be supplied by the process being checked.
public enum HelperPeerVerifier {
  public static let inheritedSocketDescriptor: Int32 = 3
  /// The released helper, and only the released helper: Apple's anchor, the
  /// Developer ID intermediate (`1.2.840.113635.100.6.2.6`) and a Developer
  /// ID Application leaf (`1.2.840.113635.100.6.1.13`) of Opensteer's team.
  /// Without the two markers any certificate of the team would pass —
  /// including an Apple Development one any team member's Mac holds.
  public static var releaseRequirement: String? {
    MacCodeIdentity.requirement(teamId: MacCodeIdentity.ownTeamId(), identifiers: ["com.opensteer.computer-use"])
  }

  static func policy(teamId: String?) -> PeerRequirementMode {
    guard let text = MacCodeIdentity.requirement(teamId: teamId, identifiers: ["com.opensteer.computer-use"])
    else { return .refuse }
    return .codeRequirement(text)
  }

  public static func verifyInheritedSocket() -> Bool {
    #if OPENSTEER_DEV_TRUST
    let mode: PeerRequirementMode = .sameUser
    #else
    let mode = policy(teamId: MacCodeIdentity.ownTeamId())
    #endif
    return PeerVerifier(mode: mode).verify(fileDescriptor: inheritedSocketDescriptor)
  }
}
