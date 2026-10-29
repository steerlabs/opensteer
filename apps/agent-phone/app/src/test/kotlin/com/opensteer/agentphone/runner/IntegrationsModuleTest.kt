package com.opensteer.agentphone.runner

import com.opensteer.agentphone.TestFiles
import com.opensteer.agentphone.wire.ComputerUseErrorCode
import com.opensteer.agentphone.wire.ComputerUseOutcome
import com.opensteer.agentphone.wire.IntegrationsMessage
import com.opensteer.agentphone.wire.InstalledAppsParams
import com.opensteer.agentphone.wire.IntegrationsWire
import com.opensteer.agentphone.wire.JsonArray
import com.opensteer.agentphone.wire.JsonObject
import com.opensteer.agentphone.wire.JsonString
import com.opensteer.agentphone.wire.JsonText
import com.opensteer.agentphone.wire.PhoneStatus
import com.opensteer.agentphone.wire.jsonObject
import com.opensteer.agentphone.wire.jsonOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's `integrations` module: what reaches the phone's hands, and what
 * goes back. Failure modes:
 *
 * 1. a duplicate request id run twice, or answered twice;
 * 2. more than four requests running, or two captures at once;
 * 3. a cancelled act left running to the end, or answered as if it had not
 *    happened, or its slot freed before the work actually stopped;
 * 4. an answer over the 1 MiB frame budget sent anyway, or an oversized act
 *    reported as a plain failure an agent would repeat;
 * 5. status not sent on attach, resent unchanged, or a pause not reported at once;
 * 6. an MCP server or invoke silently ignored instead of refused;
 * 7. results from a previous stream delivered on the next one;
 * 8. a request's deadline measured from when the runtime got round to it
 *    rather than from when its frame arrived;
 * 9. parameters the phone cannot read disconnecting the stream instead of
 *    refusing that one request, or a refusal too long to send;
 * 10. the app list refused, or sent without the schema's defaults applied;
 * 11. an owner's Stop lost because no stream carried it: dropped while
 *    detached, forgotten because the Host said something else, or cleared by
 *    the Host's record of another Stop — or sent without its Run, which a Host
 *    that forgot the session needs to hold it;
 * 12. an owner's Stop lost to a restart before the Host recorded it: not in
 *    the journal before it is reported, removed by anything but its own
 *    acknowledgement, not reported again by the module built after the
 *    restart, its Run not refused meanwhile, or the order pressed lost and a
 *    repeated Stop kept twice;
 * 13. a Stop whose write the disk refused left only in memory: never written
 *    again once the disk recovers, on the next Stop, stream or status;
 * 14. a Run refused by another identity's module: one this identity never
 *    stopped, such as a Run its previous pairing stopped.
 */
class IntegrationsModuleTest {
    private val stream = RecordingStream()
    private val phone = FakePhone()
    private var paused = false
    private val outbox = StreamOutbox()
    private val journal = MemoryJournal()
    private val module = IntegrationsModule(outbox, phone, journal, paused = { paused }, log = {})

    private val auxFence =
        """"bootId":"rbt_22222222-2222-4222-8222-222222222222","connectionGeneration":1,"connectionId":"rcn_11111111-1111-4111-8111-111111111111","connectionLeaseId":"rls_11111111-1111-4111-8111-111111111111","runnerId":"rnr_33333333-3333-4333-8333-333333333333","auxiliaryStreamId":"rax_11111111-1111-4111-8111-111111111111","module":"integrations""""

    private fun frame(
        requestId: String,
        operation: String,
        session: String = "cus_44444444-4444-4444-8444-444444444444",
        params: String = when (operation) {
            "observe" -> """{"includeScreenshot":true}"""
            "act" -> """{"includeScreenshot":true,"observationId":"obs_1","actions":[{"type":"wake"}]}"""
            else -> "{}"
        },
    ): IntegrationsMessage {
        val access = if (operation == "observe" || operation == "act") "\"read-write\"" else "null"
        return IntegrationsWire.decode(
            """{$auxFence,"access":$access,"app":null,"definitionId":"android-phone","operation":"$operation","params":$params,"requestId":"$requestId","runId":"run_55555555-5555-4555-8555-555555555555","sessionId":"$session","threadTitle":"Groceries","timeoutMs":60000,"type":"host.integrations.computer-use"}""",
        ) as IntegrationsMessage
    }

    private fun IntegrationsModule.handle(message: IntegrationsMessage) = handle(message, receivedAt = 0)

    private fun results() = stream.sent.filter { it.type() == "runner.integrations.computer-use-result" }.map {
        (it.fields.getValue("requestId") as JsonString).value to (it.fields.getValue("result") as JsonObject)
    }

    private fun JsonObject.type() = (fields.getValue("type") as JsonString).value
    private fun JsonObject.string(key: String) = (fields.getValue(key) as JsonString).value

