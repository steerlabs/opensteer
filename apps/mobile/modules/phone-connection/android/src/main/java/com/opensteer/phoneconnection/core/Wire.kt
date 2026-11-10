package com.opensteer.phoneconnection.core

import kotlinx.serialization.json.*
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import org.bouncycastle.util.encoders.Base64

class Refused(val reason: String) : Exception(reason)

object Wire {
    const val MAX_SAFE = 9_007_199_254_740_991L
    val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }
    val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")

    fun parse(text: String, maxBytes: Int = 1_048_576): JsonObject {
        requireThat(text.toByteArray(Charsets.UTF_8).size <= maxBytes && !text.startsWith('\uFEFF'))
        return try { json.parseToJsonElement(text) as? JsonObject ?: throw Refused("invalid-wire") }
        catch (_: IllegalArgumentException) { throw Refused("invalid-wire") }
    }

    fun decode(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: Exception) { throw Refused("invalid-wire") }

    fun requireThat(value: Boolean, reason: String = "invalid-wire") { if (!value) throw Refused(reason) }
    fun canonical(value: JsonElement): String = when (value) {
        is JsonObject -> value.keys.sorted().joinToString(",", "{", "}") { JsonPrimitive(it).toString() + ":" + canonical(value.getValue(it)) }
        is JsonArray -> value.joinToString(",", "[", "]") { canonical(it) }
        else -> value.toString()
    }
    fun encode64(bytes: ByteArray): String = Base64.toBase64String(bytes).trimEnd('=').replace('+', '-').replace('/', '_')
    fun decode64(text: String): ByteArray {
        requireThat(Regex("[A-Za-z0-9_-]*").matches(text) && text.length % 4 != 1)
        val bytes = try { Base64.decode(text.replace('-', '+').replace('_', '/') + "=".repeat((4 - text.length % 4) % 4)) }
            catch (_: Exception) { throw Refused("invalid-wire") }
        requireThat(encode64(bytes) == text)
        return bytes
    }
    fun digest(bytes: ByteArray) = "sha256:" + encode64(MessageDigest.getInstance("SHA-256").digest(bytes))
    fun fields(vararg values: Pair<String, JsonElement>) = JsonObject(linkedMapOf(*values))
}

fun JsonObject.text(key: String, min: Int = 1, max: Int = 255): String {
    val value = this[key] as? JsonPrimitive
    Wire.requireThat(value?.isString == true)
    return value!!.content.also { Wire.requireThat(it.length in min..max) }
}
fun JsonObject.number(key: String, min: Long = 0, max: Long = Wire.MAX_SAFE): Long {
    val value = this[key] as? JsonPrimitive
    Wire.requireThat(value != null && !value.isString)
    val number = value!!.doubleOrNull ?: throw Refused("invalid-wire")
    Wire.requireThat(number.isFinite() && number == number.toLong().toDouble() && number >= min && number <= max)
    return number.toLong()
}
fun JsonObject.finite(key: String, min: Double, max: Double): Double {
    val value = this[key] as? JsonPrimitive ?: throw Refused("invalid-wire")
    Wire.requireThat(!value.isString)
    return (value.doubleOrNull ?: throw Refused("invalid-wire")).also { Wire.requireThat(it.isFinite() && it in min..max) }
}
fun JsonObject.obj(key: String) = this[key] as? JsonObject ?: throw Refused("invalid-wire")
fun JsonObject.only(vararg keys: String) { Wire.requireThat(this.keys.all { it in keys }) }
fun JsonObject.time(key: String): Long = try {
    val text = text(key, max = 1_048_576)
    val match = Regex("(\\d{4}-\\d{2}-\\d{2}T[0-2]\\d:[0-5]\\d)(?::([0-5]\\d)(?:\\.(\\d+))?)?(Z|[+-][0-2]\\d:[0-5]\\d)").matchEntire(text) ?: throw Refused("invalid-wire")
    val prefix = match.groupValues[1]
    Wire.requireThat(prefix.substring(11, 13).toInt() <= 23)
    val seconds = match.groupValues[2].ifEmpty { "00" }
    val fraction = match.groupValues[3].take(3).padEnd(3, '0')
    val local = java.time.LocalDateTime.parse("$prefix:$seconds.$fraction").toInstant(java.time.ZoneOffset.UTC).toEpochMilli()
    val zone = match.groupValues[4]
    if (zone == "Z") local else {
        val hours = zone.substring(1, 3).toInt()
        Wire.requireThat(hours <= 23)
        local - (hours * 60 + zone.substring(4, 6).toInt()) * 60_000L * if (zone[0] == '+') 1 else -1
    }
} catch (_: Exception) { throw Refused("invalid-wire") }

data class Fence(val fields: JsonObject) {
    init {
        for ((key, prefix) in listOf("runnerId" to "rnr_", "bootId" to "rbt_", "connectionId" to "rcn_", "connectionLeaseId" to "rls_")) {
            Wire.requireThat(Regex(prefix + Wire.uuid.pattern).matches(fields.text(key)))
        }
        fields.number("connectionGeneration", 1)
        if (fields.containsKey("auxiliaryStreamId")) {
            Wire.requireThat(Regex("rax_" + Wire.uuid.pattern).matches(fields.text("auxiliaryStreamId")))
            Wire.requireThat(fields.text("module") == "browser")
        }
    }
    companion object {
        val primaryKeys = setOf("runnerId", "bootId", "connectionId", "connectionLeaseId", "connectionGeneration")
        fun primary(frame: JsonObject) = Fence(JsonObject(frame.filterKeys { it in primaryKeys }))
        fun auxiliary(frame: JsonObject) = Fence(JsonObject(frame.filterKeys { it in primaryKeys || it in setOf("module", "auxiliaryStreamId") })).also {
            it.fields.text("auxiliaryStreamId"); it.fields.text("module")
        }
    }
}

class AuxiliaryLease(private val now: () -> Long) {
    var fence: Fence? = null; private set
    var deadline: Long = 0; private set
    private var heartbeatAt = 0L
    val expired get() = fence == null || deadline <= now()
    fun adopt(welcome: JsonObject): Fence {
        fence = Fence.auxiliary(welcome)
        deadline = welcome.time("streamLeaseExpiresAt")
        heartbeatAt = 0
        return fence!!
    }
    fun renew(frame: JsonObject) {
        Wire.requireThat(accepts(Fence.auxiliary(frame)) && !expired, "retired-stream")
        deadline = maxOf(deadline, frame.time("streamLeaseExpiresAt"))
    }
    fun accepts(other: Fence) = fence == other
    fun requireCurrent(other: Fence) { Wire.requireThat(accepts(other) && !expired, "retired-stream") }
    fun heartbeatTimestamp(): Long { heartbeatAt = maxOf(now(), heartbeatAt + 1); return heartbeatAt }
    fun release() { fence = null; deadline = 0 }
}
