import UserNotifications
final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var completion: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?
  private func finish(_ content: UNNotificationContent?) {
    lock.lock(); let callback = completion; completion = nil; lock.unlock()
    if let content { callback?(content) }
  }
  override func didReceive(_ request: UNNotificationRequest, withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
    original = request.content; completion = handler
    do {
      let fields = request.content.userInfo.reduce(into: [String: String]()) { result, pair in
        if let key = pair.key as? String, let value = pair.value as? String { result[key] = value }
      }
      let store = PreviewKeyStore()
      guard let dep = fields["deploymentId"], let record = try store.read(dep),
        let raw = fields["preview"]?.data(using: .utf8), let env = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
        env["keyId"] as? String == record["keyId"], let content = request.content.mutableCopy() as? UNMutableNotificationContent else { throw PreviewError.invalid }
      let text = try Preview.open(fields, key: record["key"], marker: store.marker(), recordMarker: record["marker"] ?? "")
      content.title = text.title; content.body = text.body
      content.threadIdentifier = dep + ":" + (fields["threadId"] ?? "")
      finish(content)
    } catch { finish(original) }
  }
  override func serviceExtensionTimeWillExpire() { finish(original) }
}
