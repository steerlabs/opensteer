package com.opensteer.notificationpreview

import org.junit.Assert.*
import org.junit.Test

class PreviewNotificationTest {
  private val dep = "dep_00000000-0000-4000-8000-000000000001"
  private val thread = "thr_00000000-0000-4000-8000-000000000001"
  private val message = "msg_00000000-0000-4000-8000-000000000001"
  private val fields =
    mapOf(
      "deploymentId" to dep,
      "threadId" to thread,
      "messageId" to message,
      "notificationId" to "ntf_00000000-0000-4000-8000-000000000001",
      "kind" to "reply-published",
      "deepLink" to "com.opensteer.mobile:/deployments/$dep/threads/$thread?messageId=$message",
    )

  @Test
  fun distinctIdentifiersAndSameGroup() {
    val first = PreviewNotification.build(fields) { "Title" to "Body" }
    val second =
      PreviewNotification.build(
        fields + ("notificationId" to "ntf_00000000-0000-4000-8000-000000000002")
      ) {
        "Title" to "Body"
      }
    assertEquals("$dep:${fields.getValue("notificationId")}", first.identifier)
    assertNotEquals(first.identifier, second.identifier)
    assertEquals("$dep:$thread", first.group)
    assertEquals(first.group, second.group)
    assertEquals(fields, first.routing)
    assertEquals("Body", first.text)
  }

  @Test
  fun allDestinationsKeepRoutingWhenDecryptionFails() {
    val destinations =
      listOf(
        Triple("team-message", "channelId", "channel"),
        Triple("team-notice", "noticeId", "notice"),
        Triple("request-opened", "", "needs-you"),
        Triple("future-kind", "futureId", "future"),
      )
    for ((kind, targetField, target) in destinations) {
      val routing =
        fields - setOf("threadId", "messageId") +
          mapOf(
            "kind" to kind,
            "deepLink" to "com.opensteer.mobile:/deployments/$dep/$target",
            "teamId" to dep,
          ) + if (targetField.isEmpty()) emptyMap() else mapOf(targetField to target)
      for (fails in listOf(false, true)) {
        val result = PreviewNotification.build(routing + ("preview" to "encrypted")) {
          if (fails) error("missing key or bad tag")
          "Title" to "Body"
        }
        assertEquals(routing, result.routing)
        assertEquals(
          if (targetField in setOf("channelId", "noticeId")) "$dep:$target" else null,
          result.group,
        )
        assertEquals(if (fails) PreviewNotification.generic(kind) else "Body", result.text)
      }
    }
    val failed = PreviewNotification.build(fields) { error("bad tag") }
    assertEquals(fields, failed.routing)
    assertEquals("Opensteer", failed.title)
    assertEquals("Opensteer replied", failed.text)
  }

  @Test
  fun strictPlaintext() {
    val text = mapOf("version" to 1, "title" to "Title", "body" to "Body")
    assertEquals("Title" to "Body", PreviewNotification.plaintext(text))
    for (bad in
      listOf(
        text + ("version" to true),
        text + ("extra" to "x"),
        text + ("title" to ""),
        text + ("body" to "x".repeat(181)),
      )) {
      assertThrows(Exception::class.java) { PreviewNotification.plaintext(bad) }
    }
  }
}
