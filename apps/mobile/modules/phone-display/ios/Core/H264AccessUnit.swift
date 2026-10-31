import Foundation

/// One Annex-B access unit split into the parameter sets a key frame carries and
/// the remaining NAL units, which AVFoundation takes length-prefixed (AVCC).
struct H264AccessUnit {
  let sps: Range<Int>?
  let pps: Range<Int>?
  /// Every unit that is not a parameter set, in stream order.
  let units: [Range<Int>]

  /// The AVCC sample size: each unit behind a four-byte big-endian length.
  var sampleLength: Int { units.reduce(0) { $0 + 4 + $1.count } }

  init(_ bytes: UnsafeRawBufferPointer) {
    var starts: [(code: Int, unit: Int)] = []
    var i = 0
    while i + 2 < bytes.count {
      if bytes[i] == 0 && bytes[i + 1] == 0 {
        if bytes[i + 2] == 1 { starts.append((i, i + 3)); i += 3; continue }
        if i + 3 < bytes.count && bytes[i + 2] == 0 && bytes[i + 3] == 1 { starts.append((i, i + 4)); i += 4; continue }
      }
      i += 1
    }
    var sps: Range<Int>?, pps: Range<Int>?, units: [Range<Int>] = []
    for (index, start) in starts.enumerated() {
      let end = index + 1 < starts.count ? starts[index + 1].code : bytes.count
      guard start.unit < end else { continue }
      switch bytes[start.unit] & 31 {
      case 7: if sps == nil { sps = start.unit..<end }
      case 8: if pps == nil { pps = start.unit..<end }
      default: units.append(start.unit..<end)
      }
    }
    self.sps = sps
    self.pps = pps
    self.units = units
  }

  /// Writes the AVCC sample into `output`, which holds exactly `sampleLength` bytes.
  func writeSample(from bytes: UnsafeRawBufferPointer, into output: UnsafeMutableRawBufferPointer) {
    precondition(output.count == sampleLength)
    var offset = 0
    for unit in units {
      var length = UInt32(unit.count).bigEndian
      withUnsafeBytes(of: &length) { output.baseAddress!.advanced(by: offset).copyMemory(from: $0.baseAddress!, byteCount: 4) }
      offset += 4
      output.baseAddress!.advanced(by: offset).copyMemory(from: bytes.baseAddress!.advanced(by: unit.lowerBound), byteCount: unit.count)
      offset += unit.count
    }
  }
}
