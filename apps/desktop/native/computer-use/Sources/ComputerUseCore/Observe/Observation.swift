import CoreGraphics
import Foundation

/// The observation of §2. Every observation is a full snapshot and indices are
/// reassigned each time, so nothing here is a difference from anything.
public struct Observation: Encodable, Sendable {
  public let snapshot: String
  public var observationId: String { snapshot }
  public let app: AppIdentity
  public let window: WindowSummary
  public var windows: [WindowInfo] = []
  public var blockedBy: [WindowBlocker] = []
  public var alone: Bool = false
  public let tree: String
  public let elementCount: Int
  public let truncated: Bool
  public let geometry: Geometry
  public let screenshot: Screenshot?
  /// True when the target app came forward because of the helper's own input
  /// since the previous observation. The helper reports it and never pushes
  /// focus back, because that would take focus a second time (invariant 4).
  public let focusChanged: Bool
  public let capturedAt: String

  /// Nullable fields are written as `null`, never left out: the Host reads this
  /// with a schema, and a missing key is a different shape from a null one.
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(snapshot, forKey: .snapshot)
    try container.encode(app, forKey: .app)
    try container.encode(window, forKey: .window)
    try container.encode(windows, forKey: .windows)
    try container.encode(blockedBy, forKey: .blockedBy)
    try container.encode(alone, forKey: .alone)
    try container.encode(tree, forKey: .tree)
    try container.encode(elementCount, forKey: .elementCount)
    try container.encode(truncated, forKey: .truncated)
    try container.encode(geometry, forKey: .geometry)
    try container.encode(screenshot, forKey: .screenshot)
    try container.encode(focusChanged, forKey: .focusChanged)
    try container.encode(capturedAt, forKey: .capturedAt)
  }

  private enum CodingKeys: String, CodingKey {
    case snapshot, app, window, windows, blockedBy, alone, tree, elementCount, truncated,
      screenshot, focusChanged
    case capturedAt, geometry
  }

  public struct WindowSummary: Encodable, Sendable {
    public let ref: String
    public let id: CGWindowID
    /// A window with no title carries an empty one: the whole `window` is what
    /// is nullable, not the title inside it.
    public let title: String
    public let frame: Rect
    /// Pixels per point in the screenshot after resizing.
    public let scale: Double
  }

  public struct Rect: Encodable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(_ rect: CGRect) {
      x = Double(rect.origin.x)
      y = Double(rect.origin.y)
      width = Double(rect.width)
      height = Double(rect.height)
    }
  }

  public struct Geometry: Encodable, Sendable, Equatable {
    public let width: Int
    public let height: Int
  }

  public struct Screenshot: Encodable, Sendable {
    public let mime: String
    public let base64: String
    public let width: Int
    public let height: Int
  }

  /// 16 random hex characters. An `act` cites one, and an id that is not the
  /// latest for that app in this session is `stale-observation`.
  public static func newIdentifier() -> String {
    var bytes = [UInt8](repeating: 0, count: 8)
    for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  /// `ISO8601DateFormatter` is safe to format from several threads; it is only
  /// its configuration that must not change, and this one never does.
  nonisolated(unsafe) static let timestampFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  public static func timestamp(_ date: Date = Date()) -> String {
    timestampFormatter.string(from: date)
  }
}
