import ExpoModulesCore
import UIKit
import WebKit

public struct PhoneBrowserEventRoute {
  public let channelId: String
  public let actorToken: String
  public init(channelId: String, actorToken: String) { self.channelId = channelId; self.actorToken = actorToken }
}

@MainActor public protocol PhoneBrowserAdmission: AnyObject {
  func allocation(permit: String, binding: [String: Any]?, sessionId: String?, epoch: Int) throws
  func action(channelId: String, attachmentId: String, actorToken: String, sessionId: String, epoch: Int) throws
  func viewer(channelId: String, sessionId: String, epoch: Int, control: Bool) throws
  func routes(sessionId: String, tabId: String, actorToken: String?) -> [PhoneBrowserEventRoute]
}

@available(iOS 17, *)
@MainActor extension PhoneBrowserNative {
  public static func setAdmission(_ admission: (any PhoneBrowserAdmission)?, epoch: Int) throws {
    let pool = PhoneBrowserPool.shared
    try pool.gate.perform(epoch) { pool.admission = admission }
  }
}

protocol BrowserReference {
  var epoch: Int { get }
  var sessionId: String { get }
  var tabId: String { get }
  var generation: Int { get }
}
extension BrowserTabInput: BrowserReference {}
extension BrowserMountInput: BrowserReference {}
extension BrowserUnmountInput: BrowserReference {}
extension BrowserResizeInput: BrowserReference {}
extension BrowserNavigationInput: BrowserReference {}
extension BrowserDialogInput: BrowserReference {}
extension BrowserUploadInput: BrowserReference {}
extension BrowserCaptureInput: BrowserReference {}
extension BrowserCaptureDemand: BrowserReference {}
extension BrowserAckInput: BrowserReference {}

struct BrowserWireInput: Record, BrowserReference {
  @Field var epoch: Int = -1
  @Field var sessionId: String = ""
  @Field var tabId: String = ""
  @Field var generation: Int = -1
  @Field var documentId: String = ""
  @Field var geometryRevision: Int = -1
  @Field var channelId: String = ""
  @Field var attachmentId: String = ""
  @Field var actorToken: String = ""
  @Field var requestId: String = ""
  @Field var deadline: Double = 0
  @Field var request: [String: Any] = [:]
  @Field var message: [String: Any] = [:]
}

@available(iOS 17, *)
@MainActor extension PhoneBrowserPool {
  func checked(_ input: any BrowserReference, document: String? = nil, geometry: Int? = nil,
    live: Bool = true) throws -> PhoneBrowserTab {
    try gate.check(input.epoch)
    let tab = try tab(input.tabId, live: live)
    guard tab.sessionId == input.sessionId, tab.generation == input.generation else { throw BrowserRefusal.targetClosed }
    if let document, document != tab.documentId || document.isEmpty { throw BrowserRefusal.staleDocument }
    if let geometry, geometry != tab.geometryRevision { throw BrowserRefusal.staleGeometry }
    return tab
  }

  func portMetadata(_ tab: PhoneBrowserTab) -> [String: Any] {
    let old = metadata(tab)
    return ["generation": tab.generation, "revision": tab.revision, "documentId": tab.documentId,
      "geometryRevision": tab.geometryRevision, "captureRevision": tab.captureRevision,
      "title": old["title"]!, "url": old["url"]!, "loading": old["loading"]!,
      "navigationFailed": tab.failedURL != nil, "canGoBack": old["canGoBack"]!, "canGoForward": old["canGoForward"]!,
      "width": tab.webView?.bounds.width ?? 0, "height": tab.webView?.bounds.height ?? 0]
  }

  func reference(_ tab: PhoneBrowserTab) -> [String: Any] {
    ["epoch": gate.current, "sessionId": tab.sessionId, "tabId": tab.id, "generation": tab.generation]
  }