    @Test
    fun reportsStatusOnAttachAndAPauseAtOnceButNeverRepeatsItself() {
        module.attach(stream)
        assertEquals(listOf("runner.integrations.status"), stream.types())
        module.refreshStatus()
        assertEquals(1, stream.sent.size)
        paused = true
        module.refreshStatus()
        assertEquals(2, stream.sent.size)
        val operations = (((stream.sent[1].fields.getValue("apps") as JsonArray).items[0] as JsonObject)
            .fields.getValue("operations") as JsonArray).items.map { it as JsonObject }
        assertTrue(operations.all { it.string("state") == "unavailable" && it.string("detail") == "Paused on the phone" })
    }

    @Test
    fun reportsExactlyTheOperationsTheCatalogDeclares() {
        val contracts = (TestFiles.vectors as JsonObject).fields.getValue("contracts") as JsonObject
        assertEquals(contracts.fields.keys, PhoneStatus.operations(paused = false).map { it.operation }.toSet())
    }

    @Test
    fun ignoresADuplicateRequestWhileTheFirstRuns() {
        module.attach(stream)
        module.handle(frame("cu:1", "observe"))
        module.handle(frame("cu:1", "observe"))
        assertEquals(1, phone.running.size)
        phone.finish("cu:1", ComputerUseOutcome.Ok(jsonObject()))
        assertEquals(listOf("cu:1"), results().map { it.first })
    }

    @Test
    fun capsRunningWorkAtFour() {
        module.attach(stream)
        for (index in 1..4) module.handle(frame("cu:$index", if (index % 2 == 0) "act" else "observe"))
        module.handle(frame("cu:5", "observe"))
        assertEquals("failed", results().single { it.first == "cu:5" }.second.string("code"))
        module.handle(frame("cu:close", "close"))
        assertEquals(5, phone.running.size)
    }

    @Test
    fun answersACancelledActAsPossiblyDoneAndHoldsItsSlotUntilItStops() {
        module.attach(stream)
        module.handle(frame("cu:act", "act"))
        module.handle(IntegrationsWire.decode("""{$auxFence,"requestId":"cu:act","type":"host.integrations.cancel"}""") as IntegrationsMessage)
        assertTrue(phone.running.single().cancelled)
        assertEquals("outcome-unknown", results().single().second.string("code"))
        for (index in 1..3) module.handle(frame("cu:$index", "observe"))
        module.handle(frame("cu:4", "observe"))
        assertEquals("failed", results().single { it.first == "cu:4" }.second.string("code"))
        phone.finish("cu:act", ComputerUseOutcome.Ok(jsonObject()))
        assertEquals(1, results().count { it.first == "cu:act" })
        module.handle(frame("cu:5", "observe"))
        assertEquals(listOf("cu:1", "cu:2", "cu:3", "cu:5"), phone.running.map { it.call.requestId })
    }

    @Test
    fun replacesAnAnswerTooLargeForTheStream() {
        module.attach(stream)
        module.handle(frame("cu:act", "act"))
        module.handle(frame("cu:observe", "observe"))
        val huge = jsonObject("blob" to jsonOf("x".repeat(1_100_000)))
        phone.finish("cu:act", ComputerUseOutcome.Ok(huge))
        phone.finish("cu:observe", ComputerUseOutcome.Ok(huge))
        val answers = results().toMap()
        assertEquals("outcome-unknown", answers.getValue("cu:act").string("code"))
        assertEquals("failed", answers.getValue("cu:observe").string("code"))
        assertTrue(stream.sent.all { JsonText.stringify(it).toByteArray().size <= 1_048_576 })
    }

    @Test
    fun refusesWhatThisPhoneDoesNotRun() {
        module.attach(stream)
        module.handle(
            IntegrationsWire.decode(
                """{$auxFence,"access":"read","arguments":{},"contract":"${"A".repeat(43)}","definitionId":"reminders","operation":"list","requestId":"inv:1","timeoutMs":1000,"type":"host.integrations.invoke"}""",
            ) as IntegrationsMessage,
        )
        module.handle(
            IntegrationsWire.decode(
                """{$auxFence,"launch":{"kind":"x"},"serverId":"srv","sessionId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","type":"host.integrations.mcp.open"}""",
            ) as IntegrationsMessage,
        )
        module.handle(
            IntegrationsWire.decode(
                """{$auxFence,"access":null,"app":null,"operation":"installed_apps","params":{},"requestId":"cu:mac","runId":"run_55555555-5555-4555-8555-555555555555","sessionId":"cus_44444444-4444-4444-8444-444444444444","threadTitle":null,"timeoutMs":1000,"type":"host.integrations.computer-use"}""",
            ) as IntegrationsMessage,
        )
        val invoke = stream.sent.single { it.type() == "runner.integrations.result" }
        assertEquals("unsupported", (invoke.fields.getValue("result") as JsonObject).string("code"))
        val mcp = stream.sent.single { it.type() == "runner.integrations.mcp.closed" }
        assertEquals("unapproved", (mcp.fields.getValue("error") as JsonObject).string("code"))
        assertEquals("unsupported", results().single { it.first == "cu:mac" }.second.string("code"))
        assertTrue(phone.running.isEmpty())
    }

