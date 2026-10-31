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
  fun invalidRouteAndFailedDecrypt() {
    val invalid =
      PreviewNotification.build(fields + ("deepLink" to "https://example.com")) {
        error("must not decrypt")
      }
    assertTrue(invalid.routing.isEmpty())
    assertNull(invalid.group)
    assertEquals("Opensteer replied", invalid.text)
    val failed = PreviewNotification.build(fields) { error("bad tag") }
    assertEquals(fields, failed.routing)
    assertEquals("Opensteer", failed.title)
    assertEquals("Opensteer replied", failed.text)
    assertEquals("Opensteer needs you", PreviewNotification.generic("request-opened"))
    assertEquals("Opensteer couldn't finish", PreviewNotification.generic("run-failed"))
    assertFalse(
      PreviewNotification.validRoute(
        fields + ("deepLink" to fields.getValue("deepLink") + "&messageId=$message")
      )
    )
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
