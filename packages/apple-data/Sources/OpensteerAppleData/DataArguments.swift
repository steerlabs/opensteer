import Foundation

/// A field a change may leave as it is, clear with `null`, or set.
public enum Patch<Value: Decodable & Sendable & Equatable>: Sendable, Equatable {
  case keep
  case clear
  case set(Value)

  func applied(to current: Value?) -> Value? {
    switch self {
    case .keep: return current
    case .clear: return nil
    case .set(let value): return value
    }
  }
}

extension Patch: Decodable {
  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    self = container.decodeNil() ? .clear : .set(try container.decode(Value.self))
  }
}

extension KeyedDecodingContainer {
  /// An absent key keeps the field, which a synthesized decoder cannot say.
  func decode<Value>(_ type: Patch<Value>.Type, forKey key: Key) throws -> Patch<Value> {
    contains(key) ? try decodeIfPresent(type, forKey: key) ?? .clear : .keep
  }
}

/// An operation's arguments, which the Host validated against the catalog's
/// schema; each app checks again what it relies on.
public enum DataArguments {
  public static func decode<T: Decodable>(_ type: T.Type, from arguments: [String: JSONValue]) throws -> T {
    do {
      return try JSONValue.object(arguments).decoded(as: type)
    } catch let error as HelperError {
      throw error
    } catch {
      throw HelperError(.failed, "These arguments could not be read.")
    }
  }

  static func title(_ text: String) throws -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw HelperError(.failed, "title must not be empty.") }
    return trimmed
  }

  /// A link as Calendar and Reminders keep it: absolute, with a scheme.
  static func url(_ text: String?) throws -> String? {
    guard let text = DataText.present(text) else { return nil }
    guard let url = URL(string: text), url.scheme?.isEmpty == false else {
      throw HelperError(.failed, "url must be a full URL, such as https://example.com.")
    }
    return text
  }

  /// Notes cut when read cannot be written back whole, so they are left alone.
  static func notes(
    _ patch: Patch<String>, current: String?, limit: Int, noun: String
  ) throws -> String? {
    if patch != .keep, (current?.count ?? 0) > limit {
      throw HelperError(
        .failed,
        "This \(noun)'s notes are longer than \(limit.formatted(.number.locale(Locale(identifier: "en_US")))) characters, so they cannot be changed here."
      )
    }
    return DataText.present(patch.applied(to: current))
  }
}
