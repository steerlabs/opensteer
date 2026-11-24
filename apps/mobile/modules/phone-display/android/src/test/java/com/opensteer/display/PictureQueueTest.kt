package com.opensteer.display

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PictureQueueTest {
  private val outcomes = linkedMapOf<String, MutableList<PictureOutcome>>()
  private fun request(generation: Int = 0, fence: String = "a", upscale: Boolean = true) =
    PictureRequest(generation, fence, 8, 6, 8.0, 6.0, upscale, 15.0)
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

  // As on iOS: a picture for a generation the queue was never told takes it, as its clear would
  // have; one from an older generation is still dropped.
  @Test fun aPictureForANewerGenerationTakesItAsItsClearWouldHave() {
    val queue = PictureQueue<String>()
    assertEquals("new", queue.submit(request(3), "new", receipt("new"))?.payload)
    assertEquals(3, queue.generation)
    assertEquals("new", queue.complete(true).first?.payload)
    assertNull(outcomes["new"])
  }

  @Test fun aPictureFromAnOlderGenerationIsStillDropped() {
    val queue = PictureQueue<String>()
    queue.clear(3)
    assertNull(queue.submit(request(2), "old", receipt("old")))
    assertEquals(listOf(PictureOutcome.DROPPED), outcomes["old"])
    assertEquals(3, queue.generation)
  }

  // A clear for an older generation than one the queue took from a picture is stale: the
  // generation stays, and the picture it is decoding still draws.
  @Test fun aStaleClearNeverLowersTheGenerationNorDropsItsPictures() {
    val queue = PictureQueue<String>()
    assertEquals("new", queue.submit(request(3), "new", receipt("new"))?.payload)
    queue.clear(2)
    assertEquals(3, queue.generation)
    assertNull(outcomes["new"])
    assertEquals("new", queue.complete(true).first?.payload)
    assertNull(queue.submit(request(2), "old", receipt("old")))
    assertEquals(listOf(PictureOutcome.DROPPED), outcomes["old"])
  }

  @Test fun laysOutLikeTheSharedBrowserPresentation() {
    assertArrayEquals(doubleArrayOf(0.0, 150.0, 400.0, 450.0), request().rect(400.0, 600.0), 0.0)
    assertArrayEquals(doubleArrayOf(196.0, 297.0, 204.0, 303.0), request(upscale = false).rect(400.0, 600.0), 0.0)
    assertNull(request().rect(0.0, 600.0))
  }

  @Test fun roundsOnlyAPictureThatFloatsFreeOfTheView() {
    // Filling the width, it meets the sides square.
    assertEquals(0.0, request().radius(400.0, 600.0), 0.0)
    assertEquals(15.0, request(upscale = false).radius(400.0, 600.0), 0.0)
    assertEquals(0.0, request(upscale = false).radius(8.0, 600.0), 0.0)
    assertEquals(0.0, request().radius(0.0, 600.0), 0.0)
  }
}
