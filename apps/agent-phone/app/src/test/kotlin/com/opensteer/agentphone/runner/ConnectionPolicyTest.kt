package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.Issue
import com.opensteer.agentphone.wire.IssueCode
import com.opensteer.agentphone.wire.ProtocolError
import com.opensteer.agentphone.wire.RunnerFence
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/**
 * How the phone decides what a lost or refused connection means, and how it
 * keeps time with its Host. Failure modes, each a phone that is stuck, noisy
 * or wrong about its own state:
 *
 * 1. a revocation (close 4010, or the revoked reason) retried instead of
 *    wiping the identity and stopping;
 * 2. an expired enrollment token retried until the end of time;
 * 3. Personal remote access called off without the Host saying so — by
 *    counting 1001 closes for minutes — or the Host's explicit reason ignored;
 * 4. a refusal whose reason this phone has no rule for losing the Host's words;
 * 5. backoff without jitter or cap; reset by a welcome alone, so a Host that
 *    welcomes and then fails the same way is reconnected to twice a second;
 *    or not reset after a connection that worked, so a Host restart is
 *    waited out slowly; or carried over to a new identity or target;
 * 6. one unreadable frame called a protocol error, or frames that stay
 *    unreadable across reconnects — in the handshake or on the stream after a
 *    welcome — shown as a generic failure forever, or a run broken by another
 *    kind of ending still counted, or the status decided by timing rather
 *    than by what happened;
 * 7. the protocol error cleared by the next attempt's "connecting" before
 *    STATUS, the notification or the app can show it;
 * 8. heartbeats not strictly increasing, or stamped by the phone's own clock;
 * 9. a lease lengthened by the time a frame waited in the inbox, or lengthened
 *    or shortened by a change of the phone's wall clock;
 * 10. a lease that ran out locally still stamping frames, or a frame for
 *    another connection accepted.
 */
class ConnectionPolicyTest {
    private val name = "Mac mini"

    private fun refused(reason: String?, retryable: Boolean = false, message: String = "No") =
        AttemptEnd.Refused(ProtocolError("forbidden", message, reason, retryable))

    private fun violation() = AttemptEnd.Violation("The Host sent a frame this phone cannot read: host.extra")

    @Test
    fun revocationWipesAndStops() {
        val policy = ConnectionPolicy(Random(1))
        for (end in listOf(AttemptEnd.Closed(4010, afterWelcome = true), refused("runner-identity-revoked"))) {
            val decision = policy.next(end, enrolled = true, deploymentName = name) as Decision.Stop
            assertTrue(decision.wipe)
            assertEquals(IssueCode.REMOVED, decision.issue.code)
        }
    }

    @Test
    fun anExpiredTokenStopsPairingWithItsOwnIssue() {
        val decision = ConnectionPolicy(Random(1)).next(refused("runner-enrollment-expired"), enrolled = false, deploymentName = name)
        assertEquals(IssueCode.ENROLLMENT_EXPIRED, (decision as Decision.Stop).issue.code)
        assertFalse(decision.wipe)
    }

    @Test
    fun aFinalRefusalStopsPairingButAnEnrolledPhoneKeepsTryingSlowly() {
        val pairing = ConnectionPolicy(Random(1)).next(refused(null), enrolled = false, deploymentName = name)
        assertEquals(IssueCode.ENROLLMENT_REFUSED, (pairing as Decision.Stop).issue.code)
        val enrolled = ConnectionPolicy(Random(1)).next(refused(null), enrolled = true, deploymentName = name) as Decision.Retry
        assertEquals(IssueCode.ENROLLMENT_REFUSED, enrolled.issue?.code)
        assertEquals(ConnectionPolicy.UNRECOGNIZED_CEILING_MS, enrolled.ceilingMs)
        val transient = ConnectionPolicy(Random(1)).next(refused(null, retryable = true), enrolled = false, deploymentName = name)
        assertTrue(transient is Decision.Retry)
    }

    @Test
    fun aRefusalWithAReasonThisPhoneHasNoRuleForIsToldInTheHostsWords() {
        val words = "This Opensteer no longer accepts this version of the phone app."
        val decision = ConnectionPolicy(Random(1))
            .next(refused("runner-version-unsupported", message = words), enrolled = true, deploymentName = name) as Decision.Retry
        assertEquals(Issue(IssueCode.ENROLLMENT_REFUSED, words), decision.issue)
    }

