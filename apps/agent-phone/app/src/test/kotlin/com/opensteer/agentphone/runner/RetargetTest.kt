package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.HostTarget
import com.opensteer.agentphone.wire.IssueCode
import com.opensteer.agentphone.wire.JsonText
import com.opensteer.agentphone.wire.Pairing
import com.sun.net.httpserver.HttpServer
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.Random

/**
 * RETARGET: a Personal Deployment's route moved (Connect ↔ private), and setup
 * tells the phone where its own Deployment's Host is now. Failure modes,
 * each a phone that ends up working for the wrong server, or not at all:
 *
 * 1. a phone of another Deployment moved instead of refused — it would carry
 *    its identity to a Host that never enrolled it;
 * 2. a phone still waiting for its first welcome refused, so a pairing whose
 *    address changed can never recover — or moved with a new runner id, new
 *    key or without its enrollment token, so the Host sees another computer
 *    or the token is lost;
 * 3. the address it already confirmed treated as a move, disturbing a phone
 *    that works;
 * 4. a move that changes anything but the address — a new runner id, new
 *    key, a lost connection generation — so the Host sees another computer;
 * 5. a new address used before the phone confirms it is that Deployment's
 *    Host: a server that does not answer as Opensteer, or answers as another
 *    Opensteer, must stop the phone there (host-mismatch) without wiping it,
 *    and one that does not answer at all, or answers with a document whose
 *    identifiers are not even strings, is retried (host-unreachable);
 * 6. the confirmation lost across a restart, or claimed without one;
 * 7. a name-only change ignored, or lost on persistence or repairing an enrollment.
 */
class RetargetTest {
    private val deploymentId = "dep_55555555-5555-4555-8555-555555555555"
    private val hostInstanceId = "hst_66666666-6666-4666-8666-666666666666"
    private val enrolled = PhoneIdentity.create(
        Pairing(
            deploymentId = deploymentId,
            deploymentName = "Mac mini",
            enrollmentId = "ren_1",
            enrollmentToken = "t".repeat(40),
            expiresAt = "2026-10-11T12:10:00.000Z",
            hostInstanceId = hostInstanceId,
            hostUrl = "https://connect.example",
            runnerName = "Pixel",
        ),
    ).confirmed().welcomed(connectionGeneration = 4)
    private val moved = HostTarget(deploymentId, "Mac mini", hostInstanceId, "https://mac.private.example")

    private val pending = PhoneIdentity.create(
        Pairing(deploymentId, "Mac mini", "ren_2", "t".repeat(40), "2026-10-11T12:10:00.000Z", hostInstanceId, "https://connect.example", "Pixel"),
    ).confirmed()

    @Test
    fun refusesToMoveAnotherDeploymentsPhoneWhetherOrNotItEnrolled() {
        val elsewhere = moved.copy(deploymentId = "dep_77777777-7777-4777-8777-777777777777")
        assertSame(Retarget.OtherDeployment, enrolled.retarget(elsewhere))
        assertSame(Retarget.OtherDeployment, pending.retarget(elsewhere))
    }

    @Test
    fun movesAPhoneStillWaitingForItsFirstWelcomeWithItsIdentityAndToken() {
        val next = (pending.retarget(moved.copy(deploymentName = "Office Mac")) as Retarget.Moved).identity
        assertEquals(pending.copy(hostUrl = moved.hostUrl, deploymentName = "Office Mac", hostVerified = false), next)
        assertEquals(pending.runnerId, next.runnerId)
        assertEquals(pending.runnerKey, next.runnerKey)
        assertEquals("t".repeat(40), next.enrollmentToken)
        assertEquals(pending.enrollmentId, next.enrollmentId)
        assertFalse(next.enrolled)
        // The new address is confirmed by discovery before the token is spent there.
        assertFalse(next.hostVerified)
        assertEquals(next, PhoneIdentity.fromJson(JsonText.stringify(next.toJson())))
        assertSame(Retarget.Unchanged, pending.retarget(pending.target))
    }

    @Test
    fun leavesAPhoneAtTheAddressItConfirmedAlone() {
        assertSame(Retarget.Unchanged, enrolled.retarget(enrolled.target))
    }

