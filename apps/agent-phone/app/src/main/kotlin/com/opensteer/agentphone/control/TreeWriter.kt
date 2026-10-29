package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.AndroidPhoneWire
import com.opensteer.agentphone.wire.PixelRect
import com.opensteer.agentphone.wire.Tree

/** One line's worth of an element, its frame already in screenshot pixels. */
data class TreeElement(val depth: Int, val role: String, val label: String?, val frame: PixelRect, val flags: List<String>)

/**
 * The tree text of an observation, written as the Mac helper writes it
 * (`TreeFormatter.swift`): one element per line, indented by depth —
 * `[12] button "Send" (412,88 96×28) clickable`.
 *
 * Its budget is the smallest tool-output limit of the engines an agent runs
 * on, in UTF-8 bytes. An engine that cuts a longer result drops the middle,
 * and the model then acts on a tree it cannot tell is incomplete, so the cut
 * is made here, from the end, and the last line says so.
 */
object TreeWriter {
    private const val LABEL_LIMIT = 200

    fun write(elements: List<TreeElement>, omitted: Int): Tree {
        val lines = elements.take(AndroidPhoneWire.MAX_ELEMENTS).mapIndexed(::line)
        val walkOmitted = omitted + (elements.size - lines.size)
        var kept = 0
        var used = 0
        while (kept < lines.size) {
            val next = used + (if (kept == 0) 0 else 1) + utf8(lines[kept])
            val closing = closingLine(walkOmitted + lines.size - kept - 1)
            if (next + (closing?.let { 1 + utf8(it) } ?: 0) > AndroidPhoneWire.TREE_MAX_BYTES) break
            used = next
            kept += 1
        }
        val left = walkOmitted + lines.size - kept
        val text = buildString {
            append(lines.take(kept).joinToString("\n"))
            closingLine(left)?.let { if (isEmpty()) append(it) else append('\n').append(it) }
        }
        return Tree(text, kept, left > 0)
    }

    private fun closingLine(omitted: Int): String? =
        if (omitted > 0) "… $omitted more elements not shown; act on what you see or scroll." else null

    private fun line(index: Int, element: TreeElement): String = buildString {
        repeat(element.depth) { append("  ") }
        append('[').append(index).append("] ").append(element.role)
        element.label?.let(::sanitize)?.takeIf { it.isNotEmpty() }?.let { append(" \"").append(it).append('"') }
        val frame = element.frame
        append(" (").append(frame.left).append(',').append(frame.top).append(' ')
        append(frame.width).append('×').append(frame.height).append(')')
        for (flag in element.flags) append(' ').append(flag)
    }

    /**
     * One line, cut at 200 characters, then quoted: cutting after escaping
     * could leave half an escape at the end and break the quoting.
     */
    private fun sanitize(raw: String): String {
        val flat = raw.replace("\r\n", " ").replace('\n', ' ').replace('\r', ' ').replace('\t', ' ').trim()
        val cut = if (flat.codePointCount(0, flat.length) > LABEL_LIMIT) {
            flat.substring(0, flat.offsetByCodePoints(0, LABEL_LIMIT)) + "…"
        } else {
            flat
        }
        return cut.replace("\\", "\\\\").replace("\"", "\\\"")
    }

    private fun utf8(text: String) = text.toByteArray(Charsets.UTF_8).size
}
