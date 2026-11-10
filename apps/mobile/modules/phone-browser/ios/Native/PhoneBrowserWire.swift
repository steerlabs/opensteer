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
    let tab = try checked(input, document: input.documentId,
      geometry: viewer || input.request["geometryRevision"] != nil ? input.geometryRevision : nil)
    guard foreground, let admission else { throw BrowserRefusal.forbidden }
    if viewer { try admission.viewer(channelId: input.channelId, sessionId: tab.sessionId, epoch: input.epoch, control: true) }
    else {
      guard input.deadline.isFinite, input.deadline > Date().timeIntervalSince1970 * 1000 else { throw BrowserRefusal.timeout }
      try admission.action(channelId: input.channelId, attachmentId: input.attachmentId,
        actorToken: input.actorToken, sessionId: tab.sessionId, requestId: input.requestId, request: input.request, epoch: input.epoch)
    }
    return tab
  }

  func wireAction(_ input: BrowserWireInput) async throws -> [String: Any] {
    let tab = try authorize(input, viewer: false)
    let request = input.request
    guard request["sessionId"] as? String == tab.sessionId, request["surfaceId"] as? String == tab.id,
      request["documentId"] as? String == tab.documentId,
      let action = request["action"] as? [String: Any], let type = action["type"] as? String,
      let timeout = BrowserWireNumber.integer(request["timeoutMs"]), (1...30000).contains(timeout),
      try JSONSerialization.data(withJSONObject: request).count <= 432 * 1024 else { throw BrowserRefusal.invalidArgument }
    if let value = request["geometryRevision"] {
      guard let geometry = BrowserWireNumber.integer(value) else { throw BrowserRefusal.invalidArgument }
      guard geometry == tab.geometryRevision else { throw BrowserRefusal.staleGeometry }
    }
    let remaining = min(timeout, Int(min(30000, max(0, input.deadline - Date().timeIntervalSince1970 * 1000))))
    guard remaining > 0 else { throw BrowserRefusal.timeout }
    let primitive = BrowserActionInput()
    primitive.epoch = input.epoch; primitive.tabId = tab.id; primitive.documentId = tab.documentId
    primitive.geometryRevision = input.geometryRevision; primitive.timeoutMs = remaining
    primitive.actorToken = input.actorToken
    switch type {
    case "page.wait":
      return try await waitPage(input, tab: tab, action: action, timeout: remaining)
    case "file.choose":
      guard #available(iOS 18.4, *) else { throw BrowserRefusal.unsupportedOperation }
      guard let ids = action["stagedFileIds"] as? [String], !ids.isEmpty, tab.stagedSelection == nil,
        tab.chooser == nil, !tab.inputBusy else { throw BrowserRefusal.notActionable }
      _ = try files.selected(ids, session: tab.sessionId)
      guard let view = tab.webView, let window = view.window else { throw BrowserRefusal.notActionable }
      try protectResponder(view, window: window)
      let operation = UUID()
      try gate.perform(input.epoch) {
        tab.inputBusy = true
        tab.stagedSelection = BrowserStagedSelection(operationId: operation, epoch: input.epoch, documentId: input.documentId, fileIds: ids,
          authorize: { _ = try self.authorize(input, viewer: false) })
        tab.callOwners[operation] = input.attachmentId
      }
      defer {
        tab.callOwners.removeValue(forKey: operation)
        tab.inputBusy = false
        if tab.stagedSelection?.operationId == operation || tab.chosenSelectionId == operation { cancelChooser(tab) }
      }
      var target: [String: Any] = [:]
      if let locator = action["locator"] { target["locator"] = locator }
      if let point = action["point"] { target["point"] = point }
      guard try await invokeAgent(input, tab: tab, name: "fileChoose", args: target, timeout: remaining)["chosen"] as? Bool == true else { throw BrowserRefusal.notActionable }
      _ = try authorize(input, viewer: false)
      let chosen = try await waitChosen(tab, operation: operation, epoch: input.epoch, deadline: input.deadline)
      _ = try authorize(input, viewer: false)
      return ["type": type, "files": chosen]
    case "page.navigate", "page.history":
      let navigation = BrowserNavigationInput()
      navigation.epoch = input.epoch; navigation.tabId = tab.id
      navigation.kind = type == "page.navigate" ? "go" : action["direction"] as? String ?? ""
      navigation.url = action["url"] as? String
      _ = try navigate(navigation)
      if type == "page.history", navigation.kind == "stop" { return ["type": type] }
      try await waitReady(tab, timeoutMs: remaining, epoch: input.epoch)
      try gate.check(input.epoch)
      guard let admission else { throw BrowserRefusal.forbidden }
      try admission.action(channelId: input.channelId, attachmentId: input.attachmentId,
        actorToken: input.actorToken, sessionId: tab.sessionId, requestId: input.requestId, request: input.request, epoch: input.epoch)
      if type == "page.history" { return ["type": type] }
      return ["type": type, "binding": ["surfaceId": tab.id, "documentId": tab.documentId,
        "geometryRevision": tab.geometryRevision, "state": "live", "title": String((tab.webView?.title ?? "").prefix(1000)),
        "url": tab.webView?.url?.absoluteString ?? "about:blank"]]
    case "file.stage":
      let staged = BrowserStageInput()
      staged.epoch = input.epoch; staged.sessionId = tab.sessionId
      guard let id = action["fileId"] as? String, let name = action["name"] as? String,
        let offset = BrowserWireNumber.integer(action["offset"]), let data = action["data"] as? String else { throw BrowserRefusal.invalidArgument }
      staged.fileId = id; staged.name = name; staged.offset = offset; staged.data = data
      if let value = action["size"] {
        guard let size = BrowserWireNumber.integer(value) else { throw BrowserRefusal.invalidArgument }
        staged.size = size
      }
      var result = try files.portStage(staged); result["type"] = type
      return result
    case "text.insert", "text.key", "text.selectAll", "scroll", "pointer.tap":
      primitive.action.kind = type
      if type == "text.key" {
        guard let key = action["key"] as? String, ["Enter", "Backspace"].contains(key) else { throw BrowserRefusal.unsupportedOperation }
        primitive.action.kind = key == "Enter" ? "text.enter" : "text.backspace"
      }
      if type == "pointer.tap" {
        _ = try await invokeAgent(input, tab: tab, name: "tap", args: action, timeout: remaining)
        return ["type": type]
      }
      if type == "scroll", action["locator"] != nil {
        return try await invokeAgent(input, tab: tab, name: "scroll", args: action, timeout: remaining)
      }
      primitive.action.text = action["text"] as? String ?? ""
      primitive.action.x = action["x"] as? Double ?? 0; primitive.action.y = action["y"] as? Double ?? 0
      primitive.action.deltaX = action["deltaX"] as? Double ?? 0; primitive.action.deltaY = action["deltaY"] as? Double ?? 0
      _ = try authorize(input, viewer: false)
      let result = try await perform(primitive, viewer: false, authorization: { _ = try self.authorize(input, viewer: false) })
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
        guard let planId = result["planId"] as? String else { throw BrowserRefusal.notActionable }
        let focus = try await invokeAgent(input, tab: tab, name: "textFocus", args: ["planId": planId], timeout: remaining)
        guard focus["focused"] as? Bool == true else { throw BrowserRefusal.notActionable }
        guard let text = result["text"] as? String else { throw BrowserRefusal.notActionable }
        primitive.action.kind = "text.selectAll"
        _ = try await perform(primitive, viewer: false, authorization: { _ = try self.authorize(input, viewer: false) })
        primitive.action.kind = text.isEmpty ? "text.backspace" : "text.insert"
        primitive.action.text = text
        _ = try await perform(primitive, viewer: false, authorization: { _ = try self.authorize(input, viewer: false) })
        return try await invokeAgent(input, tab: tab, name: "textResult", args: ["planId": planId], timeout: remaining)
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

  func waitPage(_ input: BrowserWireInput, tab: PhoneBrowserTab, action: [String: Any], timeout: Int) async throws -> [String: Any] {
    guard let requested = BrowserWireNumber.integer(action["timeout"]), (1...30000).contains(requested) else { throw BrowserRefusal.invalidArgument }
    let id = UUID()
    defer { tab.pageWaitChecks.removeValue(forKey: id); tab.pendingCalls.removeValue(forKey: id); tab.callEpochs.removeValue(forKey: id) }
    return try await withCheckedThrowingContinuation { continuation in
      var finished = false
      let finish: (Result<[String: Any], Error>) -> Void = { result in
        guard !finished else { return }; finished = true
        continuation.resume(with: result)
      }
      tab.callEpochs[id] = input.epoch
      tab.pendingCalls[id] = { finish(.failure($0)) }
      let check = {
        do {
          _ = try self.authorize(input, viewer: false)
          guard tab.pendingDialog == nil else { throw BrowserRefusal.dialogOpen }
          if let url = action["url"] as? String, tab.webView?.url?.absoluteString != url { return }
          if action["loadState"] as? String == "load", tab.webView?.isLoading == true { return }
          guard (try? tab.readiness.require(frame: "main")) != nil else { return }
          finish(.success(["type": "page.wait", "binding": ["surfaceId": tab.id, "documentId": tab.documentId,
            "geometryRevision": tab.geometryRevision, "state": "live", "title": String((tab.webView?.title ?? "").prefix(1000)),
            "url": tab.webView?.url?.absoluteString ?? "about:blank"]]))
        } catch { finish(.failure(error)) }
      }
      tab.pageWaitChecks[id] = check
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(min(requested, timeout))) { finish(.failure(BrowserRefusal.timeout)) }
      check()
    }
  }

  func invokeAgent(_ input: BrowserWireInput, tab: PhoneBrowserTab, name: String, args: [String: Any], timeout: Int, viewer: Bool = false) async throws -> [String: Any] {
    guard ["query", "snapshot", "act", "tap", "focus", "scroll", "wait", "fileChoose", "textResult", "textFocus", "commit"].contains(name) else { throw BrowserRefusal.unsupportedOperation }
    if ["act", "tap", "focus", "fileChoose", "textFocus", "commit"].contains(name), let view = tab.webView, let window = view.window {
      try protectResponder(view, window: window)
    }
    let operation = name == "wait" ? args["id"] as? String ?? UUID().uuidString : UUID().uuidString
    tab.agentOperations.insert(operation)
    tab.agentOwners[operation] = input.attachmentId
    defer { tab.agentOperations.remove(operation); tab.agentFrames.removeValue(forKey: operation); tab.agentOwners.removeValue(forKey: operation) }
    do {
      let remaining = viewer ? timeout : min(timeout, Int(min(30000, max(0, input.deadline - Date().timeIntervalSince1970 * 1000))))
      guard remaining > 0 else { throw BrowserRefusal.timeout }
      var routedArgs = args
      var frame: WKFrameInfo?
      if let frameId = routedArgs.removeValue(forKey: "frameId") as? String {
        guard let selected = tab.frames[frameId], tab.frameDocuments[frameId] != nil else { throw BrowserRefusal.staleDocument }
        frame = selected
        tab.agentFrames[operation] = selected
      }
      let envelope: [String: Any] = ["name": name, "args": routedArgs, "operationId": operation]
      let reply = try await helper(tab, function: "agent", arguments: ["argument": envelope], frame: frame, epoch: input.epoch, timeoutMs: remaining,
        authorization: { _ = try self.authorize(input, viewer: viewer) }, attachmentId: input.attachmentId)
      _ = try authorize(input, viewer: viewer)
      guard let body = reply as? [String: Any], try JSONSerialization.data(withJSONObject: body).count <= 432 * 1024 else { throw BrowserRefusal.tooLarge }
      if let error = body["error"] as? [String: String] {
        let allowed = ["unsupported-operation", "stale-document", "stale-geometry", "ambiguous", "not-found", "not-actionable", "timeout", "too-large", "outcome-unknown"]
        throw BrowserHelperRefusal(code: allowed.contains(error["code"] ?? "") ? error["code"]! : "not-actionable", description: "Isolated helper refused the operation")
      }
      guard let result = body["result"] as? [String: Any] else { throw BrowserRefusal.notActionable }
      if name != "commit", result["kind"] as? String == "script-activation", let planId = result["planId"] as? String {
        var target: [String: Any] = ["planId": planId]
        target["frameId"] = args["frameId"]
        return try await invokeAgent(input, tab: tab, name: "commit", args: target, timeout: timeout, viewer: viewer)
      }
      return result
    } catch {
      cancelAgent(tab, operations: [operation])
      if ["act", "tap", "focus", "fileChoose", "textFocus", "commit"].contains(name), error as? BrowserRefusal == .timeout { throw BrowserRefusal.outcomeUnknown }
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
    guard let type = message["type"] as? String,
      type == "clipboard.part" || type == "input.cancel" || message["surfaceId"] as? String == tab.id else { throw BrowserRefusal.invalidArgument }
    if ["clipboard.copy", "clipboard.paste-data", "clipboard.part"].contains(type) {
      try await wireClipboard(input, tab: tab)
      return
    }
    let primitive = BrowserActionInput()
    primitive.epoch = input.epoch; primitive.tabId = tab.id; primitive.documentId = tab.documentId
    primitive.geometryRevision = input.geometryRevision; primitive.contextId = tab.contextId
    switch type {
    case "input.pointer", "input.wheel":
      guard BrowserWireNumber.integer(message["geometryRevision"]) == tab.geometryRevision else { throw BrowserRefusal.staleGeometry }
      if let capture = message["captureRevision"], BrowserWireNumber.integer(capture) != tab.captureRevision {
        throw BrowserRefusal.staleGeometry
      }
      if type == "input.pointer" {
        guard (message["modifiers"] as? [String] ?? []).isEmpty else { throw BrowserRefusal.unsupportedOperation }
        if message["action"] as? String == "leave" { return }
        if message["action"] as? String == "move", (BrowserWireNumber.integer(message["buttons"]) ?? 0) == 0 { return }
        guard ["up", "down"].contains(message["action"] as? String ?? ""), message["button"] as? String == "left",
          (BrowserWireNumber.integer(message["clickCount"]) ?? 1) == 1,
          let x = message["x"] as? Double, let y = message["y"] as? Double, (0...1).contains(x), (0...1).contains(y),
          let view = tab.webView else { throw BrowserRefusal.unsupportedOperation }
        if message["action"] as? String == "down" { return }
        _ = try await invokeAgent(input, tab: tab, name: "tap", args: ["type": "pointer.tap", "x": x * view.bounds.width,
          "y": y * view.bounds.height, "count": 1], timeout: 10000, viewer: true)
        _ = try await helper(tab, function: "editing", epoch: input.epoch,
          authorization: { _ = try self.authorize(input, viewer: true) })
        activity(tab, kind: "viewer", pointer: ["x": x * view.bounds.width, "y": y * view.bounds.height])
        return
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
        let start = BrowserWireNumber.integer(composition["selectionStart"]), let end = BrowserWireNumber.integer(composition["selectionEnd"]) else { throw BrowserRefusal.notActionable }
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
    _ = try await perform(primitive, viewer: true, authorization: { _ = try self.authorize(input, viewer: true) })
  }
}