    @Test
    fun remoteAccessIsOffOnlyWhenTheHostSaysSo() {
        val direct = ConnectionPolicy(Random(1)).next(refused("personal-remote-access-off", retryable = true), enrolled = true, deploymentName = name)
        assertEquals(IssueCode.REMOTE_ACCESS_OFF, (direct as Decision.Retry).issue?.code)

        // A Host restart sends a working connection away with 1001; the phone just comes back.
        val policy = ConnectionPolicy(Random(1))
        val restart = policy.next(AttemptEnd.Closed(1001, afterWelcome = true, renewed = true), enrolled = true, deploymentName = name) as Decision.Retry
        assertNull(restart.issue)
        // However long the Host keeps closing before letting the phone in, that is all it says.
        repeat(20) {
            val closed = policy.next(AttemptEnd.Closed(1001, afterWelcome = false), enrolled = true, deploymentName = name) as Decision.Retry
            assertEquals(IssueCode.HOST_UNREACHABLE, closed.issue?.code)
            assertTrue(closed.issue!!.detail.contains("Opensteer on $name"))
        }
    }

    @Test
    fun anUnreachableHostAndAMismatchedHostAreDifferentThings() {
        val unreachable = ConnectionPolicy(Random(1)).next(AttemptEnd.Unreachable("DNS failed"), enrolled = false, deploymentName = name)
        assertEquals(IssueCode.HOST_UNREACHABLE, (unreachable as Decision.Retry).issue?.code)
        assertTrue(unreachable.issue!!.detail.contains("Opensteer on $name"))
        val mismatch = ConnectionPolicy(Random(1)).next(AttemptEnd.HostMismatch("another Deployment"), enrolled = false, deploymentName = name)
        assertEquals(IssueCode.HOST_MISMATCH, (mismatch as Decision.Stop).issue.code)
    }

    @Test
    fun aProtocolErrorIsConsecutiveAttemptsEndingInAViolation() {
        val policy = ConnectionPolicy(Random(1))
        assertNull(policy.standing(name))
        val first = policy.next(violation(), enrolled = true, deploymentName = name) as Decision.Retry
        assertEquals(IssueCode.FAILED, first.issue?.code)
        assertNull(policy.standing(name))
        val second = policy.next(violation(), enrolled = true, deploymentName = name) as Decision.Retry
        val expected = Issue(
            IssueCode.PROTOCOL_ERROR,
            "This phone and Opensteer on Mac mini could not understand each other. Adding the phone again over USB installs the app this Opensteer carries.",
        )
        assertEquals(expected, second.issue)
        // It stands while the phone reconnects, so the next "connecting" does not hide it.
        assertEquals(expected, policy.standing(name))
        assertEquals(expected, (policy.next(violation(), enrolled = true, deploymentName = name) as Decision.Retry).issue)

        // Another kind of ending breaks the run.
        policy.next(AttemptEnd.Unreachable("down"), enrolled = true, deploymentName = name)
        assertNull(policy.standing(name))
        assertEquals(IssueCode.FAILED, (policy.next(violation(), enrolled = true, deploymentName = name) as Decision.Retry).issue?.code)
    }

    @Test
    fun violationsAfterEachWelcomeKeepCountingAndKeepBackingOff() {
        val policy = ConnectionPolicy(Random(1))
        val first = policy.next(violation(), enrolled = true, deploymentName = name) as Decision.Retry
        val second = policy.next(violation(), enrolled = true, deploymentName = name) as Decision.Retry
        val third = policy.next(violation(), enrolled = true, deploymentName = name) as Decision.Retry
        assertEquals(listOf(IssueCode.FAILED, IssueCode.PROTOCOL_ERROR, IssueCode.PROTOCOL_ERROR), listOf(first, second, third).map { it.issue?.code })
        assertEquals(listOf(1_000L, 2_000L, 4_000L), listOf(first, second, third).map { it.ceilingMs })
    }

    @Test
    fun aViolationANormalCloseAndAViolationAreNoProtocolError() {
        val policy = ConnectionPolicy(Random(1))
        policy.next(violation(), enrolled = true, deploymentName = name)
        val close = AttemptEnd.Closed(1000, afterWelcome = true, renewed = true)
        assertNull((policy.next(close, enrolled = true, deploymentName = name) as Decision.Retry).issue)
        val after = policy.next(violation(), enrolled = true, deploymentName = name) as Decision.Retry
        assertEquals(IssueCode.FAILED, after.issue?.code)
        assertNull(policy.standing(name))
    }

    @Test
    fun aNewIdentityOrTargetStartsWithNoneOfTheOldHostsHistory() {
        val policy = ConnectionPolicy(Random(1))
        repeat(5) { policy.next(violation(), enrolled = true, deploymentName = name) }
        policy.reset()
        assertNull(policy.standing(name))
        val fresh = policy.next(AttemptEnd.Unreachable("down"), enrolled = true, deploymentName = "Office Mac") as Decision.Retry
        assertEquals(1_000L, fresh.ceilingMs)
    }

