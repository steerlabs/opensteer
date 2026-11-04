package com.opensteer.agentphone.update

import android.content.SharedPreferences
import com.opensteer.agentphone.runner.PhoneIdentity
import com.opensteer.agentphone.wire.Pairing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.lang.reflect.Proxy

class UpdateJournalTest {
    private val values = mutableMapOf<String, Any?>()
    private val edits = mutableMapOf<String, Any?>()
    private val editor = Proxy.newProxyInstance(SharedPreferences.Editor::class.java.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { proxy, method, args ->
        when {
            method.name.startsWith("put") -> { edits[args!![0] as String] = args[1]; proxy }
            method.name == "remove" -> { edits[args!![0] as String] = null; proxy }
            method.name == "commit" -> { edits.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }; edits.clear(); true }
            else -> error("Unexpected editor operation ${method.name}")
        }
    } as SharedPreferences.Editor
    private val preferences = Proxy.newProxyInstance(SharedPreferences::class.java.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
        when (method.name) {
            "edit" -> editor
            "getString", "getInt", "getLong", "getBoolean" -> values[args!![0]] ?: args[1]
            else -> error("Unexpected preferences operation ${method.name}")
        }
    } as SharedPreferences
    private val sessions = mutableSetOf(7)
    private val journal = UpdateJournal(preferences) { it in sessions }
    private val identity = PhoneIdentity.create(Pairing(
        "dep_55555555-5555-4555-8555-555555555555", "Mac mini", "ren_1", "t".repeat(40),
        "2026-10-11T12:10:00.000Z", "hst_66666666-6666-4666-8666-666666666666", "https://connect.example", "Pixel",
    )).confirmed().welcomed(4)
    private val offer = UpdateOffer("a".repeat(64), 100, 123, "0.0.123", 30, "b".repeat(64))

    private fun pending(state: String) {
        journal.begin(identity, offer)
        values["state"] = state
        values["sessionId"] = 7
    }

    @Test
    fun compatibleAdmissionClearsConsentBeforeAbandonAndIgnoresLateResultsWithoutLosingFailures() {
        journal.begin(identity, offer)
        pending("awaiting-user")
        var notificationsCancelled = 0
        var abandoned = 0
        journal.clearObsoleteConsent(abandon = { session ->
            assertNull(values["sessionId"])
            assertEquals("idle", journal.state())
            abandoned = session
            journal.result(session) { fail("late Android result must be fenced") }
        }, cancelNotification = { notificationsCancelled++ })
        assertEquals(7, abandoned)
        assertEquals(1, notificationsCancelled)
        assertEquals(2, values["attempts"])
        journal.result(7) { fail("late consent or failure must be ignored") }
        assertFalse(journal.takeCancelled(identity))
    }

    @Test
    fun compatibleAdmissionLetsAnActiveInstallFinishButDropsItsLaterConsentRequestUntilRequiredAgain() {
        pending("installing")
        journal.clearObsoleteConsent({ fail("active install abandoned") }, { fail("active install notification cancelled") })
        assertEquals(7, values["sessionId"])
        journal.required()
        assertFalse("a new refusal makes the retained install necessary again", journal.dropObsoletePrompt { fail("required consent dropped") })
        journal.clearObsoleteConsent({ fail("active install abandoned") }, {})
        var abandoned = -1
        assertTrue(journal.dropObsoletePrompt { abandoned = it })
        assertEquals(7, abandoned)
        assertEquals("idle", journal.state())
        assertNull(values["sessionId"])
        assertFalse(journal.dropObsoletePrompt { fail("dropped twice") })
    }

    @Test
    fun compatibleAdmissionClearsConsentBegunAtAnEarlierAddress() {
        // Setup retargeted the phone to another address of the same Deployment while consent was pending.
        pending("awaiting-user")
        values["scope"] = "${identity.runnerId} https://old-route.example ${offer.sha256}"
        var abandoned = -1
        journal.clearObsoleteConsent({ abandoned = it }, {})
        assertEquals(7, abandoned)
        assertEquals("idle", journal.state())
        assertNull(values["sessionId"])
    }

    @Test
    fun requiredPendingSessionSurvivesAChangedOffer() {
        for (state in listOf("installing", "awaiting-user")) {
            values.clear()
            pending(state)
            journal.begin(identity, offer.copy(sha256 = "c".repeat(64), versionCode = 124))
            assertEquals(state, journal.pendingState(identity))
            assertEquals(offer.sha256, values["sha256"])
            assertEquals(7, values["sessionId"])
            assertEquals(1, values["attempts"])
        }
    }

    @Test
    fun requiredCancellationDecrementsOnceAndThreeGenuineFailuresHalt() {
        pending("awaiting-user")
        journal.result(7) { journal.cancelled() }
        journal.result(7) { journal.cancelled() }
        assertEquals(0, values["attempts"])
        assertTrue(journal.takeCancelled(identity))
        assertFalse(journal.takeCancelled(identity))
        repeat(3) { journal.begin(identity, offer); values["state"] = "failed" }
        assertEquals(3, values["attempts"])
        assertThrows(IllegalStateException::class.java) { journal.begin(identity, offer) }
    }

    @Test
    fun aNewAttemptWaitsForAnAndroidResultAlreadyBeingRecorded() {
        pending("awaiting-user")
        val next = offer.copy(sha256 = "c".repeat(64), versionCode = 124)
        lateinit var attempt: Thread
        journal.result(7) {
            // Android removed the finished session, so the connection sees nothing pending and begins again.
            sessions.clear()
            attempt = Thread { journal.begin(identity, next) }.apply { start() }
            val deadline = System.nanoTime() + 5_000_000_000
            while (attempt.state != Thread.State.BLOCKED) {
                assertTrue("the new attempt never waited for the result being recorded", attempt.isAlive && System.nanoTime() < deadline)
                Thread.onSpinWait()
            }
            assertEquals(offer.sha256, values["sha256"])
            journal.cancelled()
        }
        attempt.join(5_000)
        assertFalse("the new attempt never finished", attempt.isAlive)
        assertEquals("downloading", journal.state())
        assertEquals(next.sha256, values["sha256"])
        assertEquals(1, values["attempts"])
    }
}
