import Foundation

/// A JSON value carried verbatim.
///
/// The helper echoes a request's `id` back exactly as the peer sent it rather
/// than re-typing it, and decodes typed `params` in a second pass, so the wire
/// shape never depends on this process's idea of what a number is.
public enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else if let value = try? container.decode([String: JSONValue].self) {
      self = .object(value)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON.")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }

  /// A value as the wire will carry it, encoded the one way this process encodes.
  public init(encoding value: some Encodable) throws {
    self = try JSONCoding.decoder.decode(JSONValue.self, from: JSONCoding.encoder.encode(value))
  }

  /// The value as it would arrive at a `Decodable` type.
  public func decoded<T: Decodable>(as type: T.Type) throws -> T {
    let data = try JSONCoding.encoder.encode(self)
    return try JSONCoding.decoder.decode(T.self, from: data)
  }

  public var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }
}

/// One encoder and one decoder for the whole process, configured the same way
/// everywhere so a result shape cannot depend on which call site built it.
public enum JSONCoding {
  public static let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return encoder
  }()

  public static let decoder = JSONDecoder()
}

/// An `Encodable` value whose static type the envelope does not need to know.
public struct AnyEncodable: Encodable {
  private let write: (any Encoder) throws -> Void

  public init(_ value: some Encodable) {
    write = { encoder in try value.encode(to: encoder) }
  }

  public func encode(to encoder: any Encoder) throws {
    try write(encoder)
  }
}
