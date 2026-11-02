/// Admission, including hidden replay, must restart at an intact reference picture.
struct KeyframeFence {
  private var loss = 1
  private var admittedLoss = 0
  var awaitingKeyframe: Bool { loss != admittedLoss }
  mutating func lost() { loss += 1 }
  func captureLoss() -> Int { loss }
  func allows(key: Bool) -> Bool { key || !awaitingKeyframe }
  mutating func enqueued(key: Bool, lossAtAdmission: Int) {
    if key { admittedLoss = lossAtAdmission }
  }
}
