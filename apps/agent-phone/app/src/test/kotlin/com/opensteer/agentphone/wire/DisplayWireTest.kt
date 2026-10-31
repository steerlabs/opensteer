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
            val actual = WireFixture.displayFrame(expected)
            assertEquals(expected, actual)
        }
    }
    @Test fun parsesSharedInputWithoutAControlId() {
        val frame = ((vectors.fields.getValue("hostFrames") as JsonArray).items.map { (it as JsonObject).fields.getValue("frame") as JsonObject }
            .first { it.fields["type"] == jsonOf("host.integrations.display.input") })
        val fields = LinkedHashMap(frame.fields)
        fields["type"] = jsonOf("host.integrations.display.input")
        fields["sessionId"] = jsonOf("cus_cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        fields["geometry"] = jsonOf(1)
        fields["sequence"] = jsonOf(0)
        fields["events"] = JsonArray(listOf(jsonObject("kind" to jsonOf("nav"), "to" to jsonOf("back"))))
        val input = IntegrationsWire.decode(JsonText.stringify(JsonObject(fields))) as DisplayMessage.Input
        assertEquals(0L, input.sequence)
    }
    @Test fun ownerAddressIsExclusiveAndNormalized() {
        val frame = ((vectors.fields.getValue("hostFrames") as JsonArray).items.map { (it as JsonObject).fields.getValue("frame") as JsonObject }
            .first { it.fields["type"] == jsonOf("host.integrations.display.input") })
        val fields = LinkedHashMap(frame.fields)
        val source = DisplaySource.Owner("cvw_77777777-7777-4777-8777-777777777777", 1)
        fields["events"] = JsonArray(listOf(jsonObject("kind" to jsonOf("nav"), "to" to jsonOf("back"))))
        fields["source"] = source.json()
        assertThrows(Exception::class.java) { IntegrationsWire.decode(JsonText.stringify(JsonObject(fields))) }
        fields.remove("sessionId")
        val input = IntegrationsWire.decode(JsonText.stringify(JsonObject(fields))) as DisplayMessage.Input
        assertEquals(source, input.source)
        assertTrue(input.sourceAddressed)
        fields.remove("source")
        assertThrows(Exception::class.java) { IntegrationsWire.decode(JsonText.stringify(JsonObject(fields))) }
    }

    @Test fun previousReleaseHostFramesRemainStrictlyReadable() {
        val input = ((vectors.fields.getValue("hostFrames") as JsonArray).items.map { (it as JsonObject).fields.getValue("frame") as JsonObject }
            .first { it.fields["type"] == jsonOf("host.integrations.display.input") })
        val fields = LinkedHashMap(input.fields)
        fields["events"] = JsonArray(listOf(jsonObject("kind" to jsonOf("nav"), "to" to jsonOf("back"))))
        val controlId = "dcl_22222222-2222-4222-8222-222222222222"
        fields["controlId"] = jsonOf(controlId)
        assertEquals(controlId, (IntegrationsWire.decode(JsonText.stringify(JsonObject(fields))) as DisplayMessage.Input).controlId)
        listOf("geometry", "sequence", "events").forEach { fields.remove(it) }
        fields["type"] = jsonOf("host.integrations.display.control")
        fields["action"] = jsonOf("acquire")
        val control = IntegrationsWire.decode(JsonText.stringify(JsonObject(fields))) as DisplayMessage.Control
        val refusal = DisplayWire.controlState(control.fence, control.sessionId, control.streamId, control.controlId, "refused", "released-by-owner")
        assertEquals(jsonOf("refused"), refusal.fields["state"])
        fields["unknown"] = jsonOf(true)
        assertThrows(WireException::class.java) { IntegrationsWire.decode(JsonText.stringify(JsonObject(fields))) }
    }

    @Test fun advertisesSharedInputIndependentlyOfEditing() {
        val descriptor = RunnerDescriptor("boot", "phone", "runner", "version", sharedInput = true).toJson()
        val modules = descriptor.fields.getValue("modules") as JsonObject
        val integrations = modules.fields.getValue("integrations") as JsonObject
        assertEquals(jsonOf(1), integrations.fields["sharedInput"])
        assertFalse(integrations.fields.containsKey("editing"))
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
