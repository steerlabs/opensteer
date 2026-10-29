package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.PixelRect
import com.opensteer.agentphone.wire.Tree
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tree text an agent aims by. Failure modes:
 *
 * 1. a line that is not `[index] role "label" (x,y w×h) flags`, indented by depth;
 * 2. a label that breaks the line or the quoting, or runs on for a page;
 * 3. more than 1,500 elements, or more than 32,000 UTF-8 bytes, counting the
 *    closing line, or multi-byte text measured in characters;
 * 4. a cut tree that does not say how much it left out, or an `elementCount`
 *    naming lines that were cut, which would make their indices targets.
 */
class TreeWriterTest {
    private fun element(depth: Int = 0, label: String? = "Send", flags: List<String> = listOf("clickable")) =
        TreeElement(depth = depth, role = "button", label = label, frame = PixelRect(10, 20, 40, 60), flags = flags)

    /** The shortest line an element can have, so 1,500 of them fit the byte budget. */
    private fun tiny() = TreeElement(depth = 0, role = "v", label = null, frame = PixelRect(0, 0, 0, 0), flags = emptyList())

    @Test
    fun writesOneIndentedLinePerElement() {
        val tree = TreeWriter.write(listOf(element(), element(depth = 2, label = null, flags = emptyList())), omitted = 0)
        assertEquals("[0] button \"Send\" (10,20 30×40) clickable\n    [1] button (10,20 30×40)", tree.text)
        assertEquals(2, tree.elementCount)
        assertFalse(tree.truncated)
        assertEquals(TreeWriter.write(emptyList(), 0), Tree("", 0, false))
    }

    @Test
    fun keepsALabelOnOneQuotedLine() {
        val line = TreeWriter.write(listOf(element(label = "a\n\"b\"\\c\t" + "x".repeat(300))), 0).text
        assertEquals("[0] button \"a \\\"b\\\"\\\\c " + "x".repeat(192) + "…\" (10,20 30×40) clickable", line)
    }

    @Test
    fun saysHowManyElementsTheWalkLeftOut() {
        // The writer itself holds the 1,500-element cap, whatever the walk handed it.
        val tree = TreeWriter.write(List(1_600) { tiny() }, omitted = 0)
        assertEquals(1_500, tree.elementCount)
        assertTrue(tree.truncated)
        assertTrue(tree.text.endsWith("\n… 100 more elements not shown; act on what you see or scroll."))
    }

    @Test
    fun cutsFromTheEndToFitThirtyTwoThousandBytes() {
        val label = "é".repeat(150) // 300 bytes, 150 characters
        val tree = TreeWriter.write(List(400) { element(label = label) }, omitted = 0)
        assertTrue(tree.text.toByteArray(Charsets.UTF_8).size <= 32_000)
        assertTrue(tree.truncated)
        val lines = tree.text.split("\n")
        assertEquals(tree.elementCount, lines.size - 1)
        assertEquals("… ${400 - tree.elementCount} more elements not shown; act on what you see or scroll.", lines.last())
    }
}
