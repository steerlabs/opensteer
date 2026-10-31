package com.opensteer.notificationpreview

import java.net.URI
import java.util.UUID

data class PreviewNotificationFields(
  val identifier: String,
  val group: String?,
  val routing: Map<String, String>,
  val title: String,
  val text: String,
)

object PreviewNotification {
  fun generic(kind: String?): String =
    when (kind) {
      "request-opened" -> "Opensteer needs you"
      "reply-published" -> "Opensteer replied"
      else -> "Opensteer couldn't finish"
    }

  fun validRoute(f: Map<String, String>): Boolean =
    runCatching {
        require(f.values.all { it.toByteArray().size <= 4096 })
        val dep = f.getValue("deploymentId")
        val thread = f.getValue("threadId")
        require(
          dep.matches(Regex("^dep_[0-9a-f-]{36}$")) && thread.matches(Regex("^thr_[0-9a-f-]{36}$"))
        )
        require(f.getValue("notificationId").matches(Regex("^ntf_[0-9a-f-]{36}$")))
        val uri = URI(f.getValue("deepLink"))
        require(
          uri.scheme == "com.opensteer.mobile" &&
            uri.rawAuthority == null &&
            uri.fragment == null &&
            uri.path == "/deployments/$dep/threads/$thread"
        )
        val anchor =
          when (f.getValue("kind")) {
            "reply-published" -> "messageId"
            "request-opened" -> "requestId"
            "run-failed" -> null
            else -> error("invalid")
          }
        if (anchor == null) require(uri.query == null)
        else {
          val prefix = if (anchor == "messageId") "msg" else "req"
          require(f.getValue(anchor).matches(Regex("^${prefix}_[0-9a-f-]{36}$")))
          require(uri.query == "$anchor=${f.getValue(anchor)}")
        }
        true
      }
      .getOrDefault(false)

  fun plaintext(fields: Map<String, Any>): Pair<String, String> {
    require(fields.keys == setOf("version", "title", "body") && fields["version"] == 1)
    val title = fields.getValue("title") as String
    val body = fields.getValue("body") as String
    require(title.length in 1..120 && body.length in 1..180)
    require((title + body).toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8) == title + body)
    return title to body
  }

  fun build(
    fields: Map<String, String>,
    decrypt: () -> Pair<String, String>,
  ): PreviewNotificationFields {
    val generic = "Opensteer" to generic(fields["kind"])
    if (!validRoute(fields))
      return PreviewNotificationFields(
        UUID.randomUUID().toString(),
        null,
        emptyMap(),
        generic.first,
        generic.second,
      )
    val routing =
      fields.filterKeys {
        it in
          setOf(
            "deepLink",
            "deploymentId",
            "threadId",
            "kind",
            "messageId",
            "requestId",
            "notificationId",
            "installationId",
            "expiresAt",
            "preview",
          )
      }
    val text = runCatching(decrypt).getOrDefault(generic)
    return PreviewNotificationFields(
      "${fields.getValue("deploymentId")}:${fields.getValue("notificationId")}",
      "${fields.getValue("deploymentId")}:${fields.getValue("threadId")}",
      routing,
      text.first,
      text.second,
    )
  }
}
