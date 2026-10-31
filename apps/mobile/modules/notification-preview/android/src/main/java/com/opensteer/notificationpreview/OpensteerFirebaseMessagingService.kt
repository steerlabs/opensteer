package com.opensteer.notificationpreview

import android.app.NotificationChannel
import android.app.NotificationManager
import android.net.Uri
import android.os.Build
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.NotificationsService
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger
import org.json.JSONObject

class OpensteerFirebaseMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    if (!message.data.containsKey("preview")) {
      super.onMessageReceived(message)
      return
    }
    val fields = message.data
    // Invalid destinations never become tap authority, including on generic alerts.
    if (!validRoute(fields)) {
      ensureChannel()
      val content = NotificationContent.Builder()
        .setTitle("Opensteer")
        .setText(generic(fields["kind"]))
        .setBody(JSONObject())
        .setAutoDismiss(true)
        .useDefaultSound()
        .setColor(0xffe6beb0.toInt())
        .build()
      val trigger = FirebaseNotificationTrigger(
        RemoteMessage.Builder("opensteer").setData(mapOf("channelId" to "default")).build()
      )
      val request = NotificationRequest(java.util.UUID.randomUUID().toString(), content, trigger)
      NotificationsService.receive(this, Notification(request))
      return
    }
    val dep = fields.getValue("deploymentId")
    val thread = fields.getValue("threadId")
    val text = runCatching { decrypt(fields) }.getOrElse { "Opensteer" to generic(fields["kind"]) }
    ensureChannel()
    val routing = fields.filterKeys {
      it in setOf(
        "deepLink", "deploymentId", "threadId", "kind", "messageId", "requestId",
        "notificationId", "installationId", "expiresAt", "preview"
      )
    }
    val triggerData = routing + mapOf("channelId" to "default", "threadIdentifier" to "$dep:$thread")
    val trigger = FirebaseNotificationTrigger(
      RemoteMessage.Builder(message.from ?: "opensteer").setData(triggerData).build()
    )
    val content = NotificationContent.Builder()
      .setTitle(text.first)
      .setText(text.second)
      .setBody(JSONObject(routing))
      .setGroup("$dep:$thread")
      .useDefaultSound()
      .setAutoDismiss(true)
      .setColor(0xffe6beb0.toInt())
      .build()
    val request = NotificationRequest("$dep:${fields.getValue("notificationId")}", content, trigger)
    NotificationsService.receive(this, Notification(request))
  }
  private fun generic(kind: String?): String = when (kind) {
    "request-opened" -> "Opensteer needs you"
    "reply-published" -> "Opensteer replied"
    else -> "Opensteer couldn't finish"
  }
  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel("default", "Opensteer", NotificationManager.IMPORTANCE_DEFAULT)
      )
    }
  }
  private fun validRoute(f: Map<String, String>): Boolean = runCatching {
    require(f.values.all { it.toByteArray().size <= 4096 })
    val dep = f.getValue("deploymentId")
    val thread = f.getValue("threadId")
    require(dep.matches(Regex("^dep_[0-9a-f-]{36}$")) && thread.matches(Regex("^thr_[0-9a-f-]{36}$")))
    require(f.getValue("notificationId").matches(Regex("^ntf_[0-9a-f-]{36}$")))
    val uri = Uri.parse(f.getValue("deepLink"))
    require(
      uri.scheme == "com.opensteer.mobile" && uri.host == null && uri.fragment == null &&
        uri.path == "/deployments/$dep/threads/$thread"
    )
    val anchor = when (f.getValue("kind")) {
      "reply-published" -> "messageId"
      "request-opened" -> "requestId"
      "run-failed" -> null
      else -> error("invalid")
    }
    if (anchor == null) require(uri.query == null) else {
      val prefix = if (anchor == "messageId") "msg" else "req"
      require(f.getValue(anchor).matches(Regex("^${prefix}_[0-9a-f-]{36}$")))
      require(
        uri.queryParameterNames == setOf(anchor) &&
          uri.getQueryParameters(anchor) == listOf(f.getValue(anchor))
      )
    }
    true
  }.getOrDefault(false)
  private fun decrypt(f: Map<String, String>): Pair<String, String> {
    val env = JSONObject(f.getValue("preview"))
    require(
      env.keys().asSequence().toSet() == setOf("version", "keyId", "nonce", "ciphertext") &&
        env.get("version") == 1
    )
    val keyId = env.get("keyId") as String
    PreviewCrypto.decode(keyId, 16, 16)
    val store = PreviewStore(this)
    val record = requireNotNull(store.read(f.getValue("deploymentId")))
    require(keyId == record.getString("keyId"))
    val aad = PreviewCrypto.aad(f, keyId)
    val plain = PreviewCrypto.open(
      record.getString("key"), env.getString("nonce"), env.getString("ciphertext"),
      aad, f.getValue("expiresAt"), store.marker(), record.getString("marker")
    )
    val json = JSONObject(String(plain, Charsets.UTF_8))
    require(json.keys().asSequence().toSet() == setOf("version", "title", "body") && json.get("version") == 1)
    val title = json.get("title") as String
    val body = json.get("body") as String
    require(title.length in 1..120 && body.length in 1..180)
    require((title + body).toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8) == title + body)
    return title to body
  }
}
