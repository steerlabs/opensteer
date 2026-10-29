import CoreGraphics
import Foundation

/// The tree text of §2 "Observation": one element per line, indented by depth —
/// `[12] button "Save" (412,88 96×28)`.
public enum TreeFormatter {
  /// `computerUseTreeMaxBytes`: the smallest tool-output limit of the engines
  /// an agent runs on, in UTF-8 bytes of the tree text. An engine that cuts a
  /// longer result drops the middle, and the model then acts on a tree it
  /// cannot tell is incomplete — so the helper cuts, from the end, and says so.
  public static let maxBytes = 32_000
  static let valueLimit = 200

  public struct Rendered {
    public let text: String
    /// Elements named in the text. Indices beyond it were never shown and
    /// are not accepted as targets.
    public let elementCount: Int
    public let truncated: Bool
  }

  public static func render(
    _ walk: WalkResult,
    coordinates: ObservationCoordinates,
    maxBytes: Int = maxBytes
  ) -> Rendered {
    let lines = walk.elements.enumerated().map { index, element in
      line(index: index, element: element, coordinates: coordinates)
    }
    // Lines are kept from the start while they and the closing note fit. The
    // walk put what matters first, so the end is what goes.
    var kept = 0
    var used = 0
    while kept < lines.count {
      let next = used + (kept == 0 ? 0 : 1) + lines[kept].utf8.count
      let closing = closingLine(
        omitted: walk.omitted + lines.count - kept - 1, incomplete: walk.incomplete)
      let total = next + (closing.map { 1 + $0.utf8.count } ?? 0)
      guard total <= maxBytes else { break }
      used = next
      kept += 1
    }
    let omitted = walk.omitted + lines.count - kept
    var text = lines.prefix(kept).joined(separator: "\n")
    if let closing = closingLine(omitted: omitted, incomplete: walk.incomplete) {
      text += text.isEmpty ? closing : "\n" + closing
    }
    return Rendered(
      text: text,
      elementCount: kept,
      truncated: omitted > 0 || walk.incomplete
    )
  }

  /// The last line when anything was left out, saying how much and why.
  static func closingLine(omitted: Int, incomplete: Bool) -> String? {
    switch (omitted > 0, incomplete) {
    case (false, false):
      return nil
    case (true, false):
      return "… \(omitted) more elements not shown; act on what you see or scroll."
    case (false, true):
      return "… this app answered too slowly, so the rest of it is not shown; "
        + "act on what you see or observe again."
    case (true, true):
      return "… \(omitted) more elements not shown, and this app answered too slowly for "
        + "the rest of it to be read; act on what you see or observe again."
    }
  }

  public static func line(
    index: Int, element: ObservedElement, coordinates: ObservationCoordinates
  ) -> String {
    let attributes = element.attributes
    var parts = String(repeating: "  ", count: element.depth)
    parts += "[\(index)] \(role(attributes))"
    if let label = label(attributes) {
      parts += " \"\(label)\""
    }
    let frame = coordinates.pixelFrame(from: element.frame)
    parts +=
      " (\(number(frame.origin.x)),\(number(frame.origin.y))"
      + " \(number(frame.width))×\(number(frame.height)))"
    if !attributes.enabled { parts += " (disabled)" }
    if attributes.focused { parts += " (focused)" }
    return parts
  }

  /// `AXButton` → `button`. An unprefixed role is left as it is. A subrole
  /// that names what the element really is — a search field, a switch, a
  /// dialog — is used instead of its generic role.
  static func role(_ attributes: ElementAttributes) -> String {
    if let subrole = attributes.subrole, namedSubroles.contains(subrole) {
      return role(subrole)
    }
    return role(attributes.role)
  }

  static let namedSubroles: Set<String> = [
    "AXSearchField", "AXSecureTextField", "AXSwitch", "AXToggle", "AXDialog",
    "AXSystemDialog",
  ]

  static func role(_ raw: String) -> String {
    let trimmed = raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
    return trimmed.isEmpty ? "element" : trimmed.lowercased()
  }

  /// The title, or the value when there is no title (§2), else the
  /// description. Each is flattened to one line and cut at 200 characters,
  /// because a tree is for aiming, not for reading a document out of.
  static func label(_ attributes: ElementAttributes) -> String? {
    if ActionReceipt.isSecure(attributes) { return "Secure text field" }
    for candidate in [attributes.title, attributes.value, attributes.help] {
      guard let candidate else { continue }
      let clean = sanitize(candidate)
      if !clean.isEmpty { return clean }
    }
    return nil
  }

  static func sanitize(_ raw: String) -> String {
    var value =
      raw
      .replacingOccurrences(of: "\r\n", with: " ")
      .replacingOccurrences(of: "\n", with: " ")
      .replacingOccurrences(of: "\r", with: " ")
      .replacingOccurrences(of: "\t", with: " ")
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
      .trimmingCharacters(in: .whitespaces)
    if value.count > valueLimit {
      value = String(value.prefix(valueLimit)) + "…"
    }
    return value
  }

  /// Frames are in screenshot pixels and read by a model, so they are whole numbers.
  static func number(_ value: CGFloat) -> String {
    String(Int(value.rounded()))
  }
}
