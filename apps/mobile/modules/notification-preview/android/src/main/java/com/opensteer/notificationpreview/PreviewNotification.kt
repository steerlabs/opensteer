package com.opensteer.notificationpreview

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
      "run-failed" -> "Opensteer couldn't finish"
      "team-message" -> "New team message"
      "team-notice" -> "New team notice"
      "team-agent-needs-you" -> "Your agent needs you"
      "team-agent-completed" -> "Your agent replied to your team"
      "team-ready" -> "Your team is ready"
      "report-published" -> "An agent shared an update"
      "run-completed" -> "A run finished"
      "run-interrupted" -> "A run was stopped"
      else -> "New Opensteer notification"
    }

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
    val routing = fields.filterKeys { it != "preview" }
    val text =
      runCatching {
        require(fields.values.all { it.toByteArray().size <= 4096 })
        decrypt()
      }.getOrDefault(generic)
    val deployment = fields["deploymentId"]
    val target = fields["threadId"] ?: fields["channelId"] ?: fields["noticeId"]
    return PreviewNotificationFields(
      fields["notificationId"]?.let { "$deployment:$it" } ?: UUID.randomUUID().toString(),
      if (deployment != null && target != null) "$deployment:$target" else null,
      routing,
      text.first,
      text.second,
    )
  }
}
