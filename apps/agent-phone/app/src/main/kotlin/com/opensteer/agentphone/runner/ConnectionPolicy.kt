package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.Issue
import com.opensteer.agentphone.wire.IssueCode
import com.opensteer.agentphone.wire.ProtocolError
import java.util.Random

/** How one connection attempt ended. */
sealed interface AttemptEnd {
    data class UpdateFailed(val detail: String) : AttemptEnd
    /** The Host said no with a `host.error`, before or after its welcome. */
    data class Refused(val error: ProtocolError) : AttemptEnd

    /**
     * The socket closed with this code. `afterWelcome` when the Host had let
     * the phone in; `renewed` when it had also renewed the connection's lease,
     * which proves the connection worked.
     */
    data class Closed(val code: Int, val afterWelcome: Boolean, val renewed: Boolean = false) : AttemptEnd

    /** Nothing usable answered: DNS, TLS, refused TCP, a timeout, a failed discovery read. */
    data class Unreachable(val detail: String) : AttemptEnd

    /** Something answered at the pairing's address, but it is not that Deployment's Host. */
    data class HostMismatch(val detail: String) : AttemptEnd

    /** The Host broke the protocol: a frame this phone cannot read, or one out of order. */
    data class Violation(val detail: String) : AttemptEnd
}

sealed interface Decision {
    /** Try again after a jittered wait below `ceilingMs`, showing `issue` meanwhile. */
    data class Retry(val issue: Issue?, val ceilingMs: Long) : Decision

    /** Retrying cannot help; wait for the person or setup. `wipe` forgets the identity and keys. */
    data class Stop(val issue: Issue, val wipe: Boolean) : Decision
}

/**
 * What a lost or refused connection means, mirroring the Node Runner
 * (`apps/runner/src/host/host-connection.ts`) and adding what a phone must
 * tell its owner. Revocation (4010, or its reason) ends the phone's identity.
 * A refusal the Host marks with a reason is classified by that reason, never
 * by its wording, and every conclusion rests on what happened, never on how
 * long something lasted: remote access is off only when the Host says so, and
 * the two ends misunderstand each other only when attempt after attempt ends
 * in a frame this phone cannot read, wherever in the attempt it came.
 *
 * Backoff grows with every attempt that fails and starts over only after a
 * connection that worked — one the Host renewed — ends, as the Node Runner's
 * does: a welcome alone proves nothing, so a Host that lets the phone in and
 * then fails the same way is retried at most every `MAX_BACKOFF_MS`.
 */
class ConnectionPolicy(private val random: Random) {
    private var failures = 0
    private var violations = 0

    /** A new identity or target: nothing learned about the previous Host applies to it. */
    fun reset() {
        failures = 0
        violations = 0
    }

    /**
     * The issue an attempt starts under. A protocol error is a conclusion
     * about this phone and its Host rather than about one attempt, so it
     * stands while the phone tries again, until an attempt ends another way.
     */
    fun standing(deploymentName: String): Issue? = if (violations >= PROTOCOL_ERROR_VIOLATIONS) protocolError(deploymentName) else null

    fun next(end: AttemptEnd, enrolled: Boolean, deploymentName: String): Decision {
        failures = if (end is AttemptEnd.Closed && end.renewed) 1 else failures + 1
        // Any other ending — a close, a Host restart, a lost network, a refusal — breaks the run.
        violations = if (end is AttemptEnd.Violation) violations + 1 else 0
        val backoff = minOf(MAX_BACKOFF_MS, 500L shl minOf(failures, 6))
        return when (end) {
            is AttemptEnd.UpdateFailed -> Decision.Stop(Issue(IssueCode.NEEDS_UPDATE, end.detail), wipe = false)
            is AttemptEnd.Refused -> refused(end.error, enrolled, backoff, deploymentName)
            is AttemptEnd.Closed -> when {
                end.code == REVOKED_CLOSE_CODE -> removed()
                // A connection that worked and ended — a Host restart, a network change — is simply made again.
                end.afterWelcome -> Decision.Retry(null, backoff)
                else -> Decision.Retry(unreachable(deploymentName, "The connection closed before this phone was let in."), backoff)
            }
            is AttemptEnd.Unreachable -> Decision.Retry(unreachable(deploymentName, end.detail), backoff)
            is AttemptEnd.HostMismatch -> Decision.Stop(Issue(IssueCode.HOST_MISMATCH, end.detail.take(500)), wipe = false)
            is AttemptEnd.Violation -> Decision.Retry(
                standing(deploymentName) ?: Issue(IssueCode.FAILED, end.detail.take(500).ifEmpty { "Protocol error" }),
                backoff,
            )
        }
    }

    /** A jittered wait in `[0, ceiling)`, so a fleet of phones never retries in step. */
    fun delayFor(retry: Decision.Retry): Long = (random.nextDouble() * retry.ceilingMs).toLong()

