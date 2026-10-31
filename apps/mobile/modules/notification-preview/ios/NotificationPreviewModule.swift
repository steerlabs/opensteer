import ExpoModulesCore
public final class NotificationPreviewModule: Module {
  private let store = PreviewKeyStore()
  public func definition() -> ModuleDefinition {
    Name("OpensteerNotificationPreview")
    Constants(["notificationPreviewVersion": 1])
    AsyncFunction("deployments") { try self.store.deployments() }
    AsyncFunction("prepare") { try self.store.prepare() }
    AsyncFunction("existing") { (deployment: String) in try self.store.read(deployment) }
    AsyncFunction("key") { (deployment: String) in
      let record = try self.store.key(deployment)
      return ["keyId": record["keyId"]!, "key": record["key"]!]
    }
    AsyncFunction("erase") { (deployment: String?) in try self.store.erase(deployment) }
  }
}
