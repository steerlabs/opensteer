package com.opensteer.agentphone.wire

/**
 * A JSON value exactly as JavaScript holds one, because the Host is
 * JavaScript and every signature covers JavaScript's reading of a value.
 *
 * Numbers are read as doubles, as in JavaScript, so any number the wire
 * allows reads as the Host wrote it. Canonical payloads contain only safe
 * integers; unsigned frames also carry fractional geometry. Strings are UTF-16, so a lone surrogate
 * survives a round trip.
 */
sealed interface Json

data object JsonNull : Json

data class JsonBool(val value: Boolean) : Json

data class JsonNumber(val value: Double) : Json

data class JsonString(val value: String) : Json

data class JsonArray(val items: List<Json>) : Json

/** Fields in insertion order, which is the order `JSON.stringify` writes them in. */
data class JsonObject(val fields: Map<String, Json>) : Json

/** What the Host sent cannot be read as the protocol says: a violation by the connection it came on. */
class WireException(message: String, val reason: String? = null) : RuntimeException(message)

fun jsonOf(value: String): Json = JsonString(value)

fun jsonOf(value: Boolean): Json = JsonBool(value)

fun jsonOf(value: Int): Json = JsonNumber(value.toDouble())

fun jsonOf(value: Long): Json {
    require(value in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) { "$value is not exactly representable in JavaScript" }
    return JsonNumber(value.toDouble())
}

/** JSON `null` for a Kotlin null: for a field that is present and null on the wire. */
fun jsonOrNull(value: String?): Json = value?.let(::JsonString) ?: JsonNull

fun jsonObject(vararg fields: Pair<String, Json>): JsonObject = JsonObject(linkedMapOf(*fields))

fun jsonArray(vararg items: Json): JsonArray = JsonArray(items.toList())

const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

/** `JSON.parse` and `JSON.stringify`, with JavaScript's results. */
object JsonText {
    private const val MAX_DEPTH = 128

    fun parse(text: String): Json {
        val parser = Parser(text)
        parser.skipWhitespace()
        val value = parser.value(0)
        parser.skipWhitespace()
        if (!parser.atEnd()) parser.fail("unexpected text after the value")
        return value
    }

    /** `JSON.stringify(value)`. */
    fun stringify(value: Json): String = buildString { write(value, ::safeInteger) }

    /** Unsigned transport JSON needs numerical round trips, not signature-compatible spellings. */
    fun stringifyFrame(value: Json): String = buildString { write(value, ::frameNumber) }

    private fun StringBuilder.write(value: Json, number: (Double) -> String) {
        when (value) {
            JsonNull -> append("null")
            is JsonBool -> append(value.value)
            is JsonNumber -> append(number(value.value))
            is JsonString -> quote(value.value)
            is JsonArray -> {
                append('[')
                value.items.forEachIndexed { index, item ->
                    if (index > 0) append(',')
                    write(item, number)
                }
                append(']')
            }
            is JsonObject -> {
                append('{')
                var first = true
                for ((key, item) in value.fields) {
                    if (!first) append(',')
                    first = false
                    quote(key)
                    append(':')
                    write(item, number)
                }
                append('}')
            }
        }
    }

    /**
     * `JSON.stringify` of a canonical number. These are safe integers,
     * which JavaScript writes as their plain digits and
     * `-0` as `0`; anything else is refused rather than rounded, so the Host
     * can never read a different number from the one the phone meant.
     */
    private fun safeInteger(value: Double): String {
        require(value == Math.floor(value) && Math.abs(value) <= MAX_SAFE_INTEGER) { "$value is not a safe integer" }
        return value.toLong().toString()
    }

    private fun frameNumber(value: Double): String =
        if (value.isFinite() && value != Math.floor(value)) value.toString() else safeInteger(value)

    /**
     * `JSON.stringify`'s string quoting (ECMA-262 QuoteJSONString): the short
     * escapes, `\u00xx` in lowercase hex for the other control characters, and
     * a lone surrogate escaped rather than written as invalid UTF-16.
     */
    fun StringBuilder.quote(text: String) {
        append('"')
        var index = 0
        while (index < text.length) {
            val char = text[index]
            when {
                char == '"' -> append("\\\"")
                char == '\\' -> append("\\\\")
                char == '\b' -> append("\\b")
                char == '\u000c' -> append("\\f")
                char == '\n' -> append("\\n")
                char == '\r' -> append("\\r")
                char == '\t' -> append("\\t")
                char < ' ' -> appendEscape(char)
                char.isHighSurrogate() && index + 1 < text.length && text[index + 1].isLowSurrogate() -> {
                    append(char).append(text[index + 1])
                    index += 1
                }
                char.isSurrogate() -> appendEscape(char)
                else -> append(char)
            }
            index += 1
        }
        append('"')
    }

