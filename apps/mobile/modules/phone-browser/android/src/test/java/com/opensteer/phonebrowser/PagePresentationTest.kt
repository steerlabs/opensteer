package com.opensteer.phonebrowser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PagePresentationTest {
  @Test fun scrollingAndTheVisualViewportSlidingKeepTheGeometryRevision() {
    val resting = listOf(412.0, 860.0, 1.0, 0.0, 0.0, 0.0, 0.0)
    val scrolled = listOf(412.0, 860.0, 1.0, 0.0, 37.5, 0.0, 4820.0)
    assertEquals(PageGeometry.renderer(resting), PageGeometry.renderer(scrolled))
    assertNotEquals(PageGeometry.renderer(resting), PageGeometry.renderer(listOf(412.0, 540.0, 1.0, 0.0, 0.0, 0.0, 0.0)))
    assertNotEquals(PageGeometry.renderer(resting), PageGeometry.renderer(listOf(206.0, 430.0, 2.0, 0.0, 0.0, 0.0, 0.0)))
    assertNotEquals(PageGeometry.native(1080, 2340, 2.75f, 0), PageGeometry.native(1080, 2340, 2.75f, 812))
  }

  @Test fun pageScrollIsSentInTheHostsUnitsOncePerWholeStep() {
    val sample = PageScroll.of(scrollY = 1100, contentHeight = 22000.0, viewHeight = 2200, density = 2.75f, person = true)
    assertEquals(400.0, sample.y, 0.001)
    assertEquals(7200.0, sample.end, 0.001)
    assertTrue(sample.same(PageScroll.of(1101, 22000.0, 2200, 2.75f, true)))
    assertFalse(sample.same(PageScroll.of(1104, 22000.0, 2200, 2.75f, true)))
    assertFalse(sample.same(PageScroll.of(1100, 22000.0, 2200, 2.75f, false)))
    assertEquals(0.0, PageScroll.of(0, 1000.0, 2200, 2.75f, false).end, 0.0)
  }

  @Test fun onlyTheFingerAndTheFlingItLeftAreThePersons() {
    val person = PersonScroll(settle = 100)
    assertFalse(person.moved(0))
    person.touched(true, 10)
    assertTrue(person.moved(20))
    person.touched(false, 30)
    assertTrue(person.moved(46))
    assertTrue(person.moved(62))
    assertFalse(person.moved(400))
    assertFalse(person.moved(416))
    person.touched(true, 500)
    person.clear()
    assertFalse(person.moved(510))
  }

  @Test fun thePageFollowsItsHostTurningOrGrowingButNotTheKeyboard() {
    assertFalse(PageFollow.follows(null, 1080 to 2200))
    assertTrue(PageFollow.follows(1080 to 2200, 2200 to 1080))
    assertTrue(PageFollow.follows(1080 to 1400, 1080 to 2200))
    assertFalse(PageFollow.follows(1080 to 2200, 1080 to 1400))
    assertFalse(PageFollow.follows(1080 to 2200, 1080 to 2200))
  }
}
