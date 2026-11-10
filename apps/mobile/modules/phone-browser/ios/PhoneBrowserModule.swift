import ExpoModulesCore

private func browserAsyncFunction<Input: AnyArgument, Output>(_ name: String,
  _ body: sending @escaping @Sendable (Input) async throws -> sending Output) -> ConcurrentFunctionDefinition<Input, Input, Output> {
  AsyncFunction(name) { [body] (input: Input) async throws -> sending Output in
    do { return try await body(input) }
    catch let error as Exception { throw error }
    catch let error as CodedError {
      throw Exception(name: "PhoneBrowserError", description: error.description, code: error.code)
    } catch {
      throw Exception(name: "PhoneBrowserError", description: "outcome-unknown", code: "outcome-unknown")
    }
  }
}

extension BrowserRefusal: CodedError {
  public var code: String { rawValue }
  public var description: String { rawValue }
}

struct BrowserViewport: Record {
  @Field var width: Double = 390
  @Field var height: Double = 600
}

struct BrowserTabInput: Record {
  @Field var state: String = "retained"
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var anchor: BrowserAnchor?
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}

struct BrowserCreateInput: Record {
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var sessionId: String = ""
  @Field var storeHandle: String?
  @Field var allocationPermit: String = ""
  @Field var state: String = "live"
  @Field var navigationId: String?
  @Field var viewport: BrowserViewport = BrowserViewport()
  @Field var url: String?
  @Field var generation: Int = -1
}

struct BrowserMountInput: Record {
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var hostId: String = ""
  @Field var presentationGeneration: Int = 0
  @Field var interactive: Bool = true
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}

struct BrowserDialogInput: Record {
  @Field var documentId: String = ""
  @Field var geometryRevision: Int = -1
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var dialogId: String = ""
  @Field var accept: Bool = false
  @Field var promptText: String?
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}

