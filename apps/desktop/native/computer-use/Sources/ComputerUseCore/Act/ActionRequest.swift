import CoreGraphics
import Foundation

public enum MouseButton: String, Decodable, Sendable {
  case left
  case right
  case middle
}

public enum ScrollDirection: String, Decodable, Sendable {
  case up
  case down
  case left
  case right
}

/// `{index}` — an element from the cited observation — or `{x, y}`, a point in
/// screenshot pixels.
public enum ActionTarget: Decodable, Sendable {
  case index(Int)
  case point(CGPoint)

  private enum CodingKeys: String, CodingKey {
    case index, x, y
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let index = try container.decodeIfPresent(Int.self, forKey: .index) {
      self = .index(index)
      return
    }
    let x = try container.decode(Int.self, forKey: .x)
    let y = try container.decode(Int.self, forKey: .y)
    guard x >= 0, y >= 0 else {
      throw DecodingError.dataCorruptedError(
        forKey: .x, in: container,
        debugDescription: "Coordinates must be nonnegative screenshot pixels.")
    }
    self = .point(CGPoint(x: x, y: y))
  }
}

/// One action of a `session.act` batch (§2 "Actions").
public enum ActionRequest: Decodable, Sendable {
  case click(target: ActionTarget, button: MouseButton, count: Int)
  /// Without a target, text goes to whatever the app has focused after the
  /// earlier actions in the batch; with one, that element is focused first.
  case type(text: String, target: ActionTarget? = nil)
  case savedText(envelope: SealedLoginEnvelope, target: ActionTarget? = nil)
  case key(keys: String)
  case setValue(index: Int, value: String)
  case scroll(target: ActionTarget, direction: ScrollDirection, amount: Int)

  public static let maxClickCount = 3

  private enum CodingKeys: String, CodingKey {
    case type
    case target, button, count
    case text, keys, index, value, direction, amount, ms
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let name = try container.decode(String.self, forKey: .type)

    switch name {
    case "click":
      let count = try container.decodeIfPresent(Int.self, forKey: .count) ?? 1
      self = .click(
        target: try container.decode(ActionTarget.self, forKey: .target),
        button: try container.decodeIfPresent(MouseButton.self, forKey: .button) ?? .left,
        count: min(max(count, 1), Self.maxClickCount)
      )
    case "type":
      let target = try container.decodeIfPresent(ActionTarget.self, forKey: .target)
      if let text = try? container.decode(String.self, forKey: .text) {
        self = .type(text: text, target: target)
      } else {
        let raw = try JSONValue(from: decoder)
        guard case .object(let action) = raw,
          Set(action.keys).isSubset(of: ["type", "text", "target"]),
          case .object(let text) = action["text"], Set(text.keys) == ["sealed"],
          let sealed = text["sealed"]
        else { throw LoginEnvelopeCrypto.refusal }
        if let rawTarget = action["target"] {
          guard case .object(let fields) = rawTarget else { throw LoginEnvelopeCrypto.refusal }
          if Set(fields.keys) == ["index"] {
            _ = try LoginEnvelopeCrypto.integer(fields, "index", min: 0, max: 1_499)
          } else if Set(fields.keys) == ["x", "y"] {
            _ = try LoginEnvelopeCrypto.integer(fields, "x", min: 0)
            _ = try LoginEnvelopeCrypto.integer(fields, "y", min: 0)
          } else {
            throw LoginEnvelopeCrypto.refusal
          }
        }
        self = .savedText(
          envelope: try sealed.decoded(as: SealedLoginEnvelope.self), target: target)
      }
    case "key":
      self = .key(keys: try container.decode(String.self, forKey: .keys))
    case "setValue":
      self = .setValue(
        index: try container.decode(Int.self, forKey: .index),
        value: try container.decode(String.self, forKey: .value)
      )
    case "scroll":
      let amount = try container.decodeIfPresent(Int.self, forKey: .amount) ?? 3
      self = .scroll(
        target: try container.decode(ActionTarget.self, forKey: .target),
        direction: try container.decode(ScrollDirection.self, forKey: .direction),
        amount: min(max(amount, 1), 50)
      )
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .type,
        in: container,
        debugDescription: "Unknown action."
      )
    }
  }

  var requiresSnapshot: Bool {
    switch self {
    case .click, .setValue, .scroll: return true
    case .type(_, let target), .savedText(_, let target): return target != nil
    case .key: return false
    }
  }

  public var label: String {
    switch self {
    case .click: return "click"
    case .type, .savedText: return "type"
    case .key: return "key"
    case .setValue: return "setValue"
    case .scroll: return "scroll"
    }
  }
}
