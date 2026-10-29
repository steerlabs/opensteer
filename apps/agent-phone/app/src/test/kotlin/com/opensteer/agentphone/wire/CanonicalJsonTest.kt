package com.opensteer.agentphone.wire

import com.opensteer.agentphone.TestFiles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Canonical JSON is what every proof signs, so one byte of disagreement with
 * the Host's `canonicalJson` is a refused connection. Ways it could differ:
 *
 * 1. keys sorted by code point (or locale) instead of UTF-16 code unit;
 * 2. escaping that is not `JSON.stringify`'s: `/` or U+2028 escaped, a control
 *    character spelled `\u001F` or not escaped, a lone surrogate written raw;
 * 3. a number the phone emits that JavaScript would read differently: `-0`
 *    written as `-0`, the safe-integer boundary written wrongly, or a fraction
 *    or an unsafe integer rounded or truncated instead of refused — every
 *    number in a canonical payload is a safe integer;
 * 4. JSON text parsed lossily: a lone surrogate escape dropped or replaced,
 *    or a number the wire allows — a fraction in an opaque payload — refused.
 */
class CanonicalJsonTest {
    @Test
    fun reproducesEveryGoldenCase() {
        val cases = (TestFiles.vectors as JsonObject).fields.getValue("canonicalJson") as JsonArray
        check(cases.items.isNotEmpty())
        for (case in cases.items) {
            val fields = (case as JsonObject).fields
            val input = (fields.getValue("inputJson") as JsonString).value
            val output = (fields.getValue("output") as JsonString).value
            assertEquals("canonical form of $input", output, CanonicalJson.encode(JsonText.parse(input)))
        }
    }

    @Test
    fun sortsKeysByUtf16CodeUnitNotCodePoint() {
        // U+FF5A sorts after U+1F600 by code point, but before it by code unit (0xD83D < 0xFF5A).
        val value = jsonObject("ｚ" to jsonOf(1), "😀" to jsonOf(2), "a" to jsonOf(3), "Z" to jsonOf(4))
        assertEquals("""{"Z":4,"a":3,"😀":2,"ｚ":1}""", CanonicalJson.encode(value))
    }

    @Test
    fun escapesExactlyAsJsonStringify() {
        val text = "/\u2028\u007f\u0008\u000c\u001f\"\\"
        assertEquals("\"/\u2028\u007f\\b\\f\\u001f\\\"\\\\\"", CanonicalJson.encode(JsonString(text)))
        assertEquals("\"\\udc00x\"", CanonicalJson.encode(JsonString("\udc00x")))
    }

    @Test
    fun writesSafeIntegersAsJavaScriptDoesAndRefusesEveryOtherNumber() {
        assertEquals("0", JsonText.stringify(JsonNumber(-0.0)))
        assertEquals("9007199254740991", JsonText.stringify(jsonOf(MAX_SAFE_INTEGER)))
        assertEquals("-9007199254740991", JsonText.stringify(jsonOf(-MAX_SAFE_INTEGER)))
        assertEquals("[1000,-12]", CanonicalJson.encode(JsonText.parse("[1e3,-12.0]")))
        for (number in listOf(0.5, -12.5, 1e21, 9_007_199_254_740_992.0, -9_007_199_254_740_992.0, Double.NaN, Double.POSITIVE_INFINITY)) {
            assertThrows("format of $number", IllegalArgumentException::class.java) { JsonText.stringify(JsonNumber(number)) }
            assertThrows("canonical form of $number", IllegalArgumentException::class.java) { CanonicalJson.encode(jsonArray(JsonNumber(number))) }
        }
        assertThrows(IllegalArgumentException::class.java) { jsonOf(MAX_SAFE_INTEGER + 1) }
    }

    @Test
    fun parsesEveryNumberTheWireAllowsAndLoneSurrogatesLosslessly() {
        val parsed = JsonText.parse("""[-0,0.1,1e21,-1.5e-7,"\ud800"]""") as JsonArray
        assertEquals(true, 1.0 / (parsed.items[0] as JsonNumber).value < 0)
        assertEquals(listOf(0.1, 1e21, -1.5e-7), parsed.items.subList(1, 4).map { (it as JsonNumber).value })
        assertEquals("\ud800", (parsed.items[4] as JsonString).value)
    }

    @Test
    fun unsignedFramesPreserveFractionalGeometryWithoutWideningCanonicalPayloads() {
        val caret = jsonObject("x" to JsonNumber(0.022222222222222223),
            "y" to JsonNumber(0.75), "height" to JsonNumber(1.5e-7))
        val frame = jsonObject("caret" to caret, "samples" to jsonArray(JsonNumber(-12.5), JsonNumber(0.1)))
        assertEquals(frame, JsonText.parse(JsonText.stringifyFrame(frame)))
        assertThrows(IllegalArgumentException::class.java) { JsonText.stringify(frame) }
        assertThrows(IllegalArgumentException::class.java) { CanonicalJson.encode(frame) }
        assertEquals("[0,9007199254740991,-12]", JsonText.stringifyFrame(
            jsonArray(JsonNumber(-0.0), jsonOf(MAX_SAFE_INTEGER), jsonOf(-12))))
    }

    @Test
    fun unsignedFramesStillRefuseNonFiniteValuesAndUnsafeIntegers() {
        for (number in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY,
            1e21, 9_007_199_254_740_992.0, -9_007_199_254_740_992.0)) {
            assertThrows("frame number $number", IllegalArgumentException::class.java) {
                JsonText.stringifyFrame(jsonObject("value" to JsonNumber(number)))
            }
        }
    }

    @Test
    fun refusesTextJsonParseRefuses() {
        for (text in listOf("", "{", "[1,]", "{\"a\":1,}", "01", "1.", ".5", "\"\u0001\"", "nul", "[1] x", "'a'")) {
            assertThrows("parse of '$text'", WireException::class.java) { JsonText.parse(text) }
        }
    }
}
