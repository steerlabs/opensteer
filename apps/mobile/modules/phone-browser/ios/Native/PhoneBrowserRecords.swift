import ExpoModulesCore

struct BrowserEpochInput: Record {
  @Field var epoch: Int = -1
}
struct BrowserInitializeInput: Record {
  @Field var epoch: Int = -1
  @Field var deploymentId: String = ""
  @Field var runnerId: String = ""
}
struct BrowserForegroundInput: Record {
  @Field var epoch: Int = -1
  @Field var active: Bool = false
}
struct BrowserBinding: Record {
  @Field var version: Int = 1
  @Field var deploymentId: String = ""
  @Field var profileId: String = ""
  @Field var runnerId: String = ""
  @Field var storageInstanceId: String = ""
  @Field var bindingId: String = ""
  @Field var engine: String = ""

  func value() throws -> ProfileBinding {
    guard version == 1, let storage = UUID(uuidString: storageInstanceId), let binding = UUID(uuidString: bindingId) else {
      throw BrowserRefusal.bindingMismatch
    }
    return ProfileBinding(deploymentId: deploymentId, profileId: profileId, runnerId: runnerId,
      storageInstanceId: storage, bindingId: binding, engine: engine)
  }
}
struct BrowserProfileInput: Record {
  @Field var epoch: Int = -1
  @Field var binding: BrowserBinding?
  @Field var initialized: Bool = false
  @Field var allocationPermit: String = ""
  @Field var guestSessionId: String?
  @Field var deletionId: String?
}
struct BrowserDeploymentInput: Record {
  @Field var epoch: Int = -1
  @Field var deploymentId: String = ""
}
struct BrowserUnmountInput: Record {
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var presentationGeneration: Int = -1
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}
struct BrowserAnchor: Record {
  @Field var path: [Int]?
  @Field var offset: Double = 0
  @Field var x: Double = 0
  @Field var y: Double = 0
  var dictionary: [String: Any] { ["path": path as Any? ?? NSNull(), "offset": offset, "x": x, "y": y] }
  func validate() throws {
    guard [offset, x, y].allSatisfy(\.isFinite), (path?.count ?? 0) <= 256,
      path?.allSatisfy({ $0 >= 0 && $0 <= 1000000 }) ?? true else { throw BrowserRefusal.invalidArgument }
  }
}
struct BrowserResizeInput: Record {
  @Field var documentId: String = ""
  @Field var geometryRevision: Int = -1
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var width: Double = 0
  @Field var height: Double = 0
  @Field var anchor: BrowserAnchor?
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}
struct BrowserNavigationInput: Record {
  @Field var documentId: String = ""
  @Field var geometryRevision: Int = -1
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var kind: String = ""
  @Field var url: String?
  @Field var ignoreCache: Bool = false
  @Field var navigationId: String?
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}
struct BrowserAction: Record {
  @Field var kind: String = ""
  @Field var selector: String?
  @Field var x: Double = 0
  @Field var y: Double = 0
  @Field var deltaX: Double = 0
  @Field var deltaY: Double = 0
  @Field var text: String = ""
  @Field var selectionStart: Int = 0
  @Field var selectionLength: Int = 0
  @Field var stagedFileIds: [String] = []
}
struct BrowserActionInput: Record {
  @Field var actorToken: String?
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var documentId: String = ""
  @Field var frameId: String?
  @Field var frameDocumentId: String?
  @Field var geometryRevision: Int?
  @Field var contextId: String?
  @Field var timeoutMs: Int = 10000
  @Field var action: BrowserAction = BrowserAction()
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}
struct BrowserCaptureInput: Record {
  @Field var channelId: String = ""
  @Field var attachmentId: String = ""
  @Field var requestId: String = ""
  @Field var documentId: String = ""
  @Field var geometryRevision: Int = -1
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var format: String = "jpeg"
  @Field var quality: Double = 0.7
  @Field var clip: BrowserClip?
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}
struct BrowserClip: Record {
  @Field var x: Double = 0
  @Field var y: Double = 0
  @Field var width: Double = 0
  @Field var height: Double = 0
}
struct BrowserCaptureDemand: Record {
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var channelId: String = ""
  @Field var density: Double = 1
  @Field var frames: Bool = false
  @Field var frameWindow: Int = 1
  @Field var maxFps: Int = 8
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}
struct BrowserAckInput: Record {
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var channelId: String = ""
  @Field var token: String = ""
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}
struct BrowserUploadInput: Record {
  @Field var documentId: String = ""
  @Field var geometryRevision: Int = -1
  @Field var epoch: Int = -1
  @Field var tabId: String = ""
  @Field var chooserId: String = ""
  @Field var stagedFileIds: [String] = []
  @Field var sessionId: String = ""
  @Field var generation: Int = -1
}
struct BrowserStageInput: Record {
  @Field var epoch: Int = -1
  @Field var sessionId: String = ""
  @Field var fileId: String = ""
  @Field var name: String = ""
  @Field var data: String = ""
  @Field var offset: Int = 0
  @Field var size: Int?
  @Field var last: Bool = false
}
struct BrowserSessionInput: Record {
  @Field var epoch: Int = -1
  @Field var sessionId: String = ""
}
struct BrowserDownloadInput: Record {
  @Field var sessionId: String = ""
  @Field var epoch: Int = -1
  @Field var downloadId: String = ""
}
