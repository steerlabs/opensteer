public struct NavigationLedger<Key: Hashable> {
  private var identifiers: [Key: String] = [:]
  private var active: Key?
  public init() {}
  public mutating func submit(_ key: Key, id: String) {
    identifiers[key] = id
    active = key
  }
  public mutating func started(_ key: Key, id: String) -> String? {
    if identifiers[key] == nil { submit(key, id: id) }
    return current(key)
  }
  public func current(_ key: Key) -> String? {
    active == key ? identifiers[key] : nil
  }
  public mutating func finish(_ key: Key) {
    identifiers.removeValue(forKey: key)
    if active == key { active = nil }
  }
}
