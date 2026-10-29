import CoreGraphics
import Foundation

/// The parameter and result shapes of the helper protocol.
///
/// `packages/protocol/src/computer-use.ts` is the source of truth for every
/// name here. The Runner's strict schemas reject extra keys before a request
/// reaches the helper. `Tests/Fixtures/helper-wire.json` is written from these
/// types so the two sides cannot drift apart quietly.
enum Wire {
  /// Every agent observation explicitly chooses whether its engine needs an image.
  static func screenshotDecision(_ requested: Bool?) throws -> Bool {
    if let requested { return requested }
    throw HelperError(
      .failed, "An observation must choose whether to capture a screenshot.")
  }

  struct HelloParams: Decodable {
    let loginText: Int?
    let ownerViewVersion: Int?
    var ownerInputVersion: Int? = nil
    let protocolVersion: Int
    let clientVersion: String?
  }

  struct HelloResult: Encodable {
    var loginText: LoginReceiverKey? = nil
    var ownerViewVersion: Int? = nil
    var ownerInputVersion: Int? = nil
    let helperVersion: String
    let minProtocolVersion: Int
    let permissions: PermissionsState
    let protocolVersion: Int
    /// Which delivery routes this build actually has. `windowLocation` is
    /// false when `CGEventSetWindowLocation` could not be resolved, and then
    /// `click` and `scroll` answer `unsupported` (§2 "Actions"). Optional in
    /// the schema, always sent by this helper.
    let routes: Routes

    struct Routes: Encodable {
      let windowLocation: Bool
      let windowGroups: Bool
    }
  }

  struct ViewParams: Decodable {
    let viewId: String
    let generation: Int
    let leaseDurationMs: Int
    let target: ViewTarget?
    let app: AppIdentity?

    struct ViewTarget: Decodable {
      let kind: String
      let app: AppIdentity
      let window: CGWindowID?
    }

  }

  struct ViewStateResult: Encodable {
    let viewId: String
    let generation: Int
    let state: String
    let captureTargetId: String?
    var window: OwnerWindowSummary? = nil

    struct OwnerWindowSummary: Encodable {
      let id: CGWindowID
      let title: String
    }

