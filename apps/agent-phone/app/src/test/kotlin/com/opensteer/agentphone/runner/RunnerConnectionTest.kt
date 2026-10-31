package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.ConnectionState
import com.opensteer.agentphone.wire.HostTarget
import com.opensteer.agentphone.wire.Issue
import com.opensteer.agentphone.wire.IssueCode
import com.opensteer.agentphone.wire.JsonObject
import com.opensteer.agentphone.wire.JsonString
import com.opensteer.agentphone.wire.JsonText
import com.opensteer.agentphone.wire.Pairing
import com.sun.net.httpserver.HttpServer
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The runtime thread's loop against a Host that speaks through fake sockets,
 * so what is tested is the connection's own handling of what arrives.
 * Failure modes:
 *
 * 1. a handshake frame with an unknown or malformed field escaping the attempt
 *    and ending the runtime thread, and with it the app, instead of being a
 *    protocol violation the phone retries after its backoff;
 * 2. the same on the integrations stream once the phone is online;
 * 3. a failure that is not the Host's — a Keystore write that throws — ending
 *    the runtime thread instead of being reported and retried;
 * 4. Stop no longer ending the thread once everything else is caught;
 * 5. a run of attempts ending in unreadable frames — in the handshake, or on
 *    the stream after a welcome — never shown as a protocol error, or the
 *    error hidden again by the next attempt's "connecting";
 * 6. a phone still waiting for its first welcome, moved by setup while that
 *    welcome is in flight at the old address, keeping the old address, losing
 *    the move to the welcome's write, or enrolling at the new address before
 *    discovery confirms it, or with a different token;
 * 7. a revocation on the primary while the stream is being opened dropped,
 *    so it takes effect an attempt late;
 * 8. a re-paired phone starting under the old Host's protocol error;
 * 9. the CPU kept awake once the connection has given up until setup acts,
 *    or let sleep while it still retries.
 */
class RunnerConnectionTest {
    private class FakeSocket(private val request: Request, val listener: WebSocketListener) : WebSocket {
        val sent = LinkedBlockingQueue<String>()

        @Volatile
        var closed = false

        val path: String get() = request.url.encodedPath

        override fun request() = request
        override fun queueSize() = 0L
        override fun send(text: String): Boolean = !closed && sent.add(text)
        override fun send(bytes: ByteString) = false
        override fun close(code: Int, reason: String?): Boolean {
            closed = true
            return true
        }

        override fun cancel() {
            closed = true
        }

        fun hostSays(text: String) = listener.onMessage(this, text)

        fun next(type: String): JsonObject {
            val frame = JsonText.parse(requireNotNull(sent.poll(WAIT_S, TimeUnit.SECONDS)) { "the phone sent nothing" }) as JsonObject
            assertEquals(type, frame.string("type"))
            return frame
        }
    }

    private class MemoryRecord(@Volatile var identity: PhoneIdentity?) : PhoneRecord {
        @Volatile
        var failWrites = false

        @Synchronized
        override fun load() = identity

        @Synchronized
        override fun replace(expected: PhoneIdentity, next: PhoneIdentity): Boolean {
            if (failWrites) throw IOException("The Keystore is unavailable")
            if (identity != expected) return false
            identity = next
            return true
        }

        @Synchronized
        override fun removeIfCurrent(expected: PhoneIdentity): Boolean {
            if (identity?.runnerId != expected.runnerId) return false
            identity = null
            removed = true
            return true
        }

        @Volatile
        override var removed = false
    }

    private class RecordingOwner(override val module: IntegrationsModule) : ConnectionOwner {
        val links = LinkedBlockingQueue<Pair<ConnectionState, Issue?>>()
        val identities = CopyOnWriteArrayList<PhoneIdentity?>()

        override fun useIdentity(identity: PhoneIdentity?) {
            identities += identity
        }

        override fun linkChanged(target: HostTarget?, connection: ConnectionState, issue: Issue?) {
            links.put(connection to issue)
        }

