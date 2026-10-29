package com.opensteer.agentphone.wire

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Timestamps as the protocol writes them: `Date.prototype.toISOString` out,
 * and Zod's `z.iso.datetime({ offset: true })` in.
 */
object IsoTime {
    private const val DATE =
        """(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))"""
    private val pattern = Regex(
        """^${DATE}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$""",
    )
    private val output = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    fun isValid(text: String): Boolean = pattern.matches(text)

    /** Epoch milliseconds; JavaScript's `Date` holds no finer time. */
    fun parse(text: String): Long {
        if (!isValid(text)) throw WireException("Not an ISO date-time: $text")
        val normalized = text.replace(Regex("""\.(\d{9})\d+"""), ".$1")
        return OffsetDateTime.parse(normalized).toInstant().toEpochMilli()
    }

    fun format(epochMillis: Long): String = output.format(Instant.ofEpochMilli(epochMillis))
}
