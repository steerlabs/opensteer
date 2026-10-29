package com.opensteer.agentphone.wire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The strict decoders at the phone's network boundary. Each is a copy of a Zod
 * schema the Host encodes against, so the ways they can go wrong are the ways
 * a copy drifts:
 *
 * 1. an unknown or misspelled field accepted (Zod's strict objects refuse it);
 * 2. an identifier accepted without its prefix or pattern;
 * 3. a refusal's machine-readable `reason` lost from `host.error`, so an
 *    expired token reads like any other failure;
 * 4. a phone computer-use frame that names an app, or carries access on an
 *    operation that takes none, or an operation a phone does not have — or the
 *    app list refused although a phone answers it;
 * 5. act params whose Zod defaults are not applied, or whose limits — 32
 *    actions, 40 s of timed actions, element index and point bounds, package
 *    name shape — are not enforced before anything runs;
 * 6. a pairing payload pointing a phone at plaintext HTTP off its own
 *    loopback, or at a URL that is not a bare origin;
 * 7. a RETARGET payload read as anything but `AgentPhoneHostTarget` exactly —
 *    a token smuggled in, an identifier without its prefix, or an
 *    address a pairing could not name either;
 * 8. a missing, blank or oversized Deployment name accepted, or ECMAScript
 *    whitespace kept instead of trimmed in PAIR or RETARGET;
 * 9. app-list params whose Zod defaults are not applied, or whose bounds — a
 *    200-character query, a limit of 1 to 100, a safe-integer offset — are
 *    not enforced.
 */
class FramesTest {
    private val fence = """"bootId":"rbt_22222222-2222-4222-8222-222222222222","connectionGeneration":3,"connectionId":"rcn_11111111-1111-4111-8111-111111111111","connectionLeaseId":"rls_11111111-1111-4111-8111-111111111111","runnerId":"rnr_33333333-3333-4333-8333-333333333333""""
    private val auxFence = """$fence,"auxiliaryStreamId":"rax_11111111-1111-4111-8111-111111111111","module":"integrations""""
    private val session = "cus_44444444-4444-4444-8444-444444444444"

    @Test
    fun ownerViewsHaveIndependentFencedExpiringAuthority() {
        val good = """{$auxFence,"type":"host.integrations.computer-view","version":1,"operation":"open","viewId":"cvw_44444444-4444-4444-8444-444444444444","generation":2,"leaseDurationMs":180000,"target":{"kind":"phone","display":"main"},"requestId":"view:capture","timeoutMs":1000}"""
        val decoded = IntegrationsWire.decode(good) as IntegrationsMessage.ComputerView
        assertEquals(2L, decoded.generation)
        assertEquals("main", decoded.display)
        for (bad in listOf(
            good.replace("\"version\":1", "\"version\":2"),
            good.replace("\"generation\":2", "\"generation\":0"),
            good.replace("\"display\":\"main\"", "\"display\":\"main\",\"app\":{}"),
            good.dropLast(1) + ",\"runId\":\"run_44444444-4444-4444-8444-444444444444\"}",
        )) assertThrows(WireException::class.java) { IntegrationsWire.decode(bad) }
    }

    @Test
    fun refusesCrossFormatChallengesWithAnActionableUpdate() {
        val base = """{"challengeId":"rch_11111111-1111-4111-8111-111111111111","expiresAt":"2026-10-11T12:00:15.000Z","hostSessionId":"${"A".repeat(32)}","nonce":"${"B".repeat(43)}","type":"host.challenge"}"""
        for (extra in listOf("", ",\"proofFormatVersion\":1", ",\"proofFormatVersion\":3")) {
            val error = assertThrows(WireException::class.java) { RunnerWire.decodeHostMessage(base.dropLast(1) + extra + "}") }
            assertTrue(error.message.orEmpty().contains("update", ignoreCase = true))
        }
    }

    @Test
    fun decodesTheHandshake() {
        val challenge = RunnerWire.decodeHostMessage(
            """{"challengeId":"rch_11111111-1111-4111-8111-111111111111","expiresAt":"2026-10-11T12:00:15.000Z","hostSessionId":"${"A".repeat(32)}","nonce":"${"B".repeat(43)}","proofFormatVersion":2,"type":"host.challenge"}""",
        ) as HostMessage.Challenge
        assertEquals("rch_11111111-1111-4111-8111-111111111111", challenge.challenge.challengeId)
        val welcome = RunnerWire.decodeHostMessage(
            """{$fence,"allowedModules":["integrations"],"connectionLeaseExpiresAt":"2026-10-11T12:02:00.000Z","environmentIds":[],"heartbeatIntervalMs":15000,"serverTime":"2026-10-11T12:00:00.000Z","type":"host.welcome"}""",
        ) as HostMessage.Welcome
        assertEquals(3L, welcome.fence.connectionGeneration)
        assertEquals(15_000L, welcome.heartbeatIntervalMs)
        assertEquals(listOf("integrations"), welcome.allowedModules)
    }

    @Test
    fun refusesUnknownFieldsAndMalformedIdentifiers() {
        val good = """"challengeId":"rch_11111111-1111-4111-8111-111111111111","expiresAt":"2026-10-11T12:00:15.000Z","hostSessionId":"${"A".repeat(32)}","nonce":"${"B".repeat(43)}","proofFormatVersion":2,"type":"host.challenge""""
        RunnerWire.decodeHostMessage("{$good}")
        for (bad in listOf(
            "{$good,\"extra\":1}",
            "{${good.replace("rch_", "rcx_")}}",
            "{${good.replace("2026-10-11T12:00:15.000Z", "2026-10-11 12:00:15")}}",
            "{${good.replace("A".repeat(32), "A".repeat(31))}}",
        )) {
            assertThrows(bad, WireException::class.java) { RunnerWire.decodeHostMessage(bad) }
        }
        assertThrows(WireException::class.java) {
            RunnerWire.decodeHostMessage("""{$fence,"connectionLeaseExpiresAt":"2026-10-11T12:02:00.000Z","type":"host.connection.lease-renewed","bootId2":1}""")
        }
    }

    @Test
    fun keepsTheReasonOfAStructuredRefusal() {
        val error = RunnerWire.decodeHostMessage(
            """{"type":"host.error","error":{"code":"forbidden","message":"Runner enrollment failed","reason":"runner-enrollment-expired","retryable":false}}""",
        ) as HostMessage.Error
        assertEquals("runner-enrollment-expired", error.error.reason)
        assertEquals(false, error.error.retryable)
        val plain = RunnerWire.decodeHostMessage(
            """{"type":"host.error","error":{"code":"internal","message":"Try again","retryable":true}}""",
        ) as HostMessage.Error
        assertNull(plain.error.reason)
        assertThrows(WireException::class.java) {
            RunnerWire.decodeHostMessage("""{"type":"host.error","error":{"code":"teapot","message":"x","retryable":true}}""")
        }
        assertEquals(HostMessage.Unexpected, RunnerWire.decodeHostMessage("""{"type":"host.command"}"""))
    }

    @Test
    fun decodesAuxiliaryHandshakeFrames() {
        val welcome = RunnerWire.decodeAuxiliaryHandshake(
            """{$auxFence,"heartbeatIntervalMs":15000,"serverTime":"2026-10-11T12:00:00.000Z","streamLeaseExpiresAt":"2026-10-11T12:02:00.000Z","type":"host.auxiliary.welcome"}""",
        ) as AuxiliaryHandshake.Welcome
        assertEquals("rax_11111111-1111-4111-8111-111111111111", welcome.fence.auxiliaryStreamId)
        val rejected = RunnerWire.decodeAuxiliaryHandshake(
            """{"error":{"code":"forbidden","message":"No","retryable":false},"type":"host.auxiliary.rejected"}""",
        )
        assertTrue(rejected is AuxiliaryHandshake.Rejected)
        assertThrows(WireException::class.java) {
            RunnerWire.decodeAuxiliaryHandshake(
                """{${auxFence.replace("\"integrations\"", "\"browser\"")},"heartbeatIntervalMs":15000,"serverTime":"2026-10-11T12:00:00.000Z","streamLeaseExpiresAt":"2026-10-11T12:02:00.000Z","type":"host.auxiliary.welcome"}""",
            )
        }
    }

    private fun computerUse(fields: String) =
        """{$auxFence,"params":{},"requestId":"cu:1","runId":"run_55555555-5555-4555-8555-555555555555","sessionId":"$session","threadTitle":null,"timeoutMs":60000,"type":"host.integrations.computer-use",$fields}"""

    @Test
    fun enforcesThePhoneShapeOfComputerUseFrames() {
        val observe = IntegrationsWire.decode(
            computerUse(""""access":"read","app":null,"definitionId":"android-phone","operation":"observe""""),
        ) as IntegrationsMessage.ComputerUse
        assertEquals("android-phone", observe.definitionId)
        assertEquals("read", observe.access)
        val close = IntegrationsWire.decode(
            computerUse(""""access":null,"app":null,"definitionId":"android-phone","operation":"close""""),
        ) as IntegrationsMessage.ComputerUse
        assertNull(close.access)
        val mac = IntegrationsWire.decode(computerUse(""""access":null,"app":null,"operation":"permissions"""")) as IntegrationsMessage.ComputerUse
        assertNull(mac.definitionId)
        val apps = IntegrationsWire.decode(
            computerUse(""""access":null,"app":null,"definitionId":"android-phone","operation":"installed_apps""""),
        ) as IntegrationsMessage.ComputerUse
        assertEquals("installed_apps", apps.operation)
        for (bad in listOf(
            """"access":"read","app":{"bundleId":"x"},"definitionId":"android-phone","operation":"observe"""",
            """"access":"read","app":null,"definitionId":"android-phone","operation":"capture"""",
            """"access":null,"app":null,"definitionId":"android-phone","operation":"act"""",
            """"access":"read","app":null,"definitionId":"android-phone","operation":"installed_apps"""",
            """"access":null,"app":null,"definitionId":"android-phone","operation":"resolve_app"""",
            """"access":"read","app":null,"definitionId":"macos-app","operation":"observe"""",
            """"access":"read","app":null,"operation":"observe"""",
        )) {
            assertThrows(bad, WireException::class.java) { IntegrationsWire.decode(computerUse(bad)) }
        }
    }

    @Test
    fun appliesActDefaultsAndLimits() {
        val params = AndroidPhoneWire.decodeActParams(
            JsonText.parse(
                """{"includeScreenshot":true,"observationId":"obs_1","actions":[{"type":"tap","target":{"index":3}},{"type":"longPress","target":{"x":1,"y":2}},{"type":"swipe","from":{"x":1,"y":2},"to":{"x":3,"y":4}},{"type":"drag","from":{"index":0},"to":{"index":1}},{"type":"type","text":"héllo 😀"},{"type":"scroll","target":{"index":2},"direction":"down","amount":2},{"type":"navigate","to":"quickSettings"},{"type":"launch","packageName":"com.android.settings"},{"type":"wake"},{"type":"wait","ms":10},{"type":"clear","target":{"index":4}}]}""",
            ) as JsonObject,
        )
        assertEquals(true, params.includeScreenshot)
        assertEquals(
            listOf(
                PhoneAction.Tap(PhoneTarget.Element(3), 1),
                PhoneAction.LongPress(PhoneTarget.Point(1, 2), 800),
                PhoneAction.Swipe(PhoneTarget.Point(1, 2), PhoneTarget.Point(3, 4), 300),
                PhoneAction.Drag(PhoneTarget.Element(0), PhoneTarget.Element(1), holdMs = 600, durationMs = 600),
                PhoneAction.Type(null, "héllo 😀", submit = false),
                PhoneAction.Scroll(PhoneTarget.Element(2), ScrollDirection.DOWN, 2),
                PhoneAction.Navigate(Navigation.QUICK_SETTINGS),
                PhoneAction.Launch("com.android.settings"),
                PhoneAction.Wake,
                PhoneAction.Wait(10),
                PhoneAction.Clear(PhoneTarget.Element(4)),
            ),
            params.actions,
        )
        val wait = """{"type":"wait","ms":5000}"""
        for (bad in listOf(
            """[$wait,$wait,$wait,$wait,$wait,$wait,$wait,$wait,$wait]""",
            "[" + List(33) { """{"type":"wake"}""" }.joinToString(",") + "]",
            "[]",
            """[{"type":"tap","target":{"index":1500}}]""",
            """[{"type":"tap","target":{"index":1,"x":2}}]""",
            """[{"type":"tap","target":{"x":10001,"y":2}}]""",
            """[{"type":"tap","target":{"x":1.5,"y":2}}]""",
            """[{"type":"tap","target":{"index":1},"count":3}]""",
            """[{"type":"launch","packageName":"android"}]""",
            """[{"type":"type","text":""}]""",
            """[{"type":"press","key":"enter"}]""",
            """[{"type":"wake","extra":true}]""",
            """[{"type":"longPress","target":{"index":1},"durationMs":399}]""",
        )) {
            assertThrows(bad, WireException::class.java) {
                AndroidPhoneWire.decodeActParams(
                    JsonText.parse("""{"includeScreenshot":false,"observationId":"o","actions":$bad}""") as JsonObject,
                )
            }
        }
        assertThrows(WireException::class.java) {
            AndroidPhoneWire.decodeActParams(JsonText.parse("""{"observationId":"o","actions":[{"type":"wake"}]}""") as JsonObject)
        }
    }

    @Test
    fun appliesAppListDefaultsAndBounds() {
        fun params(json: String) = AndroidPhoneWire.decodeInstalledAppsParams(JsonText.parse(json) as JsonObject)
        assertEquals(InstalledAppsParams("", 50, 0), params("{}"))
        assertEquals(InstalledAppsParams("Mail", 100, MAX_SAFE_INTEGER), params("""{"query":"Mail","limit":100,"offset":9007199254740991}"""))
        assertEquals(InstalledAppsParams("x".repeat(240), 1, 0), params("""{"query":"${"x".repeat(240)}","limit":1}"""))
        for (bad in listOf(
            """{"query":"${"x".repeat(241)}"}""",
            """{"limit":0}""",
            """{"limit":101}""",
            """{"limit":2.5}""",
            """{"offset":-1}""",
            """{"offset":0.5}""",
            """{"offset":9007199254740992}""",
            """{"query":null}""",
            """{"icons":true}""",
        )) {
            assertThrows(bad, WireException::class.java) { params(bad) }
        }
    }

    @Test
    fun acceptsOnlyAPairingAPhoneCanUseSafely() {
        fun payload(hostUrl: String, extra: String = "", name: String = "Pixel") = Base64Url.encode(
            """{"deploymentId":"dep_55555555-5555-4555-8555-555555555555","deploymentName":"Mac mini","enrollmentId":"enr-1","enrollmentToken":"${"t".repeat(40)}","expiresAt":"2026-10-11T12:10:00.000Z","hostInstanceId":"hst_66666666-6666-4666-8666-666666666666","hostUrl":"$hostUrl","runnerName":"$name","version":1$extra}""".toByteArray(),
        )
        assertEquals("https://phone.example.com", SetupWire.decodePairing(payload("https://phone.example.com")).hostUrl)
        assertEquals("http://127.0.0.1:4310", SetupWire.decodePairing(payload("http://127.0.0.1:4310")).hostUrl)
        assertEquals("http://localhost:4310", SetupWire.decodePairing(payload("http://localhost:4310")).hostUrl)
        assertEquals("Pixel 9", SetupWire.decodePairing(payload("https://a.example", name = "  Pixel 9\\u00a0")).runnerName)
        for (bad in listOf(
            payload("http://10.0.2.2:4310"),
            payload("https://phone.example.com/"),
            payload("https://phone.example.com/path"),
            payload("https://Phone.example.com"),
            payload("https://phone.example.com:443"),
            payload("https://user@phone.example.com"),
            payload("https://phone.example.com", ",\"extra\":1"),
            payload("https://phone.example.com", name = "   "),
            payload("https://phone.example.com") + "=",
            "not base64 !",
        )) {
            assertThrows(bad, WireException::class.java) { SetupWire.decodePairing(bad) }
        }
    }

    @Test
    fun acceptsOnlyAHostTargetToMoveTo() {
        fun payload(hostUrl: String, extra: String = "", deployment: String = "dep_55555555-5555-4555-8555-555555555555") = Base64Url.encode(
            """{"deploymentId":"$deployment","deploymentName":"Mac mini","hostInstanceId":"hst_66666666-6666-4666-8666-666666666666","hostUrl":"$hostUrl"$extra}""".toByteArray(),
        )
        assertEquals(
            HostTarget("dep_55555555-5555-4555-8555-555555555555", "Mac mini", "hst_66666666-6666-4666-8666-666666666666", "https://mac.private.example"),
            SetupWire.decodeHostTarget(payload("https://mac.private.example")),
        )
        for (bad in listOf(
            payload("http://10.0.2.2:4310"),
            payload("https://mac.private.example/"),
            payload("https://mac.private.example", ",\"enrollmentToken\":\"${"t".repeat(40)}\""),
            payload("https://mac.private.example", deployment = "55555555-5555-4555-8555-555555555555"),
            Base64Url.encode("""{"deploymentId":"dep_55555555-5555-4555-8555-555555555555","hostUrl":"https://a.example"}""".toByteArray()),
            "not base64 !",
        )) {
            assertThrows(bad, WireException::class.java) { SetupWire.decodeHostTarget(bad) }
        }
    }
    @Test
    fun requiresAndTrimsTheDeploymentNameInPairingAndRetarget() {
        val target = """{"deploymentId":"dep_55555555-5555-4555-8555-555555555555","deploymentName":"  Mac mini\u00a0\ufeff","hostInstanceId":"hst_66666666-6666-4666-8666-666666666666","hostUrl":"https://phone.example.com"}"""
        val pairingFields = ""","enrollmentId":"enr-1","enrollmentToken":"${"t".repeat(40)}","expiresAt":"2026-10-11T12:10:00.000Z","runnerName":"Pixel","version":1"""
        fun pairing(json: String) = json.dropLast(1) + pairingFields + "}"
        fun encoded(json: String) = Base64Url.encode(json.toByteArray())
        assertEquals("Mac mini", SetupWire.decodeHostTarget(encoded(target)).deploymentName)
        assertEquals("Mac mini", SetupWire.decodePairing(encoded(pairing(target))).deploymentName)
        val nameField = """"deploymentName":"  Mac mini\u00a0\ufeff","""
        for (name in listOf("", "   ", "a".repeat(121))) {
            val bad = target.replace(nameField, "\"deploymentName\":\"$name\",")
            assertThrows(WireException::class.java) { SetupWire.decodeHostTarget(encoded(bad)) }
            assertThrows(WireException::class.java) { SetupWire.decodePairing(encoded(pairing(bad))) }
        }
        val missing = target.replace(nameField, "")
        assertThrows(WireException::class.java) { SetupWire.decodeHostTarget(encoded(missing)) }
        assertThrows(WireException::class.java) { SetupWire.decodePairing(encoded(pairing(missing))) }
    }

}