    @Test
    fun backsOffWithJitterUpToAboutThirtySecondsAndResetsOnlyAfterAConnectionThatWorked() {
        val policy = ConnectionPolicy(Random(7))
        val ceilings = (1..9).map {
            (policy.next(AttemptEnd.Unreachable("down"), enrolled = true, deploymentName = name) as Decision.Retry).ceilingMs
        }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L, 30_000L), ceilings)
        // Closed right after a welcome, before the Host ever renewed it: nothing proved it worked.
        val unproven = policy.next(AttemptEnd.Closed(1006, afterWelcome = true), enrolled = true, deploymentName = name) as Decision.Retry
        assertEquals(30_000L, unproven.ceilingMs)
        // Renewed, then lost: it worked, so the next blip starts the backoff over.
        val worked = policy.next(AttemptEnd.Closed(1006, afterWelcome = true, renewed = true), enrolled = true, deploymentName = name) as Decision.Retry
        assertEquals(1_000L, worked.ceilingMs)
        val delays = (1..200).map { policy.delayFor(Decision.Retry(null, 30_000)) }
        assertTrue(delays.all { it in 0 until 30_000 })
        assertTrue(delays.toSet().size > 100)
    }

    /** The phone's two clocks: only the monotonic one may reach the connection. */
    private class PhoneClocks {
        var wall = 1_760_184_000_000L
        var elapsed = 5_000L
    }

    @Test
    fun stampsHeartbeatsInHostTimeAndStrictlyIncreasing() {
        val clocks = PhoneClocks()
        val clock = HostClock { clocks.elapsed }
        val serverTime = 1_760_184_030_000L
        clock.adopt(serverTime, receivedAt = clocks.elapsed)
        assertEquals(serverTime, clock.now())
        val first = clock.heartbeatTimestamp()
        assertEquals(serverTime, first)
        clocks.wall -= 120_000 // the phone's wall clock is set back two minutes
        val second = clock.heartbeatTimestamp()
        assertEquals(first + 1, second)
        clocks.elapsed += 15_000
        assertEquals(serverTime + 15_000, clock.heartbeatTimestamp())
    }

    @Test
    fun aLeaseIsTimedFromReceiptOnTheMonotonicClockWhateverTheWallClockDoes() {
        val clocks = PhoneClocks()
        val clock = HostClock { clocks.elapsed }
        val serverTime = 1_760_184_000_000L
        // The welcome arrived at 5 s but was handled at 7 s: the two seconds it waited count.
        val receivedAt = clocks.elapsed
        clocks.elapsed += 2_000
        clock.adopt(serverTime, receivedAt)
        val lease = Lease(fence, expiresAt = clock.local(serverTime + 60_000))
        assertEquals(receivedAt + 60_000, lease.expiresAt)

        for (jump in listOf(+3_600_000L, -3_600_000L, +86_400_000L)) {
            clocks.wall += jump
            assertFalse(lease.expired(clocks.elapsed))
            assertEquals(fence, lease.fenceAt(clocks.elapsed))
        }
        clocks.elapsed = receivedAt + 59_999
        assertFalse(lease.expired(clocks.elapsed))
        clocks.elapsed = receivedAt + 60_000
        assertTrue(lease.expired(clocks.elapsed))
        clocks.wall -= 86_400_000L
        assertTrue(lease.expired(clocks.elapsed))
    }

    @Test
    fun refusesToStampFramesOnceTheLeaseRunsOut() {
        val lease = Lease(fence, expiresAt = 10_000)
        assertEquals(fence, lease.fenceAt(now = 9_999))
        lease.renew(20_000)
        lease.renew(15_000) // an older renewal never shortens it
        assertEquals(20_000L, lease.expiresAt)
        assertFalse(lease.expired(now = 19_999))
        assertTrue(lease.expired(now = 20_000))
        assertNull(lease.fenceAt(now = 20_000))
        assertTrue(lease.accepts(fence))
        assertFalse(lease.accepts(fence.copy(connectionGeneration = 2)))
    }

    private val fence = RunnerFence(
        bootId = "rbt_22222222-2222-4222-8222-222222222222",
        connectionGeneration = 1,
        connectionId = "rcn_11111111-1111-4111-8111-111111111111",
        connectionLeaseId = "rls_11111111-1111-4111-8111-111111111111",
        runnerId = "rnr_33333333-3333-4333-8333-333333333333",
    )
}
