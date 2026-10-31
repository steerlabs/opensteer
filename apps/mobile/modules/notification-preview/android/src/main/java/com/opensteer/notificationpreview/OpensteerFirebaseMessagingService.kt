package com.opensteer.notificationpreview

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.service.NotificationsService
import org.json.JSONObject

class OpensteerFirebaseMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    if (!message.data.containsKey("preview")) {
      super.onMessageReceived(message)
      return
    }
    val fields = message.data
    val notification = PreviewNotification.build(fields) { decrypt(fields) }
    ensureChannel()
    val triggerData =
      notification.routing +
        mapOf("channelId" to "default") +
        (notification.group?.let { mapOf("threadIdentifier" to it) } ?: emptyMap())
    val trigger =
      FirebaseNotificationTrigger(
        RemoteMessage.Builder(message.from ?: "opensteer").setData(triggerData).build()
      )
    val content =
      NotificationContent.Builder()
        .setTitle(notification.title)
        .setText(notification.text)
        .setBody(JSONObject(notification.routing))
        .setGroup(notification.group)
        .useDefaultSound()
        .setAutoDismiss(true)
        .setColor(0xffe6beb0.toInt())
        .build()
    val request = NotificationRequest(notification.identifier, content, trigger)
    NotificationsService.receive(this, Notification(request))
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager::class.java)
        .createNotificationChannel(
          NotificationChannel("default", "Opensteer", NotificationManager.IMPORTANCE_DEFAULT)
        )
    }
  }

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
    val plain =
      PreviewCrypto.open(
        record.getString("key"),
        env.getString("nonce"),
        env.getString("ciphertext"),
        aad,
        f.getValue("expiresAt"),
        store.marker(),
        record.getString("marker"),
      )
    val json = JSONObject(String(plain, Charsets.UTF_8))
    return PreviewNotification.plaintext(json.keys().asSequence().associateWith { json.get(it) })
  }
}
