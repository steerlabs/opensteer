import Foundation

/// Framing for the Unix socket: a 4-byte big-endian length followed by UTF-8
/// JSON, at most 4 MiB (docs/computer-use.md §2 "IPC").
public enum Frame {
  public static let maxBytes = 4 * 1_024 * 1_024

  /// Length-prefix one payload. A payload the helper itself cannot frame is a
  /// bug in the helper, so this throws rather than truncating.
  public static func encode(_ payload: Data) throws -> Data {
    guard payload.count <= maxBytes else {
      throw FrameError.oversize(payload.count)
    }
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
  /// The peer announced, or the helper produced, a frame larger than 4 MiB.
  /// On the receiving side this closes the connection: a peer that cannot
  /// frame is a peer that cannot be resynchronised.
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

  /// The next whole frame, or `nil` when more bytes are needed.
  ///
  /// Throws `FrameError.oversize` as soon as the announced length is out of
  /// bounds — before waiting for 4 MiB of body — and stays failed afterwards.
  public mutating func next() throws -> Data? {
    if failed { throw FrameError.oversize(Frame.maxBytes + 1) }
    guard buffer.count >= 4 else { return nil }
    let length = buffer.withUnsafeBytes { raw -> Int in
      let base = raw.bindMemory(to: UInt8.self)
      return (Int(base[0]) << 24) | (Int(base[1]) << 16) | (Int(base[2]) << 8) | Int(base[3])
    }
    guard length <= Frame.maxBytes else {
      failed = true
      throw FrameError.oversize(length)
    }
    guard buffer.count >= length + 4 else { return nil }
    let payload = buffer.subdata(in: 4..<(length + 4))
    buffer.removeSubrange(0..<(length + 4))
    return payload
  }

  /// Bytes held but not yet forming a frame. Used by tests only.
  public var pendingByteCount: Int { buffer.count }
}
