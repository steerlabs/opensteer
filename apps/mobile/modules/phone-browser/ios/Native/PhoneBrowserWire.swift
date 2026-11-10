import ExpoModulesCore
import UIKit
import WebKit

struct BrowserHelperRefusal: CodedError {
  let code: String
  let description: String
}

@available(iOS 17, *)
@MainActor extension PhoneBrowserPool {
  func authorize(_ input: BrowserWireInput, viewer: Bool) throws -> PhoneBrowserTab {
    let tab = try checked(input, document: input.documentId, geometry: input.geometryRevision)
    guard foreground, let admission else { throw BrowserRefusal.forbidden }
    if viewer { try admission.viewer(channelId: input.channelId, sessionId: tab.sessionId, epoch: input.epoch) }
    else {
      guard input.deadline.isFinite, input.deadline > Date().timeIntervalSince1970 * 1000 else { throw BrowserRefusal.timeout }
      try admission.action(channelId: input.channelId, attachmentId: input.attachmentId,
        actorToken: input.actorToken, sessionId: tab.sessionId, epoch: input.epoch)
    }
    return tab
  }

  func wireAction(_ input: BrowserWireInput) async throws -> [String: Any] {
    let tab = try authorize(input, viewer: false)
    let request = input.request
    guard request["sessionId"] as? String == tab.sessionId, request["surfaceId"] as? String == tab.id,
      request["documentId"] as? String == tab.documentId,
      let action = request["action"] as? [String: Any], let type = action["type"] as? String,
      let timeout = request["timeoutMs"] as? Int, (1...30000).contains(timeout),
      try JSONSerialization.data(withJSONObject: request).count <= 432 * 1024 else { throw BrowserRefusal.invalidArgument }
    if let geometry = request["geometryRevision"] as? Int, geometry != tab.geometryRevision { throw BrowserRefusal.staleGeometry }
    let remaining = min(timeout, Int(min(30000, max(0, input.deadline - Date().timeIntervalSince1970 * 1000))))
    guard remaining > 0 else { throw BrowserRefusal.timeout }
    let primitive = BrowserActionInput()
    primitive.epoch = input.epoch; primitive.tabId = tab.id; primitive.documentId = tab.documentId
    primitive.geometryRevision = input.geometryRevision; primitive.timeoutMs = remaining
    primitive.actorToken = input.actorToken
    switch type {
    case "page.navigate", "page.history":
      let navigation = BrowserNavigationInput()
      navigation.epoch = input.epoch; navigation.tabId = tab.id
      navigation.kind = type == "page.navigate" ? "go" : action["direction"] as? String ?? ""
      navigation.url = action["url"] as? String
      _ = try navigate(navigation)
      if type == "page.history" { return ["type": type] }
      try await waitReady(tab, timeoutMs: remaining, epoch: input.epoch)
      try gate.check(input.epoch)
      guard let admission else { throw BrowserRefusal.forbidden }
      try admission.action(channelId: input.channelId, attachmentId: input.attachmentId,
        actorToken: input.actorToken, sessionId: tab.sessionId, epoch: input.epoch)
      return ["type": type, "binding": ["surfaceId": tab.id, "documentId": tab.documentId,
        "geometryRevision": tab.geometryRevision, "state": "live", "title": String((tab.webView?.title ?? "").prefix(1000)),
        "url": tab.webView?.url?.absoluteString ?? "about:blank"]]
    case "file.stage":
      let staged = BrowserStageInput()
      staged.epoch = input.epoch; staged.sessionId = tab.sessionId
      guard let id = action["fileId"] as? String, let name = action["name"] as? String,
        let offset = action["offset"] as? Int, let data = action["data"] as? String else { throw BrowserRefusal.invalidArgument }
      staged.fileId = id; staged.name = name; staged.offset = offset; staged.data = data; staged.size = action["size"] as? Int
      var result = try files.portStage(staged); result["type"] = type
      return result
    case "text.insert", "text.key", "text.selectAll", "scroll", "pointer.tap":
      primitive.action.kind = type
      if type == "text.key" {
        guard let key = action["key"] as? String, ["Enter", "Backspace"].contains(key) else { throw BrowserRefusal.unsupportedOperation }
        primitive.action.kind = key == "Enter" ? "text.enter" : "text.backspace"
      }
      if type == "pointer.tap", action["count"] as? Int != 1 { throw BrowserRefusal.unsupportedOperation }
      if type == "scroll", action["locator"] != nil {
        return try await invokeAgent(input, tab: tab, name: "scroll", args: action, timeout: remaining)
      }
      primitive.action.text = action["text"] as? String ?? ""
      primitive.action.x = action["x"] as? Double ?? 0; primitive.action.y = action["y"] as? Double ?? 0
      primitive.action.deltaX = action["deltaX"] as? Double ?? 0; primitive.action.deltaY = action["deltaY"] as? Double ?? 0
      _ = try authorize(input, viewer: false)
      let result = try await perform(primitive, viewer: false)
      if type == "scroll" { return ["type": type, "source": "native", "x": result["x"]!, "y": result["y"]!] }
      return ["type": type]
    case "dom.query", "dom.snapshot", "dom.act", "dom.wait":
      let name = ["dom.query": "query", "dom.snapshot": "snapshot", "dom.act": "act", "dom.wait": "wait"][type]!
      var args = action
      if type == "dom.wait" { args = ["id": input.requestId, "locator": action["locator"]!, "state": action["state"]!] }
      let result = try await invokeAgent(input, tab: tab, name: name, args: args, timeout: remaining)
      if result["kind"] as? String == "native-text" {
        _ = try authorize(input, viewer: false)
        guard let view = tab.webView, let window = view.window else { throw BrowserRefusal.notActionable }
        try protectResponder(view, window: window)
        let focus = try await invokeAgent(input, tab: tab, name: "focus", args: ["locator": action["locator"]!], timeout: remaining)
        guard focus["focused"] as? Bool == true else { throw BrowserRefusal.notActionable }
        return try gate.perform(input.epoch) {
          _ = try authorize(input, viewer: false)
          try protectResponder(view, window: window)
          guard view.becomeFirstResponder(), let responder = firstResponder(in: view), let keyInput = responder as? UIKeyInput,
            let text = result["text"] as? String else { throw BrowserRefusal.notActionable }
          responder.selectAll(nil)
          if text.isEmpty { keyInput.deleteBackward() } else { keyInput.insertText(text) }
          return ["type": "dom.act", "outcome": text.isEmpty ? "cleared" : "filled", "trusted": true]
        }
      }
      return result
    case "page.capture":
      let capture = BrowserCaptureInput()
      capture.epoch = input.epoch; capture.tabId = tab.id; capture.documentId = tab.documentId
      capture.channelId = input.channelId; capture.attachmentId = input.attachmentId; capture.requestId = input.requestId
      capture.format = action["format"] as? String ?? "jpeg"
      capture.quality = (action["quality"] as? Double ?? 70) / 100
      if let clip = action["clip"] as? [String: Double] {
        let rect = BrowserClip(); rect.x = clip["x"] ?? -1; rect.y = clip["y"] ?? -1
        rect.width = clip["width"] ?? 0; rect.height = clip["height"] ?? 0; capture.clip = rect
      }
      _ = try await self.capture.once(capture)
      return ["type": "delivered"]
    default: throw BrowserRefusal.unsupportedOperation
    }
  }

