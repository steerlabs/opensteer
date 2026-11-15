package com.opensteer.composereditor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComposerDocumentTest {
  private val link = "[Fix login](opensteer:thr_12345678-1234-4234-8234-123456789abc)"
  private val text = "a $link b"
  private val chip = ChipRange(2, 2 + link.length)

  @Test
  fun staleChipsAreNotDrawn() {
    assertEquals(listOf(chip), ComposerDocument.validChips(text, listOf(chip to link)))
    assertEquals(emptyList<ChipRange>(), ComposerDocument.validChips(text, listOf(ChipRange(1, 1 + link.length) to link)))
    assertEquals(listOf(chip), ComposerDocument.validChips(text, listOf(chip to link, chip to link)))
  }

  @Test
  fun caretNeverRestsInsideAChipAndRangesTakeWholeChips() {
    assertEquals(2 to 2, ComposerDocument.snapSelection(4, 4, listOf(chip)))
    assertEquals(chip.end to chip.end, ComposerDocument.snapSelection(chip.end - 2, chip.end - 2, listOf(chip)))
    assertEquals(0 to chip.end, ComposerDocument.snapSelection(0, 5, listOf(chip)))
    assertEquals(chip.start to text.length, ComposerDocument.snapSelection(text.length, chip.end - 1, listOf(chip)))
  }

  @Test
  fun backspaceAndDeleteRemoveTheWholeChip() {
    assertEquals(chip, ComposerDocument.keyDeletion(chip.end, chip.end, true, listOf(chip)))
    assertEquals(chip, ComposerDocument.keyDeletion(chip.start, chip.start, false, listOf(chip)))
    assertNull(ComposerDocument.keyDeletion(1, 1, true, listOf(chip)))
    assertEquals(ChipRange(0, chip.end), ComposerDocument.keyDeletion(0, 4, true, listOf(chip)))
  }

  @Test
  fun gboardSurroundingDeletionGrowsToWholeChips() {
    // One character back from just after the chip removes all of its source.
    assertEquals(link.length to 0, ComposerDocument.surroundingDeletion(chip.end, chip.end, 1, 0, listOf(chip)))
    // A swipe-delete of the word before reaches into the chip and takes it.
    assertEquals(link.length + 2 to 0, ComposerDocument.surroundingDeletion(text.length, text.length, 3, 0, listOf(chip)))
    assertEquals(0 to link.length, ComposerDocument.surroundingDeletion(chip.start, chip.start, 0, 1, listOf(chip)))
    assertEquals(1 to 0, ComposerDocument.surroundingDeletion(1, 1, 1, 0, listOf(chip)))
  }

  @Test
  fun composingRegionStopsAtAChip() {
    // Re-composing "b" after the chip must not take the chip's closing source with it.
    assertEquals(chip.end to text.length, ComposerDocument.composingRegion(chip.end - 3, text.length, text.length, listOf(chip)))
    assertEquals(0 to chip.start, ComposerDocument.composingRegion(0, chip.start + 3, 0, listOf(chip)))
  }
}