    func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(viewId, forKey: .viewId)
      try c.encode(generation, forKey: .generation)
      try c.encode(state, forKey: .state)
      try c.encode(captureTargetId, forKey: .captureTargetId)
      try c.encodeIfPresent(window, forKey: .window)
    }
    private enum CodingKeys: CodingKey { case viewId, generation, state, captureTargetId, window }
  }

  struct ViewUnavailableResult: Encodable {
    let viewId: String
    let generation: Int
    let kind: String
    let reason: String
  }

  struct PermissionsResult: Encodable {
    let permissions: PermissionsState
  }

  /// Requests name exactly the grant the person is currently setting up.
  struct PermissionsRequestParams: Decodable {
    let pane: PermissionPane?

    func validatedPane() throws -> PermissionPane {
      guard let pane else {
        throw HelperError(.failed, "A permission request must name one macOS grant.")
      }
      return pane
    }

    private enum CodingKeys: String, CodingKey { case pane }

    init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      pane = try container.decodeIfPresent(PermissionPane.self, forKey: .pane)
    }
  }

  struct InstalledAppsParams: Decodable, Sendable {
    let query: String
    let limit: Int
    let offset: Int
    let icons: Bool

    private enum CodingKeys: String, CodingKey { case query, limit, offset, icons }

    init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      query = c.contains(.query) ? try c.decode(String.self, forKey: .query) : ""
      limit = c.contains(.limit) ? try c.decode(Int.self, forKey: .limit) : 50
      offset = c.contains(.offset) ? try c.decode(Int.self, forKey: .offset) : 0
      icons = c.contains(.icons) ? try c.decode(Bool.self, forKey: .icons) : false
      guard (1...100).contains(limit), offset >= 0 else {
        throw DecodingError.dataCorruptedError(
          forKey: .limit, in: c,
          debugDescription: "limit must be 1...100 and offset must be nonnegative.")
      }
    }
  }

  struct InstalledAppsResult: Encodable {
    let apps: [InstalledApp]
    let total: Int
  }

  struct ResolveParams: Decodable {
    let app: String
  }

  struct ResolveAppResult: Encodable {
    let app: ResolvedApp
  }

  /// Opening a session is bookkeeping only: the session's id and the task the
  /// person sees on the pill. No app is named until a call targets one.
  struct SessionOpenParams: Decodable {
    let sessionId: String
    let threadTitle: String?
    let runId: String?

    private enum CodingKeys: String, CodingKey { case sessionId, threadTitle, runId }

    init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      sessionId = try c.decode(String.self, forKey: .sessionId)
      runId = c.contains(.runId) ? try c.decode(String.self, forKey: .runId) : nil
      if let runId,
        runId.range(of: LoginEnvelopeCrypto.runPattern, options: .regularExpression) != runId
          .startIndex..<runId.endIndex
      {
        throw LoginEnvelopeCrypto.refusal
      }
      threadTitle = try c.decode(String?.self, forKey: .threadTitle)
      guard (threadTitle?.utf16.count ?? 0) <= 240 else {
        throw DecodingError.dataCorruptedError(
          forKey: .threadTitle, in: c,
          debugDescription: "threadTitle must be at most 240 characters.")
      }
    }
  }

  struct SessionOpenResult: Encodable {
    let sessionId: String
  }

  struct SessionParams: Decodable {
    let sessionId: String
  }

  /// `data.status` and `data.request`: every grant, as it stands now.
  struct DataStatusResult: Encodable {
    let grants: DataGrants
  }

  /// `data.request` names the one grant the person at this Mac is allowing.
  struct DataRequestParams: Decodable {
    let grant: DataGrant
  }

  /// `data.invoke`: one operation of an app the helper serves, with the
  /// access the Host resolved and the contract it expects this build to have.
  struct IMessagePollParams: Decodable, Sendable {
    let accountId: String
    let after: IMessagePosition
    let limit: Int
    let owner: String
  }

  struct IMessageSendParams: Decodable, Sendable {
    let accountId: String
    let key: String
    let owner: String
    let text: String
    let to: String
  }

  struct DataInvokeParams: Codable, Sendable, Equatable {
    let access: DataAccess
    let arguments: [String: JSONValue]
    let contract: String
    let definitionId: String
    let effect: DataEffect
    let operation: String
  }

  struct DataInvokeResult: Encodable {
    let value: JSONValue
  }

  /// `session.close` answers with an empty object, which the schema is strict
  /// about: there is nothing to say beyond the absence of an error.
  struct EmptyResult: Encodable {
    func encode(to encoder: any Encoder) throws {
      _ = encoder.container(keyedBy: NoKeys.self)
    }

    private enum NoKeys: CodingKey {}
  }

  struct WindowsParams: Decodable {
    let sessionId: String
    let app: SessionApp
  }
  struct BindParams: Decodable {
    let sessionId: String
    let app: SessionApp
    let window: CGWindowID?
    private enum CodingKeys: CodingKey { case sessionId, app, window }
    init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      sessionId = try c.decode(String.self, forKey: .sessionId)
      app = try c.decode(SessionApp.self, forKey: .app)
      window = try c.decode(CGWindowID?.self, forKey: .window)
    }
  }
  struct WindowsResult: Encodable { let windows: [WindowInfo] }
  struct BindResult: Encodable { let window: WindowInfo }
  struct OwnerWindowsParams: Decodable { let app: AppIdentity }
  struct OwnerWindowsResult: Encodable { let windows: [OwnerWindowInfo] }

  struct ObserveParams: Decodable {
    let sessionId: String
    let app: SessionApp
    let window: String
    let includeScreenshot: Bool?

    private enum CodingKeys: String, CodingKey { case sessionId, app, window, includeScreenshot }

    init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      sessionId = try c.decode(String.self, forKey: .sessionId)
      app = try c.decode(SessionApp.self, forKey: .app)
      window = try c.decode(String.self, forKey: .window)
      guard (1...128).contains(window.utf16.count) else {
        throw HelperError(.failed, "Name a window from this session.")
      }
      includeScreenshot = try c.decodeIfPresent(Bool.self, forKey: .includeScreenshot)
    }
  }

  struct ActParams: Decodable {
    let sessionId: String
    let app: SessionApp
    let window: String
    let snapshot: String?
    let actions: [ActionRequest]
    let loginContext: LoginActContext?

    private enum CodingKeys: String, CodingKey {
      case sessionId, app, window, snapshot, actions, loginContext
    }

    init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      sessionId = try c.decode(String.self, forKey: .sessionId)
      app = try c.decode(SessionApp.self, forKey: .app)
      window = try c.decode(String.self, forKey: .window)
      guard (1...128).contains(window.utf16.count) else {
        throw HelperError(.failed, "Name a window from this session.")
      }
      snapshot = try c.decode(String?.self, forKey: .snapshot)
      actions = try c.decode([ActionRequest].self, forKey: .actions)
      loginContext =
        c.contains(.loginContext) ? try c.decode(LoginActContext.self, forKey: .loginContext) : nil
      guard (1...32).contains(actions.count) else { throw LoginEnvelopeCrypto.refusal }
      for (index, action) in actions.enumerated() {
        guard case .savedText(let envelope, _) = action else { continue }
        guard case .object(let raw) = try JSONValue(from: decoder),
          Set(raw.keys).isSubset(of: [
            "sessionId", "app", "window", "snapshot", "actions", "loginContext",
          ])
        else { throw LoginEnvelopeCrypto.refusal }
        guard let loginContext, envelope.binding.runId == loginContext.runId,
          envelope.binding.actId == loginContext.actId, envelope.binding.sessionId == sessionId,
          envelope.binding.actionIndex == index
        else { throw LoginEnvelopeCrypto.refusal }
      }
      guard snapshot.map({ (1...64).contains($0.utf16.count) }) ?? true else {
        throw DecodingError.dataCorruptedError(
          forKey: .snapshot, in: c,
          debugDescription: "snapshot must contain 1...64 characters.")
      }
    }
  }

  /// Only observe captures the app; act returns receipts.
  struct ObservationResult: Encodable {
    let observation: Observation
  }

  /// An action batch always reports how far it got: one sentence per fully
  /// completed action, in order. Once any action may have changed the app,
  /// failures are results rather than error envelopes so the caller receives
  /// receipts and never retries the batch blind.
  struct ActResult: Encodable {
    let performed: [String]
    let error: Failure?

    struct Failure: Encodable {
      let code: HelperErrorCode
      let message: String

      init(_ error: HelperError) {
        code = error.code
        message = error.message
      }
    }

    func encode(to encoder: any Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(performed, forKey: .performed)
      try container.encode(error, forKey: .error)
    }

    private enum CodingKeys: String, CodingKey {
      case performed, error
    }
  }
}