        override fun settled() = Unit

        /** Whether the connection last asked for the CPU to stay awake. */
        @Volatile
        var awake = false

        override fun keepAwake(needed: Boolean) {
            awake = needed
        }

        /** Waits for the next state report that `matches`, skipping the ones before it. */
        fun awaitLink(matches: (ConnectionState, Issue?) -> Boolean): Pair<ConnectionState, Issue?> {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
            while (true) {
                val left = deadline - System.nanoTime()
                val link = requireNotNull(links.poll(left, TimeUnit.NANOSECONDS)) { "no matching state report" }
                if (matches(link.first, link.second)) return link
            }
        }
    }

    private val opened = LinkedBlockingQueue<FakeSocket>()
    private val sockets = object : WebSocket.Factory {
        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
            FakeSocket(request, listener).also { opened.put(it) }
    }
    private val identity = PhoneIdentity.create(
        Pairing(
            "dep_55555555-5555-4555-8555-555555555555", "Mac mini", "ren_1", "t".repeat(40),
            "2026-10-11T12:10:00.000Z", "hst_66666666-6666-4666-8666-666666666666",
            "https://connect.example", "Pixel",
        ),
    ).confirmed().welcomed(connectionGeneration = 4)
    private val record = MemoryRecord(identity)
    private val phone = FakePhone()
    private val outbox = StreamOutbox()
    private val owner = RecordingOwner(
        IntegrationsModule(
            outbox,
            phone,
            MemoryJournal(),
            paused = { false },
            log = {},
        ),
    )
    @Volatile private var updateResult: PhoneUpdateResult = PhoneUpdateResult.Current
    @Volatile private var requiredUpdateResult: PhoneUpdateResult = PhoneUpdateResult.Current
    private val updater = object : PhoneUpdater {
        override fun check(identity: PhoneIdentity, required: Boolean) = if (required) requiredUpdateResult else updateResult
        override fun cancel() = Unit
    }
    private val connection = RunnerConnection(
        sockets = sockets,
        discovery = HostDiscovery(OkHttpClient()),
        record = record,
        runtimeVersion = "0.1.117",
        updater = updater,
        owner = owner,
        elapsed = { System.nanoTime() / 1_000_000 },
        log = {},
    )

    @After
    fun stop() {
        connection.stop()
    }

    private fun nextSocket(path: String): FakeSocket {
        val socket = requireNotNull(opened.poll(WAIT_S, TimeUnit.SECONDS)) { "the phone did not connect again" }
        assertEquals(path, socket.path)
        return socket
    }

    private fun stoppedCleanly() {
        connection.stop()
        // The loop gives its identity back only on its way out through Stop.
        assertNull(owner.identities.last())
    }

    @Test
    fun requiredAndroidConsentKeepsItsMessageAndRetriesInsteadOfHaltingForUsb() {
        requiredUpdateResult = PhoneUpdateResult.Pending("Tap Update to finish updating Agent Phone.")
        connection.start()
        val primary = nextSocket(PRIMARY)
        primary.hostSays(challenge())
        primary.next("runner.authenticate")
        primary.hostSays("""{"type":"host.error","error":{"code":"forbidden","message":"Update","reason":"agent-phone-outdated","retryable":false}}""")
        val (_, issue) = owner.awaitLink { _, issue -> issue?.detail?.startsWith("Tap Update") == true }
        assertEquals(IssueCode.NEEDS_UPDATE, issue?.code)
        assertTrue(owner.awake)
        requiredUpdateResult = PhoneUpdateResult.Current
        nextSocket(PRIMARY)
        stoppedCleanly()
    }

    @Test
    fun existingAndroidConsentDoesNotOpenAnotherPrimaryConnectionAndCanResumeWhenItEnds() {
        updateResult = PhoneUpdateResult.Pending("Tap Update to finish updating Agent Phone.")
        connection.start()
        owner.awaitLink { _, issue -> issue?.detail?.startsWith("Tap Update") == true }
        assertTrue(opened.isEmpty())
        updateResult = PhoneUpdateResult.Current
        connection.identityChanged()
        nextSocket(PRIMARY)
        stoppedCleanly()
    }