    @Test
    fun dropsAnswersMeantForAStreamThatEnded() {
        module.attach(stream)
        module.handle(frame("cu:1", "observe"))
        module.detach()
        assertEquals(1, phone.released)
        assertTrue(phone.running.single().cancelled)
        val next = RecordingStream()
        module.attach(next)
        phone.finish("cu:1", ComputerUseOutcome.Ok(jsonObject()))
        assertEquals(listOf("runner.integrations.status"), next.types())
    }

    @Test
    fun announcesASessionThePersonStopped() {
        module.attach(stream)
        module.sessionStopped("cus_44444444-4444-4444-8444-444444444444", "run_55555555-5555-4555-8555-555555555555")
        val event = stream.sent.last()
        assertEquals("runner.integrations.computer-use-event", event.type())
        val body = event.fields.getValue("event") as JsonObject
        assertEquals("session.stopped", body.string("event"))
        assertEquals("user", (body.fields.getValue("params") as JsonObject).string("reason"))
        assertEquals(ComputerUseErrorCode.BUSY.wire, "busy")
    }

    private fun stopRecorded(runId: String, sessionId: String) = IntegrationsWire.decode(
        """{$auxFence,"runId":"$runId","sessionId":"$sessionId","type":"host.integrations.computer-use-stop-recorded"}""",
    ) as IntegrationsMessage

    @Test
    fun reportsAStopUntilTheHostRecordsThatExactStop() {
        val session = "cus_44444444-4444-4444-8444-444444444444"
        val run = "run_55555555-5555-4555-8555-555555555555"
        fun stops(on: RecordingStream): Int {
            val events = on.sent.filter { it.type() == "runner.integrations.computer-use-event" }
            // Every sending names the Run, re-sends included.
            for (event in events) {
                val params = (event.fields.getValue("event") as JsonObject).fields.getValue("params") as JsonObject
                assertEquals(run, params.string("runId"))
                assertEquals(session, params.string("sessionId"))
            }
            return events.size
        }
        fun reattach(): RecordingStream {
            module.detach()
            return RecordingStream().also(module::attach)
        }
        module.sessionStopped(session, run)
        val first = RecordingStream()
        module.attach(first)
        assertEquals(1, stops(first))
        // Something else from the Host proves nothing about what the phone sent.
        module.handle(
            frame("cu:unrelated", "installed_apps"),
        )
        assertEquals(1, stops(reattach()))
        // Nor does the Host's record of another Stop.
        module.handle(stopRecorded(run, "cus_99999999-9999-4999-8999-999999999999"))
        module.handle(stopRecorded("run_99999999-9999-4999-8999-999999999999", session))
        assertEquals(1, stops(reattach()))
        // A stream that cannot send keeps it for the next.
        module.detach()
        val dead = RecordingStream().also { it.open = false }
        module.attach(dead)
        assertEquals(0, stops(dead))
        assertEquals(1, stops(reattach()))
        // The Host recorded exactly this Stop: it is not told again.
        module.handle(stopRecorded(run, session))
        assertEquals(0, stops(reattach()))
    }

    @Test
    fun keepsEachStopOnDiskUntilTheHostRecordsThatStop() {
        val session = "cus_44444444-4444-4444-8444-444444444444"
        val run = "run_55555555-5555-4555-8555-555555555555"
        val other = PendingStop("cus_66666666-6666-4666-8666-666666666666", "run_77777777-7777-4777-8777-777777777777")
        // Kept before any stream could carry it.
        module.sessionStopped(session, run)
        module.sessionStopped(other.sessionId, other.runId)
        module.sessionStopped(session, run)
        assertEquals(listOf(PendingStop(session, run), other), journal.kept)
        module.attach(stream)
        module.handle(stopRecorded(run, other.sessionId))
        module.handle(stopRecorded(other.runId, session))
        assertEquals(listOf(PendingStop(session, run), other), journal.kept)
        module.handle(stopRecorded(run, session))
        assertEquals(listOf(other), journal.kept)
        module.handle(stopRecorded(other.runId, other.sessionId))
        assertEquals(emptyList<PendingStop>(), journal.kept)
    }