    @Test
    fun movesOnlyTheAddressAndWantsItConfirmedFirst() {
        val next = (enrolled.retarget(moved) as Retarget.Moved).identity
        assertEquals(moved, next.target)
        assertFalse(next.hostVerified)
        assertEquals(enrolled.copy(hostUrl = moved.hostUrl, hostVerified = false), next)
        assertEquals(enrolled.runnerId, next.runnerId)
        assertEquals(4L, next.lastConnectionGeneration)
        // An address it was told to use but has not yet confirmed is looked at again.
        assertEquals(Retarget.Moved(next), next.retarget(moved))
        assertTrue(next.confirmed().hostVerified)
        assertSame(Retarget.Unchanged, next.confirmed().retarget(moved))
        // The confirmation is part of what the phone stores.
        assertEquals(next, PhoneIdentity.fromJson(JsonText.stringify(next.toJson())))
        assertEquals(next.confirmed(), PhoneIdentity.fromJson(JsonText.stringify(next.confirmed().toJson())))
    }

    @Test
    fun keepsARenameAcrossRestartWithoutChangingTheRunnerOrKey() {
        val renamed = enrolled.target.copy(deploymentName = "Office Mac")
        val next = (enrolled.retarget(renamed) as Retarget.Moved).identity
        assertEquals(enrolled.copy(deploymentName = "Office Mac", hostVerified = false), next)
        assertEquals(next, PhoneIdentity.fromJson(JsonText.stringify(next.toJson())))
        assertSame(Retarget.Unchanged, next.confirmed().retarget(renamed))
        val repaired = next.repaired(Pairing(deploymentId, "Living room", "ren_3", "t".repeat(40), "2026-10-11T12:10:00.000Z", hostInstanceId, "https://connect.example", "Pixel"))
        assertEquals("Living room", repaired.deploymentName)
        assertEquals(next.runnerId, repaired.runnerId)
        assertEquals(next.runnerKey, repaired.runnerKey)
    }

    @Test
    fun confirmsTheNewAddressAnswersAsThisDeploymentsHost() {
        serving("""{"authority":{"document":{"deploymentId":"$deploymentId","hostInstanceId":"$hostInstanceId"}}}""") { origin ->
            assertSame(HostDiscovery.Result.Matches, HostDiscovery(OkHttpClient()).check(enrolled.copy(hostUrl = origin, hostVerified = false)))
        }
        serving("""{"authority":{"document":{"deploymentId":"$deploymentId","hostInstanceId":"hst_88888888-8888-4888-8888-888888888888"}}}""") { origin ->
            val result = HostDiscovery(OkHttpClient()).check(enrolled.copy(hostUrl = origin, hostVerified = false))
            assertTrue(result is HostDiscovery.Result.Mismatch)
        }
        serving("""{"authority":{"document":{"deploymentId":5,"hostInstanceId":null}}}""") { origin ->
            assertTrue(HostDiscovery(OkHttpClient()).check(enrolled.copy(hostUrl = origin, hostVerified = false)) is HostDiscovery.Result.Unreachable)
        }
        serving("""<html>a captive portal</html>""") { origin ->
            assertTrue(HostDiscovery(OkHttpClient()).check(enrolled.copy(hostUrl = origin, hostVerified = false)) is HostDiscovery.Result.Unreachable)
        }
        val closed = ServerSocket(0).use { it.localPort }
        val unreachable = HostDiscovery(OkHttpClient()).check(enrolled.copy(hostUrl = "http://127.0.0.1:$closed", hostVerified = false))
        assertTrue(unreachable is HostDiscovery.Result.Unreachable)
    }

    @Test
    fun aWrongServerStopsAnEnrolledPhoneWithoutWipingItAndSilenceIsRetried() {
        val mismatch = ConnectionPolicy(Random(1)).next(AttemptEnd.HostMismatch("another Opensteer"), enrolled = true, deploymentName = "Mac mini")
        assertEquals(Decision.Stop(com.opensteer.agentphone.wire.Issue(IssueCode.HOST_MISMATCH, "another Opensteer"), wipe = false), mismatch)
        val silent = ConnectionPolicy(Random(1)).next(AttemptEnd.Unreachable("connect timed out"), enrolled = true, deploymentName = "Mac mini")
        assertEquals(IssueCode.HOST_UNREACHABLE, (silent as Decision.Retry).issue?.code)
    }

    private fun serving(body: String, use: (String) -> Unit) {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/.well-known/opensteer") { exchange ->
            val bytes = body.toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            use("http://127.0.0.1:${server.address.port}")
        } finally {
            server.stop(0)
        }
    }
}
