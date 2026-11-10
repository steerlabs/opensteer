import IphoneApps
import UIKit
import WebKit

@available(iOS 17, *)
final class PhoneBrowserServices: IphoneBrowserServices, @unchecked Sendable {
  static let shared = PhoneBrowserServices()
  private let lock = NSLock()
  private var record: [String: Any] = [:]
  var qualification: [String: Any] { lock.lock(); defer { lock.unlock() }; return record }

  @MainActor func install() throws {
    let pool = PhoneBrowserPool.shared
    try pool.gate.adopt(IphoneBrowserTransport.shared.connection.epoch)
    try PhoneBrowserNative.setAdmission(self, epoch: pool.gate.current)
    try PhoneBrowserNative.setFrameSink(self, epoch: pool.gate.current)
    IphoneBrowserTransport.shared.register(self)
  }

  func qualified(_ value: [String: Any]) {
    lock.lock(); record = value; lock.unlock()
  }

  func fence(epoch: Int, reason: String) {
    try? PhoneBrowserPool.epochGate.adopt(epoch)
    Task { @MainActor in
      let pool = PhoneBrowserPool.shared
      guard pool.gate.current == epoch else { return }
      pool.invalidateWork(before: epoch + 1)
      for tab in pool.tabs.values where pool.state.tabs[tab.id] == .live {
        tab.webView?.removeFromSuperview()
        for discarded in (try? pool.state.suspend(tab.id)) ?? [] { pool.releaseView(discarded) }
      }
      if reason != "manager-fenced" { pool.setForeground(false) }
    }
  }

  func eraseDeployment(_ deploymentId: String, completion: @escaping (Bool) -> Void) {
    Task { @MainActor in
      do {
        let pool = PhoneBrowserPool.shared
        try pool.stores.prepareErasure(deploymentId)
        let input = BrowserDeploymentInput()
        input.epoch = pool.gate.current; input.deploymentId = deploymentId
        let entries = try await pool.eraseDeployment(input)
        completion(entries.allSatisfy { $0["state"] as? String == "deleted" })
      } catch { completion(false) }
    }
  }
}

@available(iOS 17, *)
@MainActor extension PhoneBrowserServices: PhoneBrowserAdmission {
  func allocation(permit: String, binding: [String: Any]?, sessionId: String?, epoch: Int) throws {
    let authority = try IphoneBrowserTransport.shared.allocationPermit(permit, epoch: epoch)
    if let sessionId, authority.claims["sessionId"] as? String != sessionId { throw BrowserRefusal.forbidden }
    if let binding {
      guard let identity = authority.claims["identity"] as? [String: Any], identity["kind"] as? String == "profile-local",
        let expected = identity["binding"] as? NSDictionary, expected == binding as NSDictionary else { throw BrowserRefusal.forbidden }
    } else if sessionId != nil {
      guard let identity = authority.claims["identity"] as? [String: Any], identity["kind"] as? String == "fresh" else { throw BrowserRefusal.forbidden }
    }
  }

  func action(channelId: String, attachmentId: String, actorToken: String, sessionId: String, epoch: Int) throws {
    try IphoneBrowserTransport.shared.connection.checkAgent(epoch: epoch, channelId: channelId,
      sessionId: sessionId, attachmentId: attachmentId, actorToken: actorToken)
  }

  func viewer(channelId: String, sessionId: String, epoch: Int, control: Bool) throws {
    try IphoneBrowserTransport.shared.connection.checkViewer(epoch: epoch, channelId: channelId, sessionId: sessionId, control: control)
  }

  func routes(sessionId: String, tabId: String, actorToken: String?) -> [PhoneBrowserEventRoute] {
    IphoneBrowserTransport.shared.connection.eventRoutes(epoch: PhoneBrowserPool.epochGate.current,
      sessionId: sessionId, actorToken: actorToken).map { PhoneBrowserEventRoute(channelId: $0.channelId, actorToken: $0.actorToken) }
  }

}

@available(iOS 17, *)
@MainActor extension PhoneBrowserServices: PhoneBrowserFrameSink {
  func receive(_ frame: PhoneBrowserFrame) -> Bool {
    let pool = PhoneBrowserPool.shared
    guard pool.gate.current == frame.epoch, pool.foreground, let tab = pool.tabs[frame.tabId],
      tab.sessionId == frame.sessionId, tab.generation == frame.generation, tab.documentId == frame.documentId,
      tab.geometryRevision == frame.geometryRevision, let viewport = frame.geometry["nativeViewport"] as? [String: Double] else { return false }
    let size: [String: Any] = ["width": Int(viewport["width"] ?? 0), "height": Int(viewport["height"] ?? 0)]
    do {
      if let channel = frame.channelId, let attachment = frame.attachmentId, let request = frame.requestId {
        try viewer(channelId: channel, sessionId: frame.sessionId, epoch: frame.epoch, control: true)
        let writer = try IphoneBrowserTransport.shared.frameWriter(epoch: frame.epoch, channelId: channel)
        var result: [String: Any] = ["type": "page.capture", "format": frame.mimeType == "image/png" ? "png" : "jpeg",
          "viewport": size, "width": frame.width, "height": frame.height]
        if let clip = frame.clip { result["clip"] = clip }
        writer.writePixelResult(message: ["type": "agent.result", "attachmentId": attachment, "requestId": request,
          "result": result], dataPath: ["result", "data"], pixels: frame.bytes) { _ in }
      } else {
        guard !frame.channelIds.isEmpty else { return false }
        for channel in frame.channelIds {
          try viewer(channelId: channel, sessionId: frame.sessionId, epoch: frame.epoch, control: false)
          let writer = try IphoneBrowserTransport.shared.frameWriter(epoch: frame.epoch, channelId: channel)
          let header: [String: Any] = ["surfaceId": frame.tabId, "frameId": frame.captureRevision,
            "geometryRevision": frame.geometryRevision, "rasterWidth": frame.width, "rasterHeight": frame.height,
            "viewportWidth": size["width"]!, "viewportHeight": size["height"]!,
            "capture": size.merging(["revision": frame.captureRevision]) { _, next in next },
            "encoding": frame.mimeType == "image/png" ? "png" : "jpeg", "watchToken": frame.token]
          writer.writeFrame(header: header, pixels: frame.bytes) { accepted in
            if !accepted {
              Task { @MainActor in
                if pool.gate.current == frame.epoch { tab.capture.ack(channel: channel, token: frame.token) }
              }
            }
          }
        }
      }
      return true
    } catch { return false }
  }
}