public final class PhoneBrowserModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PhoneBrowser")
    Events("event")
    OnCreate { [weak self] in
      Task { @MainActor in
        if #available(iOS 17, *) {
          let pool = PhoneBrowserPool.shared
          pool.emit = { [weak self] name, body in
            for event in pool.portEvents(name, body) { self?.sendEvent("event", event) }
          }
        }
      }
    }
    OnDestroy {
      if #available(iOS 17, *) {
        let epoch = PhoneBrowserPool.epochGate.advance()
        Task { @MainActor in
          let pool = PhoneBrowserPool.shared
          pool.invalidateWork(before: epoch)
          pool.setForeground(false)
          pool.emit = nil
          for id in Array(pool.tabs.keys) { pool.destroy(id) }
          pool.stores.releaseHeld()
        }
      }
    }
    Function("fence") { (_: String) -> Int in
      guard #available(iOS 17, *) else { return 0 }
      let epoch = PhoneBrowserPool.epochGate.advance()
      Task { @MainActor in PhoneBrowserPool.shared.invalidateWork(before: epoch) }
      return epoch
    }
    browserAsyncFunction("initialize") { (input: BrowserInitializeInput) async throws -> [String: Any] in
      guard #available(iOS 17, *) else {
        return ["platform": "ios", "runtimeId": "unavailable", "storageInstanceId": "unavailable", "browser": false,
          "sharedControl": false, "agentActions": false, "cdpBoundary": false, "fileStaging": false]
      }
      return try await PhoneBrowserPool.shared.qualification(input)
    }
    browserAsyncFunction("setForeground") { (input: BrowserForegroundInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        try pool.gate.perform(input.epoch) { pool.setForeground(input.active) }
      }
    }
    browserAsyncFunction("ensureProfile") { (input: BrowserProfileInput) async throws -> String in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await Self.ensureProfile(input)
    }
    browserAsyncFunction("listProfiles") { (input: BrowserDeploymentInput) async throws -> [[String: Any]] in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        return try pool.gate.perform(input.epoch) { pool.stores.inventory(input.deploymentId) }
      }
    }
    browserAsyncFunction("eraseProfile") { (input: BrowserProfileInput) async throws -> String in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await PhoneBrowserPool.shared.eraseProfile(input)["state"] as? String ?? "pending-restart"
    }
    browserAsyncFunction("eraseDeployment") { (input: BrowserDeploymentInput) async throws -> [[String: Any]] in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      _ = try await PhoneBrowserPool.shared.eraseDeployment(input)
      return await PhoneBrowserPool.shared.stores.inventory(input.deploymentId)
    }
    browserAsyncFunction("createTab") { (input: BrowserCreateInput) async throws -> [String: Any] in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await PhoneBrowserPool.shared.portCreate(input)
    }
    browserAsyncFunction("destroyTab") { (input: BrowserTabInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        try pool.gate.perform(input.epoch) { _ = try pool.checked(input, live: false); pool.destroy(input.tabId) }
      }
    }
    browserAsyncFunction("suspendTab") { (input: BrowserTabInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await PhoneBrowserPool.shared.portSuspend(input)
    }
    browserAsyncFunction("resumeTab") { (input: BrowserTabInput) async throws -> [String: Any] in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await PhoneBrowserPool.shared.portResume(input)
    }
    browserAsyncFunction("mountTab") { (input: BrowserMountInput) async throws -> [String: Any] in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await PhoneBrowserPool.shared.portMount(input)
    }
    browserAsyncFunction("unmountTab") { (input: BrowserUnmountInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        _ = try pool.checked(input)
        try pool.unmount(input)
      }
    }
    browserAsyncFunction("resizeTab") { (input: BrowserResizeInput) async throws -> [String: Any] in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await PhoneBrowserPool.shared.portResize(input)
    }
    browserAsyncFunction("navigate") { (input: BrowserNavigationInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        _ = try pool.checked(input, document: input.documentId, geometry: input.geometryRevision)
        _ = try pool.navigate(input)
      }
    }
    browserAsyncFunction("respondDialog") { (input: BrowserDialogInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        _ = try pool.checked(input, document: input.documentId, geometry: input.geometryRevision)
        try pool.respondDialog(input)
      }
    }
    browserAsyncFunction("respondUpload") { (input: BrowserUploadInput) async throws -> [[String: Any]] in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        _ = try pool.checked(input, document: input.documentId, geometry: input.geometryRevision)
        return try pool.respondUpload(input)
      }
    }
    browserAsyncFunction("performAction") { (input: BrowserWireInput) async throws -> [String: Any] in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await PhoneBrowserPool.shared.wireAction(input)
    }
    browserAsyncFunction("applyViewerInput") { (input: BrowserWireInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await PhoneBrowserPool.shared.wireViewer(input)
    }
    browserAsyncFunction("setCaptureDemand") { (input: BrowserCaptureDemand) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        try pool.gate.perform(input.epoch) {
          let tab = try pool.checked(input, live: false)
          guard input.maxFps == 8, let admission = pool.admission else { throw BrowserRefusal.forbidden }
          try admission.viewer(channelId: input.channelId, sessionId: input.sessionId, epoch: input.epoch)
          try tab.capture.set(channel: input.channelId, density: input.density, frames: input.frames, window: input.frameWindow)
          tab.captureEpoch = input.epoch
          pool.capture.refresh()
        }
      }
    }
    browserAsyncFunction("ackFrame") { (input: BrowserAckInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        try pool.gate.perform(input.epoch) {
          let tab = try pool.checked(input, live: false)
          guard let admission = pool.admission else { throw BrowserRefusal.forbidden }
          try admission.viewer(channelId: input.channelId, sessionId: input.sessionId, epoch: input.epoch)
          tab.capture.ack(channel: input.channelId, token: input.token)
        }
      }
    }
    browserAsyncFunction("captureOnce") { (input: BrowserCaptureInput) async throws -> String in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await Self.captureOnce(input)
    }
    browserAsyncFunction("stageChunk") { (input: BrowserStageInput) async throws -> [String: Any] in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      return try await MainActor.run { try PhoneBrowserPool.shared.files.portStage(input) }
    }
    browserAsyncFunction("finishSessionFiles") { (input: BrowserSessionInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        try pool.gate.perform(input.epoch) {
          for tab in pool.tabs.values where tab.sessionId == input.sessionId { pool.cancelChooser(tab) }
          pool.files.finishSession(input.sessionId)
          if !pool.tabs.values.contains(where: { $0.sessionId == input.sessionId }) { pool.stores.endGuest(input.sessionId) }
        }
      }
    }
    browserAsyncFunction("cancelDownload") { (input: BrowserDownloadInput) async throws in
      guard #available(iOS 17, *) else { throw BrowserRefusal.unsupportedOperation }
      try await MainActor.run {
        let pool = PhoneBrowserPool.shared
        try pool.gate.perform(input.epoch) { try pool.files.cancel(input.downloadId, session: input.sessionId) }
      }
    }
    View(PhoneBrowserHostView.self) {
      ViewName("PhoneBrowserHost")
      Events("onReady")
      Prop("hostId") { (view: PhoneBrowserHostView, value: String) in view.hostId = value }
    }
    View(PhoneBrowserPictureView.self) {
      ViewName("PhoneBrowserPicture")
      Prop("tabId") { (view: PhoneBrowserPictureView, value: String) in view.tabId = value }
    }
    View(PhoneBrowserDownloadView.self) {
      ViewName("PhoneBrowserDownload")
      Prop("downloadId") { (view: PhoneBrowserDownloadView, value: String) in view.downloadId = value }
    }
  }

  @available(iOS 17, *) @MainActor private static func ensureProfile(_ input: BrowserProfileInput) async throws -> String {
    let pool = PhoneBrowserPool.shared
    try pool.gate.check(input.epoch)
    guard let admission = pool.admission, let binding = try input.binding?.value(), input.guestSessionId == nil else { throw BrowserRefusal.forbidden }
    try admission.allocation(permit: input.allocationPermit, binding: pool.stores.bindingDictionary(binding), sessionId: nil, epoch: input.epoch)
    let result = try await pool.stores.ensure(input, gate: pool.gate)
    guard let handle = result["storeHandle"] as? String else { throw BrowserRefusal.outcomeUnknown }
    return handle
  }

  @available(iOS 17, *) @MainActor private static func captureOnce(_ input: BrowserCaptureInput) async throws -> String {
    let pool = PhoneBrowserPool.shared
    _ = try pool.checked(input, document: input.documentId, geometry: input.geometryRevision)
    guard let admission = pool.admission else { throw BrowserRefusal.forbidden }
    try admission.viewer(channelId: input.channelId, sessionId: input.sessionId, epoch: input.epoch)
    let result = try await pool.capture.once(input)
    guard let artifact = result["artifactId"] as? String else { throw BrowserRefusal.outcomeUnknown }
    return artifact
  }
}