    @Test
    fun aModuleBuiltAfterARestartReportsTheStopsItsJournalKept() {
        val kept = listOf(
            PendingStop("cus_44444444-4444-4444-8444-444444444444", "run_55555555-5555-4555-8555-555555555555"),
            PendingStop("cus_66666666-6666-4666-8666-666666666666", "run_77777777-7777-4777-8777-777777777777"),
        )
        val restarted = IntegrationsModule(StreamOutbox(), phone, MemoryJournal(kept), paused = { paused }, log = {})
        // These Runs are refused again before any frame can reach the phone.
        assertTrue(restarted.refuses("run_55555555-5555-4555-8555-555555555555"))
        assertTrue(restarted.refuses("run_77777777-7777-4777-8777-777777777777"))
        val after = RecordingStream()
        restarted.attach(after)
        val reported = after.sent.filter { it.type() == "runner.integrations.computer-use-event" }.map {
            val params = (it.fields.getValue("event") as JsonObject).fields.getValue("params") as JsonObject
            PendingStop(params.string("sessionId"), params.string("runId"))
        }
        assertEquals(kept, reported)
    }

    @Test
    fun refusesTheRunsItsOwnIdentityStoppedAndNoOthers() {
        val session = "cus_44444444-4444-4444-8444-444444444444"
        val run = "run_55555555-5555-4555-8555-555555555555"
        assertEquals(false, module.refuses(run))
        module.sessionStopped(session, run)
        assertTrue(module.refuses(run))
        module.attach(stream)
        // Recorded by the Host, which refuses it from then on; the phone still does too.
        module.handle(stopRecorded(run, session))
        assertTrue(module.refuses(run))
        // A new pairing's module refuses none of the previous pairing's Runs.
        val repaired = IntegrationsModule(StreamOutbox(), phone, MemoryJournal(), paused = { paused }, log = {})
        assertEquals(false, repaired.refuses(run))
    }

    @Test
    fun keepsWritingAStopTheDiskRefusedUntilItIsKept() {
        val stop = PendingStop("cus_44444444-4444-4444-8444-444444444444", "run_55555555-5555-4555-8555-555555555555")
        val failing = MemoryJournal(failures = 3)
        val logged = mutableListOf<String>()
        val flaky = IntegrationsModule(outbox, phone, failing, paused = { paused }, log = { logged += it })
        flaky.sessionStopped(stop.sessionId, stop.runId)
        assertEquals(1, failing.writes)
        assertEquals(emptyList<PendingStop>(), failing.kept)
        assertTrue(logged.any { "could not be written" in it })
        // The same Stop pressed again, a new stream, and the next status each try again.
        flaky.sessionStopped(stop.sessionId, stop.runId)
        flaky.attach(stream)
        assertEquals(3, failing.writes)
        flaky.refreshStatus()
        assertEquals(4, failing.writes)
        assertEquals(listOf(stop), failing.kept)
        // Kept: nothing is written again until something changes.
        flaky.refreshStatus()
        flaky.attach(RecordingStream())
        assertEquals(4, failing.writes)
        // It was enforced and reported all along, whatever the disk did.
        assertTrue(flaky.refuses(stop.runId))
    }

    @Test
    fun measuresEachRequestsDeadlineFromWhenItsFrameArrived() {
        module.attach(stream)
        module.handle(frame("cu:1", "observe"), receivedAt = 5_000)
        val call = phone.running.single().call
        assertEquals(5_000L + 60_000, call.deadline)
        assertEquals("run_55555555-5555-4555-8555-555555555555", call.runId)
    }

    @Test
    fun refusesParametersItCannotReadForThatRequestAloneInASentenceItCanSend() {
        module.attach(stream)
        module.handle(frame("cu:bad", "act", params = """{"includeScreenshot":true,"observationId":"obs_1","actions":[]}"""))
        val unknown = (1..2_000).joinToString(",") { """"field$it":1""" }
        module.handle(frame("cu:noisy", "observe", params = """{"includeScreenshot":true,$unknown}"""))
        val answers = results().toMap()
        assertEquals("failed", answers.getValue("cu:bad").string("code"))
        assertEquals("failed", answers.getValue("cu:noisy").string("code"))
        assertTrue(answers.getValue("cu:noisy").string("message").length <= 1_000)
        // The stream still serves the next request.
        module.handle(frame("cu:next", "observe"))
        assertEquals(listOf("cu:next"), phone.running.map { it.call.requestId })
    }

    @Test
    fun listsAppsWithTheSchemasDefaults() {
        module.attach(stream)
        module.handle(frame("cu:apps", "installed_apps"))
        module.handle(frame("cu:mail", "installed_apps", params = """{"query":"mail","limit":10,"offset":20}"""))
        assertEquals(
            listOf(PhoneRequest.InstalledApps(InstalledAppsParams("", 50, 0)), PhoneRequest.InstalledApps(InstalledAppsParams("mail", 10, 20))),
            phone.running.map { it.call.request },
        )
    }
}
