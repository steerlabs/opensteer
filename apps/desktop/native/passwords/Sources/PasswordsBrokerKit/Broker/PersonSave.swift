import Foundation
import PasswordsCore

/// A login the person typed into a page, exactly as typed. Only `save.begin`
/// makes one, and only for an origin the vault's write rules accept.
struct CapturedLogin: Sendable {
  let origin: String
  /// `https://<registrable domain>`: the scope release uses, ports ignored.
  let site: String
  let username: String
  let password: String
  let expiresAt: Date

  var siteHost: String { String(site.dropFirst("https://".count)) }

  init?(_ params: Wire.SaveBeginParams, expiresAt: Date) {
    guard WireRules.origin(params.origin), let host = URL(string: params.origin)?.host,
      let domain = Origins.registrableDomain(host)
    else { return nil }
    origin = params.origin
    site = "https://" + domain
    username = params.username
    password = params.password
    self.expiresAt = expiresAt
    guard (try? draft.validate()) != nil else { return nil }
  }

  /// The one login a save adds: no label, code, passkey or grant.
  var draft: ItemDraft {
    ItemDraft(origins: [origin], loginURL: origin + "/", username: username, password: password)
  }
}

/// A typed login the broker holds for one connection until the person
/// answers, it expires, or the Mac locks or sleeps. Swift strings cannot be
/// wiped, so the login is let go as soon as the save ends.
@MainActor
final class HeldSave {
  enum Stage { case checking, offered, committing }
  let id: String
  let connectionID: Int
  let expiresAt: Date
  var login: CapturedLogin?
  var stage = Stage.checking
  let authority = TransactionAuthority()
  var expiry: DispatchWorkItem?

  init(id: String, connectionID: Int, login: CapturedLogin) {
    self.id = id
    self.connectionID = connectionID
    self.expiresAt = login.expiresAt
    self.login = login
  }
}
