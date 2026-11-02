/// Admission, including hidden replay, must restart at an intact reference picture.
struct KeyframeFence {
  private(set) var awaitingKeyframe = true
  mutating func lost() { awaitingKeyframe = true }
  func allows(key: Bool) -> Bool { key || !awaitingKeyframe }
  mutating func enqueued(key: Bool) { if key { awaitingKeyframe = false } }
}
