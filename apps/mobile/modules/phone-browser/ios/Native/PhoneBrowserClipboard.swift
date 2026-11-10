import Foundation

@available(iOS 17, *)
@MainActor final class BrowserClipboardPaste {
  let epoch: Int
  let documentId: String
  let contextId: String
  let channelId: String
  let operationId: String
  let consumerToken: String?
  let size: Int
  var bytes = Data()
  var index = 0

  init(input: BrowserWireInput, tab: PhoneBrowserTab, operationId: String, size: Int) throws {
    guard let contextId = tab.contextId else { throw BrowserRefusal.notActionable }
    epoch = input.epoch; documentId = tab.documentId; self.contextId = contextId
    channelId = input.channelId; self.operationId = operationId; self.size = size
    consumerToken = input.message["consumerToken"] as? String
  }
}

@available(iOS 17, *)
@MainActor extension PhoneBrowserPool {
  func clipboardReply(_ tab: PhoneBrowserTab, channel: String, operation: String, consumer: String?,
    outcome: String, bytes: Data? = nil) {
    var result: [String: Any] = ["type": "clipboard.result", "surfaceId": tab.id,
      "operationId": operation, "outcome": outcome]
    result["consumerToken"] = consumer
    if let bytes { result["items"] = [["type": "text/plain", "size": bytes.count]] }
    func send(_ message: [String: Any]) {
      emit?("serverMessage", ["tabId": tab.id, "channelId": channel, "message": message])
    }
    send(result)
    if let bytes {
      let partSize = 512 * 1024
      for index in 0..<max(1, (bytes.count + partSize - 1) / partSize) {
        let start = index * partSize
        var part: [String: Any] = ["type": "clipboard.part", "part": ["operationId": operation,
          "index": index, "data": bytes.subdata(in: start..<min(start + partSize, bytes.count)).base64EncodedString()]]
        part["consumerToken"] = consumer
        send(part)
      }
    }
  }

  func wireClipboard(_ input: BrowserWireInput, tab: PhoneBrowserTab) async throws {
    let message = input.message
    let type = message["type"] as? String
    if type == "clipboard.copy" {
      guard let operation = message["operationId"] as? String else { throw BrowserRefusal.invalidArgument }
      let primitive = BrowserActionInput()
      primitive.epoch = input.epoch; primitive.tabId = tab.id; primitive.documentId = tab.documentId
      primitive.contextId = tab.contextId; primitive.action.kind = "text.copy"
      let result = try await perform(primitive, viewer: true)
      _ = try authorize(input, viewer: true)
      guard let text = result["text"] as? String else { throw BrowserRefusal.notActionable }
      let bytes = Data(text.utf8)
      clipboardReply(tab, channel: input.channelId, operation: operation, consumer: message["consumerToken"] as? String,
        outcome: bytes.count > 16 * 1024 * 1024 ? "too-large" : bytes.isEmpty ? "empty" : "copied",
        bytes: bytes.count <= 16 * 1024 * 1024 && !bytes.isEmpty ? bytes : nil)
      return
    }
    if type == "clipboard.paste-data" {
      guard let operation = message["operationId"] as? String,
        let items = message["items"] as? [[String: Any]], items.count == 1,
        items[0]["type"] as? String == "text/plain", items[0]["name"] == nil,
        let size = BrowserWireNumber.integer(items[0]["size"]), (0...16 * 1024 * 1024).contains(size),
        tab.clipboardPastes.count < 32 else { throw BrowserRefusal.invalidArgument }
      let key = "\(input.channelId):\(operation)"
      guard tab.clipboardPastes[key] == nil else { throw BrowserRefusal.invalidArgument }
      let paste = try BrowserClipboardPaste(input: input, tab: tab, operationId: operation, size: size)
      tab.clipboardPastes[key] = paste
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
        guard tab.clipboardPastes[key] === paste else { return }
        tab.clipboardPastes.removeValue(forKey: key)
        if tab.documentId == paste.documentId, self.gate.current == paste.epoch {
          self.clipboardReply(tab, channel: paste.channelId, operation: operation, consumer: paste.consumerToken, outcome: "stale")
        }
      }
      return
    }
    guard type == "clipboard.part", let part = message["part"] as? [String: Any],
      let operation = part["operationId"] as? String else { throw BrowserRefusal.invalidArgument }
    let key = "\(input.channelId):\(operation)"
    guard let paste = tab.clipboardPastes[key] else { throw BrowserRefusal.notActionable }
    guard paste.epoch == input.epoch, paste.documentId == tab.documentId, paste.contextId == tab.contextId,
      BrowserWireNumber.integer(part["index"]) == paste.index, let encoded = part["data"] as? String,
      encoded.utf8.count <= 699052, let bytes = Data(base64Encoded: encoded),
      bytes.count == min(512 * 1024, paste.size - paste.bytes.count) else {
      tab.clipboardPastes.removeValue(forKey: key)
      clipboardReply(tab, channel: paste.channelId, operation: operation, consumer: paste.consumerToken, outcome: "stale")
      return
    }
    paste.bytes.append(bytes); paste.index += 1
    guard paste.bytes.count == paste.size else { return }
    tab.clipboardPastes.removeValue(forKey: key)
    guard let text = String(data: paste.bytes, encoding: .utf8) else { throw BrowserRefusal.invalidArgument }
    let primitive = BrowserActionInput()
    primitive.epoch = input.epoch; primitive.tabId = tab.id; primitive.documentId = tab.documentId
    primitive.contextId = paste.contextId; primitive.action.kind = "text.paste"; primitive.action.text = text
    _ = try authorize(input, viewer: true)
    _ = try await perform(primitive, viewer: true)
    clipboardReply(tab, channel: paste.channelId, operation: operation, consumer: paste.consumerToken, outcome: "pasted")
  }
}
