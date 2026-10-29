package com.opensteer.agentphone.wire

/**
 * Reads one JSON object the way a Zod `strictObject` does: every field the
 * schema names is checked, and `end()` refuses any field it did not name.
 *
 * Lengths are UTF-16 code units and integers are JavaScript safe integers,
 * because those are what Zod measures on the Host.
 */
class Fields private constructor(private val fields: Map<String, Json>, private val path: String) {
    private val seen = HashSet<String>()

    fun fail(key: String, reason: String): Nothing = throw WireException("$path.$key $reason")

    private fun take(key: String): Json? {
        seen += key
        return fields[key]
    }

    private fun required(key: String): Json = take(key) ?: fail(key, "is missing")

    fun has(key: String): Boolean = fields.containsKey(key)

    fun raw(key: String): Json = required(key)

    fun optionalRaw(key: String): Json? = take(key)

    fun string(key: String, min: Int = 0, max: Int = Int.MAX_VALUE, pattern: Regex? = null): String =
        checkString(key, required(key) as? JsonString ?: fail(key, "is not a string"), min, max, pattern)

    fun stringOrNull(key: String, min: Int = 0, max: Int = Int.MAX_VALUE, pattern: Regex? = null): String? =
        when (val value = required(key)) {
            JsonNull -> null
            is JsonString -> checkString(key, value, min, max, pattern)
            else -> fail(key, "is not a string or null")
        }

    fun optionalString(key: String, min: Int = 0, max: Int = Int.MAX_VALUE, pattern: Regex? = null): String? =
        when (val value = take(key)) {
            null -> null
            is JsonString -> checkString(key, value, min, max, pattern)
            else -> fail(key, "is not a string")
        }

    private fun checkString(key: String, value: JsonString, min: Int, max: Int, pattern: Regex?): String {
        val text = value.value
        if (text.length < min || text.length > max) fail(key, "has length ${text.length} outside $min..$max")
        if (pattern != null && !pattern.matches(text)) fail(key, "does not match its pattern")
        return text
    }

    fun literal(key: String, expected: String) {
        if (string(key) != expected) fail(key, "is not \"$expected\"")
    }

    fun enum(key: String, values: Set<String>): String = string(key).also { if (it !in values) fail(key, "is not one of $values") }

    fun isoTime(key: String): String = string(key).also { if (!IsoTime.isValid(it)) fail(key, "is not an ISO date-time") }

    fun bool(key: String): Boolean = (required(key) as? JsonBool ?: fail(key, "is not a boolean")).value

    fun optionalBool(key: String): Boolean? = when (val value = take(key)) {
        null -> null
        is JsonBool -> value.value
        else -> fail(key, "is not a boolean")
    }

    fun int(key: String, min: Long = -MAX_SAFE_INTEGER, max: Long = MAX_SAFE_INTEGER): Long =
        checkInt(key, required(key), min, max)

    fun optionalInt(key: String, min: Long = -MAX_SAFE_INTEGER, max: Long = MAX_SAFE_INTEGER): Long? =
        take(key)?.let { checkInt(key, it, min, max) }

    private fun checkInt(key: String, value: Json, min: Long, max: Long): Long {
        val number = (value as? JsonNumber ?: fail(key, "is not a number")).value
        if (number != Math.floor(number) || Math.abs(number) > MAX_SAFE_INTEGER) fail(key, "is not an integer")
        val integer = number.toLong()
        if (integer < min || integer > max) fail(key, "is $integer, outside $min..$max")
        return integer
    }

    fun obj(key: String): Fields = of(required(key), "$path.$key")

    fun objectValue(key: String): JsonObject = required(key) as? JsonObject ?: fail(key, "is not an object")

    fun array(key: String, min: Int = 0, max: Int = Int.MAX_VALUE): List<Json> {
        val items = (required(key) as? JsonArray ?: fail(key, "is not an array")).items
        if (items.size < min || items.size > max) fail(key, "has ${items.size} items outside $min..$max")
        return items
    }

    fun stringArray(key: String, max: Int = Int.MAX_VALUE, item: Regex? = null): List<String> = array(key, max = max).map {
        val text = (it as? JsonString ?: fail(key, "holds a non-string")).value
        if (item != null && !item.matches(text)) fail(key, "holds an invalid item")
        text
    }

    /** Refuses every field that was never read: Zod's strict objects allow none. */
    fun end() {
        val unknown = fields.keys - seen
        if (unknown.isNotEmpty()) throw WireException("$path has unexpected fields $unknown")
    }

    companion object {
        fun of(value: Json, path: String): Fields =
            Fields((value as? JsonObject ?: throw WireException("$path is not an object")).fields, path)

        fun parse(text: String, path: String): Fields = of(JsonText.parse(text), path)
    }
}

/** The identifier shapes of `@opensteer/core` and `@opensteer/protocol`. */
object Ids {
    private const val UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"

    // Core and protocol identifiers match case-insensitively (`new RegExp(..., "i")`).
    private fun prefixed(prefix: String) = Regex("^${prefix}_$UUID$", RegexOption.IGNORE_CASE)

    val runner = prefixed("rnr")
    val boot = prefixed("rbt")
    val challenge = prefixed("rch")
    val connection = prefixed("rcn")
    val lease = prefixed("rls")
    val auxiliaryStream = prefixed("rax")
    val deployment = prefixed("dep")
    val hostInstance = prefixed("hst")
    val run = prefixed("run")
    val environment = prefixed("env")
    val computerUseSession = prefixed("cus")
    val computerView = prefixed("cvw")
    val displayStream = prefixed("dsp")
    val displayControl = prefixed("dcl")

    /** Zod's `z.uuid()`: versions 1 to 8, plus the nil and max UUIDs. */
    val uuid = Regex("^(?:$UUID|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")

    val nonce = Regex("^[A-Za-z0-9_-]{32,255}$")
    val signature = Regex("^[A-Za-z0-9_-]{86}$")
    val requestId = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    val ticket = Regex("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")
    val definitionId = Regex("^[a-z][a-z0-9-]*$")
    val contract = Regex("^[A-Za-z0-9_-]{43}$")
    val androidPackage = Regex("^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$")
}

/**
 * `String.prototype.trim`: ECMAScript white space and line terminators,
 * which is not Kotlin's `trim` (it keeps U+FEFF and strips U+001C..U+001F).
 * Zod trims the fields it is told to before it checks them, so the phone
 * signs and stores exactly what the Host will read.
 */
fun String.jsTrim(): String {
    fun Char.isJsSpace() = this == '\t' || this == '\u000b' || this == '\u000c' || this == ' ' || this == '\u00a0' ||
        this == '\ufeff' || this == '\n' || this == '\r' || this == '\u2028' || this == '\u2029' ||
        Character.getType(this) == Character.SPACE_SEPARATOR.toInt()
    return trim { it.isJsSpace() }
}
