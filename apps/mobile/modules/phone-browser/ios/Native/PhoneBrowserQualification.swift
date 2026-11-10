import UIKit
import WebKit

@available(iOS 17, *)
@MainActor extension PhoneBrowserPool {
  func qualify(epoch: Int) async -> [String: Any] {
    var checks: [String] = []
    var fileStaging = false
    var failure: String?
    var agentFailure: String?
    var stage = "store"
    let session = "qualification-\(UUID().uuidString)"
    let id = "bsf_\(UUID().uuidString.lowercased())"
    let previous = emit
    defer { emit = previous; destroy(id); stores.endGuest(session); files.finishSession(session) }
    do {
      try gate.check(epoch)
      let guest = BrowserProfileInput(); guest.epoch = epoch; guest.guestSessionId = session
      let store = try await stores.ensure(guest, gate: gate)
      stage = "create"
      let create = BrowserCreateInput(); create.epoch = epoch; create.sessionId = session; create.tabId = id
      create.storeHandle = store["storeHandle"] as? String
      _ = try await self.create(create)
      let tab = try self.tab(id)
      stage = "fixture"
      guard let view = tab.webView, let window = view.window else { throw BrowserRefusal.notActionable }
      try protectResponder(view, window: window)
      let fixture = """
      <!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>
      <label>Message<input id=text></label><input id=check type=checkbox>
      <select id=select><option value=a>A</option><option value=b>B</option></select>
      <button id=button onclick="document.getElementById('status').textContent=event.isTrusted?'trusted':'script'">Go</button>
      <button id=focusButton style='position:fixed;right:10px;top:100px' onclick="document.getElementById('text').focus()">Focus the page field</button>
      <button id=dialog onclick="confirm('qualification')">Dialog</button>
      <input id=file type=file style='position:fixed;left:20px;top:200px;width:200px;height:50px'><pre id=status></pre><pre id=trusted></pre>
      <script>document.getElementById('text').addEventListener('input',e=>document.getElementById('trusted').textContent=String(e.isTrusted));</script>
      """
      tab.readiness.provisional()
      view.loadHTMLString(fixture, baseURL: nil)
      try await waitReady(tab, epoch: epoch)
      try await waitLoadFinished(tab, epoch: epoch)
      func invoke(_ name: String, _ args: [String: Any]) async throws -> [String: Any] {
        let reply = try await self.helper(tab, function: "agent", arguments: ["argument": ["name": name,
          "args": args, "operationId": UUID().uuidString]], epoch: epoch) as? [String: Any]
        if let error = reply?["error"] as? [String: String] {
          throw BrowserHelperRefusal(code: error["code"] ?? "not-actionable", description: "Conformance helper refused")
        }
        guard let result = reply?["result"] as? [String: Any] else { throw BrowserRefusal.notActionable }
        if name != "commit", result["kind"] as? String == "script-activation", let planId = result["planId"] as? String {
          return try await invoke("commit", ["planId": planId])
        }
        return result
      }
      func query(_ selector: String, _ read: String) async throws -> Any? {
        try await invoke("query", ["type": "dom.query", "locator": ["by": "css", "value": selector], "read": read])["value"]
      }
      stage = "snapshot"
      let snapshot = try await invoke("snapshot", ["type": "dom.snapshot"])
      guard (snapshot["text"] as? String)?.contains("Message") == true else { throw BrowserRefusal.helperNotReady }
      stage = "element-wait"
      _ = try await invoke("wait", ["id": UUID().uuidString, "locator": ["by": "role", "value": "button", "name": "Go"], "state": "visible"])
      checks.append("isolated-helper")
      stage = "dom-actions"
      _ = try await invoke("act", ["type": "dom.act", "kind": "click", "locator": ["by": "role", "value": "button", "name": "Go"]])
      guard try await query("#status", "textContent") as? String == "script" else { throw BrowserRefusal.notActionable }
      _ = try await invoke("act", ["type": "dom.act", "kind": "check", "locator": ["by": "css", "value": "#check"]])
      guard try await query("#check", "checked") as? Bool == true else { throw BrowserRefusal.notActionable }
      _ = try await invoke("act", ["type": "dom.act", "kind": "selectOption", "locator": ["by": "css", "value": "#select"], "values": ["b"]])
      guard try await query("#select", "inputValue") as? String == "b" else { throw BrowserRefusal.notActionable }
      checks.append("dom-actions")
      stage = "trusted-text"
      _ = try await invoke("focus", ["locator": ["by": "label", "value": "Message"]])
      func text(_ kind: String, value: String = "") async throws {
        let input = BrowserActionInput(); input.epoch = epoch; input.tabId = id; input.documentId = tab.documentId
        input.geometryRevision = tab.geometryRevision; input.action.kind = kind; input.action.text = value
        _ = try await self.perform(input, viewer: false)
      }
      try await text("text.insert", value: "native")
      guard try await query("#text", "inputValue") as? String == "native",
        try await query("#trusted", "textContent") as? String == "true" else { throw BrowserRefusal.notActionable }
      try await text("text.selectAll")
      try await text("text.insert", value: "replacement")
      try await text("text.backspace")
      guard try await query("#text", "inputValue") as? String == "replacemen" else { throw BrowserRefusal.notActionable }
      try await text("text.enter")
      checks.append("trusted-text-and-keys")
      stage = "native-snapshot"
      let image: UIImage = try await withCheckedThrowingContinuation { continuation in
        let request = UUID()
        tab.callEpochs[request] = epoch
        tab.pendingCalls[request] = { continuation.resume(throwing: $0) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
          tab.callEpochs.removeValue(forKey: request)
          tab.pendingCalls.removeValue(forKey: request)?(BrowserRefusal.timeout)
        }
        view.takeSnapshot(with: nil) { image, error in
          tab.callEpochs.removeValue(forKey: request)
          guard tab.pendingCalls.removeValue(forKey: request) != nil else { return }
          if let image { continuation.resume(returning: image) }
          else { continuation.resume(throwing: error ?? BrowserRefusal.notActionable) }
        }
      }
      guard image.size.width > 0, image.jpegData(compressionQuality: 0.5) != nil else { throw BrowserRefusal.notActionable }
      checks.append("native-snapshot")
      if #available(iOS 18.4, *) {
        stage = "file-chooser"
        let staged = BrowserStageInput(); staged.epoch = epoch; staged.sessionId = session; staged.fileId = "qualification"
        staged.name = "qualification.txt"; staged.data = Data("qualification".utf8).base64EncodedString(); staged.size = 13
        let file = try files.portStage(staged)
        func choose(_ target: [String: Any]) async throws {
          let operation = UUID()
          tab.stagedSelection = BrowserStagedSelection(operationId: operation, epoch: epoch, documentId: tab.documentId, fileIds: [file["fileId"] as! String])
          defer { self.cancelChooser(tab) }
          _ = try await invoke("fileChoose", target)
          let chosen = try await waitChosen(tab, operation: operation, epoch: epoch, deadline: Date().timeIntervalSince1970 * 1000 + 10000)
          guard chosen.first?["name"] as? String == "qualification.txt" else { throw BrowserRefusal.notActionable }
        }
        do {
          try await choose(["locator": ["by": "css", "value": "#file"]])
          try await choose(["point": ["x": 30, "y": 210]])
          fileStaging = true
          checks.append("staged-file-chooser-locator-and-point")
        } catch { fileStaging = false }
      }
      stage = "person-responder-protection"
      view.endEditing(true)
      _ = try await invoke("act", ["type": "dom.act", "kind": "focus", "locator": ["by": "css", "value": "#button"]])
      do {
        let person = UITextField(frame: CGRect(x: 0, y: 0, width: 150, height: 40))
        person.text = "person"
        window.addSubview(person)
        defer { person.resignFirstResponder(); person.removeFromSuperview() }
        guard person.becomeFirstResponder() else { throw BrowserRefusal.notActionable }
        _ = try await invoke("act", ["type": "dom.act", "kind": "click", "locator": ["by": "css", "value": "#focusButton"]])
        guard person.isFirstResponder, person.text == "person" else { throw BrowserRefusal.forbidden }
        do { try await text("text.insert", value: "must-refuse"); throw BrowserRefusal.forbidden }
        catch BrowserRefusal.notActionable {}
        guard person.isFirstResponder else { throw BrowserRefusal.forbidden }
      }
      checks.append("person-responder-protection")
      checks.append("script-focus-preserves-person-responder")
      stage = "agent-dialog-interruption"
      do {
        do {
          _ = try await invoke("act", ["type": "dom.act", "kind": "click", "locator": ["by": "css", "value": "#dialog"]])
          throw BrowserRefusal.notActionable
        } catch BrowserRefusal.dialogOpen {}
        guard let dialog = tab.pendingDialog else { throw BrowserRefusal.notActionable }
        let answer = BrowserDialogInput(); answer.epoch = epoch; answer.tabId = id
        answer.documentId = tab.documentId; answer.dialogId = dialog.id; answer.accept = false
        try respondDialog(answer)
        do { try respondDialog(answer); throw BrowserRefusal.notActionable }
        catch BrowserRefusal.staleDialog {}
        checks.append("interrupt-before-answer-once-dialog")
        stage = "agent-text-plans"
        tab.readiness.provisional()
        view.loadHTMLString("""
          <!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>
          <style>#message{position:fixed;left:10px;top:10px;width:180px;height:30px}</style>
          <form onsubmit="event.preventDefault();document.getElementById('submitted').textContent='yes'"><label>Message<input id=message></label></form>
          <div style='height:600px'></div><input id=rejected oninput="this.value=''" aria-label=Rejected>
          <pre id=submitted></pre><div style='height:2000px'></div>
          """, baseURL: URL(string: "https://phone-browser-conformance.invalid"))
        try await waitReady(tab, epoch: epoch)
        try await waitLoadFinished(tab, epoch: epoch)
        func fill(_ selector: String, value: String) async throws {
          let plan = try await invoke("act", ["type": "dom.act", "kind": "fill", "value": value,
            "locator": ["by": "css", "value": selector]])
          guard plan["kind"] as? String == "native-text", let planId = plan["planId"] as? String else { throw BrowserRefusal.notActionable }
          _ = try await invoke("textFocus", ["planId": planId])
          try await text("text.selectAll")
          try await text(value.isEmpty ? "text.backspace" : "text.insert", value: value)
          _ = try await invoke("textResult", ["planId": planId])
        }
        try await fill("#message", value: "accepted")
        do { try await fill("#rejected", value: "must-refuse"); throw BrowserRefusal.notActionable }
        catch let error as BrowserHelperRefusal where error.code == "not-actionable" {}
        _ = try await invoke("act", ["type": "dom.act", "kind": "focus", "locator": ["by": "css", "value": "#message"]])
        try await text("text.enter")
        guard try await query("#submitted", "textContent") as? String == "yes" else { throw BrowserRefusal.notActionable }
        checks.append("accepted-and-rejected-text-plans-then-enter")
      } catch {
        agentFailure = (error as? BrowserRefusal)?.rawValue ?? (error as? BrowserHelperRefusal)?.code ?? "conformance-failed"
      }
      try gate.check(epoch)
      stage = "complete"
    } catch { failure = (error as? BrowserRefusal)?.rawValue ?? (error as? BrowserHelperRefusal)?.code ?? "conformance-failed" }
    return ["platform": "ios", "runtimeId": runtimeId, "storageInstanceId": stores.storageInstanceId,
      "browser": failure == nil, "sharedControl": failure == nil, "agentActions": failure == nil && agentFailure == nil,
      "cdpBoundary": false, "fileStaging": failure == nil && fileStaging,
      "checks": checks, "failure": failure as Any? ?? NSNull(), "agentFailure": agentFailure as Any? ?? NSNull(), "stage": stage]
  }
}
