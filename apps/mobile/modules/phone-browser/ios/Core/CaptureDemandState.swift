public struct CaptureDemandState: Sendable {
  public struct Demand: Sendable {
    public var density: Double
    public var token: String?
    public var revision: Int
  }
  public private(set) var channels: [String: Demand] = [:]
  public private(set) var capturing = false
  private var lastStarted = -Double.infinity
  private var revision = 0
  private var inFlight: [String: Int] = [:]
  public init() {}
  public var density: Double? { channels.values.filter { $0.token == nil }.map(\.density).max() }
  public var recipients: [String] {
    channels.filter { $0.value.token == nil && inFlight[$0.key] == $0.value.revision }.map(\.key)
  }

  public mutating func set(channel: String, density: Double, frames: Bool, window: Int) throws {
    guard !channel.isEmpty, [0.75, 1, 1.25, 1.5, 2].contains(density), window == 1 else {
      throw BrowserRefusal.invalidArgument
    }
    if frames {
      revision += 1
      channels[channel] = Demand(density: density, token: channels[channel]?.token, revision: revision)
    } else { channels.removeValue(forKey: channel) }
  }

  public mutating func begin(now: Double, foreground: Bool, picture: Bool = false) -> Bool {
    guard foreground, !capturing, now - lastStarted >= 0.125, density != nil || picture else { return false }
    lastStarted = now
    capturing = true
    inFlight = channels.filter { $0.value.token == nil }.mapValues(\.revision)
    return true
  }

  public mutating func complete(token: String) {
    capturing = false
    for channel in recipients { channels[channel]?.token = token }
    inFlight.removeAll()
  }
  public mutating func cancel() { capturing = false; inFlight.removeAll() }
  public mutating func clear() { channels.removeAll(); cancel() }
  public mutating func ack(channel: String, token: String) {
    if channels[channel]?.token == token { channels[channel]?.token = nil }
  }
}
