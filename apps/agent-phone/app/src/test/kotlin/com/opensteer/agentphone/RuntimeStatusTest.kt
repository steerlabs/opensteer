package com.opensteer.agentphone

import com.opensteer.agentphone.control.ActiveSession
import com.opensteer.agentphone.runner.PhoneIdentity
import com.opensteer.agentphone.wire.ConnectionState
import com.opensteer.agentphone.wire.HostTarget
import com.opensteer.agentphone.wire.Issue
import com.opensteer.agentphone.wire.IssueCode
import com.opensteer.agentphone.wire.Pairing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * A stored RETARGET is not a connected target. Failure modes: an old Online,
 * session or issue report survives a new URL/name/Host; a late old report
 * restores it; rebinding merely relabels Online; old-target link callbacks
 * overwrite Connecting; an unconfirmed same target is already called Online.
 */
class RuntimeStatusTest {
    private val identity = PhoneIdentity.create(
        Pairing(
            "dep_55555555-5555-4555-8555-555555555555", "Mac mini", "ren_1", "t".repeat(40),
            "2026-10-11T12:10:00.000Z", "hst_66666666-6666-4666-8666-666666666666",
            "https://connect.example", "Pixel",
        ),
    ).confirmed().welcomed(4)
    private val online = RuntimeReport(
        link = RuntimeLink(identity.key, identity.target, ConnectionState.ONLINE, issue = null),
        session = ActiveSession("cus_44444444-4444-4444-8444-444444444444", "run_55555555-5555-4555-8555-555555555555", "Reply to messages"),
    )

    private fun RuntimeReport.with(target: HostTarget? = link.target, connection: ConnectionState = link.connection, issue: Issue? = link.issue) =
        copy(link = link.copy(target = target, connection = connection, issue = issue))

    @Test
    fun rejectsAnOldTargetsWholeReportIncludingALatePublication() {
        assertSame(online, online.forIdentity(identity))
        val variants = listOf(
            identity.copy(hostUrl = "https://unreachable.example", hostVerified = false),
            identity.copy(deploymentName = "Office Mac", hostVerified = false),
            identity.copy(hostInstanceId = "hst_77777777-7777-4777-8777-777777777777", hostVerified = false),
        )
        for (current in variants) {
            assertNull(online.forIdentity(current))
            val oldFailure = online.with(connection = ConnectionState.OFFLINE, issue = Issue(IssueCode.HOST_UNREACHABLE, "Old address failed"))
            assertNull(oldFailure.forIdentity(current))
            val connecting = online.with(target = current.target, connection = ConnectionState.CONNECTING)
            assertSame(connecting, connecting.forIdentity(current))
            // A publication arriving after Connecting still cannot qualify as current.
            assertNull(online.forIdentity(current))
        }
    }

    @Test
    fun neverCallsAnUnconfirmedStoredTargetOnline() {
        assertNull(online.forIdentity(identity.copy(hostVerified = false)))
        val pending = online.with(connection = ConnectionState.CONNECTING)
        assertSame(pending, pending.forIdentity(identity.copy(hostVerified = false)))
        assertSame(online, online.forIdentity(identity))
    }

    @Test
    fun refusesReportsForAnOldEnrollmentOrNoStoredIdentity() {
        assertNull(online.forIdentity(identity.copy(enrollmentId = "ren_2")))
        assertNull(online.forIdentity(null))
    }

    @Test
    fun rebindingResetsOnlineBeforeAnyNewConnectionCallback() {
        val oldIssue = Issue(IssueCode.HOST_UNREACHABLE, "Old address failed")
        val old = RuntimeLink().useIdentity(identity).changed(identity.target, ConnectionState.ONLINE, oldIssue)
        val moved = identity.copy(hostUrl = "https://unreachable.example", hostVerified = false)
        val bound = old.useIdentity(moved)
        assertEquals(moved.target, bound.target)
        assertEquals(ConnectionState.CONNECTING, bound.connection)
        assertNull(bound.issue)
        assertSame(bound, bound.changed(identity.target, ConnectionState.ONLINE, null))
        val failed = bound.changed(moved.target, ConnectionState.OFFLINE, Issue(IssueCode.HOST_UNREACHABLE, "New address failed"))
        assertEquals(ConnectionState.OFFLINE, failed.connection)
        assertEquals("New address failed", failed.issue?.detail)
        assertSame(failed, failed.changed(identity.target, ConnectionState.ONLINE, null))
        assertEquals(ConnectionState.ONLINE, failed.changed(moved.target, ConnectionState.ONLINE, null).connection)
    }

    @Test
    fun aRenameAlsoStartsConnectingInsteadOfRelabelingOldOnline() {
        val old = RuntimeLink().useIdentity(identity).changed(identity.target, ConnectionState.ONLINE, null)
        val renamed = identity.copy(deploymentName = "Office Mac", hostVerified = false)
        val bound = old.useIdentity(renamed)
        assertEquals(ConnectionState.CONNECTING, bound.connection)
        assertEquals("Office Mac", bound.target?.deploymentName)
        assertSame(bound, bound.changed(identity.target, ConnectionState.ONLINE, null))
        assertSame(bound, bound.useIdentity(renamed.confirmed()))
    }
}
