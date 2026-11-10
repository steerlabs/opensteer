import WebKit

@available(iOS 17, *)
@MainActor final class BrowserStores {
  struct HeldStore {
    let store: WKWebsiteDataStore
    let binding: ProfileBinding?
    let sessionId: String?
  }
  private var manifest = ProfileManifest()
  private var manifestURL: URL?
  private(set) var held: [String: HeldStore] = [:]
  private(set) var deploymentId = ""
  private(set) var runnerId = ""
  private var erasing = Set<UUID>()

  func initialize(deploymentId: String, runnerId: String) throws {
    guard !deploymentId.isEmpty, !runnerId.isEmpty else { throw BrowserRefusal.invalidArgument }
    if manifestURL == nil {
      var directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("PhoneBrowser", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      let url = directory.appendingPathComponent("profiles.json")
      if FileManager.default.fileExists(atPath: url.path) {
        manifest = try JSONDecoder().decode(ProfileManifest.self, from: Data(contentsOf: url))
        guard manifest.version == 1 else { throw BrowserRefusal.storageMissing }
      }
      manifestURL = url
      try save()
    }
    if self.deploymentId != deploymentId || self.runnerId != runnerId { held.removeAll() }
    self.deploymentId = deploymentId
    self.runnerId = runnerId
  }

  var storageInstanceId: String { manifest.storageInstanceId.uuidString.lowercased() }

  private func save() throws {
    guard var url = manifestURL else { throw BrowserRefusal.notActionable }
    try JSONEncoder().encode(manifest).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.synchronize()
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }

  func ensure(_ input: BrowserProfileInput, gate: EpochGate) async throws -> [String: Any] {
    try gate.check(input.epoch)
    guard manifestURL != nil else { throw BrowserRefusal.notActionable }
    if let session = input.guestSessionId {
      guard input.binding == nil, !session.isEmpty else { throw BrowserRefusal.invalidArgument }
      return try gate.perform(input.epoch) {
        if let existing = held.first(where: { $0.value.sessionId == session }) { return ["storeHandle": existing.key, "guest": true] }
        let handle = UUID().uuidString
        held[handle] = HeldStore(store: .nonPersistent(), binding: nil, sessionId: session)
        return ["storeHandle": handle, "guest": true]
      }
    }
    guard let binding = try input.binding?.value(), binding.deploymentId == deploymentId,
      binding.runnerId == runnerId, binding.storageInstanceId.uuidString.lowercased() == storageInstanceId else {
      throw BrowserRefusal.bindingMismatch
    }
    let identifiers = Set(await WKWebsiteDataStore.allDataStoreIdentifiers)
    return try gate.perform(input.epoch) {
      if let current = held.first(where: { $0.value.binding == binding }) { return ["storeHandle": current.key, "guest": false] }
      let identifier = try manifest.ensure(binding, initialized: input.initialized, identifiers: identifiers)
      try save()
      let handle = UUID().uuidString
      held[handle] = HeldStore(store: WKWebsiteDataStore(forIdentifier: identifier), binding: binding, sessionId: nil)
      return ["storeHandle": handle, "guest": false]
    }
  }

  func store(_ handle: String, session: String) throws -> WKWebsiteDataStore {
    guard let held = held[handle], held.sessionId == nil || held.sessionId == session else { throw BrowserRefusal.bindingMismatch }
    if let binding = held.binding {
      guard binding.deploymentId == deploymentId, binding.runnerId == runnerId else { throw BrowserRefusal.bindingMismatch }
    }
    return held.store
  }

  func inventory(_ deployment: String) -> [[String: Any]] {
    manifest.entries.filter { $0.binding.deploymentId == deployment }.map { entry in
      var result: [String: Any] = ["binding": bindingDictionary(entry.binding), "phase": entry.deletionId == nil ? "ready" : "deleted"]
      if let deletion = entry.deletionId {
        result["deletionId"] = deletion.uuidString.lowercased()
        result["erasure"] = entry.erased ? "deleted" : "pending-restart"
      }
      return result
    }
  }

  func bindings(_ deployment: String) -> [ProfileBinding] { manifest.entries.filter { $0.binding.deploymentId == deployment }.map(\.binding) }
  func handles(_ binding: ProfileBinding) -> [String] { held.filter { $0.value.binding == binding }.map(\.key) }
  func endGuest(_ session: String) { held = held.filter { $0.value.sessionId != session } }
  func releaseHeld() { held.removeAll() }
  func markInitialized(_ handle: String) throws {
    guard let binding = held[handle]?.binding else { return }
    try manifest.markInitialized(binding)
    try save()
    let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
    for name in ["WebKit", "Cookies"] {
      var directory = library.appendingPathComponent(name, isDirectory: true)
      if FileManager.default.fileExists(atPath: directory.path) {
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
      }
    }
  }

  func tombstone(_ binding: ProfileBinding, deletionId: UUID) throws {
    try manifest.beginErasure(binding, deletionId: deletionId)
    try save()
    for handle in handles(binding) { held.removeValue(forKey: handle) }
  }

  func erase(_ binding: ProfileBinding) async throws -> String {
    guard let entry = manifest.entries.first(where: { $0.binding == binding }), entry.deletionId != nil else {
      throw BrowserRefusal.bindingMismatch
    }
    if entry.erased { return "deleted" }
    guard erasing.insert(entry.identifier).inserted else { return "pending-restart" }
    defer { erasing.remove(entry.identifier) }
    do {
      await clear(identifier: entry.identifier)
      try await WKWebsiteDataStore.remove(forIdentifier: entry.identifier)
      try manifest.completeErasure(binding)
      try save()
      return "deleted"
    } catch { return "pending-restart" }
  }

  private func clear(identifier: UUID) async {
    let store = WKWebsiteDataStore(forIdentifier: identifier)
    await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
  }

  func recoverErasures() async {
    for entry in manifest.entries where entry.deletionId != nil && !entry.erased { _ = try? await erase(entry.binding) }
  }

  func bindingDictionary(_ binding: ProfileBinding) -> [String: Any] {
    ["version": binding.version, "deploymentId": binding.deploymentId, "profileId": binding.profileId,
      "runnerId": binding.runnerId, "storageInstanceId": binding.storageInstanceId.uuidString.lowercased(),
      "bindingId": binding.bindingId.uuidString.lowercased(), "engine": binding.engine]
  }
}
