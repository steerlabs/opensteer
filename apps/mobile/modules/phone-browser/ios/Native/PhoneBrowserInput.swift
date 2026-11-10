import UIKit
import WebKit

@available(iOS 17, *)
@MainActor extension PhoneBrowserPool {
  func firstResponder(in root: UIView) -> UIView? {
    if root.isFirstResponder { return root }
    for child in root.subviews {
      if let found = firstResponder(in: child) { return found }
    }
    return nil
  }

  func perform(_ input: BrowserActionInput, viewer: Bool, authorization: (() throws -> Void)? = nil) async throws -> [String: Any] {
    try gate.check(input.epoch)
    try authorization?()
    let textLimit = viewer && input.action.kind == "text.paste" ? 16 * 1024 * 1024 : 432 * 1024
    guard foreground, (1...30000).contains(input.timeoutMs), input.action.text.utf8.count <= textLimit,
      (input.action.selector?.utf8.count ?? 0) <= 16384 else { throw BrowserRefusal.invalidArgument }
    let tab = try tab(input.tabId)
    guard tab.documentId == input.documentId else { throw BrowserRefusal.staleDocument }
    guard tab.pendingDialog == nil else { throw BrowserRefusal.dialogOpen }
    guard !tab.inputBusy else { throw BrowserRefusal.notActionable }
    tab.inputBusy = true
    tab.inputEpoch = input.epoch
    defer { tab.inputBusy = false }
    let action = input.action
    if action.kind == "text.mark" {
      guard action.selectionStart >= 0, action.selectionStart <= action.text.utf16.count,
        action.selectionLength >= 0, action.selectionLength <= action.text.utf16.count - action.selectionStart else {
        throw BrowserRefusal.invalidArgument
      }
    }
    if viewer {
      guard action.selector == nil,
        ["pointer.tap", "scroll", "text.copy", "text.paste", "text.insert", "text.backspace", "text.enter", "text.selectAll", "text.mark", "text.unmark"].contains(action.kind) else {
        throw BrowserRefusal.unsupportedOperation
      }
      if action.kind.hasPrefix("text.") {
        guard let contextId = input.contextId, contextId == tab.contextId else { throw BrowserRefusal.notActionable }
      }
    }
    if ["pointer.tap", "scroll", "file.choose"].contains(action.kind) {
      guard input.geometryRevision == tab.geometryRevision else { throw BrowserRefusal.staleGeometry }
    }
    let frame: WKFrameInfo?
    if let frameId = input.frameId {
      guard let selected = tab.frames[frameId], tab.frameDocuments[frameId] == input.frameDocumentId else { throw BrowserRefusal.staleDocument }
      frame = selected
    } else { frame = nil }
    switch action.kind {
    case "helper.ping":
      return try await helper(tab, function: "ping", frame: frame, epoch: input.epoch, timeoutMs: input.timeoutMs, authorization: authorization) as? [String: Any] ?? ["ready": false]
    case "pointer.tap", "file.choose":
      guard let view = tab.webView, action.x.isFinite, action.y.isFinite,
        action.x >= 0, action.y >= 0, action.x < view.bounds.width, action.y < view.bounds.height else { throw BrowserRefusal.notActionable }
      if action.kind == "file.choose" {
        guard #available(iOS 18.4, *) else { throw BrowserRefusal.unsupportedOperation }
        _ = try files.selected(action.stagedFileIds, session: tab.sessionId)
        tab.stagedChooser = true
      }
      if let window = view.window { try protectResponder(view, window: window) }
      guard tab.geometryRevision == input.geometryRevision else { throw BrowserRefusal.staleGeometry }
      guard try await helper(tab, function: "tap", arguments: ["argument": ["x": action.x, "y": action.y,
        "selector": action.selector as Any? ?? NSNull()]], frame: frame, epoch: input.epoch, timeoutMs: input.timeoutMs, authorization: authorization) as? Bool == true else {
        throw BrowserRefusal.notActionable
      }
      activity(tab, kind: viewer ? "viewer" : "agent", pointer: ["x": action.x, "y": action.y], actorToken: input.actorToken)
      return ["submitted": true]
    case "scroll":
      return try gate.perform(input.epoch) {
        try authorization?()
        guard action.deltaX.isFinite, action.deltaY.isFinite, let scroll = tab.webView?.scrollView else { throw BrowserRefusal.invalidArgument }
        let inset = scroll.adjustedContentInset
        let x = ScrollAnchor.clamped(target: scroll.contentOffset.x + action.deltaX, content: scroll.contentSize.width,
          viewport: scroll.bounds.width, leadingInset: inset.left)
        let y = ScrollAnchor.clamped(target: scroll.contentOffset.y + action.deltaY, content: scroll.contentSize.height,
          viewport: scroll.bounds.height, leadingInset: inset.top)
        scroll.setContentOffset(CGPoint(x: x, y: y), animated: false)
        activity(tab, kind: viewer ? "viewer" : "agent", actorToken: input.actorToken)
        return ["x": x, "y": y]
      }
    case "text.copy":
      guard viewer, !tab.secureInput else { throw BrowserRefusal.unsupportedOperation }
      return ["text": try await helper(tab, function: "selection", frame: frame, epoch: input.epoch, timeoutMs: input.timeoutMs, authorization: authorization)]
    case "text.insert", "text.paste", "text.backspace", "text.enter", "text.selectAll", "text.mark", "text.unmark", "focus":
      if action.kind == "text.paste", !viewer { throw BrowserRefusal.unsupportedOperation }
      guard let view = tab.webView, let window = view.window else { throw BrowserRefusal.notActionable }
      try protectResponder(view, window: window)
      if let context = input.contextId, context != tab.contextId { throw BrowserRefusal.notActionable }
      if let selector = action.selector {
        guard try await helper(tab, function: "focus", arguments: ["argument": selector], frame: frame,
          epoch: input.epoch, timeoutMs: input.timeoutMs, authorization: authorization) as? Bool == true else { throw BrowserRefusal.notActionable }
      } else if tab.contextId == nil { throw BrowserRefusal.notActionable }
      return try gate.perform(input.epoch) {
        try authorization?()
        guard foreground, state.tabs[tab.id] == .live, tab.webView === view else { throw BrowserRefusal.targetSuspended }
        guard tab.documentId == input.documentId else { throw BrowserRefusal.staleDocument }
        try protectResponder(view, window: window)
        guard view.becomeFirstResponder(), let responder = firstResponder(in: view), let keyInput = responder as? UIKeyInput else { throw BrowserRefusal.notActionable }
        switch action.kind {
        case "text.insert", "text.paste":
          keyInput.insertText(action.text)
          (responder as? UITextInput)?.unmarkText()
          tab.markedByRemote = false
        case "text.backspace": keyInput.deleteBackward()
        case "text.enter": keyInput.insertText("\n")
        case "text.selectAll": responder.selectAll(nil)
        case "text.mark":
          guard let textInput = responder as? UITextInput else { throw BrowserRefusal.notActionable }
          textInput.setMarkedText(action.text, selectedRange: NSRange(location: action.selectionStart, length: action.selectionLength))
          tab.markedByRemote = true
        case "text.unmark": guard let textInput = responder as? UITextInput else { throw BrowserRefusal.notActionable }; textInput.unmarkText(); tab.markedByRemote = false
        default: break
        }
        activity(tab, kind: viewer ? "viewer" : "agent", actorToken: input.actorToken)
        return ["submitted": true]
      }
    default: throw BrowserRefusal.unsupportedOperation
    }
  }

  func protectResponder(_ view: WKWebView, window: UIWindow) throws {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    for candidate in windows {
      if let responder = firstResponder(in: candidate), responder !== view, !responder.isDescendant(of: view) { throw BrowserRefusal.notActionable }
    }
  }

  func cancelComposition(_ tab: PhoneBrowserTab) {
    guard tab.markedByRemote else { return }
    tab.markedByRemote = false
    if let view = tab.webView, let textInput = firstResponder(in: view) as? UITextInput {
      textInput.setMarkedText("", selectedRange: NSRange(location: 0, length: 0))
      textInput.unmarkText()
    }
  }

  func activity(_ tab: PhoneBrowserTab, kind: String, pointer: [String: Double]? = nil, actorToken: String? = nil) {
    var body: [String: Any] = ["tabId": tab.id, "kind": kind, "at": Date().timeIntervalSince1970 * 1000]
    body["actorToken"] = actorToken
    if let pointer, let view = tab.webView, view.bounds.width > 0, view.bounds.height > 0 {
      body["pointer"] = ["x": max(0, min(1, (pointer["x"] ?? 0) / view.bounds.width)),
        "y": max(0, min(1, (pointer["y"] ?? 0) / view.bounds.height))]
    }
    emit?("activity", body)
  }

}
