import Foundation

/// RFC 3492 Punycode for single DNS labels (without the `xn--` prefix).
enum Punycode {
  private static let base = 36
  private static let tMin = 1
  private static let tMax = 26
  private static let skew = 38
  private static let damp = 700
  private static let initialBias = 72
  private static let initialN = 128
  private static let limit = Int(Int32.max)

  static func encode(_ label: String) -> String? {
    let input = label.unicodeScalars.map { Int($0.value) }
    var output = input.filter { $0 < 0x80 }.map { UInt8($0) }
    let basicCount = output.count
    var handled = basicCount
    if basicCount > 0 { output.append(UInt8(ascii: "-")) }
    var n = initialN
    var delta = 0
    var bias = initialBias
    while handled < input.count {
      guard let next = input.filter({ $0 >= n }).min() else { return nil }
      guard next - n <= (limit - delta) / (handled + 1) else { return nil }
      delta += (next - n) * (handled + 1)
      n = next
      for scalar in input {
        if scalar < n {
          delta += 1
          guard delta < limit else { return nil }
        }
        if scalar == n {
          var q = delta
          var k = base
          while true {
            let t = threshold(k, bias)
            if q < t { break }
            output.append(digit(t + (q - t) % (base - t)))
            q = (q - t) / (base - t)
            k += base
          }
          output.append(digit(q))
          bias = adapt(delta, handled + 1, handled == basicCount)
          delta = 0
          handled += 1
        }
      }
      delta += 1
      n += 1
    }
    return String(decoding: output, as: UTF8.self)
  }

  static func decode(_ label: String) -> String? {
    let input = Array(label.utf8)
    guard input.allSatisfy({ $0 < 0x80 }) else { return nil }
    var output: [Int] = []
    var position = 0
    if let lastDash = input.lastIndex(of: UInt8(ascii: "-")) {
      output = input[..<lastDash].map { Int($0) }
      position = lastDash + 1
    }
    var n = initialN
    var i = 0
    var bias = initialBias
    while position < input.count {
      let oldI = i
      var weight = 1
      var k = base
      while true {
        guard position < input.count, let value = digitValue(input[position]) else { return nil }
        position += 1
        guard value <= (limit - i) / weight else { return nil }
        i += value * weight
        let t = threshold(k, bias)
        if value < t { break }
        guard weight <= limit / (base - t) else { return nil }
        weight *= base - t
        k += base
      }
      bias = adapt(i - oldI, output.count + 1, oldI == 0)
      guard i / (output.count + 1) <= limit - n else { return nil }
      n += i / (output.count + 1)
      i %= output.count + 1
      guard n >= 0x80, Unicode.Scalar(UInt32(n)) != nil else { return nil }
      output.insert(n, at: i)
      i += 1
    }
    var text = ""
    for value in output {
      guard let scalar = Unicode.Scalar(UInt32(value)) else { return nil }
      text.unicodeScalars.append(scalar)
    }
    return text
  }

  private static func threshold(_ k: Int, _ bias: Int) -> Int {
    if k <= bias { return tMin }
    if k >= bias + tMax { return tMax }
    return k - bias
  }

  private static func adapt(_ delta: Int, _ points: Int, _ first: Bool) -> Int {
    var delta = first ? delta / damp : delta / 2
    delta += delta / points
    var k = 0
    while delta > ((base - tMin) * tMax) / 2 {
      delta /= base - tMin
      k += base
    }
    return k + (base - tMin + 1) * delta / (delta + skew)
  }

  private static func digit(_ value: Int) -> UInt8 {
    value < 26 ? UInt8(ascii: "a") + UInt8(value) : UInt8(ascii: "0") + UInt8(value - 26)
  }

  private static func digitValue(_ byte: UInt8) -> Int? {
    switch byte {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): return Int(byte - UInt8(ascii: "0")) + 26
    case UInt8(ascii: "a")...UInt8(ascii: "z"): return Int(byte - UInt8(ascii: "a"))
    case UInt8(ascii: "A")...UInt8(ascii: "Z"): return Int(byte - UInt8(ascii: "A"))
    default: return nil
    }
  }
}
