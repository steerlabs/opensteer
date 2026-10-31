package com.opensteer.agentphone.wire

import com.opensteer.agentphone.TestFiles
import com.opensteer.agentphone.control.LaunchableApps
import com.opensteer.agentphone.control.LauncherEntry
import com.opensteer.agentphone.control.PhoneDesk
import com.opensteer.agentphone.control.PhoneExecutor
import com.opensteer.agentphone.runner.ConnectionPolicy
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The phone's side of the wire, as the phone's own encoders write it.
 *
 * `wire-fixture.json` is every kind of frame the phone sends, produced here by
 * the production encoders from the golden vectors' keys and inputs.
 * `packages/runner-auth/src/agent-phone-wire.test.ts` parses each entry with the
 * Zod schemas the Host reads with and verifies each signature with
 * `@opensteer/runner-auth`, so a change on either end fails exactly one of the
 * two tests. An ordinary run compares; `OPENSTEER_WRITE_WIRE_FIXTURE=1`
 * rewrites the file after an intended change.
 */
class WireFixtureTest {
    @Test
    fun matchesTheCheckedInFixture() {
        val file = TestFiles.appDirectory.resolve("src/test/resources/wire-fixture.json")
        val actual = pretty(WireFixture.build(TestFiles.vectors as JsonObject)) + "\n"
        if (System.getenv("OPENSTEER_WRITE_WIRE_FIXTURE") == "1") file.writeText(actual)
        assertEquals(
            "wire-fixture.json drifted from the encoders; rerun with OPENSTEER_WRITE_WIRE_FIXTURE=1 after an intended change",
            file.readText(),
            actual,
        )
    }

    /** `JSON.stringify(value, null, 2)`, so the checked-in file reads the way the Host's tools write JSON. */
    private fun pretty(value: Json, indent: String = ""): String {
        val inner = "$indent  "
        return when {
            value is JsonArray && value.items.isNotEmpty() ->
                value.items.joinToString(",\n", "[\n", "\n$indent]") { inner + pretty(it, inner) }
            value is JsonObject && value.fields.isNotEmpty() ->
                value.fields.entries.joinToString(",\n", "{\n", "\n$indent}") { (key, item) ->
                    inner + JsonText.stringify(JsonString(key)) + ": " + pretty(item, inner)
                }
            else -> JsonText.stringifyFrame(value)
        }
    }
}

