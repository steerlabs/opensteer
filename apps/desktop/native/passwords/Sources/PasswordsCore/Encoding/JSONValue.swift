import Foundation

/// The JSON subset every vault format uses: no floating-point numbers.
///
/// Objects are unordered here; `CanonicalJSON.encode` sorts their keys.
/// Swift's `String ==` treats canonically equivalent strings as equal, so code
/// that must compare secrets exactly compares `utf8` bytes, never `JSONValue`s.
public enum JSONValue: Sendable, Equatable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case integer(Int64)
  case bool(Bool)
  case null
}

public enum JSONError: Error, Equatable, Sendable {
  case invalidUTF8
  case syntax(offset: Int)
  case duplicateKey(String)
  case nonInteger(offset: Int)
  case integerOutOfRange
  case tooDeep
  /// More array elements or values than the caller allows (`CanonicalJSON.parse(_:maxArrayCount:maxValues:)`).
  case arrayTooLong
  case tooManyValues
  case trailingData(offset: Int)
  case notCanonical
  /// The JSON is well formed but not the expected shape.
  case shape(String)
}

/// Reads a JSON object whose key set must be exactly `keys`.
///
/// Every vault format is closed: an unknown key means a format this build
/// does not understand, so it is an error rather than something to skip. The
/// broker reads its socket frames and the import worker's answer the same way.
public struct StrictObject {
  public let fields: [String: JSONValue]

  public init(_ value: JSONValue, keys: Set<String>, context: String) throws {
    guard case .object(let fields) = value else {
      throw JSONError.shape("\(context) is not an object")
    }
    guard Set(fields.keys) == keys else {
      throw JSONError.shape("\(context) has keys \(fields.keys.sorted()), expected \(keys.sorted())")
    }
    self.fields = fields
  }

  public func value(_ key: String) throws -> JSONValue {
    guard let value = fields[key] else { throw JSONError.shape("missing \(key)") }
    return value
  }

  public func string(_ key: String) throws -> String {
    guard case .string(let value) = try value(key) else { throw JSONError.shape("\(key) is not a string") }
    return value
  }

  public func optionalString(_ key: String) throws -> String? {
    switch try value(key) {
    case .null: return nil
    case .string(let value): return value
    default: throw JSONError.shape("\(key) is not a string or null")
    }
  }

  public func integer(_ key: String) throws -> Int64 {
    guard case .integer(let value) = try value(key) else { throw JSONError.shape("\(key) is not an integer") }
    return value
  }

  public func array(_ key: String) throws -> [JSONValue] {
    guard case .array(let value) = try value(key) else { throw JSONError.shape("\(key) is not an array") }
    return value
  }

  public func bytes(_ key: String) throws -> Data {
    guard let data = Base64URL.decode(try string(key)) else { throw JSONError.shape("\(key) is not base64url") }
    return data
  }
}

/// The `v` field every vault format carries, checked before the key set so an
/// unknown version reports as one rather than as an unexpected shape.
func formatVersion(of value: JSONValue) -> Int64? {
  guard case .object(let fields) = value, case .integer(let version)? = fields["v"] else { return nil }
  return version
}
