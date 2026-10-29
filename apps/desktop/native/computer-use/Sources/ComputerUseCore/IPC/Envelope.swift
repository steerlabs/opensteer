import Foundation

/// `{id, method, params, timeoutMs?}` — every message the peer sends (§2 "IPC").
public struct RequestEnvelope: Decodable, Sendable {
  public let id: JSONValue
  public let method: String
  public let params: JSONValue
  /// The time left for this request, counted from when it arrived. The Host's
  /// one deadline, carried down every hop.
  public let timeoutMs: JSONValue?

  /// `computerUseMaxTimeoutMs` in the protocol.
  public static let maxTimeoutMs = 120_000

  private enum CodingKeys: String, CodingKey {
    case id, method, params, timeoutMs
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decodeIfPresent(JSONValue.self, forKey: .id) ?? .null
    method = try container.decode(String.self, forKey: .method)
    params = try container.decodeIfPresent(JSONValue.self, forKey: .params) ?? .object([:])
    timeoutMs = try container.decodeIfPresent(JSONValue.self, forKey: .timeoutMs)
  }

  public init(id: JSONValue, method: String, params: JSONValue, timeoutMs: Int? = nil) {
    self.id = id
    self.method = method
    self.params = params
    self.timeoutMs = timeoutMs.map { .number(Double($0)) }
  }

  /// When this request's time runs out, given when it arrived. A value the
  /// protocol does not allow is refused with the request's own id rather than
  /// dropped with the whole frame.
  public func deadline(receivedAt: Date) throws -> Date? {
    guard let timeoutMs else { return nil }
    guard case .number(let value) = timeoutMs, value == value.rounded(), value >= 1,
      value <= Double(Self.maxTimeoutMs)
    else {
      throw HelperError(
        .failed, "timeoutMs must be a whole number of milliseconds from 1 to 120000.")
    }
    return receivedAt.addingTimeInterval(value / 1_000)
  }

  /// The parameters as the method's own type. A shape the method does not
  /// understand is `failed`, never a crash.
  public func decodeParams<T: Decodable>(_ type: T.Type, method: String) throws -> T {
    do {
      return try params.decoded(as: T.self)
    } catch {
      throw HelperError(.failed, "The parameters for \(method) were not in the expected shape.")
    }
  }
}

/// `{id, result}` or `{id, error: {code, message}}` (§2 "IPC").
public struct ResponseEnvelope: Encodable {
  public struct ErrorBody: Encodable {
    public let code: HelperErrorCode
    public let message: String
  }

  public let id: JSONValue
  public let result: AnyEncodable?
  public let error: ErrorBody?

  private enum CodingKeys: String, CodingKey {
    case id, result, error
  }

  public static func success(id: JSONValue, result: some Encodable) -> ResponseEnvelope {
    ResponseEnvelope(id: id, result: AnyEncodable(result), error: nil)
  }

  public static func failure(id: JSONValue, error: HelperError) -> ResponseEnvelope {
    ResponseEnvelope(
      id: id,
      result: nil,
      error: ErrorBody(code: error.code, message: error.message)
    )
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    if let result { try container.encode(result, forKey: .result) }
    if let error { try container.encode(error, forKey: .error) }
  }
}

/// `{event, params}` — sent by the helper for a session it holds (§2 "IPC").
public struct EventEnvelope: Encodable {
  public let event: String
  public let params: AnyEncodable

  public init(event: String, params: some Encodable) {
    self.event = event
    self.params = AnyEncodable(params)
  }
}

/// The events the helper sends for a session the connection holds.
public enum HelperEvent {
  public static let sessionStopped = "session.stopped"
}

/// Why a session ended without `session.close`.
public enum SessionStoppedReason: String, Encodable, Sendable {
  case user
  case appQuit = "app-quit"
}

public struct SessionStoppedParams: Encodable, Sendable {
  public let reason: SessionStoppedReason
  public let sessionId: String
}