/** Every frame kind the phone sends, each built by the code that sends it. */
object WireFixture {
    private val fence = RunnerFence(
        bootId = "rbt_22222222-2222-4222-8222-222222222222",
        connectionGeneration = 7,
        connectionId = "rcn_99999999-9999-4999-8999-999999999999",
        connectionLeaseId = "rls_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        runnerId = "rnr_33333333-3333-4333-8333-333333333333",
    )
    private val auxiliaryFence = AuxiliaryFence(fence, "rax_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    private const val sessionId = "cus_cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    private const val capturedAt = "2026-10-11T12:00:20.000Z"
    // A tiny base64 body: the schemas bound and shape it; nothing decodes it.
    private val screenshot = Screenshot(base64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2w==", width = 648, height = 1440)

    fun build(vectors: JsonObject): JsonObject {
        val runner = vectors.obj("runner")
        val auxiliary = vectors.obj("auxiliary")
        val runnerKey = Ed25519Key.fromSeed(hex(runner.obj("key").string("seed")))
        val challenge = runner.obj("challenge").let {
            RunnerChallenge(it.string("challengeId"), it.string("expiresAt"), it.string("hostSessionId"), it.string("nonce"))
        }
        val descriptor = runner.obj("descriptor").let {
            RunnerDescriptor(it.string("bootId"), it.string("name"), it.string("runnerId"), it.string("runtimeVersion"))
        }
        val auxiliaryChallenge = auxiliary.obj("challenge").let {
            AuxiliaryChallenge(it.string("challengeId"), it.string("expiresAt"), it.string("hostSessionId"), it.string("module"), it.string("nonce"))
        }
        val token = runner.obj("enrollment").string("enrollmentToken")

        val visible = Observation.visible(
            capturedAt = capturedAt,
            observationId = "obs_0001",
            display = DisplayState(width = 1080, height = 2400, rotation = 0, interactive = true, locked = false, secureLock = false),
            geometry = PixelSize(648, 1440),
            foreground = Foreground("com.opensteer.agentphone.fixture", "Agent Phone fixture"),
            tree = Tree(
                text = "[0] textview \"Receipts\" (24,96 600×60)\n[1] edittext \"Type here\" (24,180 600×80) editable focused",
                elementCount = 2,
                truncated = false,
            ),
            screenshot = ScreenshotOutcome.Taken(screenshot),
        )
        val withoutPicture = visible.copyForFixture(observationId = "obs_0002", screenshot = ScreenshotOutcome.NotRequested)
        val screenOff = Observation.screenOff(
            capturedAt = capturedAt,
            observationId = "obs_0004",
            display = DisplayState(1080, 2400, 90, interactive = false, locked = true, secureLock = true),
            geometry = PixelSize(1440, 648),
        )
        val opensteerApp = Observation.opensteerApp(
            capturedAt = capturedAt,
            observationId = "obs_0005",
            display = DisplayState(1080, 2400, 0, interactive = true, locked = false, secureLock = false),
            geometry = PixelSize(648, 1440),
            foreground = Foreground(AndroidPhoneWire.AGENT_PHONE_PACKAGE, "Opensteer Agent Phone"),
        )

        fun result(requestId: String, outcome: ComputerUseOutcome) =
            IntegrationsWire.computerUseResult(auxiliaryFence, requestId, outcome)

        return jsonObject(
            "version" to jsonOf(1),
            "context" to jsonObject(
                "auxiliaryChallenge" to auxiliary.fields.getValue("challenge"),
                "challenge" to runner.fields.getValue("challenge"),
                "runnerPublicKeyPem" to jsonOf(runnerKey.publicKeyPem),
                "verifyAt" to jsonOf("2026-10-11T12:00:05.000Z"),
            ),
            "primary" to jsonObject(
                "authenticate" to RunnerWire.authenticate(challenge, descriptor, runnerKey),
                "enroll" to RunnerWire.enroll(challenge, descriptor, runnerKey, token),
                "heartbeat" to RunnerWire.heartbeat(fence, "2026-10-11T12:00:15.001Z"),
                "modulesReport" to RunnerWire.modulesReport(fence, "2026-10-11T12:00:16.000Z"),
                "ticketRequest" to RunnerWire.ticketRequest(fence, "aux:dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
            ),
            "auxiliary" to jsonObject(
                "authenticate" to RunnerWire.auxiliaryAuthenticate(
                    auxiliaryChallenge,
                    runnerKey,
                    runnerId = descriptor.runnerId,
                    bootId = descriptor.bootId,
                    ticket = auxiliary.string("ticket"),
                ),
                "heartbeat" to RunnerWire.auxiliaryHeartbeat(auxiliaryFence, "2026-10-11T12:00:17.000Z"),
            ),
            "integrations" to jsonObject(
                "status" to IntegrationsWire.status(auxiliaryFence, PhoneStatus.operations(paused = false), true),
                "statusPaused" to IntegrationsWire.status(auxiliaryFence, PhoneStatus.operations(paused = true), true),
                "observe" to result("cu:observe", ComputerUseOutcome.Ok(AndroidPhoneWire.observationResult(visible))),
                "observeWithoutScreenshot" to result("cu:observe-2", ComputerUseOutcome.Ok(AndroidPhoneWire.observationResult(withoutPicture))),
                "observeScreenOff" to result("cu:observe-4", ComputerUseOutcome.Ok(AndroidPhoneWire.observationResult(screenOff))),
                "observeOpensteerApp" to result("cu:observe-5", ComputerUseOutcome.Ok(AndroidPhoneWire.observationResult(opensteerApp))),
                "act" to result(
                    "cu:act",
                    ComputerUseOutcome.Ok(AndroidPhoneWire.actResult(null, visible, listOf("Turned the screen on", "Tapped \"Send\""))),
                ),
                "actStopped" to result(
                    "cu:act-2",
                    ComputerUseOutcome.Ok(
                        AndroidPhoneWire.actResult(
                            ActError(ComputerUseErrorCode.STOPPED_BY_USER, PhoneDesk.STOPPED),
                            null,
                            listOf("Typed 8 characters into \"Password\""),
                        ),
                    ),
                ),
                "actStale" to result(
                    "cu:act-3",
                    ComputerUseOutcome.Failure(ComputerUseErrorCode.STALE_OBSERVATION, "Observation obs_0001 is not the latest; observe again."),
                ),
                "actOutOfTime" to result(
                    "cu:act-5",
                    ComputerUseOutcome.Ok(
                        AndroidPhoneWire.actResult(
                            ActError(ComputerUseErrorCode.FAILED, PhoneDesk.OUT_OF_TIME),
                            null,
                            listOf("Tapped \"Send\""),
                        ),
                    ),
                ),
                "actExpired" to result("cu:act-6", ComputerUseOutcome.Failure(ComputerUseErrorCode.FAILED, PhoneExecutor.EXPIRED)),
                "installedApps" to result(
                    "cu:apps",
                    ComputerUseOutcome.Ok(
                        AndroidPhoneWire.installedAppsResult(
                            LaunchableApps.page(
                                listOf(
                                    LauncherEntry("com.android.settings", "Settings"),
                                    LauncherEntry("com.opensteer.agentphone.fixture", "Agent Phone fixture"),
                                    LauncherEntry(AndroidPhoneWire.AGENT_PHONE_PACKAGE, "Opensteer Agent Phone"),
                                ),
                                InstalledAppsParams(query = "", limit = 50, offset = 0),
                            ),
                        ),
                    ),
                ),
                "actOpensteerApp" to result(
                    "cu:act-4",
                    ComputerUseOutcome.Failure(ComputerUseErrorCode.APP_NOT_ALLOWED, PhoneDesk.OWN_APP),
                ),
                "close" to result("cu:close", ComputerUseOutcome.Ok(jsonObject())),
                "busy" to result("cu:busy", ComputerUseOutcome.Failure(ComputerUseErrorCode.BUSY, "Another task is using this phone.")),
                "stopped" to IntegrationsWire.computerUseStopped(auxiliaryFence, sessionId, "run_dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
                "invokeRefused" to IntegrationsWire.invokeUnsupported(auxiliaryFence, "inv:1"),
                "mcpClosed" to IntegrationsWire.mcpUnapproved(auxiliaryFence, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
            ),
            "displayFrames" to JsonArray((vectors.fields.getValue("phoneFrames") as JsonArray).items.map { entry ->
                displayFrame((entry as JsonObject).fields.getValue("frame") as JsonObject)
            }),
            "displayMedia" to JsonArray((vectors.fields.getValue("displayMediaFrames") as JsonArray).items.map { entry ->
                val frame = entry as JsonObject
                val header = DisplayMediaHeader.read(frame.fields.getValue("header") as JsonObject)
                val payload = java.util.Base64.getDecoder().decode((frame.fields.getValue("payloadBase64") as JsonString).value)
                jsonOf(java.util.Base64.getEncoder().encodeToString(DisplayWire.media(header, payload)))
            }),
            "setupStatus" to jsonObject(
                "unpaired" to SetupWire.encodeStatus(
                    SetupStatus(
                        accessibilityEnabled = false,
                        accessibilityConnected = false,
                        versionCode = 1117,
                        versionName = "0.1.117",
                        batteryOptimizationExempt = false,
                        connection = ConnectionState.UNPAIRED,
                        issue = null,
                        pairing = null,
                        paused = false,
                    ),
                ),
                "online" to SetupWire.encodeStatus(
                    SetupStatus(
                        accessibilityEnabled = true,
                        accessibilityConnected = true,
                        versionCode = 1117,
                        versionName = "0.1.117",
                        batteryOptimizationExempt = true,
                        connection = ConnectionState.ONLINE,
                        issue = null,
                        pairing = PairingSummary(
                            deploymentId = "dep_55555555-5555-4555-8555-555555555555",
                            deploymentName = "Mac mini",
                            enrollmentId = "enr_fixture",
                            hostUrl = "https://phone.example.com",
                            runnerId = descriptor.runnerId,
                        ),
                        paused = false,
                    ),
                ),
                "protocolError" to SetupWire.encodeStatus(
                    SetupStatus(
                        accessibilityEnabled = true,
                        accessibilityConnected = true,
                        versionCode = 1117,
                        versionName = "0.1.117",
                        batteryOptimizationExempt = true,
                        connection = ConnectionState.OFFLINE,
                        issue = ConnectionPolicy.protocolError("Mac mini"),
                        pairing = PairingSummary("dep_55555555-5555-4555-8555-555555555555", "Mac mini", "enr_fixture", "https://phone.example.com", descriptor.runnerId),
                        paused = false,
                    ),
                ),
                "expired" to SetupWire.encodeStatus(
                    SetupStatus(
                        accessibilityEnabled = true,
                        accessibilityConnected = true,
                        versionCode = 1117,
                        versionName = "0.1.117",
                        batteryOptimizationExempt = true,
                        connection = ConnectionState.PAIRING,
                        issue = Issue(IssueCode.ENROLLMENT_EXPIRED, "The setup code expired before this phone could use it."),
                        pairing = PairingSummary("dep_55555555-5555-4555-8555-555555555555", "Mac mini", "enr_fixture", "http://127.0.0.1:4310", descriptor.runnerId),
                        paused = false,
                    ),
                ),
            ),
        )
    }

    fun displayFrame(frame: JsonObject): JsonObject {
        val f = Fields.of(frame, "phone")
        val type = f.string("type")
        val fence = RunnerWire.auxiliaryFence(f)
        val stream = f.string("streamId")
        val result = when {
            type.endsWith("source-ended") -> {
                f.literal("display", "main")
                val source = f.obj("source")
                source.literal("kind", "owner-view")
                DisplayWire.sourceEnded(fence, stream, DisplaySource.Owner(source.string("viewId"), source.int("generation")), f.string("reason"))
            }
            type.endsWith("editing") -> {
                val source = if (f.has("source")) DisplayWire.source(f.raw("source")) else null
                DisplayWire.editingContext(fence, stream, if (source == null) f.string("sessionId") else null, f.int("geometry"), f.objectValue("context"), source)
            }
            type.endsWith("power-result") -> {
                val source = DisplayWire.source(f.raw("source"))
                val sequence = f.int("sequence")
                val dispatched = f.string("outcome") == "dispatched"
                f.optionalString("reason")
                DisplayWire.powerResult(DisplayMessage.Power(fence, stream, source, sequence, "wake"), dispatched)
            }
            type.endsWith("input-result") || type.endsWith("clipboard") -> {
                val source = if (f.has("source")) DisplayWire.source(f.raw("source")) else null
                val session = if (source == null) f.string("sessionId") else null
                val input = DisplayMessage.Input(fence, session, stream, f.int("geometry"), f.int("sequence"), emptyList(), source = source ?: DisplaySource.Task(requireNotNull(session)), sourceAddressed = source != null)
                val fields = linkedMapOf("sequence" to jsonOf(input.sequence), "outcome" to jsonOf(f.string("outcome")))
                f.optionalString("reason")?.let { fields["reason"] = jsonOf(it) }
                f.optionalString("text")?.let { fields["text"] = jsonOf(it) }
                DisplayWire.editingReply(input, type.substringAfterLast('.'), *fields.toList().toTypedArray())
            }
            else -> { f.literal("display", "main"); DisplayWire.state(fence, stream, f.string("state"), f.optionalString("reason"),
                f.int("generation"), f.int("width").toInt(), f.int("height").toInt(), f.int("rotation").toInt()) }
        }
        f.end()
        return result
    }

    private fun Observation.copyForFixture(observationId: String, screenshot: ScreenshotOutcome) = Observation.visible(
        capturedAt = capturedAt,
        observationId = observationId,
        display = display,
        geometry = geometry,
        foreground = foreground,
        tree = Tree(tree, elementCount, truncated),
        screenshot = screenshot,
    )

    private fun JsonObject.obj(key: String) = fields.getValue(key) as JsonObject
    private fun JsonObject.string(key: String) = (fields.getValue(key) as JsonString).value
    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
