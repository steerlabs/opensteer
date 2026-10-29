import Foundation

/// Saved login text delivered as keyboard events: runs carried as unicode
/// payloads alone, never as the layout's keys and modifiers.
///
/// The payload of one event is bounded, and a chunk is always cut on a
/// character boundary so an emoji or a combining sequence is never split across
/// two events — which is what would turn it into two broken glyphs in the app.
public enum TextChunker {
  public static let maxUTF16UnitsPerChunk = 20

  public static func chunks(_ text: String, limit: Int = maxUTF16UnitsPerChunk) -> [String] {
    guard limit > 0, !text.isEmpty else { return [] }
    var chunks: [String] = []
    var current = ""
    var currentUnits = 0
    for character in text {
      let units = String(character).utf16.count
      if units > limit {
        // One character that cannot fit alone still goes in its own event
        // rather than being cut in half.
        if !current.isEmpty {
          chunks.append(current)
          current = ""
          currentUnits = 0
        }
        chunks.append(String(character))
        continue
      }
      if currentUnits + units > limit {
        chunks.append(current)
        current = ""
        currentUnits = 0
      }
      current.append(character)
      currentUnits += units
    }
    if !current.isEmpty { chunks.append(current) }
    return chunks
  }
}
