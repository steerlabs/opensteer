package com.opensteer.notificationpreview
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
class NotificationPreviewModule : Module() {
  private fun store() = PreviewStore(requireNotNull(appContext.reactContext))
  override fun definition() = ModuleDefinition {
    Name("OpensteerNotificationPreview")
    Constants("notificationPreviewVersion" to 1)
    AsyncFunction("prepare") { store().prepare() }
    AsyncFunction("key") { dep: String -> store().key(dep) }
    AsyncFunction("erase") { dep: String? -> store().erase(dep) }
  }
}
