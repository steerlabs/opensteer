package com.opensteer.agentphone.wire

import com.opensteer.agentphone.TestFiles
import java.util.Base64
import org.junit.Assert.*
import org.junit.Test

/** Failure list: unknown fields, invalid bounds/variants, fractional/unsafe sequence, binary ordering or length drift. */
class DisplayWireTest {
    private val vectors = TestFiles.vectors as JsonObject
    @Test fun goldenMediaBytesAndPhoneFrames() {
        for (entry in (vectors.fields.getValue("displayMediaFrames") as JsonArray).items) {
            val v = entry as JsonObject
            val header = v.fields.getValue("header") as JsonObject
            val payload = Base64.getDecoder().decode((v.fields.getValue("payloadBase64") as JsonString).value)
            assertArrayEquals(Base64.getDecoder().decode((v.fields.getValue("envelopeBase64") as JsonString).value),
                DisplayWire.media(DisplayMediaHeader.read(header), payload))
        }
        for (entry in (vectors.fields.getValue("phoneFrames") as JsonArray).items) {
            val expected = (entry as JsonObject).fields.getValue("frame") as JsonObject
            val fields = Fields.of(expected, "phone")
            val type = fields.string("type")
            val fence = RunnerWire.auxiliaryFence(fields)
            val stream = fields.string("streamId")
            val actual = when {
                type.endsWith("control-state") -> DisplayWire.controlState(fence, fields.string("sessionId"), stream, fields.string("controlId"), fields.string("state"), fields.optionalString("reason"))
                type.endsWith("source-ended") -> {
                    fields.literal("display", "main")
                    val source = fields.obj("source")
                    source.literal("kind", "owner-view")
                    DisplayWire.sourceEnded(fence, stream, DisplaySource.Owner(source.string("viewId"), source.int("generation")), fields.string("reason"))
                }
                else -> {
                    fields.literal("display", "main")
                    DisplayWire.state(fence, stream, fields.string("state"), fields.optionalString("reason"),
                        fields.int("generation"), fields.int("width").toInt(), fields.int("height").toInt(), fields.int("rotation").toInt())
                }
            }
            fields.end()
            assertEquals(expected, actual)
        }
    }
    @Test fun editingVariantsBeforeRuntime() {
        listOf(
            """{"kind":"key","action":"down","code":"KeyE","key":"é","modifiers":[],"text":"é"}""",
            """{"kind":"command","command":"selectAll"}""",
            """{"kind":"edit","edit":{"contextId":"11111111-1111-4111-8111-111111111111","text":"é","before":"e","after":""}}""",
            """{"kind":"cut","contextId":"11111111-1111-4111-8111-111111111111"}""",
            """{"kind":"copy"}""", """{"kind":"paste","text":"🧑‍💻"}""",
        ).forEach { DisplayWire.event(JsonText.parse(it)) }
        listOf(
            """{"kind":"cut"}""", """{"kind":"cut","contextId":"bad"}""",
            """{"kind":"command","command":"invented"}""",
            """{"kind":"edit","edit":{"contextId":"bad","text":"e","before":"","after":""}}""",
            """{"kind":"paste","text":"","files":[]}""",
        ).forEach { assertThrows(WireException::class.java) { DisplayWire.event(JsonText.parse(it)) } }
    }
    @Test fun strictAck() {
        assertEquals(3L, DisplayWire.ack("""{"type":"display.ack","sequence":3}""").sequence)
        for (bad in listOf("""{"type":"ack","sequence":1}""", """{"type":"display.ack","sequence":-1}""",
            """{"type":"display.ack","sequence":1.1}""", """{"type":"display.ack","sequence":9007199254740992}""",
            """{"type":"display.ack","sequence":1,"extra":true}""")) {
            assertThrows(WireException::class.java) { DisplayWire.ack(bad) }
        }
    }
    @Test fun strictInputVariantsAndLimits() {
        val valid = listOf("""{"kind":"pointer","phase":"move","x":0,"y":1,"t":32.5}""",
            """{"kind":"text","deleteBackward":100}""", """{"kind":"text","submit":true}""")
        valid.forEach { DisplayWire.event(JsonText.parse(it)) }
        val bad = listOf("""{"kind":"pointer","phase":"move","x":1.1,"y":0,"t":0}""",
            """{"kind":"pointer","phase":"down","x":0,"y":0}""", """{"kind":"text","insert":""}""",
            """{"kind":"text","insert":"a","submit":true}""", """{"kind":"text","deleteBackward":101}""",
            """{"kind":"scroll","x":0,"y":0,"dx":2,"dy":0}""", """{"kind":"nav","to":"quick_settings"}""")
        bad.forEach { assertThrows(WireException::class.java) { DisplayWire.event(JsonText.parse(it)) } }
    }
}