    @Test
    fun anUnreadableHandshakeFrameIsAViolationThatIsRetriedNotACrash() {
        connection.start()
        val first = nextSocket(PRIMARY)
        first.hostSays(challenge(extra = ""","surprise":true"""))
        val (state, issue) = owner.awaitLink { state, issue -> state == ConnectionState.OFFLINE && issue != null }
        assertEquals(ConnectionState.OFFLINE, state)
        assertEquals(IssueCode.FAILED, issue?.code)
        assertTrue(issue!!.detail, issue.detail.contains("cannot read"))
        assertTrue(first.closed)

        // The runtime lived through it and tries again after its backoff.
        val second = nextSocket(PRIMARY)
        second.hostSays(challenge())
        val bootId = (second.next("runner.authenticate").fields.getValue("descriptor") as JsonObject).string("bootId")
        second.hostSays(welcome(bootId, extra = ""","environmentIds":["not-an-environment"]"""))
        val (_, persistent) = owner.awaitLink { state, issue -> state == ConnectionState.OFFLINE && issue != null }
        assertEquals(IssueCode.PROTOCOL_ERROR, persistent?.code)
        assertTrue(persistent!!.detail.contains("Opensteer on Mac mini"))

        // While it reconnects the conclusion still stands.
        nextSocket(PRIMARY)
        val (_, reconnecting) = owner.awaitLink { state, _ -> state == ConnectionState.CONNECTING }
        assertEquals(IssueCode.PROTOCOL_ERROR, reconnecting?.code)
        stoppedCleanly()
    }

    @Test
    fun unreadableStreamFramesAfterEachWelcomeReachAProtocolError() {
        connection.start()
        val primary = nextSocket(PRIMARY)
        val stream = online(primary)
        stream.hostSays("""{${auxFence()},"type":"host.integrations.unheard-of"}""")
        val (_, issue) = owner.awaitLink { state, issue -> state == ConnectionState.OFFLINE && issue != null }
        assertEquals(IssueCode.FAILED, issue?.code)
        assertTrue(primary.closed && stream.closed)
        // The stream's work was let go with it.
        assertEquals(1, phone.released)

        // The Host welcomes the phone again, then sends the same unreadable frame.
        val again = online(nextSocket(PRIMARY), generation = 6)
        again.hostSays("""{${auxFence(generation = 6)},"type":"host.integrations.unheard-of"}""")
        val (_, persistent) = owner.awaitLink { state, issue -> state == ConnectionState.OFFLINE && issue != null }
        assertEquals(IssueCode.PROTOCOL_ERROR, persistent?.code)
        nextSocket(PRIMARY)
        stoppedCleanly()
    }

    @Test
    fun aFailureThatIsNotTheHostsKeepsTheRuntimeAlive() {
        record.failWrites = true
        connection.start()
        val primary = nextSocket(PRIMARY)
        primary.hostSays(challenge())
        val bootId = (primary.next("runner.authenticate").fields.getValue("descriptor") as JsonObject).string("bootId")
        // Storing the welcomed generation throws a checked exception from the Keystore.
        primary.hostSays(welcome(bootId))
        val (state, issue) = owner.awaitLink { state, issue -> state == ConnectionState.OFFLINE && issue != null }
        assertEquals(ConnectionState.OFFLINE, state)
        assertEquals(IssueCode.FAILED, issue?.code)
        stoppedCleanly()
    }

