package com.opensteer.phonebrowser

import kotlin.math.max
import kotlin.math.roundToLong

/**
 * What a page's geometry revision follows: its size, zoom and keyboard. Scrolling, and the visual
 * viewport sliding over the layout viewport as it scrolls, move the page under unchanged
 * coordinates, as on the Mac and iPhone, so they are reported but not counted.
 */
internal object PageGeometry {
  fun native(width: Int, height: Int, scale: Float, keyboard: Int): List<Number> = listOf(width, height, scale, keyboard)
  /** The renderer's `[width, height, scale, offsetX, offsetY, scrollX, scrollY]`, without what scrolling moves. */
  fun renderer(observed: List<Double>): List<Double> = observed.take(3)
}

/** Where a presented page is scrolled, in the host's density-independent units, as `onPageScroll` sends it. */
internal data class PageScroll(val y: Double, val end: Double, val person: Boolean) {
  fun same(other: PageScroll?) = other != null && other.person == person && y.roundToLong() == other.y.roundToLong() && end.roundToLong() == other.end.roundToLong()
  companion object {
    fun of(scrollY: Int, contentHeight: Double, viewHeight: Int, density: Float, person: Boolean): PageScroll {
      val unit = density.toDouble().coerceAtLeast(0.01)
      return PageScroll(scrollY / unit, max(0.0, contentHeight - viewHeight) / unit, person)
    }
  }
}

/**
 * Whether the person is moving the page: a finger on it, or the fling it left still carrying it.
 * A fling's frames follow each other closely; a pause longer than [settle] ends it, so a later
 * scroll by an agent or the page itself is not the person's.
 */
internal class PersonScroll(private val settle: Long = 100) {
  var touching = false
    private set
  private var carrying = false
  private var last = 0L
  fun touched(down: Boolean, now: Long) {
    if (down) { touching = true; carrying = false }
    else if (touching) { touching = false; carrying = true; last = now }
  }
  fun moved(now: Long): Boolean {
    if (touching) { last = now; return true }
    if (carrying && now - last <= settle) { last = now; return true }
    carrying = false
    return false
  }
  fun clear() { touching = false; carrying = false }
}

/**
 * Whether a presented page takes its host's new size. It follows the host turning or growing; a
 * host the keyboard shortens for a moment, and a size an agent chose, are left as they are.
 */
internal object PageFollow {
  fun follows(before: Pair<Int, Int>?, after: Pair<Int, Int>): Boolean =
    before != null && after.first > 0 && after.second > 0 && before != after && (after.first != before.first || after.second > before.second)
}