  func invokeAgent(_ input: BrowserWireInput, tab: PhoneBrowserTab, name: String, args: [String: Any], timeout: Int) async throws -> [String: Any] {
    guard ["query", "snapshot", "act", "tap", "focus", "scroll", "wait"].contains(name) else { throw BrowserRefusal.unsupportedOperation }
    if ["act", "tap", "focus"].contains(name), let view = tab.webView, let window = view.window {
      try protectResponder(view, window: window)
    }
    let operation = name == "wait" ? args["id"] as? String ?? UUID().uuidString : UUID().uuidString
    tab.agentOperations.insert(operation)
    defer { tab.agentOperations.remove(operation); tab.agentFrames.removeValue(forKey: operation) }
    do {
      let remaining = min(timeout, Int(min(30000, max(0, input.deadline - Date().timeIntervalSince1970 * 1000))))
      guard remaining > 0 else { throw BrowserRefusal.timeout }
      var routedArgs = args
      var frame: WKFrameInfo?
      if let frameId = routedArgs.removeValue(forKey: "frameId") as? String {
        guard let selected = tab.frames[frameId], tab.frameDocuments[frameId] != nil else { throw BrowserRefusal.staleDocument }
        frame = selected
        tab.agentFrames[operation] = selected
      }
      let envelope: [String: Any] = ["name": name, "args": routedArgs, "operationId": operation]
      let reply = try await helper(tab, function: "agent", arguments: ["argument": envelope], frame: frame, epoch: input.epoch, timeoutMs: remaining)
      _ = try authorize(input, viewer: false)
      guard let body = reply as? [String: Any], try JSONSerialization.data(withJSONObject: body).count <= 432 * 1024 else { throw BrowserRefusal.tooLarge }
      if let error = body["error"] as? [String: String] {
        let allowed = ["unsupported-operation", "stale-document", "stale-geometry", "ambiguous", "not-found", "not-actionable", "timeout", "too-large", "outcome-unknown"]
        throw BrowserHelperRefusal(code: allowed.contains(error["code"] ?? "") ? error["code"]! : "not-actionable", description: "Isolated helper refused the operation")
      }
      guard let result = body["result"] as? [String: Any] else { throw BrowserRefusal.notActionable }
      return result
    } catch {
      cancelAgent(tab, operations: [operation])
      throw error
    }
  }

