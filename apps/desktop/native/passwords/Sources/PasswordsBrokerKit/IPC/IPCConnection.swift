import Darwin
import Foundation

/// One accepted, verified client. Transactions belong to the connection that
/// opened them and end when it drops.
public final class IPCConnection: @unchecked Sendable {
  public let id: Int

  private let fileDescriptor: Int32
  private let readQueue: DispatchQueue
  private let writeQueue: DispatchQueue
  private let lock = NSLock()
  private var readSource: DispatchSourceRead?
  private var decoder = FrameDecoder()
  private var isClosed = false
  /// Only read or written on `writeQueue`.
  private var descriptorClosed = false

  private let onFrame: @Sendable (IPCConnection, Data) -> Void
  private let onClose: @Sendable (IPCConnection) -> Void

  init(
    id: Int,
    fileDescriptor: Int32,
    onFrame: @escaping @Sendable (IPCConnection, Data) -> Void,
    onClose: @escaping @Sendable (IPCConnection) -> Void
  ) {
    self.id = id
    self.fileDescriptor = fileDescriptor
    self.onFrame = onFrame
    self.onClose = onClose
    readQueue = DispatchQueue(label: "com.opensteer.passwords.connection.\(id).read")
    writeQueue = DispatchQueue(label: "com.opensteer.passwords.connection.\(id).write")
  }

  func resume() {
    let source = DispatchSource.makeReadSource(fileDescriptor: fileDescriptor, queue: readQueue)
    source.setEventHandler { [weak self] in self?.readAvailable() }
    source.setCancelHandler { [weak self, fileDescriptor, writeQueue] in
      // Closed on the write queue, behind anything already queued there, so
      // an answer sent just before a close (a refused `hello`) still arrives.
      let connection = self
      writeQueue.async {
        connection?.descriptorClosed = true
        Darwin.close(fileDescriptor)
      }
    }
    lock.lock()
    let alreadyClosed = isClosed
    if !alreadyClosed { readSource = source }
    lock.unlock()
    source.resume()
    if alreadyClosed { source.cancel() }
  }

  private func readAvailable() {
    var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
    let count = buffer.withUnsafeMutableBytes { raw in
      Darwin.read(fileDescriptor, raw.baseAddress, raw.count)
    }
    if count <= 0 {
      if count < 0, errno == EINTR || errno == EAGAIN { return }
      close()
      return
    }
    decoder.append(Data(buffer[0..<count]))
    while !closedFlag {
      do {
        guard let frame = try decoder.next() else { return }
        onFrame(self, frame)
      } catch {
        Log.ipc.error("Closing connection \(self.id, privacy: .public): a frame was over 256 KiB.")
        close()
        return
      }
    }
  }

  /// Frames and writes one JSON payload. A payload the protocol cannot carry
  /// is a broker bug: it is logged and the connection closed, because the
  /// peer would otherwise wait for an answer that never comes.
  public func send(_ payload: Data) {
    guard let framed = try? Frame.encode(payload) else {
      Log.ipc.fault("Refused to send a frame larger than the protocol allows.")
      close()
      return
    }
    guard !closedFlag else { return }
    // Strongly captured: the last answer before a close must still go out.
    writeQueue.async { [self] in
      guard !descriptorClosed else { return }
      framed.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
          let written = Darwin.write(fileDescriptor, raw.baseAddress! + offset, raw.count - offset)
          if written <= 0 {
            if written < 0, errno == EINTR { continue }
            close()
            return
          }
          offset += written
        }
      }
    }
  }

  public var closedFlag: Bool {
    lock.lock()
    defer { lock.unlock() }
    return isClosed
  }

  public func close() {
    lock.lock()
    if isClosed {
      lock.unlock()
      return
    }
    isClosed = true
    let source = readSource
    readSource = nil
    lock.unlock()
    source?.cancel()
    onClose(self)
  }
}
