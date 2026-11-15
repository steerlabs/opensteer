package com.opensteer.composereditor

/** One chip: the UTF-16 range of its Markdown source in the editor's text. */
data class ChipRange(val start: Int, val end: Int)

/**
 * The editor keeps the Markdown source as its text and draws each reference as a
 * span over it, so every edit an IME or key can make is checked here to remove or
 * select whole references, never part of one.
 */
object ComposerDocument {
  /** Chips that still match `text`, in order and without overlap. */
  fun validChips(text: CharSequence, chips: List<Pair<ChipRange, String>>): List<ChipRange> {
    var cursor = 0
    return chips.mapNotNull { (range, source) ->
      if (range.start < cursor || range.end <= range.start || range.end > text.length) return@mapNotNull null
      if (text.subSequence(range.start, range.end).toString() != source) return@mapNotNull null
      cursor = range.end
      range
    }
  }

  /** A caret inside a chip moves to its nearer edge; a range grows to whole chips. */
  fun snapSelection(start: Int, end: Int, chips: List<ChipRange>): Pair<Int, Int> {
    var from = minOf(start, end)
    var to = maxOf(start, end)
    if (from == to) {
      val inside = chips.firstOrNull { from > it.start && from < it.end } ?: return from to to
      val edge = if (from - inside.start < inside.end - from) inside.start else inside.end
      return edge to edge
    }
    for (chip in chips) {
      if (from < chip.end && to > chip.start) {
        from = minOf(from, chip.start)
        to = maxOf(to, chip.end)
      }
    }
    return from to to
  }

  /** What Backspace (or forward Delete) removes when it touches a chip, or null for plain text. */
  fun keyDeletion(selectionStart: Int, selectionEnd: Int, backwards: Boolean, chips: List<ChipRange>): ChipRange? {
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    val from = if (start == end && backwards) start - 1 else start
    val to = if (start == end && !backwards) end + 1 else end
    val touched = chips.filter { it.start < to && it.end > from }
    if (touched.isEmpty()) return null
    return ChipRange(minOf(from, touched.minOf { it.start }), maxOf(to, touched.maxOf { it.end }))
  }

  /**
   * An IME's `deleteSurroundingText(before, after)` around the selection, grown so a
   * chip it reaches into goes whole (Gboard deletes by word and by swipe).
   */
  fun surroundingDeletion(
    selectionStart: Int,
    selectionEnd: Int,
    before: Int,
    after: Int,
    chips: List<ChipRange>,
  ): Pair<Int, Int> {
    val start = minOf(selectionStart, selectionEnd)
    val end = maxOf(selectionStart, selectionEnd)
    var from = (start - before).coerceAtLeast(0)
    var to = end + after
    for (chip in chips) {
      if (before > 0 && chip.start < start && chip.end > from) from = minOf(from, chip.start)
      if (after > 0 && chip.end > end && chip.start < to) to = maxOf(to, chip.end)
    }
    return (start - from) to (to - end)
  }

  /** A composing region never takes part of a chip: it stops at the chip's edge. */
  fun composingRegion(start: Int, end: Int, caret: Int, chips: List<ChipRange>): Pair<Int, Int> {
    var from = minOf(start, end)
    var to = maxOf(start, end)
    for (chip in chips) {
      if (chip.start >= to || chip.end <= from) continue
      if (chip.end <= caret) from = maxOf(from, chip.end) else to = minOf(to, chip.start)
    }
    return from to maxOf(from, to)
  }
}
