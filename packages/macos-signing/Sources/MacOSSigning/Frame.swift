import Foundation

/// A 4-byte big-endian length followed by UTF-8 JSON, at most
/// `passwordsBrokerMaxFrameBytes` (256 KiB), as `packages/protocol` declares.
public enum Frame {
  public static let maxBytes = 256 * 1_024

  /// A payload the broker itself cannot frame is a bug in the broker, so this
  /// throws rather than truncating.
  public static func encode(_ payload: Data) throws -> Data {
    guard payload.count <= maxBytes else { throw FrameError.oversize(payload.count) }
    var framed = Data(capacity: payload.count + 4)
    let length = UInt32(payload.count)
    framed.append(UInt8(truncatingIfNeeded: length >> 24))
    framed.append(UInt8(truncatingIfNeeded: length >> 16))
    framed.append(UInt8(truncatingIfNeeded: length >> 8))
    framed.append(UInt8(truncatingIfNeeded: length))
    framed.append(payload)
    return framed
  }
}

public enum FrameError: Error, Equatable {
  /// A peer that announces an oversize frame cannot be resynchronised, so its
  /// connection is closed.
  case oversize(Int)
}

/// Accumulates bytes off the socket and yields whole frames.
public struct FrameDecoder {
  private var buffer = Data()
  private var failed = false

  public init() {}

  public mutating func append(_ bytes: Data) {
    buffer.append(bytes)
  }

  /// The next whole frame, or nil when more bytes are needed. Throws as soon
  /// as an announced length is too large, before any of its body is held,
  /// and stays failed.
  public mutating func next() throws -> Data? {
    if failed { throw FrameError.oversize(Frame.maxBytes + 1) }
    guard buffer.count >= 4 else { return nil }
    let start = buffer.startIndex
    let length =
      (Int(buffer[start]) << 24) | (Int(buffer[start + 1]) << 16) | (Int(buffer[start + 2]) << 8)
      | Int(buffer[start + 3])
    guard length <= Frame.maxBytes else {
      failed = true
      buffer = Data()
      throw FrameError.oversize(length)
    }
    guard buffer.count >= length + 4 else { return nil }
    let payload = Data(buffer[(start + 4)..<(start + 4 + length)])
    buffer = Data(buffer[(start + 4 + length)...])
    return payload
  }
}
