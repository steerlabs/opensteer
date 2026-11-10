import Foundation

public struct ProfileBinding: Codable, Equatable, Sendable {
  public var version = 1
  public var deploymentId: String
  public var profileId: String
  public var runnerId: String
  public var storageInstanceId: UUID
  public var bindingId: UUID
  public var engine: String
}

public struct ProfileEntry: Codable, Equatable, Sendable {
  public let binding: ProfileBinding
  public let identifier: UUID
  public var initialized = false
  public var deletionId: UUID?
  public var erased = false
}

public struct ProfileManifest: Codable, Sendable {
  public private(set) var version = 1
  public private(set) var storageInstanceId = UUID()
  public private(set) var entries: [ProfileEntry] = []
  public init() {}

  public mutating func ensure(_ binding: ProfileBinding, initialized: Bool, identifiers: Set<UUID>) throws -> UUID {
    guard binding.version == 1, binding.engine == "wkwebview", !binding.deploymentId.isEmpty,
      !binding.profileId.isEmpty, !binding.runnerId.isEmpty else { throw BrowserRefusal.bindingMismatch }
    if let index = entries.firstIndex(where: { $0.binding.deploymentId == binding.deploymentId && $0.binding.profileId == binding.profileId }) {
      let entry = entries[index]
      guard entry.binding == binding else { throw BrowserRefusal.bindingMismatch }
      guard entry.deletionId == nil else { throw BrowserRefusal.profileDeleted }
      guard identifiers.contains(entry.identifier) || (!initialized && !entry.initialized) else { throw BrowserRefusal.storageMissing }
      if initialized { entries[index].initialized = true }
      return entry.identifier
    }
    guard !initialized else { throw BrowserRefusal.storageMissing }
    let identifier = UUID()
    entries.append(ProfileEntry(binding: binding, identifier: identifier))
    return identifier
  }

  public mutating func markInitialized(_ binding: ProfileBinding) throws {
    guard let index = entries.firstIndex(where: { $0.binding == binding }), entries[index].deletionId == nil else { throw BrowserRefusal.bindingMismatch }
    entries[index].initialized = true
  }

  public mutating func beginErasure(_ binding: ProfileBinding, deletionId: UUID) throws {
    if let index = entries.firstIndex(where: { $0.binding.deploymentId == binding.deploymentId && $0.binding.profileId == binding.profileId }) {
      guard entries[index].binding == binding else { throw BrowserRefusal.bindingMismatch }
      if entries[index].deletionId == nil { entries[index].deletionId = deletionId }
    } else {
      entries.append(ProfileEntry(binding: binding, identifier: UUID(), deletionId: deletionId))
    }
  }

  public mutating func completeErasure(_ binding: ProfileBinding) throws {
    guard let index = entries.firstIndex(where: { $0.binding == binding }), entries[index].deletionId != nil else {
      throw BrowserRefusal.bindingMismatch
    }
    entries[index].erased = true
  }
}
