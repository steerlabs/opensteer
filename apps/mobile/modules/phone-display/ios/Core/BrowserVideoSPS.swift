import Foundation

/// Baseline SPS resource validation precedes native decoder allocation.
enum BrowserVideoSPS {
  static func valid(_ data: Data, width: Int, height: Int) -> Bool {
    data.withUnsafeBytes { valid($0, width: width, height: height) }
  }
  static func valid(_ bytes: UnsafeRawBufferPointer, width: Int, height: Int) -> Bool {
    guard width >= 2, height >= 2, width <= 3840, height <= 2160, width * height <= 3840 * 2160,
          bytes.count <= 4_194_304 else { return false }
    let unit = H264AccessUnit(bytes)
    guard let sps = unit.sps, unit.pps != nil, unit.units.contains(where: { bytes[$0.lowerBound] & 31 == 5 }), sps.count >= 5, sps.count <= 4096, bytes[sps.lowerBound + 1] == 66 else { return false }
    var rbsp: [UInt8] = [], zeros = 0
    for at in (sps.lowerBound + 4)..<sps.upperBound {
      let value = bytes[at]
      if zeros >= 2 && value == 3 { zeros = 0; continue }
      rbsp.append(value); zeros = value == 0 ? zeros + 1 : 0
    }
    var reader = Bits(bytes: rbsp)
    guard let id = reader.ue(), id <= 31, let frameBits = reader.ue(), frameBits <= 12, let order = reader.ue() else { return false }
    if order == 0 { guard let bits = reader.ue(), bits <= 12 else { return false } }
    else if order != 2 { return false }
    guard let refs = reader.ue(), refs <= 16, reader.read(1) != nil,
          let columns = reader.ue(), let rows = reader.ue(), columns < 240, rows < 135,
          reader.read(1) == 1, reader.read(1) != nil, let cropping = reader.read(1) else { return false }
    var left = 0, right = 0, top = 0, bottom = 0
    if cropping == 1 {
      guard let l = reader.ue(), let r = reader.ue(), let t = reader.ue(), let b = reader.ue() else { return false }
      left = l; right = r; top = t; bottom = b
    }
    return (columns + 1) * 16 - 2 * (left + right) == width && (rows + 1) * 16 - 2 * (top + bottom) == height
  }
  private struct Bits {
    let bytes: [UInt8]
    var at = 0
    mutating func read(_ count: Int) -> Int? {
      guard count >= 0, count <= 24, at + count <= bytes.count * 8 else { return nil }
      var value = 0
      for _ in 0..<count { value = value * 2 + Int((bytes[at / 8] >> (7 - at % 8)) & 1); at += 1 }
      return value
    }
    mutating func ue() -> Int? {
      var zeros = 0
      while true {
        guard let bit = read(1) else { return nil }
        if bit == 1 { break }; zeros += 1
        if zeros > 16 { return nil }
      }
      guard let value = read(zeros) else { return nil }
      return (1 << zeros) - 1 + value
    }
  }
}
