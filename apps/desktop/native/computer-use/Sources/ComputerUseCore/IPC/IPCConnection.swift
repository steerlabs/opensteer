import Darwin
import Foundation

/// One accepted client. A session belongs to the connection that opened it and
/// ends when that connection drops (§1 invariant 3, §2 "IPC").
public final class IPCConnection: @unchecked Sendable {
  public let id: Int

  private let fileDescriptor: Int32
  private let readQueue: DispatchQueue
  private let writeQueue: DispatchQueue
  private let lock = NSLock()
  private var readSource: DispatchSourceRead?
  private var decoder = FrameDecoder()
  private var isClosed = false
  /// Only ever read or written on `writeQueue`, which is what makes it safe
  /// without a lock.
  private var descriptorClosed = false
  private let mediaReceiver = Locked<(@Sendable (Data) -> Void)?>(nil)
  func receiveMedia(_ receiver: @escaping @Sendable (Data) -> Void) { mediaReceiver.withLock { $0 = receiver } }
  private var mediaReady = false
  func enableMedia() { lock.lock(); mediaReady = true; lock.unlock() }
  private var mediaQueuedBytes = 0
  private var loginTextReceiver: LoginTextReceiver?
  var loginReceiver: LoginTextReceiver? {
    lock.lock(); defer { lock.unlock() }
    return isClosed ? nil : loginTextReceiver
  }
  private var clientProtocolVersion: Int?
  private var clientOwnerViewVersion: Int?
  private var clientOwnerInputVersion: Int?
  var negotiatedOwnerInputVersion: Int? {
    lock.lock(); defer { lock.unlock() }; return clientOwnerInputVersion
  }

  var negotiatedOwnerViewVersion: Int? {
    lock.lock()
    defer { lock.unlock() }
    return clientOwnerViewVersion
  }

  /// Called on the connection's read queue with one whole JSON frame.
  private let onFrame: @Sendable (IPCConnection, Data) -> Void
  /// Called once, after the connection is finished, from any queue.
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
    readQueue = DispatchQueue(label: "com.opensteer.computer-use.connection.\(id).read")
    writeQueue = DispatchQueue(label: "com.opensteer.computer-use.connection.\(id).write")
  }

  func resume() {
    let source = DispatchSource.makeReadSource(fileDescriptor: fileDescriptor, queue: readQueue)
    source.setEventHandler { [weak self] in self?.readAvailable() }
    source.setCancelHandler { [weak self, fileDescriptor, writeQueue] in
      // The descriptor is closed on the write queue, behind anything already
      // enqueued there, so the last answer before a close still goes out. That
      // is what makes "answer, then close" — an incompatible protocol version,
      // a first frame that is not `hello` — actually reach the peer.
      let connection = self
      writeQueue.async {
        connection?.descriptorClosed = true
        Darwin.close(fileDescriptor)
      }
    }
    readSource = source
    source.resume()
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
    while true {
      do {
        guard let frame = try decoder.next() else { return }
        if let receiver = mediaReceiver.current { receiver(frame) } else { onFrame(self, frame) }
      } catch {
        // A frame over 4 MiB cannot be resynchronised from, so the connection
        // goes rather than the frame (§2 "IPC").
        Log.ipc.error("Closing connection \(self.id, privacy: .public): frame too large.")
        close()
        return
      }
    }
  }

  /// Length-prefix and write one payload. Failures close the connection; the
  /// peer learns the answer is lost by the socket going away, which is what
  /// `outcome-unknown` is for on the Host side.
  public func send(_ payload: Data) {
    guard let framed = try? Frame.encode(payload) else {
      Log.ipc.error("Refusing to send a frame larger than the protocol allows.")
      return
    }
    // Whether the connection is still open is decided here, when the answer is
    // handed over — not inside the write, which runs after `close()` has
    // already flipped the flag for a "reply, then close" exchange.
    guard !closedFlag else { return }
    // Captured strongly on purpose: closing a connection drops the server's
    // reference to it, and a weak capture here would lose the very last answer
    // — the one sent immediately before the close.
    writeQueue.async { [self] in writeFramed(framed) }
  }

  /// Used only on the separately authenticated media attachment. The short
  /// reservation bounds queued writes; rechecking the gate drops late samples.
  func sendMedia(_ payload: Data, allowed: @escaping @Sendable () -> Bool) -> Bool {
    guard let framed = try? Frame.encode(payload) else { return false }
    lock.lock()
    let admitted = !isClosed && mediaReady && mediaQueuedBytes + framed.count <= 1_048_576
    if admitted { mediaQueuedBytes += framed.count }
    lock.unlock()
    guard admitted else { return false }
    writeQueue.async { [self] in
      defer {
        lock.lock(); mediaQueuedBytes -= framed.count; lock.unlock()
      }
      guard allowed() else { return }
      writeFramed(framed)
    }
    return true
  }

  private func writeFramed(_ framed: Data) {
    guard !descriptorClosed else { return }
    framed.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let written = Darwin.write(fileDescriptor, raw.baseAddress?.advanced(by: offset), raw.count - offset)
        if written <= 0 {
          if written < 0, errno == EINTR { continue }
          close(); return
        }
        offset += written
      }
    }
  }

  /// Whether this connection has said `hello`. Frames are read in order on
  /// the connection's read queue and the greeting is answered there, so the
  /// frame after `hello` always finds it set, whichever queue answers it.
  public var isGreeted: Bool {
    lock.lock()
    defer { lock.unlock() }
    return clientProtocolVersion != nil
  }

  var negotiatedProtocolVersion: Int? {
    lock.lock()
    defer { lock.unlock() }
    return clientProtocolVersion
  }

  func markGreeted(protocolVersion: Int, ownerViewVersion: Int? = nil, loginText: Int? = nil, ownerInputVersion: Int? = nil) {
    lock.lock()
    guard !isClosed, clientProtocolVersion == nil else { lock.unlock(); return }
    if loginText == 1 { loginTextReceiver = LoginTextReceiver() }
    clientProtocolVersion = protocolVersion
    clientOwnerViewVersion = ownerViewVersion
    clientOwnerInputVersion = ownerInputVersion
    lock.unlock()
  }

  public func send(response: ResponseEnvelope) {
    guard let data = try? JSONCoding.encoder.encode(response) else {
      Log.ipc.error("A response could not be encoded.")
      return
    }
    send(data)
  }

  public func send(event: EventEnvelope) {
    guard let data = try? JSONCoding.encoder.encode(event) else {
      Log.ipc.error("An event could not be encoded.")
      return
    }
    send(data)
  }

  var closedFlag: Bool {
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
    loginTextReceiver?.invalidate()
    loginTextReceiver = nil
    lock.unlock()
    readSource?.cancel()
    readSource = nil
    onClose(self)
  }
}