    @Test
    fun aPendingPhoneMovedWhileItsWelcomeIsInFlightEnrollsAtTheNewAddressWithItsToken() {
        // Paired, confirmed at its address, and never welcomed.
        val waiting = identity.copy(
            lastConnectionGeneration = 0,
            enrollmentId = "ren_2",
            enrollmentToken = "p".repeat(40),
            hostUrl = "https://old.example",
        )
        record.identity = waiting
        val discovery = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        discovery.createContext("/.well-known/opensteer") { exchange ->
            val body = """{"authority":{"document":{"deploymentId":"${waiting.deploymentId}","hostInstanceId":"${waiting.hostInstanceId}"}}}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        discovery.start()
        try {
            val newAddress = "http://127.0.0.1:${discovery.address.port}"
            connection.start()
            val old = nextSocket(PRIMARY)
            assertEquals("old.example", old.request().url.host)
            old.hostSays(challenge())
            val enroll = old.next("runner.enroll")
            val bootId = (enroll.fields.getValue("descriptor") as JsonObject).string("bootId")
            // Setup moves the stored identity, then the old address's welcome arrives.
            val moved = (waiting.retarget(waiting.target.copy(hostUrl = newAddress)) as Retarget.Moved).identity
            record.identity = moved
            old.hostSays(welcome(bootId, generation = 1))
            val next = nextSocket(PRIMARY)
            assertEquals(newAddress + PRIMARY, next.request().url.toString())
            // The move survived the welcome, and discovery confirmed the new address first.
            assertEquals(moved.confirmed(), record.identity)
            next.hostSays(challenge())
            val again = next.next("runner.enroll")
            assertEquals(enroll.fields.getValue("credential"), again.fields.getValue("credential"))
            assertEquals(
                (enroll.fields.getValue("descriptor") as JsonObject).string("runnerId"),
                (again.fields.getValue("descriptor") as JsonObject).string("runnerId"),
            )
            stoppedCleanly()
        } finally {
            discovery.stop(0)
        }
    }

    @Test
    fun aRevocationWhileTheStreamOpensTakesEffectAtOnce() {
        connection.start()
        val primary = nextSocket(PRIMARY)
        primary.hostSays(challenge())
        val bootId = (primary.next("runner.authenticate").fields.getValue("descriptor") as JsonObject).string("bootId")
        bootIdSeen = bootId
        primary.hostSays(welcome(bootId))
        val requestId = primary.next("runner.auxiliary.ticket-request").string("requestId")
        primary.hostSays(
            """{${fence()},"expiresAt":"2026-10-11T12:01:00.000Z","module":"integrations","requestId":"$requestId","ticket":"a.b.c","type":"host.auxiliary.ticket"}""",
        )
        nextSocket(STREAM)
        // The Host removes the phone before the stream's challenge.
        primary.listener.onClosing(primary, 4010, "removed")
        val (state, issue) = owner.awaitLink { state, _ -> state == ConnectionState.REMOVED }
        assertEquals(ConnectionState.REMOVED, state)
        assertEquals(IssueCode.REMOVED, issue?.code)
        assertNull(record.identity)
        assertTrue(record.removed)
        stoppedCleanly()
    }

    @Test
    fun keepsThePhoneAwakeWhileItRetriesAndLetsItSleepOnceItHasGivenUp() {
        record.identity = identity.copy(lastConnectionGeneration = 0, enrollmentId = "ren_3", enrollmentToken = "r".repeat(40))
        connection.start()
        val first = nextSocket(PRIMARY)
        first.hostSays(challenge(extra = ""","surprise":true"""))
        owner.awaitLink { _, issue -> issue != null }
        assertTrue(owner.awake)
        val second = nextSocket(PRIMARY)
        second.hostSays(challenge())
        second.next("runner.enroll")
        second.hostSays("""{"type":"host.error","error":{"code":"forbidden","message":"Expired","reason":"runner-enrollment-expired","retryable":false}}""")
        owner.awaitLink { _, issue -> issue?.code == IssueCode.ENROLLMENT_EXPIRED }
        // The decision is final until setup acts: nothing left to time.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_S)
        while (owner.awake && System.nanoTime() < deadline) Thread.sleep(10)
        assertTrue(!owner.awake)
        stoppedCleanly()
    }

    @Test
    fun aRePairedPhoneStartsWithoutTheOldHostsProtocolError() {
        connection.start()
        repeat(2) {
            nextSocket(PRIMARY).hostSays(challenge(extra = ""","surprise":true"""))
        }
        owner.awaitLink { _, issue -> issue?.code == IssueCode.PROTOCOL_ERROR }
        // Setup pairs the phone again, as a new enrollment.
        record.identity = identity.copy(lastConnectionGeneration = 0, enrollmentId = "ren_9", enrollmentToken = "q".repeat(40))
        connection.identityChanged()
        val (_, issue) = owner.awaitLink { state, _ -> state == ConnectionState.PAIRING }
        assertNull(issue)
        stoppedCleanly()
    }

    /** Takes `primary` through the whole handshake to a served integrations stream; each welcome needs a newer generation. */
    private fun online(primary: FakeSocket, generation: Int = 5): FakeSocket {
        primary.hostSays(challenge())
        val bootId = (primary.next("runner.authenticate").fields.getValue("descriptor") as JsonObject).string("bootId")
        bootIdSeen = bootId
        primary.hostSays(welcome(bootId, generation = generation))
        val requestId = primary.next("runner.auxiliary.ticket-request").string("requestId")
        primary.hostSays(
            """{${fence(generation = generation)},"expiresAt":"2026-10-11T12:01:00.000Z","module":"integrations","requestId":"$requestId","ticket":"a.b.c","type":"host.auxiliary.ticket"}""",
        )
        val stream = nextSocket(STREAM)
        stream.hostSays(
            """{"challengeId":"rch_44444444-4444-4444-8444-444444444444","expiresAt":"2026-10-11T12:00:30.000Z","hostSessionId":"${"C".repeat(32)}","module":"integrations","nonce":"${"D".repeat(43)}","type":"host.auxiliary.challenge"}""",
        )
        stream.next("runner.auxiliary.authenticate")
        stream.hostSays(
            """{${auxFence(generation)},"heartbeatIntervalMs":15000,"serverTime":"2026-10-11T12:00:00.000Z","streamLeaseExpiresAt":"2026-10-11T12:02:00.000Z","type":"host.auxiliary.welcome"}""",
        )
        primary.next("runner.modules.report")
        stream.next("runner.integrations.status")
        assertNotNull(owner.awaitLink { state, _ -> state == ConnectionState.ONLINE })
        return stream
    }

    private var bootIdSeen = ""

    private fun fence(bootId: String = bootIdSeen, generation: Int = 5) =
        """"bootId":"$bootId","connectionGeneration":$generation,"connectionId":"rcn_11111111-1111-4111-8111-111111111111","connectionLeaseId":"rls_11111111-1111-4111-8111-111111111111","runnerId":"${identity.runnerId}""""

    private fun auxFence(generation: Int = 5) =
        """${fence(generation = generation)},"auxiliaryStreamId":"rax_11111111-1111-4111-8111-111111111111","module":"integrations""""

    private fun challenge(extra: String = "") =
        """{"challengeId":"rch_11111111-1111-4111-8111-111111111111","expiresAt":"2026-10-11T12:00:15.000Z","hostSessionId":"${"A".repeat(32)}","nonce":"${"B".repeat(43)}","proofFormatVersion":2,"type":"host.challenge"$extra}"""

    /** `extra` stands where `environmentIds` goes, so a test can replace it with something unreadable. */
    private fun welcome(bootId: String, extra: String = ""","environmentIds":[]""", generation: Int = 5) =
        """{${fence(bootId, generation)},"allowedModules":["integrations"],"connectionLeaseExpiresAt":"2026-10-11T12:02:00.000Z"$extra,"heartbeatIntervalMs":15000,"serverTime":"2026-10-11T12:00:00.000Z","type":"host.welcome"}"""

    private companion object {
        const val WAIT_S = 10L
        const val PRIMARY = "/internal/v1/runners"
        const val STREAM = "/internal/v1/runners/auxiliary/integrations"

        fun JsonObject.string(key: String) = (fields.getValue(key) as JsonString).value
    }
}
