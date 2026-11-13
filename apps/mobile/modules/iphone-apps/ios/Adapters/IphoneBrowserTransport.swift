import Foundation

public protocol IphoneBrowserServices: AnyObject {
  var qualification: [String: Any] { get }
  func fence(epoch: Int, reason: String)
  func detachAgent(epoch: Int, attachmentId: String)
  func eraseDeployment(_ deploymentId: String, completion: @escaping (Bool) -> Void)
}

@available(iOS 17, *)
public final class IphoneBrowserTransport: @unchecked Sendable {
  public static let shared = IphoneBrowserTransport()
  private let lock = NSRecursiveLock()
  private let clockLock = NSLock()
  private var services: (any IphoneBrowserServices)?
  private var descriptor: [String: Any]?
  private var deploymentId: String?
  private var erasing = false
  private(set) var heartbeatIntervalMs = 1000
  private var clockDate = Date()
  private var clockTick = DispatchTime.now().uptimeNanoseconds
  private var socket: URLSessionWebSocketTask?
  private var observer: (([String: Any]) -> Void)?
  private var erasureObserver: (([String: Any]) -> Void)?
  private static let nativeConnection = PhoneBrowserConnection(now: { shared.now() },
    onRetire: { epoch, reason in shared.fenceServices(epoch: epoch, reason: reason) },
    onDetach: { epoch, attachment in shared.detachServices(epoch: epoch, attachmentId: attachment) })
  public var connection: PhoneBrowserConnection { Self.nativeConnection }

  private init() {}

  public func register(_ services: any IphoneBrowserServices) {
    lock.lock(); self.services = services; lock.unlock()
    IphoneExecutorRuntime.shared.retryBrowserErasure()
  }

  func setObserver(_ observer: (([String: Any]) -> Void)?, erasure: (([String: Any]) -> Void)?) {
    connection.setObserver(observer)
    lock.lock(); erasureObserver = erasure; lock.unlock()
    IphoneExecutorRuntime.shared.retryBrowserErasure()
  }

  func configure(epoch: Int, deploymentId: String, descriptor: [String: Any], allowCreate: Bool,
    beforeAdvertisement: () throws -> Void) throws {
    lock.lock()
    guard !erasing, let services else { lock.unlock(); throw PhoneBrowserFailure.unavailable }
    lock.unlock()
    let storageId = try PhoneBrowserValidation.descriptor(descriptor, qualification: services.qualification)
    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let scope = IphoneProofs.tokenDigest(deploymentId).replacingOccurrences(of: ":", with: "-")
    let directory = support.appendingPathComponent("phone-browser-transport/\(scope)/\(storageId)", isDirectory: true)
    let ledger = try PhoneBrowserReplayLedger(directory: directory, allowCreate: allowCreate)
    try connection.configure(epoch: epoch, runtimeId: WireField.string(descriptor, "runtimeId"), ledger: ledger)
    try beforeAdvertisement()
    lock.lock(); defer { lock.unlock() }
    guard !erasing else { throw PhoneBrowserFailure.unavailable }
    self.deploymentId = deploymentId; self.descriptor = descriptor
  }

  func browserDescriptor() -> [String: Any]? {
    lock.lock(); defer { lock.unlock() }
    guard !erasing, services?.qualification["browser"] as? Bool == true else { return nil }
    return descriptor
  }

  func now() -> Int64 {
    clockLock.lock(); defer { clockLock.unlock() }
    return Int64(clockDate.timeIntervalSince1970 * 1000) + Int64((DispatchTime.now().uptimeNanoseconds - clockTick) / 1_000_000)
  }

  func adopt(_ welcome: [String: Any], socket: URLSessionWebSocketTask) throws {
    let date = try WireField.date(welcome, "serverTime")
    let heartbeat = try WireField.int(welcome, "heartbeatIntervalMs", range: 1_000...300_000)
    clockLock.lock(); clockDate = date; clockTick = DispatchTime.now().uptimeNanoseconds; clockLock.unlock()
    lock.lock(); self.socket = socket; heartbeatIntervalMs = heartbeat; lock.unlock()
    try connection.adopt(welcome, sender: { [weak socket] message, completion in
      guard let socket else { completion(PhoneBrowserFailure.unavailable); return }
      socket.send(message, completionHandler: completion)
    }, close: { [weak socket] in socket?.cancel(with: .goingAway, reason: nil) })
  }

  @discardableResult func fence(reason: String) -> Int {
    let epoch = connection.fence()
    fenceServices(epoch: epoch, reason: reason)
    return epoch
  }

  private func fenceServices(epoch: Int, reason: String) {
    lock.lock(); let services = services; lock.unlock()
    services?.fence(epoch: epoch, reason: reason)
  }

  private func detachServices(epoch: Int, attachmentId: String) {
    lock.lock(); let services = services; lock.unlock()
    services?.detachAgent(epoch: epoch, attachmentId: attachmentId)
  }

  func offline(reason: String) {
    connection.offline(reason: reason)
    lock.lock(); socket?.cancel(with: .goingAway, reason: nil); socket = nil; lock.unlock()
  }

  func erase(deploymentId: String, completion: @escaping (Bool) -> Void) {
    offline(reason: "enrollment-removed")
    lock.lock(); erasing = true; descriptor = nil
    let services = services; lock.unlock()
    guard let services else { completion(false); return }
    services.eraseDeployment(deploymentId) { [weak self] success in
      if success { self?.lock.lock(); self?.erasing = false; self?.deploymentId = nil; self?.lock.unlock() }
      completion(success)
    }
  }

  func requestErasure(deploymentId: String) {
    lock.lock(); erasing = true; descriptor = nil; let observer = erasureObserver; lock.unlock()
    observer?(["deploymentId": deploymentId, "epoch": connection.epoch])
  }

  func disable() {
    lock.lock(); descriptor = nil; lock.unlock()
    offline(reason: "storage-unavailable")
  }

  public func frameWriter(epoch: Int, channelId: String) throws -> any PhoneBrowserFrameWriter {
    try connection.frameWriter(epoch: epoch, channelId: channelId)
  }

  public func allocationPermit(_ handle: String, epoch: Int) throws -> PhoneBrowserConnection.Permit {
    try connection.permit(handle, epoch: epoch)
  }
}
