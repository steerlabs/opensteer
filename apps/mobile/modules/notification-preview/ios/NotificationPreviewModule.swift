import ExpoModulesCore

public final class NotificationPreviewModule: Module {
  private let store = PreviewKeyStore()
  public func definition() -> ModuleDefinition {
    Name("OpensteerNotificationPreview")
    Constants(["notificationPreviewVersion": 1])
    AsyncFunction("prepare") { try self.store.prepare() }
    AsyncFunction("key") { (deployment: String) in
      let record = try self.store.key(deployment)
      return ["keyId": record["keyId"]!, "key": record["key"]!]
    }
    AsyncFunction("erase") { (deployment: String?) in try self.store.erase(deployment) }
  }
}
