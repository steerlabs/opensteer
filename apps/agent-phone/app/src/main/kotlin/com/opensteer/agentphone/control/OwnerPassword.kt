package com.opensteer.agentphone.control

/** API 30 fallback: learn a secret only from an empty field; forget it on reset or agent editing. Never copy masked text. */
class OwnerPassword {
    private var node: Any? = null
    private var value: String? = null
    fun clear() { node = null; value = null }
    fun edit(identity: Any, length: Int, start: Int, end: Int, insert: String?, delete: Int): TextInsertion? {
        if (node != identity) { clear(); node = identity }
        if (length == 0) value = ""
        val current = value
        if (current == null || current.length != length || (start !in 0..length || end !in 0..length) && !(length == 0 && start == -1 && end == -1)) { clear(); return null }
        val next = if (insert != null) TextInsertion.insert(current, start, end, insert)
            else TextInsertion.deleteBackward(current, start, end, delete)
        value = next.text
        return next
    }
}
