package com.opensteer.agentphone.wire

import com.opensteer.agentphone.TestFiles
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Every kind of frame a Host sends a phone, exactly as the Host's own schemas
 * produce it — the golden vectors' `hostFrames`, parameters parsed with their
 * defaults as the Host sends them — through the phone's strict decoders.
 * Failure modes:
 *
 * 1. a field the Host sends that the phone refuses as unknown, or one the
 *    phone requires that the Host never sends: every such frame would end the
 *    phone's connection as a protocol violation;
 * 2. a frame decoded as another kind, or its values misread;
 * 3. a frame the Host can send that the phone cannot decode at all, or phone
 *    operation parameters it cannot read.
 */
class HostFramesTest {
    private val frames = (TestFiles.vectors as JsonObject).fields.getValue("hostFrames") as JsonArray

    private val decoded: List<Any> = frames.items.map { item ->
        val entry = item as JsonObject
        val text = hostJson(entry.fields.getValue("frame"))
        when (val channel = (entry.fields.getValue("channel") as JsonString).value) {
            "primary" -> RunnerWire.decodeHostMessage(text)
            "auxiliary" -> RunnerWire.decodeAuxiliaryHandshake(text)
            "integrations" -> IntegrationsWire.decode(text)
            "display-data" -> DisplayWire.ack(text)
            else -> error("No decoder for the $channel channel")
        }
    }

    @Test
    fun decodesEveryFrameTheHostSendsAsWhatItIs() {
        assertEquals(
            listOf(
                HostMessage.Challenge::class, HostMessage.Welcome::class, HostMessage.LeaseRenewed::class,
                HostMessage.AuxiliaryTicket::class, HostMessage.Error::class,
                AuxiliaryHandshake.Challenge::class, AuxiliaryHandshake.Welcome::class, AuxiliaryHandshake.Rejected::class,
                StreamFrame.LeaseRenewed::class,
                IntegrationsMessage.ComputerUse::class, IntegrationsMessage.ComputerUse::class, IntegrationsMessage.ComputerUse::class,
                IntegrationsMessage.ComputerUse::class,
                IntegrationsMessage.Cancel::class, IntegrationsMessage.StopRecorded::class,
                IntegrationsMessage.McpOpen::class, IntegrationsMessage.McpMessage::class, IntegrationsMessage.McpClose::class,
                IntegrationsMessage.Invoke::class,
                DisplayMessage.Start::class, DisplayMessage.Stop::class, DisplayMessage.Refresh::class,
                DisplayMessage.Input::class, DisplayMessage.InputReset::class,
                DisplayMessage.Demand::class,
                DisplayMessage.Start::class, DisplayMessage.Demand::class,
                DisplayMessage.Input::class, DisplayMessage.InputReset::class, DisplayMessage.Power::class, DisplayMessage.Power::class,
                DisplayMessage.Input::class, DisplayMessage.InputReset::class, DisplayMessage.Power::class, DisplayMessage.Power::class,
                DisplayAck::class,
            ),
            decoded.map { it::class },
        )
    }

    @Test
    fun readsWhatTheHostMeant() {
        assertEquals("runner-enrollment-expired", decoded.filterIsInstance<HostMessage.Error>().single().error.reason)

        val calls = decoded.filterIsInstance<IntegrationsMessage.ComputerUse>()
        assertEquals(listOf("observe", "act", "close", "installed_apps"), calls.map { it.operation })
        assertEquals(true, AndroidPhoneWire.decodeObserveParams(calls[0].params))
        val act = AndroidPhoneWire.decodeActParams(calls[1].params)
        assertEquals(7, act.actions.size)
        assertEquals(false, act.includeScreenshot)
        AndroidPhoneWire.decodeEmptyParams(calls[2].params)
        assertEquals(InstalledAppsParams("maps", 50, 40), AndroidPhoneWire.decodeInstalledAppsParams(calls[3].params))

        val stop = decoded.filterIsInstance<IntegrationsMessage.StopRecorded>().single()
        assertEquals("run_55555555-5555-4555-8555-555555555555", stop.runId)
        assertEquals("cus_99999999-9999-4999-8999-999999999999", stop.sessionId)
    }
    // Host pointer coordinates are fractional; the phone's outbound JSON intentionally writes only safe integers.
    private fun hostJson(value: Json): String = when (value) {
        is JsonNumber -> if (value.value == kotlin.math.floor(value.value)) JsonText.stringify(value) else value.value.toString()
        is JsonArray -> value.items.joinToString(",", "[", "]", transform = ::hostJson)
        is JsonObject -> value.fields.entries.joinToString(",", "{", "}") { (key, item) -> JsonText.stringify(jsonOf(key)) + ":" + hostJson(item) }
        else -> JsonText.stringify(value)
    }

}
