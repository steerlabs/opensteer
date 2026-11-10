import CryptoKit
import Darwin
import Foundation

public struct PhoneBrowserReplayState: Codable, Equatable {
  public struct Entry: Codable, Equatable {
    public let nonce: String
    public let expiresAt: Int64
  }
  public let version: Int
  public let highWaterAt: Int64
  public let entries: [Entry]

  public func claiming(nonce: String, expiresAt: Int64, now: Int64, capacity: Int) throws -> Self {
    guard (16...255).contains(nonce.unicodeScalars.count), now >= 0, now <= 9_007_199_254_740_991, now >= highWaterAt,
      expiresAt > now, expiresAt <= 9_007_199_254_740_991 else { throw PhoneBrowserFailure.unavailable }
    let active = entries.filter { $0.expiresAt > now }
    guard !active.contains(where: { $0.nonce == nonce }) else { throw PhoneBrowserFailure.alreadyUsed }
    guard active.count < capacity else { throw PhoneBrowserFailure.full }
    return Self(version: 1, highWaterAt: now, entries: active + [.init(nonce: nonce, expiresAt: expiresAt)])
  }
}

public enum PhoneBrowserDurableFile {
  public static func write(_ bytes: Data, to destination: URL) throws {
    let directory = destination.deletingLastPathComponent()
    let temporary = directory.appendingPathComponent(".\(UUID().uuidString).tmp")
    let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw PhoneBrowserFailure.unavailable }
    defer { Darwin.close(descriptor); try? FileManager.default.removeItem(at: temporary) }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    try handle.write(contentsOf: bytes)
    var excluded = temporary
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
    #if os(iOS)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: temporary.path)
    #endif
    try handle.synchronize()
    guard Darwin.rename(temporary.path, destination.path) == 0 else { throw PhoneBrowserFailure.unavailable }
    let parent = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard parent >= 0 else { throw PhoneBrowserFailure.unavailable }
    defer { Darwin.close(parent) }
    guard Darwin.fsync(parent) == 0 else { throw PhoneBrowserFailure.unavailable }
  }
}

public final class PhoneBrowserReplayLedger {
  private static let lock = NSRecursiveLock()
  private let file: URL
  public let capacity: Int
  private struct Record: Codable { let state: PhoneBrowserReplayState; let digest: String }

  public init(directory: URL, capacity: Int = 4096, allowCreate: Bool = true) throws {
    Self.lock.lock(); defer { Self.lock.unlock() }
    guard capacity > 0 else { throw PhoneBrowserFailure.unavailable }
    self.capacity = capacity; file = directory.appendingPathComponent("replay.json")
    if !FileManager.default.fileExists(atPath: directory.path) {
      guard allowCreate else { throw PhoneBrowserFailure.unavailable }
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var excluded = directory
      var values = URLResourceValues(); values.isExcludedFromBackup = true
      try excluded.setResourceValues(values)
      try persist(.init(version: 1, highWaterAt: 0, entries: []))
    }
    _ = try snapshot()
  }

  public func snapshot() throws -> PhoneBrowserReplayState {
    Self.lock.lock(); defer { Self.lock.unlock() }
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
      attributes[.type] as? FileAttributeType == .typeRegular,
      let size = attributes[.size] as? NSNumber, size.intValue <= capacity * 512 + 1024,
      let data = try? Data(contentsOf: file),
      let record = try? JSONDecoder().decode(Record.self, from: data),
      record.state.version == 1, record.state.highWaterAt >= 0, record.state.highWaterAt <= 9_007_199_254_740_991,
      record.state.entries.count <= capacity,
      Set(record.state.entries.map(\.nonce)).count == record.state.entries.count,
      record.state.entries.allSatisfy({ (16...255).contains($0.nonce.unicodeScalars.count) && $0.expiresAt > record.state.highWaterAt && $0.expiresAt <= 9_007_199_254_740_991 }),
      record.digest == (try digest(record.state)) else { throw PhoneBrowserFailure.unavailable }
    return record.state
  }

  @discardableResult public func claim(nonce: String, expiresAt: Int64, now: Int64,
    expected: PhoneBrowserReplayState? = nil, proposed: PhoneBrowserReplayState? = nil) throws -> PhoneBrowserReplayState {
    Self.lock.lock(); defer { Self.lock.unlock() }
    let current = try snapshot()
    if let expected, current != expected { throw PhoneBrowserFailure.forbidden }
    let next = try current.claiming(nonce: nonce, expiresAt: expiresAt, now: now, capacity: capacity)
    if let proposed, next != proposed { throw PhoneBrowserFailure.forbidden }
    try persist(next)
    return next
  }

  private func digest(_ state: PhoneBrowserReplayState) throws -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    return IphoneProofs.tokenDigest(String(decoding: try encoder.encode(state), as: UTF8.self))
  }

  private func persist(_ state: PhoneBrowserReplayState) throws {
    try PhoneBrowserDurableFile.write(JSONEncoder().encode(Record(state: state, digest: try digest(state))), to: file)
  }
}
