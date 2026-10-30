import Foundation

public enum DictationError: String, Codable, Error, Sendable {
  case permissionDenied = "permission-denied", busy
  case microphoneUnavailable = "microphone-unavailable", modelUnavailable = "model-unavailable"
  case downloadFailed = "download-failed", recognitionFailed = "recognition-failed"
  case serviceUnavailable = "service-unavailable"
}
public enum DictationEndReason: String, Codable, Sendable {
  case completed, cancelled, interrupted, deviceChanged = "device-changed", failed
}
public enum DictationMicrophone: String, Codable, Sendable { case undetermined, granted, denied }
public enum DictationUnavailableReason: String, Codable, Sendable { case platform, os, hardware, language, restricted }
public enum DictationModel: String, Codable, Sendable { case installed, download }

public enum DictationAvailability: Codable, Sendable, Equatable {
  case unavailable(DictationUnavailableReason)
  case available(locale: String, languageName: String, model: DictationModel, microphone: DictationMicrophone)
  private enum CodingKeys: String, CodingKey { case available, reason, locale, languageName, model, microphone }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .unavailable(let reason):
      try c.encode(false, forKey: .available); try c.encode(reason, forKey: .reason)
    case let .available(locale, languageName, model, microphone):
      try c.encode(true, forKey: .available); try c.encode(locale, forKey: .locale)
      try c.encode(languageName, forKey: .languageName); try c.encode(model, forKey: .model)
      try c.encode(microphone, forKey: .microphone)
    }
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    if try c.decode(Bool.self, forKey: .available) {
      self = .available(locale: try c.decode(String.self, forKey: .locale), languageName: try c.decode(String.self, forKey: .languageName), model: try c.decode(DictationModel.self, forKey: .model), microphone: try c.decode(DictationMicrophone.self, forKey: .microphone))
    } else { self = .unavailable(try c.decode(DictationUnavailableReason.self, forKey: .reason)) }
  }
}

public struct DictationEvent: Codable, Sendable, Equatable {
  public enum Payload: Sendable, Equatable {
    case downloading(Double?), listening, text(finalized: [String], volatile: [String]), level(Double)
    case ended(DictationEndReason, DictationError?)
  }
  public let session: String
  public let seq: Int
  public let payload: Payload
  public init(session: String, seq: Int, payload: Payload) { self.session = session; self.seq = seq; self.payload = payload }
  private enum CodingKeys: String, CodingKey { case session, seq, type, progress, finalized, volatile, level, reason, error }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(session, forKey: .session); try c.encode(seq, forKey: .seq)
    switch payload {
    case .downloading(let progress):
      try c.encode("downloading", forKey: .type); try c.encode(progress, forKey: .progress)
    case .listening: try c.encode("listening", forKey: .type)
    case let .text(finalized, volatile):
      try c.encode("text", forKey: .type); try c.encode(finalized, forKey: .finalized); try c.encode(volatile, forKey: .volatile)
    case .level(let level): try c.encode("level", forKey: .type); try c.encode(level, forKey: .level)
    case let .ended(reason, error):
      try c.encode("ended", forKey: .type); try c.encode(reason, forKey: .reason); try c.encode(error, forKey: .error)
    }
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    session = try c.decode(String.self, forKey: .session); seq = try c.decode(Int.self, forKey: .seq)
    switch try c.decode(String.self, forKey: .type) {
    case "downloading": payload = .downloading(try c.decodeIfPresent(Double.self, forKey: .progress))
    case "listening": payload = .listening
    case "text": payload = .text(finalized: try c.decode([String].self, forKey: .finalized), volatile: try c.decode([String].self, forKey: .volatile))
    case "level": payload = .level(try c.decode(Double.self, forKey: .level))
    case "ended": payload = .ended(try c.decode(DictationEndReason.self, forKey: .reason), try c.decodeIfPresent(DictationError.self, forKey: .error))
    default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown dictation event")
    }
  }
}

public func dictationJSON<T: Encodable>(_ value: T) throws -> String {
  let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
  return String(decoding: try encoder.encode(value), as: UTF8.self)
}

func validateSession(_ session: String) throws {
  guard session.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil else {
    throw DictationError.serviceUnavailable
  }
}