  func portEvents(_ name: String, _ body: [String: Any]) -> [[String: Any]] {
    if name == "agentEvent", let attachment = body["attachmentId"] as? String, let payload = body["event"] as? [String: Any] {
      return [["type": name, "epoch": gate.current, "attachmentId": attachment, "event": payload]]
    }
    if name == "memoryPressure" { return [["type": name, "epoch": gate.current, "level": body["level"] ?? "critical"]] }
    if name == "rendererGone" {
      let affected = (body["tabIds"] as? [String] ?? []).compactMap { tabs[$0] }.map(reference)
      return [["type": name, "epoch": gate.current, "tabs": affected]]
    }
    guard let id = body["tabId"] as? String, let tab = tabs[id] else { return [] }
    var event = reference(tab)
    event["type"] = name
    switch name {
    case "tabChanged", "documentChanged", "geometry", "navigationCommitted", "popup":
      event["metadata"] = portMetadata(tab)
      if name == "navigationCommitted" { event["navigationId"] = body["navigationId"] }
      if name == "popup" { event["openerId"] = body["openerId"]; event["consumerToken"] = body["consumerToken"] }
    case "dialog":
      event["documentId"] = body["documentId"]
      event["geometryRevision"] = tab.geometryRevision
      if let dialog = body["dialog"] as? [String: Any] {
        event["dialog"] = ["id": dialog["id"]!, "surfaceId": tab.id, "type": dialog["kind"]!,
          "message": String((dialog["message"] as? String ?? "").prefix(10000))]
      } else { event["dialog"] = NSNull(); event["dialogId"] = body["dialogId"] }
    case "upload":
      for key in ["chooserId", "accept", "multiple"] { event[key] = body[key] }
      event["documentId"] = body["documentId"]; event["geometryRevision"] = tab.geometryRevision
    case "download":
      for key in ["downloadId", "name", "received", "total"] { event[key] = body[key] }
      let state = body["state"] as? String
      event["state"] = state == "downloading" ? "receiving" : state == "complete" ? "complete" : "failed"
    case "serverMessage":
      event["documentId"] = tab.documentId; event["geometryRevision"] = tab.geometryRevision
      event["channelId"] = body["channelId"]; event["message"] = body["message"]
    case "activity", "editing":
      guard let admission, !tab.documentId.isEmpty else { return [] }
      event["documentId"] = tab.documentId; event["geometryRevision"] = tab.geometryRevision
      return admission.routes(sessionId: tab.sessionId, tabId: tab.id, actorToken: body["actorToken"] as? String).compactMap { route in
        if name == "activity", UUID(uuidString: route.actorToken) == nil { return nil }
        var routed = event
        routed["channelId"] = route.channelId
        if name == "activity" {
          tab.activitySequence += 1
          routed["report"] = ["type": "browser.activity", "actorToken": route.actorToken, "surfaceId": tab.id,
            "seq": tab.activitySequence, "geometryRevision": tab.geometryRevision, "pointer": body["pointer"] ?? NSNull()]
        } else {
          let context = body["context"] as? [String: Any] ?? [:]
          routed["context"] = ["contextId": context["contextId"] ?? UUID().uuidString,
            "field": context["field"] ?? NSNull(), "caret": NSNull()]
        }
        return routed
      }
    default: return []
    }
    return [event]
  }

  func qualification(_ input: BrowserInitializeInput) async throws -> [String: Any] {
    guard UIApplication.shared.applicationState == .active else { throw BrowserRefusal.notActionable }
    setForeground(true)
    _ = try await initialize(input)
    let result = await qualify(epoch: input.epoch)
    try gate.check(input.epoch)
    PhoneBrowserServices.shared.qualified(result)
    return result
  }

  func portCreate(_ input: BrowserCreateInput) async throws -> [String: Any] {
    try gate.check(input.epoch)
    guard let admission else { throw BrowserRefusal.forbidden }
    guard ["live", "retained"].contains(input.state) else { throw BrowserRefusal.invalidArgument }
    let existingBinding = input.storeHandle.flatMap { stores.held[$0]?.binding }.map(stores.bindingDictionary)
    try admission.allocation(permit: input.allocationPermit, binding: existingBinding, sessionId: input.sessionId, epoch: input.epoch)
    if input.storeHandle == nil {
      let guest = BrowserProfileInput()
      guest.epoch = input.epoch; guest.guestSessionId = input.sessionId
      let result = try await stores.ensure(guest, gate: gate)
      input.storeHandle = result["storeHandle"] as? String
    }
    if input.url == "about:blank" { input.url = nil }
    try gate.check(input.epoch)
    let binding = input.storeHandle.flatMap { stores.held[$0]?.binding }.map(stores.bindingDictionary)
    try admission.allocation(permit: input.allocationPermit, binding: binding, sessionId: input.sessionId, epoch: input.epoch)
    _ = try await create(input)
    try gate.check(input.epoch)
    return portMetadata(try tab(input.tabId, live: false))
  }

  func portMount(_ input: BrowserMountInput) async throws -> [String: Any] {
    let tab = try checked(input)
    _ = try await mount(input)
    _ = try checked(input)
    return portMetadata(tab)
  }

  func portResize(_ input: BrowserResizeInput) async throws -> [String: Any] {
    let tab = try checked(input, document: input.documentId, geometry: input.geometryRevision)
    _ = try await resize(input)
    _ = try checked(input, document: input.documentId)
    return portMetadata(tab)
  }

  func portSuspend(_ input: BrowserTabInput) async throws {
    let tab = try checked(input, live: false)
    guard ["retained", "discarded"].contains(input.state) else { throw BrowserRefusal.invalidArgument }
    if input.state == "discarded" {
      try gate.perform(input.epoch) { try state.discard(tab.id); releaseView(tab.id) }
    } else if state.tabs[tab.id] == .live { _ = try await suspend(input) }
    else if state.tabs[tab.id] != .retained { throw BrowserRefusal.targetSuspended }
  }

  func portResume(_ input: BrowserTabInput) async throws -> [String: Any] {
    let tab = try checked(input, live: false)
    _ = try await resume(input)
    _ = try checked(input)
    return portMetadata(tab)
  }
}
