package com.opensteer.display

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PictureQueueTest {
  private val outcomes = linkedMapOf<String, MutableList<PictureOutcome>>()
  private fun request(generation: Int = 0, fence: String = "a", upscale: Boolean = true) =
    PictureRequest(generation, fence, 8, 6, 8.0, 6.0, upscale, 0.0)
  private fun receipt(key: String) = PictureReceipt { outcomes.getOrPut(key) { mutableListOf() }.add(it) }

  @Test fun keepsOneDecodingAndOnlyTheNewestWaitingAndSettlesEachOnce() {
    val queue = PictureQueue<String>()
    assertEquals("1", queue.submit(request(), "1", receipt("1"))?.payload)
    assertNull(queue.submit(request(), "2", receipt("2")))
    assertNull(queue.submit(request(), "3", receipt("3")))
    // The decode in progress is protected from starvation under the same fence.
    val (shown, next) = queue.complete(true)
    assertEquals("1", shown?.payload)
    assertEquals("3", next?.payload)
    shown?.receipt?.invoke(PictureOutcome.PRESENTED)
    shown?.receipt?.invoke(PictureOutcome.DROPPED)
    val (none, last) = queue.complete(false)
    assertNull(none); assertNull(last)
    assertEquals(
      mapOf("2" to listOf(PictureOutcome.DROPPED), "1" to listOf(PictureOutcome.PRESENTED), "3" to listOf(PictureOutcome.FAILED)),
      outcomes,
    )
  }

  @Test fun aNewerFenceSupersedesTheDecodeInProgress() {
    val queue = PictureQueue<String>()
    queue.submit(request(fence = "old"), "1", receipt("1"))
    queue.submit(request(fence = "new"), "2", receipt("2"))
    val (shown, next) = queue.complete(true)
    assertNull(shown)
    assertEquals("2", next?.payload)
    assertEquals(listOf(PictureOutcome.DROPPED), outcomes["1"])
  }

  @Test fun clearDropsEverythingAndNeverRunsTwoDecodesOrDrawsTheOldGeneration() {
    val queue = PictureQueue<String>()
    queue.submit(request(), "1", receipt("1"))
    queue.submit(request(), "2", receipt("2"))
    queue.clear(1)
    assertNull(queue.submit(request(0), "late", receipt("late")))
    // The abandoned decode is still running, so the next one waits for it.
    assertNull(queue.submit(request(1), "3", receipt("3")))
    val (abandoned, next) = queue.complete(true)
    assertNull(abandoned)
    assertEquals("3", next?.payload)
    assertEquals("3", queue.complete(true).first?.payload)
    assertEquals(listOf(PictureOutcome.DROPPED), outcomes["1"])
    assertEquals(listOf(PictureOutcome.DROPPED), outcomes["2"])
    assertEquals(listOf(PictureOutcome.DROPPED), outcomes["late"])
  }

  @Test fun laysOutLikeTheSharedBrowserPresentation() {
    assertArrayEquals(doubleArrayOf(0.0, 150.0, 400.0, 450.0), request().rect(400.0, 600.0), 0.0)
    assertArrayEquals(doubleArrayOf(196.0, 297.0, 204.0, 303.0), request(upscale = false).rect(400.0, 600.0), 0.0)
    assertNull(request().rect(0.0, 600.0))
  }
}