    private fun StringBuilder.appendEscape(char: Char) {
        append("\\u").append(char.code.toString(16).padStart(4, '0'))
    }

    private class Parser(private val text: String) {
        private var position = 0

        fun atEnd() = position >= text.length

        fun fail(reason: String): Nothing = throw WireException("Invalid JSON at $position: $reason")

        fun skipWhitespace() {
            while (position < text.length && text[position] in " \t\n\r") position += 1
        }

        fun value(depth: Int): Json {
            if (depth > MAX_DEPTH) fail("nested too deeply")
            if (atEnd()) fail("unexpected end")
            return when (text[position]) {
                '{' -> obj(depth)
                '[' -> array(depth)
                '"' -> JsonString(string())
                't' -> literal("true", JsonBool(true))
                'f' -> literal("false", JsonBool(false))
                'n' -> literal("null", JsonNull)
                else -> number()
            }
        }

        private fun literal(word: String, value: Json): Json {
            if (!text.startsWith(word, position)) fail("expected $word")
            position += word.length
            return value
        }

        private fun obj(depth: Int): JsonObject {
            position += 1
            val fields = LinkedHashMap<String, Json>()
            skipWhitespace()
            if (peek() == '}') {
                position += 1
                return JsonObject(fields)
            }
            while (true) {
                skipWhitespace()
                if (peek() != '"') fail("expected a key")
                val key = string()
                skipWhitespace()
                if (peek() != ':') fail("expected ':'")
                position += 1
                skipWhitespace()
                // A repeated key keeps its first position and its last value, as in JavaScript.
                fields[key] = value(depth + 1)
                skipWhitespace()
                when (peek()) {
                    ',' -> position += 1
                    '}' -> {
                        position += 1
                        return JsonObject(fields)
                    }
                    else -> fail("expected ',' or '}'")
                }
            }
        }

        private fun array(depth: Int): JsonArray {
            position += 1
            val items = ArrayList<Json>()
            skipWhitespace()
            if (peek() == ']') {
                position += 1
                return JsonArray(items)
            }
            while (true) {
                skipWhitespace()
                items += value(depth + 1)
                skipWhitespace()
                when (peek()) {
                    ',' -> position += 1
                    ']' -> {
                        position += 1
                        return JsonArray(items)
                    }
                    else -> fail("expected ',' or ']'")
                }
            }
        }

        private fun peek(): Char = if (atEnd()) fail("unexpected end") else text[position]

        private fun string(): String {
            position += 1
            val out = StringBuilder()
            while (true) {
                val char = peek()
                position += 1
                when {
                    char == '"' -> return out.toString()
                    char == '\\' -> {
                        val escape = peek()
                        position += 1
                        when (escape) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000c')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (position + 4 > text.length) fail("short unicode escape")
                                val hex = text.substring(position, position + 4)
                                if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) fail("bad unicode escape")
                                out.append(hex.toInt(16).toChar())
                                position += 4
                            }
                            else -> fail("bad escape")
                        }
                    }
                    char < ' ' -> fail("control character in a string")
                    else -> out.append(char)
                }
            }
        }

        private fun number(): JsonNumber {
            val start = position
            if (peek() == '-') position += 1
            when {
                atEnd() -> fail("unexpected end")
                text[position] == '0' -> position += 1
                text[position] in '1'..'9' -> while (!atEnd() && text[position].isAsciiDigit()) position += 1
                else -> fail("unexpected character")
            }
            if (!atEnd() && text[position] == '.') {
                position += 1
                if (atEnd() || !text[position].isAsciiDigit()) fail("expected a digit")
                while (!atEnd() && text[position].isAsciiDigit()) position += 1
            }
            if (!atEnd() && (text[position] == 'e' || text[position] == 'E')) {
                position += 1
                if (!atEnd() && (text[position] == '+' || text[position] == '-')) position += 1
                if (atEnd() || !text[position].isAsciiDigit()) fail("expected a digit")
                while (!atEnd() && text[position].isAsciiDigit()) position += 1
            }
            // Correctly rounded, as JavaScript's own parse is; `-0` stays negative zero.
            return JsonNumber(text.substring(start, position).toDouble())
        }

        private fun Char.isAsciiDigit() = this in '0'..'9'
    }
}
