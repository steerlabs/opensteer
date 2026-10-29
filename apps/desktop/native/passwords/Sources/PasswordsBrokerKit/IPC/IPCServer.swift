import Darwin
import Foundation

/// What the socket server reports, always on the main queue and in the order
/// it happened for each connection: opened, frames, closed.
@MainActor
public protocol IPCServerDelegate: AnyObject {
  func connectionOpened(_ connection: IPCConnection)
  func connection(_ connection: IPCConnection, received frame: Data)
  func connectionClosed(_ connection: IPCConnection)
}

public enum IPCServerError: Error, Equatable {
  case pathTooLong
  case failed(String)
}

/// The listening Unix socket.
///
/// The caller holds the instance lock before `start`, which is what makes
/// replacing a stale socket safe: nobody else can be serving it.
public final class IPCServer: @unchecked Sendable {
  private struct FileIdentity: Equatable {
    let device: dev_t
    let inode: ino_t
  }

  public let socketURL: URL
  private let verifier: PeerVerifier
  private weak var delegate: IPCServerDelegate?
  private let acceptQueue = DispatchQueue(label: "com.opensteer.passwords.accept")
  private let lock = NSLock()
  private var listenDescriptor: Int32 = -1
  private var acceptSource: DispatchSourceRead?
  private var nextConnectionID = 1
  private var connections: [Int: IPCConnection] = [:]
  private var bound: FileIdentity?

  public init(socketURL: URL, verifier: PeerVerifier, delegate: IPCServerDelegate) {
    self.socketURL = socketURL
    self.verifier = verifier
    self.delegate = delegate
  }

  public var connectionCount: Int {
    lock.withLock { connections.count }
  }

  public func start() throws {
    let path = socketURL.path
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(path.utf8)
    guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
      throw IPCServerError.pathTooLong
    }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in raw.copyBytes(from: pathBytes) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

    // Safe only because the caller holds the instance lock: a socket file
    // here belongs to a broker that is no longer running.
    if unlink(path) != 0, errno != ENOENT {
      throw IPCServerError.failed("The old socket could not be removed (\(errno)).")
    }

    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw IPCServerError.failed("socket (\(errno))") }
    var one: Int32 = 1
    setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)

    // Created owner-only, so there is no moment when another user could connect.
    let previousMask = umask(0o177)
    let result = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    umask(previousMask)
    guard result == 0 else {
      let code = errno
      Darwin.close(descriptor)
      throw IPCServerError.failed("bind (\(code))")
    }
    // Non-blocking, so the accept loop ends when nothing more is waiting
    // instead of parking the accept queue inside `accept`.
    guard chmod(path, 0o600) == 0, fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0, Darwin.listen(descriptor, 16) == 0 else {
      let code = errno
      Darwin.close(descriptor)
      unlink(path)
      throw IPCServerError.failed("listen (\(code))")
    }
    var information = stat()
    guard lstat(path, &information) == 0 else {
      let code = errno
      Darwin.close(descriptor)
      throw IPCServerError.failed("stat (\(code))")
    }

    lock.withLock {
      listenDescriptor = descriptor
      bound = FileIdentity(device: information.st_dev, inode: information.st_ino)
    }
    let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: acceptQueue)
    source.setEventHandler { [weak self] in self?.acceptPending() }
    source.setCancelHandler { Darwin.close(descriptor) }
    acceptSource = source
    source.resume()
    Log.ipc.notice("Listening for the desktop app.")
  }

  /// Whether the socket path still names the socket this server bound. A
  /// desktop that launched a fresh instance unlinked it, and a new instance
  /// may have bound another one there; either way this broker has nobody to
  /// serve.
  public func ownsSocketPath() -> Bool {
    guard let bound = lock.withLock({ bound }) else { return false }
    var information = stat()
    guard lstat(socketURL.path, &information) == 0 else { return false }
    return FileIdentity(device: information.st_dev, inode: information.st_ino) == bound
  }

  /// Stops listening and closes every connection. The socket file is removed
  /// only while it is still this server's own.
  public func stop() {
    let owned = ownsSocketPath()
    acceptSource?.cancel()
    acceptSource = nil
    let open: [IPCConnection] = lock.withLock {
      listenDescriptor = -1
      bound = nil
      return Array(connections.values)
    }
    if owned { unlink(socketURL.path) }
    for connection in open { connection.close() }
  }

  private func acceptPending() {
    while true {
      let descriptor = lock.withLock { listenDescriptor }
      guard descriptor >= 0 else { return }
      let accepted = Darwin.accept(descriptor, nil, nil)
      if accepted < 0 { return }
      var one: Int32 = 1
      setsockopt(accepted, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
      _ = fcntl(accepted, F_SETFD, FD_CLOEXEC)
      // Darwin passes the listener's O_NONBLOCK on to accepted sockets;
      // writes run on their own queue and may block there.
      _ = fcntl(accepted, F_SETFL, fcntl(accepted, F_GETFL) & ~O_NONBLOCK)

      // The peer is verified before a byte is read, and a refused one is
      // closed with no answer, because an answer is itself information.
      guard verifier.verify(fileDescriptor: accepted) else {
        Darwin.close(accepted)
        continue
      }

      let id = lock.withLock { () -> Int in
        let id = nextConnectionID
        nextConnectionID += 1
        return id
      }
      let connection = IPCConnection(
        id: id,
        fileDescriptor: accepted,
        onFrame: { [weak self] connection, frame in
          guard let server = self else { return }
          DispatchQueue.main.async {
            MainActor.assumeIsolated { server.delegate?.connection(connection, received: frame) }
          }
        },
        onClose: { [weak self] connection in
          guard let self else { return }
          self.lock.withLock { self.connections[connection.id] = nil }
          DispatchQueue.main.async {
            MainActor.assumeIsolated { self.delegate?.connectionClosed(connection) }
          }
        }
      )
      lock.withLock { connections[id] = connection }
      // Queued before the connection reads anything, so "opened" always
      // reaches the delegate before the connection's first frame.
      DispatchQueue.main.async { [weak self] in
        MainActor.assumeIsolated { self?.delegate?.connectionOpened(connection) }
      }
      connection.resume()
      Log.ipc.notice("Accepted connection \(id, privacy: .public).")
    }
  }
}
