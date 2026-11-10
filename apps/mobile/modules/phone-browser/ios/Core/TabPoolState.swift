public enum TabResidency: String, Codable, Sendable {
  case live, retained, discarded
}

public struct TabPoolState: Sendable {
  public private(set) var tabs: [String: TabResidency] = [:]
  public private(set) var retained: [String] = []
  public private(set) var covered: String?
  public private(set) var visible: String?
  public let retainedLimit: Int

  public init(retainedLimit: Int = 4) {
    self.retainedLimit = max(0, retainedLimit)
  }

  public mutating func create(_ tab: String) throws {
    guard tabs[tab] == nil else { throw BrowserRefusal.invalidArgument }
    tabs[tab] = .discarded
  }

  public mutating func activate(_ tab: String, covered isCovered: Bool) throws {
    guard tabs[tab] != nil else { throw BrowserRefusal.targetClosed }
    let occupied = isCovered ? covered : visible
    guard occupied == nil || occupied == tab else { throw BrowserRefusal.targetSuspended }
    if visible == tab { visible = nil }
    if covered == tab { covered = nil }
    if isCovered { covered = tab } else { visible = tab }
    retained.removeAll { $0 == tab }
    tabs[tab] = .live
  }

  public mutating func suspend(_ tab: String) throws -> [String] {
    guard let state = tabs[tab] else { throw BrowserRefusal.targetClosed }
    guard state == .live else { return [] }
    if visible == tab { visible = nil }
    if covered == tab { covered = nil }
    tabs[tab] = .retained
    retained.append(tab)
    var evicted: [String] = []
    while retained.count > retainedLimit {
      let oldest = retained.removeFirst()
      tabs[oldest] = .discarded
      evicted.append(oldest)
    }
    return evicted
  }

  public mutating func discard(_ tab: String) throws {
    guard tabs[tab] != nil else { throw BrowserRefusal.targetClosed }
    if visible == tab { visible = nil }
    if covered == tab { covered = nil }
    retained.removeAll { $0 == tab }
    tabs[tab] = .discarded
  }

  public mutating func destroy(_ tab: String) throws {
    try discard(tab)
    tabs.removeValue(forKey: tab)
  }

  public mutating func memoryPressure() -> [String] {
    var released = retained
    if let covered { released.append(covered) }
    for tab in released { try? discard(tab) }
    return released
  }
}
