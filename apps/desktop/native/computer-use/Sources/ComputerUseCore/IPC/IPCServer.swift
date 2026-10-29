import Darwin
import Foundation

/// The helper's canonical on-disk locations (§2 "Install", "IPC").
public enum HelperPaths {
  public static var supportDirectory: URL {
    URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
      .appendingPathComponent(
        "Library/Application Support/Opensteer/Computer Use", isDirectory: true)
  }

  public static var socket: URL {
    supportDirectory.appendingPathComponent("ipc.sock", isDirectory: false)
  }

  public static var application: URL {
    supportDirectory.appendingPathComponent("Opensteer Computer Use.app", isDirectory: true)
  }

  public static var executable: URL {
    application.appendingPathComponent(
      "Contents/MacOS/Opensteer Computer Use", isDirectory: false)
  }
}

/// The listening Unix socket. Multiple concurrent connections are allowed; each
/// connection is one client, and a session belongs to the connection that
/// opened it.
public final class IPCServer: @unchecked Sendable {
  private let socketURL: URL
  private let verifier: PeerVerifier
  private let acceptQueue = DispatchQueue(label: "com.opensteer.computer-use.accept")
  private let lock = NSLock()
  private var listenDescriptor: Int32 = -1
  private var acceptSource: DispatchSourceRead?
  private var nextConnectionID = 1
  private var connections: [Int: IPCConnection] = [:]

  private let onFrame: @Sendable (IPCConnection, Data) -> Void
  private let onConnectionClosed: @Sendable (IPCConnection) -> Void

  public init(
    socketURL: URL = HelperPaths.socket,
    verifier: PeerVerifier,
    onFrame: @escaping @Sendable (IPCConnection, Data) -> Void,
    onConnectionClosed: @escaping @Sendable (IPCConnection) -> Void
  ) {
    self.socketURL = socketURL
    self.verifier = verifier
    self.onFrame = onFrame
    self.onConnectionClosed = onConnectionClosed
  }

  public var connectionCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return connections.count
  }

  public func start() throws {
    let directory = socketURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    // An existing directory keeps whatever mode it had, so it is set again.
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

    let path = socketURL.path
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard pathBytes.count < capacity else {
      throw HelperError(
        .failed,
        "The Computer Use support folder path is too long for a Unix socket."
      )
    }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: pathBytes)
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

    // A stale socket file from a helper that was killed would refuse the bind.
    unlink(path)

    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else {
      throw HelperError(.failed, "The helper could not open its local socket.")
    }
    var one: Int32 = 1
    setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

    let bound = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
        Darwin.bind(descriptor, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0 else {
      Darwin.close(descriptor)
      throw HelperError(.failed, "The helper could not claim its local socket.")
    }
    chmod(path, 0o600)

    guard Darwin.listen(descriptor, 8) == 0 else {
      Darwin.close(descriptor)
      unlink(path)
      throw HelperError(.failed, "The helper could not listen on its local socket.")
    }

    listenDescriptor = descriptor
    let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: acceptQueue)
    source.setEventHandler { [weak self] in self?.acceptPending() }
    acceptSource = source
    source.resume()
    Log.ipc.notice("Listening for the desktop app.")
  }

  public func stop() {
    acceptSource?.cancel()
    acceptSource = nil
    if listenDescriptor >= 0 {
      Darwin.close(listenDescriptor)
      listenDescriptor = -1
    }
    unlink(socketURL.path)
    lock.lock()
    let open = Array(connections.values)
    lock.unlock()
    for connection in open { connection.close() }
  }

  private func acceptPending() {
    while true {
      let accepted = Darwin.accept(listenDescriptor, nil, nil)
      if accepted < 0 { return }

      var one: Int32 = 1
      setsockopt(accepted, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

      // Invariant 2: the peer is verified before a byte is read, and a peer
      // that fails is closed with no response at all.
      guard verifier.verify(fileDescriptor: accepted) else {
        Darwin.close(accepted)
        continue
      }

      lock.lock()
      let id = nextConnectionID
      nextConnectionID += 1
      lock.unlock()

      let connection = IPCConnection(
        id: id,
        fileDescriptor: accepted,
        onFrame: onFrame,
        onClose: { [weak self] connection in
          guard let self else { return }
          self.lock.lock()
          self.connections[connection.id] = nil
          self.lock.unlock()
          self.onConnectionClosed(connection)
        }
      )
      lock.lock()
      connections[id] = connection
      lock.unlock()
      connection.resume()
      Log.ipc.notice("Accepted connection \(id, privacy: .public).")
    }
  }
}
