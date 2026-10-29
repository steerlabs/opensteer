package com.opensteer.agentphone.wire

import com.opensteer.agentphone.wire.JsonText.quote

/**
 * `canonicalJson` from `@opensteer/shared`: `JSON.stringify` with every
 * object's keys sorted by UTF-16 code unit, which is how JavaScript compares
 * strings and how Kotlin's `String.compareTo` compares them.
 */
object CanonicalJson {
    fun encode(value: Json): String = buildString { write(value) }

    private fun StringBuilder.write(value: Json) {
        when (value) {
            is JsonArray -> {
                append('[')
                value.items.forEachIndexed { index, item ->
                    if (index > 0) append(',')
                    write(item)
                }
                append(']')
            }
            is JsonObject -> {
                append('{')
                value.fields.entries.sortedWith { left, right -> left.key.compareTo(right.key) }
                    .forEachIndexed { index, (key, item) ->
                        if (index > 0) append(',')
                        quote(key)
                        append(':')
                        write(item)
                    }
                append('}')
            }
            else -> append(JsonText.stringify(value))
        }
    }
}
