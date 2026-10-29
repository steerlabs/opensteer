package com.opensteer.agentphone.control

/**
 * Text typed as a person types it: at the cursor, replacing any selection,
 * with the cursor after it. `ACTION_SET_TEXT` replaces a field's whole text,
 * so the phone computes the whole new text itself — before the selection,
 * the typed text, after it — and then puts the cursor back.
 */
data class TextInsertion(val text: String, val cursor: Int) {
    companion object {
        /** A selection of -1 is no cursor at all, which types at the end. */
        fun insert(current: String, selectionStart: Int, selectionEnd: Int, typed: String): TextInsertion {
            val start = clamp(minOf(selectionStart, selectionEnd), current.length)
            val end = clamp(maxOf(selectionStart, selectionEnd), current.length)
            return TextInsertion(current.substring(0, start) + typed + current.substring(end), start + typed.length)
        }

        fun deleteBackward(current: String, selectionStart: Int, selectionEnd: Int, count: Int): TextInsertion {
            val start = clamp(minOf(selectionStart, selectionEnd), current.length)
            val end = clamp(maxOf(selectionStart, selectionEnd), current.length)
            var from = start
            if (start == end) repeat(count) { if (from > 0) from = current.offsetByCodePoints(from, -1) }
            return TextInsertion(current.removeRange(from, end), from)
        }

        private fun clamp(index: Int, length: Int) = if (index < 0 || index > length) length else index
    }
}
