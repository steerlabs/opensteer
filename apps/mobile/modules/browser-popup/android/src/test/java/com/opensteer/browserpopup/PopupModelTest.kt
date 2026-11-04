package com.opensteer.browserpopup
import org.junit.Assert.*
import org.junit.Test
class PopupModelTest {
  @Test fun openingReleaseBelongsToTheOriginalProxyExactlyOnce() {val keys=PopupKeyReleases();assertTrue(keys.ended(62));assertFalse(keys.ended(62));keys.began(66);assertFalse(keys.ended(66))}

  @Test fun lateActionsCannotCommitAfterRevisionOrDismissal() {
    val fence=PopupFence();fence.present("a","9007199254740993")
    assertFalse(fence.accept("a","9007199254740992"));assertTrue(fence.accept("a","9007199254740993"))
    fence.dismiss("a");assertFalse(fence.accept("a","9007199254740993"))
    fence.present("b","1");fence.dismiss("a");assertTrue(fence.accept("b","1"))
  }
  @Test fun calendarComponentsPreserveDSTSecondsAndWeekYear() {
    assertEquals(59,PopupCalendar.parse("2024-03-10T01:59:59.123","datetime-local")?.second)
    assertEquals(".125",PopupCalendar.parse("2024-11-03T01:30:00.125","datetime-local")?.fraction)
    assertNull(PopupCalendar.parse("2023-02-29","date"));assertNotNull(PopupCalendar.parse("2020-W53","week"));assertNull(PopupCalendar.parse("2021-W53","week"))
    assertEquals(12024,PopupCalendar.parse("12024-12","month")?.year)
  }
}