    private fun refused(error: ProtocolError, enrolled: Boolean, backoff: Long, deploymentName: String): Decision = when {
        error.reason == REVOKED_REASON -> removed()
        error.reason == "runner-proof-format-mismatch" -> Decision.Stop(Issue(IssueCode.NEEDS_UPDATE, error.message.take(500)), wipe = false)
        error.reason == "agent-phone-outdated" -> Decision.Stop(
            Issue(IssueCode.NEEDS_UPDATE, "Update Agent Phone on this phone. Plug it into a computer and add it again in Opensteer to update it."),
            wipe = false,
        )
        error.reason == ENROLLMENT_EXPIRED_REASON -> Decision.Stop(
            Issue(IssueCode.ENROLLMENT_EXPIRED, "The setup code expired before this phone could use it. Run setup again."),
            wipe = false,
        )
        error.reason == REMOTE_ACCESS_OFF_REASON -> Decision.Retry(
            Issue(IssueCode.REMOTE_ACCESS_OFF, "Remote access is off in Opensteer on $deploymentName. Turn it on there to reach this phone."),
            backoff,
        )
        error.retryable -> Decision.Retry(Issue(IssueCode.FAILED, error.message.take(500)), backoff)
        // A refused enrollment token is final for that token.
        !enrolled -> Decision.Stop(Issue(IssueCode.ENROLLMENT_REFUSED, error.message.take(500)), wipe = false)
        // A reason this phone has no rule for — a version the Host no longer
        // accepts, say — is the Host's to explain, so its words are shown.
        error.reason != null -> Decision.Retry(Issue(IssueCode.ENROLLMENT_REFUSED, error.message.take(500)), UNRECOGNIZED_CEILING_MS)
        // The Host does not recognize an identity it once welcomed: most often
        // a reset database. No token can fix that from here, so the phone keeps
        // asking slowly, as the Node Runner does, and says what would help.
        else -> Decision.Retry(
            Issue(IssueCode.ENROLLMENT_REFUSED, "Opensteer no longer recognizes this phone. Remove it and set it up again."),
            UNRECOGNIZED_CEILING_MS,
        )
    }

    private fun removed() = Decision.Stop(Issue(IssueCode.REMOVED, REMOVED_DETAIL), wipe = true)

    private fun unreachable(deploymentName: String, detail: String) =
        Issue(IssueCode.HOST_UNREACHABLE, "This phone cannot reach Opensteer on $deploymentName. $detail".take(500))

    companion object {
        const val REVOKED_CLOSE_CODE = 4010
        const val REVOKED_REASON = "runner-identity-revoked"
        const val ENROLLMENT_EXPIRED_REASON = "runner-enrollment-expired"
        const val REMOTE_ACCESS_OFF_REASON = "personal-remote-access-off"
        const val MAX_BACKOFF_MS = 30_000L
        const val UNRECOGNIZED_CEILING_MS = 120_000L

        /** One unreadable frame can be a fluke; attempts ending in one twice running is how this pair behaves. */
        const val PROTOCOL_ERROR_VIOLATIONS = 2

        /** The fact behind `removed`, beside a state that already says "Removed from Opensteer". */
        const val REMOVED_DETAIL = "This phone's identity and keys were erased."

        /** Neutral on purpose: an unreadable frame does not say which of the two is out of date. */
        fun protocolError(deploymentName: String) = Issue(
            IssueCode.PROTOCOL_ERROR,
            "This phone and Opensteer on $deploymentName could not understand each other. " +
                "Adding the phone again over USB installs the app this Opensteer carries.",
        )
    }
}

/**
 * The Host's clock as this phone can know it: the Host's `serverTime` at a
 * welcome, carried forward on the phone's monotonic clock from the moment that
 * welcome arrived. Leases and heartbeats are judged by the Host's clock, so
 * they are stamped and checked by it here; the phone's wall clock never enters,
 * so setting it, or its being minutes off, changes nothing.
 */
class HostClock(private val elapsed: () -> Long) {
    @Volatile
    private var offset = 0L
    private var lastHeartbeat = 0L

    /** `receivedAt` is when the welcome's frame arrived, so the time it waited to be read counts. */
    fun adopt(serverTime: Long, receivedAt: Long) {
        offset = serverTime - receivedAt
        lastHeartbeat = 0
    }

    fun now(): Long = host(elapsed())

    /** The Host time of a frame's local arrival or deadline, including time already queued. */
    fun host(localTime: Long): Long = localTime + offset

    /** Where a Host time falls on the monotonic clock. */
    fun local(hostTime: Long): Long = hostTime - offset

    /** Strictly increasing: two heartbeats in one millisecond would read as a replay. */
    @Synchronized
    fun heartbeatTimestamp(): Long {
        val sentAt = maxOf(now(), lastHeartbeat + 1)
        lastHeartbeat = sentAt
        return sentAt
    }
}

/** One connection's fence and lease, on the monotonic clock: a frame is stamped only while both hold. */
class Lease<F>(private val fence: F, expiresAt: Long) {
    var expiresAt: Long = expiresAt
        private set

    /** Renewals can arrive out of order; one never shortens the lease. */
    fun renew(until: Long) {
        expiresAt = maxOf(expiresAt, until)
    }

    fun expired(now: Long): Boolean = expiresAt <= now

    /** The fence to stamp a frame with, or null once the lease has run out. */
    fun fenceAt(now: Long): F? = if (expired(now)) null else fence

    fun accepts(other: F): Boolean = other == fence
}