  func cancelAgent(_ tab: PhoneBrowserTab, operations: Set<String>? = nil) {
    let identifiers = operations ?? tab.agentOperations
    guard !identifiers.isEmpty else { return }
    for id in identifiers {
      tab.webView?.callAsyncJavaScript("const h=globalThis.__opensteerAgentHelper;if(h)h.invoke({documentId:h.documentId,name:'cancel',args:{id}});return true",
        arguments: ["id": id], in: tab.agentFrames[id], in: world) { _ in }
    }
    if operations == nil { tab.agentOperations.removeAll(); tab.agentFrames.removeAll() }
  }

  func wireViewer(_ input: BrowserWireInput) async throws {
    let tab = try authorize(input, viewer: true)
    let message = input.message
    guard message["surfaceId"] as? String == tab.id, let type = message["type"] as? String else { throw BrowserRefusal.invalidArgument }
    let primitive = BrowserActionInput()
    primitive.epoch = input.epoch; primitive.tabId = tab.id; primitive.documentId = tab.documentId
    primitive.geometryRevision = input.geometryRevision; primitive.contextId = tab.contextId
    switch type {
    case "input.pointer", "input.wheel":
      guard message["geometryRevision"] as? Int == tab.geometryRevision,
        message["captureRevision"] as? Int == tab.captureRevision else { throw BrowserRefusal.staleGeometry }
      if type == "input.pointer" {
        guard (message["modifiers"] as? [String] ?? []).isEmpty else { throw BrowserRefusal.unsupportedOperation }
        if message["action"] as? String == "leave" { return }
        if message["action"] as? String == "move", (message["buttons"] as? Int ?? 0) == 0 { return }
        guard ["up", "down"].contains(message["action"] as? String ?? ""), message["button"] as? String == "left",
          (message["clickCount"] as? Int ?? 1) == 1,
          let x = message["x"] as? Double, let y = message["y"] as? Double, (0...1).contains(x), (0...1).contains(y),
          let view = tab.webView else { throw BrowserRefusal.unsupportedOperation }
        if message["action"] as? String == "down" { return }
        primitive.action.kind = "pointer.tap"; primitive.action.x = x * view.bounds.width; primitive.action.y = y * view.bounds.height
      } else {
        primitive.action.kind = "scroll"; primitive.action.deltaX = message["deltaX"] as? Double ?? 0
        primitive.action.deltaY = message["deltaY"] as? Double ?? 0
      }
    case "input.text":
      guard let edit = message["edit"] as? [String: Any], edit["contextId"] as? String == tab.contextId,
        edit["before"] as? String == "", edit["after"] as? String == "", let text = edit["text"] as? String else { throw BrowserRefusal.notActionable }
      primitive.action.kind = "text.insert"; primitive.action.text = text
    case "input.compose":
      guard let composition = message["composition"] as? [String: Any], composition["contextId"] as? String == tab.contextId,
        (composition["before"] as? String ?? "").isEmpty, (composition["after"] as? String ?? "").isEmpty, let text = composition["text"] as? String,
        let start = composition["selectionStart"] as? Int, let end = composition["selectionEnd"] as? Int else { throw BrowserRefusal.notActionable }
      primitive.action.kind = "text.mark"; primitive.action.text = text
      primitive.action.selectionStart = start; primitive.action.selectionLength = end - start
    case "input.cancel":
      cancelComposition(tab)
      return
    case "input.key":
      guard let modifiers = message["modifiers"] as? [String], modifiers.allSatisfy({ $0 == "shift" }),
        let action = message["action"] as? String, ["down", "up"].contains(action),
        let key = message["key"] as? String else { throw BrowserRefusal.unsupportedOperation }
      if action == "up" { return }
      if key == "Enter", modifiers.isEmpty { primitive.action.kind = "text.enter" }
      else if key == "Backspace", modifiers.isEmpty { primitive.action.kind = "text.backspace" }
      else if let text = message["text"] as? String, !text.isEmpty {
        primitive.action.kind = "text.insert"; primitive.action.text = text
      } else if key.count == 1 {
        primitive.action.kind = "text.insert"; primitive.action.text = key
      } else { throw BrowserRefusal.unsupportedOperation }
    case "input.command":
      guard let command = message["command"] as? String, ["selectAll", "deleteBackward"].contains(command) else { throw BrowserRefusal.unsupportedOperation }
      primitive.action.kind = command == "selectAll" ? "text.selectAll" : "text.backspace"
    case "clipboard.paste":
      guard let text = message["text"] as? String else { throw BrowserRefusal.invalidArgument }
      primitive.action.kind = "text.paste"; primitive.action.text = text
    default: throw BrowserRefusal.unsupportedOperation
    }
    _ = try authorize(input, viewer: true)
    _ = try await perform(primitive, viewer: true)
  }
}
