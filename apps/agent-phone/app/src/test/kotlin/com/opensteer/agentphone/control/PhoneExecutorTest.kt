package com.opensteer.agentphone.control

import com.opensteer.agentphone.runner.PhoneCall
import com.opensteer.agentphone.runner.PhoneOperations
import com.opensteer.agentphone.runner.PhoneRequest
import com.opensteer.agentphone.runner.PhoneWork
import com.opensteer.agentphone.wire.ActParams
import com.opensteer.agentphone.wire.ComputerUseOutcome
import com.opensteer.agentphone.wire.DisplayState
import com.opensteer.agentphone.wire.Foreground
import com.opensteer.agentphone.wire.InstalledAppsParams
import com.opensteer.agentphone.wire.JsonArray
import com.opensteer.agentphone.wire.JsonNull
import com.opensteer.agentphone.wire.JsonObject
import com.opensteer.agentphone.wire.JsonString
import com.opensteer.agentphone.wire.Navigation
import com.opensteer.agentphone.wire.PhoneAction
import com.opensteer.agentphone.wire.PhoneTarget
import com.opensteer.agentphone.wire.PixelSize
import com.opensteer.agentphone.wire.ScreenshotOutcome
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cancellation and deadline failures, specified before changing the executor:
 * 1. A received close sits behind a long wait, letting later actions run;
 *    work already queued for that same session can reopen its hold.
 * 2. A late close for an old session cancels the new holder or drops its hold.
 * 3. Stopping interrupts an already-dispatched gesture, loses its completed
 *    progress, calls the partial batch certain, or shares a fresh observation.
 * 4. Request cancellation or stream teardown waits out the full delay and
 *    leaves later actions able to run.
 * 5. A close for one queued session cancels another session's earlier work.
 * 6. A local Stop for an old session stops the next holder, or its cleanup
 *    clears that new holder; queued work for the stopped session still runs.
 * 7. Work whose deadline passed before it started runs anyway, or is answered
 *    as busy or as an unknown outcome; time spent queued does not count.
 * 8. An expired or cancelled close is refused like other work and leaves its
 *    session holding the phone.
 * 9. Listing apps waits behind a batch, or claims a session.
 * 10. An exception that is not a RuntimeException ends the executor thread,
 *     and with it the app, instead of answering the request.
 * 11. Work queued behind a long batch is answered only when its turn comes,
 *     after the Host has stopped waiting, rather than at its own deadline; or
 *     it is answered at the deadline and then runs anyway.
 * 12. The deadline and the work reaching the call at the same moment answer
 *     it twice, or not at all; a queued call the Host cancelled is answered
 *     again when its deadline passes.
 * 13. A listing queued behind a capture on the reads thread waits past its
 *     deadline the same way.
 * 14. Pause is read live, so a pause and resume during a wait lets the rest
 *     of the batch run, and queued work runs after it.
 * 15. A close waits its turn behind another session's batch, answered after
 *     the Host stopped waiting; or, answered early, leaves its session usable.
 * 16. A Run its owner stopped is served again after the session ends.
 * 17. A Stop or Pause accepted while its session holds the phone goes
 *     unreported because cleanup queued earlier ended the session first; or
 *     it is reported twice, or for the wrong Run or session.
 * 18. An identity replacement installs a new module while the old holder's
 *     cleanup waits behind a gesture, routing an accepted Stop or Pause to
 *     the new module instead of its originating module.
 * 19. A different owner's rejected observe overwrites the holder's reporter,
 *     or late old-owner release/Close cancels or ends the new owner's hold.
 */
class PhoneExecutorTest {
    private class WaitingDevice : Device {
        val waiting = CountDownLatch(1)
        var gestureStarted = CountDownLatch(1)
        var finishGesture = CountDownLatch(1)
        var blockGesture = false
        var broken = false
        val did = CopyOnWriteArrayList<String>()

        override fun display(): DisplayState {
            if (broken) throw IOException("The accessibility connection is gone")
            return DisplayState(1080, 2400, 0, interactive = true, locked = false, secureLock = false)
        }
        override fun foreground() = Foreground("com.example.app", "Example")
        override fun walk(limit: Int, budget: Budget) = Walk(emptyList(), omitted = 0)
        /** Set to hold the reads thread inside a capture until the test opens it. */
        @Volatile
        var screenshotGate: CountDownLatch? = null

        @Volatile
        var screenshotEntered = CountDownLatch(1)

        override fun screenshot(size: PixelSize, maxBase64Length: Int, budget: Budget): ScreenshotOutcome {
            screenshotEntered.countDown()
            screenshotGate?.let { assertTrue(it.await(2, TimeUnit.SECONDS)) }
            return ScreenshotOutcome.Failed
        }
        override fun resolve(ref: ElementRef): LiveElement? = null
        override fun focusedInput(): LiveElement? = null
        override fun tap(point: DisplayPoint, count: Int, budget: Budget, admit: () -> Unit): Effect {
            admit()
            gestureStarted.countDown()
            if (blockGesture) assertTrue(finishGesture.await(2, TimeUnit.SECONDS))
            did += "tap"
            return Effect.DONE
        }
        override fun press(point: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit) = admit().let { Effect.FAILED }
        override fun swipe(from: DisplayPoint, to: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit) = admit().let { Effect.FAILED }
        override fun touchDown(point: DisplayPoint, holdMs: Int, budget: Budget, admit: () -> Unit): Contact? = admit().let { null }
        override fun move(contact: Contact, to: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit) = admit().let { Effect.FAILED }
        override fun lift(contact: Contact) = Unit
        override fun focus(element: LiveElement, admit: () -> Unit) = admit().let { false }
        override fun setText(element: LiveElement, text: String, admit: () -> Unit) = admit().let { false }
        override fun setSelection(element: LiveElement, start: Int, end: Int, admit: () -> Unit) = admit().let { false }
        override fun imeEnter(element: LiveElement, admit: () -> Unit) = admit().let { false }
        override fun navigate(to: Navigation, admit: () -> Unit) = admit().let { false }
        override fun launchable(packageName: String): Launchable? = null
        override fun start(app: Launchable, admit: () -> Unit) = admit().let { false }
        override fun wake(budget: Budget, admit: () -> Unit) = admit().let { Effect.FAILED }
        override fun pause(ms: Long) {
            waiting.countDown()
            Thread.sleep(ms)
        }
        override fun launcherEntries() = listOf(LauncherEntry("com.example.mail", "Mail"))
    }

    private data class Pending(
        val work: PhoneWork,
        val result: CompletableFuture<ComputerUseOutcome>,
        /** Every answer the executor gave, which must be exactly one. */
        val answers: AtomicInteger,
    )

    /** Alarms on the phone's monotonic clock that fire only when the test says the time has come. */
    private class TestAlarms : AlarmClock {
        private val set = ArrayList<Pair<Long, () -> Unit>>()

        @Synchronized
        override fun at(time: Long, action: () -> Unit): Alarm {
            val entry = time to action
            set += entry
            return Alarm { synchronized(this) { set.remove(entry) } }
        }

        /** Runs, on the calling thread, every alarm due by `time`. */
        fun reach(time: Long) {
            val due = synchronized(this) { set.filter { it.first <= time }.also { set.removeAll(it.toSet()) } }
            due.forEach { it.second() }
        }

        @Synchronized
        fun pending() = set.size
    }

    private val device = WaitingDevice()

    /** The phone's monotonic clock, which only the test moves. */
    @Volatile
    private var now = 1_000_000L
    private var observationIds = 0
    private var requestIds = 0
    private val desk = PhoneDesk(
        device,
        wallClock = { 1_760_184_000_000L },
        mintObservationId = { "obs_${++observationIds}" },
        // The identities' modules refuse what their owners stopped.
        refused = { it in refusedRuns },
    )
    private val refusedRuns: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val alarms = TestAlarms()
    private val executor = PhoneExecutor(desk, elapsed = { now }, alarms = alarms, post = { it() }, log = {})
    private val stopped = CopyOnWriteArrayList<ActiveSession>()
    private val operations = executor.forOwner { stopped += it; refusedRuns += it.runId }
    private val a = "cus_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val b = "cus_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private val tap = PhoneAction.Tap(PhoneTarget.Point(100, 100), 1)

    @After
    fun shutdown() {
        device.finishGesture.countDown()
        executor.shutdown()
    }

    private fun runOf(session: String) = "run_" + session.removePrefix("cus_")

    private fun submit(session: String, request: PhoneRequest, deadline: Long = now + 60_000, run: String = runOf(session), owner: PhoneOperations = operations): Pending {
        val result = CompletableFuture<ComputerUseOutcome>()
        val answers = AtomicInteger()
        val work = owner.run(PhoneCall("request_${++requestIds}", session, run, session, request, deadline)) {
            answers.incrementAndGet()
            result.complete(it)
        }
        return Pending(work, result, answers)
    }

    /** Waits until both threads have worked through everything queued before now. */
    private fun drain() {
        submit(a, PhoneRequest.Close).done()
        submit(b, PhoneRequest.InstalledApps(InstalledAppsParams("", 1, 0))).done()
    }

    private fun Pending.done(): ComputerUseOutcome = result.get(2, TimeUnit.SECONDS)
    private fun ComputerUseOutcome.value() = (this as ComputerUseOutcome.Ok).value as JsonObject
    private fun ComputerUseOutcome.failure() = this as ComputerUseOutcome.Failure
    private fun JsonObject.string(key: String) = (fields.getValue(key) as JsonString).value
    private fun observe(session: String): String =
        (submit(session, PhoneRequest.Observe(includeScreenshot = false)).done().value().fields.getValue("observation") as JsonObject)
            .string("observationId")

    private fun act(session: String, observation: String, vararg actions: PhoneAction) =
        submit(session, PhoneRequest.Act(ActParams(observation, actions.toList(), includeScreenshot = false)))

    private fun assertCancelled(result: ComputerUseOutcome, completed: Int, code: String = "outcome-unknown") {
        val value = result.value()
        assertEquals(code, (value.fields.getValue("error") as JsonObject).string("code"))
        assertEquals(completed, (value.fields.getValue("performed") as JsonArray).items.size)
        assertEquals(JsonNull, value.fields.getValue("observation"))
    }

    private fun assertExpired(result: ComputerUseOutcome) {
        assertEquals("failed", result.failure().code.wire)
        assertEquals("The request expired before it ran.", result.failure().message)
    }

    @Test
    fun closeCancelsAnActiveWaitAndEveryQueuedCallForItsSession() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val queuedObserve = submit(a, PhoneRequest.Observe(includeScreenshot = false))
        val closing = submit(a, PhoneRequest.Close)
        assertCancelled(acting.done(), completed = 0)
        assertTrue(queuedObserve.done() is ComputerUseOutcome.Failure)
        assertTrue(closing.done() is ComputerUseOutcome.Ok)
        drain()
        assertEquals(null, desk.activeSession)
        assertTrue(device.did.isEmpty())
        observe(b)
        assertEquals(b, desk.activeSession?.id)
    }

    @Test
    fun lateCloseForAnOldSessionDoesNotCancelTheNewHoldersWait() {
        observe(a)
        submit(a, PhoneRequest.Close).done()
        val observation = observe(b)
        val acting = act(b, observation, PhoneAction.Wait(300), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val oldClose = submit(a, PhoneRequest.Close)
        val result = acting.done().value()
        assertEquals(JsonNull, result.fields.getValue("error"))
        assertEquals(2, (result.fields.getValue("performed") as JsonArray).items.size)
        assertTrue(oldClose.done() is ComputerUseOutcome.Ok)
        assertEquals(listOf("tap"), device.did.toList())
        assertEquals(b, desk.activeSession?.id)
    }

    @Test
    fun closeWaitsForADispatchedGestureButStopsEveryLaterAction() {
        device.blockGesture = true
        val observation = observe(a)
        val acting = act(a, observation, tap, PhoneAction.Wait(5_000), tap)
        assertTrue(device.gestureStarted.await(2, TimeUnit.SECONDS))
        val closing = submit(a, PhoneRequest.Close)
        // Answered at once; the gesture already on the screen still finishes.
        assertTrue(closing.done() is ComputerUseOutcome.Ok)
        assertFalse(acting.result.isDone)
        device.finishGesture.countDown()
        assertCancelled(acting.done(), completed = 1)
        assertEquals(listOf("tap"), device.did.toList())
    }

    @Test
    fun cancellingTheRequestEndsItsWaitWithoutDispatchingTheNextGesture() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        acting.work.cancel()
        assertCancelled(acting.done(), completed = 0)
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun streamTeardownCancelsTheBatchBeforeReleasingItsHolder() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        operations.releaseSessions()
        assertCancelled(acting.done(), completed = 0)
        observe(b)
        assertEquals(b, desk.activeSession?.id)
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun closingAQueuedSessionLeavesTheOtherHoldersEarlierBatchAlone() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(300), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val queuedObserve = submit(b, PhoneRequest.Observe(includeScreenshot = false))
        val closing = submit(b, PhoneRequest.Close)
        assertEquals(JsonNull, acting.done().value().fields.getValue("error"))
        assertTrue(queuedObserve.done() is ComputerUseOutcome.Failure)
        assertTrue(closing.done() is ComputerUseOutcome.Ok)
        assertEquals(a, desk.activeSession?.id)
        assertEquals(listOf("tap"), device.did.toList())
    }

    @Test
    fun staleLocalStopDoesNotCancelOrClearTheNewHolder() {
        observe(a)
        submit(a, PhoneRequest.Close).done()
        val observation = observe(b)
        val acting = act(b, observation, PhoneAction.Wait(300), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        executor.stopSession(a)
        assertEquals(JsonNull, acting.done().value().fields.getValue("error"))
        submit(b, PhoneRequest.Observe(false)).done()
        assertEquals(b, desk.activeSession?.id)
        assertTrue(stopped.isEmpty())
        assertEquals(listOf("tap"), device.did.toList())
    }

    @Test
    fun localStopCancelsPendingWorkBeforeEndingOnlyItsMatchingSession() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val queuedObserve = submit(a, PhoneRequest.Observe(false))
        executor.stopSession(a)
        assertCancelled(acting.done(), completed = 0, code = "stopped-by-user")
        assertEquals("stopped-by-user", queuedObserve.done().failure().code.wire)
        assertEquals(listOf(a), stopped.map { it.id })
        assertEquals(null, desk.activeSession)
        observe(b)
        assertEquals(b, desk.activeSession?.id)
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun aRequestWhoseDeadlineHasAlreadyPassedDoesNothing() {
        val observation = observe(a)
        assertExpired(submit(a, PhoneRequest.Act(ActParams(observation, listOf(tap), false)), deadline = now - 1).done())
        // Less time than the answer itself needs is no time at all.
        assertExpired(submit(a, PhoneRequest.Observe(false), deadline = now + PhoneExecutor.REPLY_RESERVE_MS).done())
        assertExpired(submit(a, PhoneRequest.InstalledApps(InstalledAppsParams("", 50, 0)), deadline = now).done())
        assertTrue(device.did.isEmpty())
        // Nothing ran, so the observation the agent holds is still the latest.
        assertEquals(JsonNull, act(a, observation, tap).done().value().fields.getValue("error"))
    }

    @Test
    fun timeSpentQueuedCountsAndExpiredWorkNeverRuns() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val queued = submit(a, PhoneRequest.Act(ActParams(observation, listOf(tap), false)), deadline = now + 2_000)
        now += 2_000
        acting.work.cancel()
        assertCancelled(acting.done(), completed = 0)
        assertExpired(queued.done())
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun anExpiredOrCancelledCloseStillEndsItsSession() {
        observe(a)
        assertTrue(submit(a, PhoneRequest.Close, deadline = now - 1).done() is ComputerUseOutcome.Ok)
        drain()
        assertEquals(null, desk.activeSession)

        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val closing = submit(a, PhoneRequest.Close)
        closing.work.cancel()
        assertTrue(closing.done() is ComputerUseOutcome.Ok)
        assertCancelled(acting.done(), completed = 0)
        drain()
        assertEquals(null, desk.activeSession)
    }

    @Test
    fun aCloseIsAnsweredAtOnceAndItsSessionIsUnusableFromThen() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val closing = submit(a, PhoneRequest.Close)
        assertTrue(closing.done() is ComputerUseOutcome.Ok)
        assertFalse(acting.result.isDone)
        assertCancelled(acting.done(), completed = 0)
        assertTrue(device.did.isEmpty())
        // A close for another session waits behind nothing either.
        val other = act(a, observe(a), PhoneAction.Wait(5_000), tap)
        assertTrue(submit(b, PhoneRequest.Close).done() is ComputerUseOutcome.Ok)
        assertFalse(other.result.isDone)
        other.work.cancel()
        other.done()
    }

    @Test
    fun aPauseStopsRunningWorkEvenIfTheOwnerResumesAtOnce() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val queued = submit(a, PhoneRequest.Observe(false))
        executor.setPaused(true)
        executor.setPaused(false)
        assertCancelled(acting.done(), completed = 0, code = "stopped-by-user")
        assertEquals("stopped-by-user", queued.done().failure().code.wire)
        assertEquals(listOf(a), stopped.map { it.id })
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun aStopAcceptedBehindQueuedCleanupIsReportedOnceForItsHolder() {
        // Each its own session, because the Run a Stop stops stays stopped.
        val cleanups = listOf<Pair<String, () -> Unit>>(a to { submit(a, PhoneRequest.Close) }, b to { operations.releaseSessions() })
        for ((session, cleanup) in cleanups) {
            val observation = observe(session)
            device.blockGesture = true
            device.gestureStarted = CountDownLatch(1)
            device.finishGesture = CountDownLatch(1)
            val acting = act(session, observation, tap, tap)
            assertTrue(device.gestureStarted.await(2, TimeUnit.SECONDS))
            // Cleanup is queued behind the running batch and has not run; the session still holds the phone.
            cleanup()
            stopped.clear()
            executor.stopSession(session)
            assertEquals(listOf(ActiveSession(session, runOf(session), session)), stopped.toList())
            device.finishGesture.countDown()
            acting.done()
            drain()
            assertEquals(listOf(ActiveSession(session, runOf(session), session)), stopped.toList())
            assertEquals(null, desk.activeSession)
        }
    }

    @Test
    fun aPauseAcceptedBehindQueuedCleanupIsReportedOnceForItsHolder() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        operations.releaseSessions()
        executor.setPaused(true)
        assertEquals(listOf(ActiveSession(a, runOf(a), a)), stopped.toList())
        acting.done()
        drain()
        assertEquals(listOf(ActiveSession(a, runOf(a), a)), stopped.toList())
    }

    @Test
    fun aStopOrPauseAcrossIdentityReplacementReportsOnlyToItsOriginatingOwner() {
        for ((index, pause) in listOf(false, true).withIndex()) {
            stopped.clear()
            executor.setPaused(false)
            val oldSession = if (index == 0) a else "cus_cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            val newSession = if (index == 0) b else "cus_dddddddd-dddd-4ddd-8ddd-dddddddddddd"
            val replaced = CopyOnWriteArrayList<ActiveSession>()
            val replacement = executor.forOwner { replaced += it; refusedRuns += it.runId }
            val observation = observe(oldSession)
            device.blockGesture = true
            device.gestureStarted = CountDownLatch(1)
            device.finishGesture = CountDownLatch(1)
            val acting = act(oldSession, observation, tap, tap)
            assertTrue(device.gestureStarted.await(2, TimeUnit.SECONDS))
            operations.releaseSessions()
            // New identity is installed while the old holder's cleanup waits for its gesture.
            val next = submit(newSession, PhoneRequest.Observe(false), owner = replacement)
            if (pause) executor.setPaused(true) else executor.stopSession(oldSession)
            assertEquals(listOf(ActiveSession(oldSession, runOf(oldSession), oldSession)), stopped.toList())
            assertTrue(replaced.isEmpty())
            executor.setPaused(false)
            device.finishGesture.countDown()
            acting.done()
            next.done()
            val current = submit(newSession, PhoneRequest.Observe(false), owner = replacement).done()
            assertTrue(current is ComputerUseOutcome.Ok)
            assertEquals(newSession, desk.activeSession?.id)

            // Old identity teardown and Close remain scoped even after the replacement acquired the phone.
            operations.releaseSessions()
            submit(newSession, PhoneRequest.Close).done()
            val currentId = (current.value().fields.getValue("observation") as JsonObject).string("observationId")
            val afterOldCleanup = submit(newSession, PhoneRequest.Act(ActParams(currentId, listOf(tap), false)), owner = replacement).done()
            assertEquals(JsonNull, afterOldCleanup.value().fields.getValue("error"))
            assertEquals(newSession, desk.activeSession?.id)
            assertTrue(replaced.isEmpty())
            replacement.releaseSessions()
            // Wait for its cleanup before the next iteration starts another old-owner holder.
            submit(newSession, PhoneRequest.Observe(false)).done()
            submit(newSession, PhoneRequest.Close).done()
        }
    }

    @Test
    fun aDifferentOwnersBusyObserveCannotReplaceTheHoldersReporter() {
        observe(a)
        val otherStops = CopyOnWriteArrayList<ActiveSession>()
        val other = executor.forOwner { otherStops += it; refusedRuns += it.runId }
        assertEquals("busy", submit(b, PhoneRequest.Observe(false), owner = other).done().failure().code.wire)
        executor.stopSession(a)
        assertEquals(listOf(ActiveSession(a, runOf(a), a)), stopped.toList())
        assertTrue(otherStops.isEmpty())
    }

    @Test
    fun aRunItsOwnerStoppedStaysStoppedUnderANewSession() {
        observe(a)
        executor.stopSession(a)
        assertEquals(listOf(a), stopped.map { it.id })
        val again = submit("cus_cccccccc-cccc-4ccc-8ccc-cccccccccccc", PhoneRequest.Observe(false), run = runOf(a)).done()
        assertEquals("stopped-by-user", again.failure().code.wire)
        observe(b)
        assertEquals(b, desk.activeSession?.id)
    }

    @Test
    fun listingAppsNeverWaitsBehindABatchNorClaimsASession() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val listed = submit(b, PhoneRequest.InstalledApps(InstalledAppsParams("mail", 50, 0))).done().value()
        assertFalse(acting.result.isDone)
        assertEquals(1, (listed.fields.getValue("apps") as JsonArray).items.size)
        assertEquals(a, desk.activeSession?.id)
        acting.work.cancel()
        acting.done()
    }

    @Test
    fun queuedWorkIsAnsweredAtItsDeadlineWhileABatchRunsAndNeverRunsAfterwards() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val queued = submit(a, PhoneRequest.Observe(false), deadline = now + 30_000)
        val observed = observationIds
        alarms.reach(now + 30_000 - PhoneExecutor.REPLY_RESERVE_MS - 1)
        assertFalse(queued.result.isDone)
        alarms.reach(now + 30_000 - PhoneExecutor.REPLY_RESERVE_MS)
        assertExpired(queued.done())
        // The batch is still running when the answer goes out.
        assertFalse(acting.result.isDone)
        acting.work.cancel()
        assertCancelled(acting.done(), completed = 0)
        drain()
        assertEquals(1, queued.answers.get())
        assertEquals(observed, observationIds)
    }



    @Test
    fun aQueuedCallTheHostCancelledIsAnsweredOnceAndNeverRuns() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val queued = submit(a, PhoneRequest.Observe(false), deadline = now + 30_000)
        val observed = observationIds
        queued.work.cancel()
        // Its slot is given back at once: it never started.
        assertEquals("The request was cancelled before it ran.", queued.done().failure().message)
        alarms.reach(now + 60_000)
        acting.work.cancel()
        acting.done()
        drain()
        assertEquals(1, queued.answers.get())
        assertEquals(observed, observationIds)
    }



    @Test
    fun anExceptionThatIsNotARuntimeExceptionIsAnAnswer() {
        device.broken = true
        val answer = submit(a, PhoneRequest.Observe(false)).done()
        assertEquals("failed", answer.failure().code.wire)
        device.broken = false
        // The thread lived through it.
        observe(a)
        assertEquals(a, desk.activeSession?.id)
    }
    /** Failures: takeover cancels reads/stops Run, held precedes cleanup, release precedes queued observation. */
    @Test fun takeoverWithdrawsOnlyActsAndKeepsSession() {
        val observation = observe(a)
        val acting = act(a, observation, PhoneAction.Wait(5_000), tap)
        assertTrue(device.waiting.await(2, TimeUnit.SECONDS))
        val read = submit(a, PhoneRequest.Observe(false))
        desk.ownerInControl = true
        val held = CompletableFuture<Unit>()
        executor.takeOver(a) { held.complete(Unit) }
        acting.done()
        assertTrue(read.done() is ComputerUseOutcome.Ok)
        held.get(2, TimeUnit.SECONDS)
        assertTrue(stopped.isEmpty())
        assertEquals(a, desk.activeSession?.id)
        assertEquals("owner-in-control", act(a, observation, tap).done().failure().code.wire)
        val released = CompletableFuture<Unit>()
        executor.controlBarrier { desk.ownerInControl = false; released.complete(Unit) }
        released.get(2, TimeUnit.SECONDS)
        assertEquals("stale-observation", act(a, observation, tap).done().failure().code.wire)
    }

    @Test fun acquireRacesDispatchedAgentChangeAndWaitsForItsCleanup() {
        device.blockGesture = true
        val observation = observe(a)
        val acting = act(a, observation, tap, tap)
        assertTrue(device.gestureStarted.await(2, TimeUnit.SECONDS))
        val queued = act(a, observation, tap)
        desk.ownerInControl = true
        val held = CompletableFuture<Unit>()
        executor.takeOver(a) { held.complete(Unit) }
        assertFalse(held.isDone)
        device.finishGesture.countDown()
        assertCancelled(acting.done(), completed = 1, code = "owner-in-control")
        assertEquals("owner-in-control", queued.done().failure().code.wire)
        held.get(2, TimeUnit.SECONDS)
        assertEquals(listOf("tap"), device.did.toList())
        assertTrue(stopped.isEmpty())
    }

    @Test fun releaseRacesObservationAndInvalidatesItsResultBeforeAdmission() {
        observe(a)
        desk.ownerInControl = true
        device.screenshotGate = CountDownLatch(1)
        val observing = submit(a, PhoneRequest.Observe(true))
        assertTrue(device.screenshotEntered.await(2, TimeUnit.SECONDS))
        val released = CompletableFuture<Unit>()
        executor.controlBarrier { desk.ownerInControl = false; released.complete(Unit) }
        assertFalse(released.isDone)
        device.screenshotGate?.countDown()
        val old = (observing.done().value().fields.getValue("observation") as JsonObject).string("observationId")
        released.get(2, TimeUnit.SECONDS)
        assertEquals("stale-observation", act(a, old, tap).done().failure().code.wire)
        assertTrue(device.did.isEmpty())
    }

    @Test fun heldLeaseRefusesNewActsBeforeWaitingForAnExecutorTurn() {
        val observation = observe(a)
        desk.ownerInControl = true
        val gate = CountDownLatch(1)
        val entered = CountDownLatch(1)
        executor.acquisition { entered.countDown(); gate.await(2, TimeUnit.SECONDS) }
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        try {
            assertEquals("owner-in-control", act(a, observation, tap).done().failure().code.wire)
        } finally { gate.countDown() }
    }

    @Test fun acquisitionRunsAfterTheCurrentChangeAndBeforeTheNextObservation() {
        device.blockGesture = true
        val id = observe(a)
        val acting = act(a, id, tap)
        assertTrue(device.gestureStarted.await(2, TimeUnit.SECONDS))
        val entered = CountDownLatch(1)
        val finish = CountDownLatch(1)
        executor.acquisition { entered.countDown(); finish.await(2, TimeUnit.SECONDS) }
        val next = submit(a, PhoneRequest.Observe(false))
        assertFalse(entered.await(20, TimeUnit.MILLISECONDS))
        device.finishGesture.countDown()
        acting.done()
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        assertFalse(next.result.isDone)
        finish.countDown()
        assertTrue(next.done() is ComputerUseOutcome.Ok)
    }

    @Test fun ownerLanePreservesOrderWithoutWaitingForAgentObserve() {
        observe(a)
        device.screenshotGate = CountDownLatch(1)
        val observing = submit(a, PhoneRequest.Observe(true))
        assertTrue(device.screenshotEntered.await(2, TimeUnit.SECONDS))
        val seen = CopyOnWriteArrayList<Int>(); val done = CountDownLatch(1)
        try {
            repeat(10) { n -> executor.ownerInput { seen += n } }
            executor.ownerInput { done.countDown() }
            assertTrue(done.await(1, TimeUnit.SECONDS))
            assertEquals((0..9).toList(), seen.toList())
        } finally { device.screenshotGate?.countDown(); observing.done() }
    }
    /** Failure: rejected queued owner input cancels an agent gesture after release reopens admission. */
    @Test fun releaseDrainsRejectedOwnerInputBeforeAgentAdmission() {
        observe(a)
        val held = CompletableFuture<Unit>(); val released = CompletableFuture<Unit>()
        val events = CopyOnWriteArrayList<String>()
        val lease = OwnerLease({ desk.ownerInControl = it },
            { session, done -> executor.takeOver(session, done) },
            { done -> executor.ownerInput { executor.controlBarrier(done) } }, { it() },
            { _, _, state, _ ->
                if (state == "held") held.complete(Unit)
                if (state == "released") { events += "released"; released.complete(Unit) }
            })
        lease.acquire(a, "owner"); held.get(2, TimeUnit.SECONDS)
        val stamp = lease.stamp
        val entered = CountDownLatch(1); val drain = CountDownLatch(1)
        executor.ownerInput { entered.countDown(); assertTrue(drain.await(2, TimeUnit.SECONDS)) }
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        executor.ownerInput {
            if (!lease.current(stamp)) {
                assertTrue(desk.ownerInControl)
                events += "cancel"
            }
        }
        try {
            lease.release("released-by-owner")
            val barrier = CompletableFuture<Unit>()
            executor.controlBarrier { barrier.complete(Unit) }
            barrier.get(2, TimeUnit.SECONDS)
            assertFalse(released.isDone)
            assertTrue(desk.ownerInControl)
        } finally { drain.countDown() }
        released.get(2, TimeUnit.SECONDS)
        assertEquals(listOf("cancel", "released"), events.toList())
        assertFalse(desk.ownerInControl)
        val observation = observe(a)
        assertTrue(act(a, observation, tap).done() is ComputerUseOutcome.Ok)
        assertEquals(listOf("tap"), device.did.toList())
    }
    @Test fun realLeaseWiringCancelsAgentGestureBeforeHeld() {
        device.blockGesture = true
        val id = observe(a); val acting = act(a, id, tap, tap)
        assertTrue(device.gestureStarted.await(2, TimeUnit.SECONDS))
        val cleanup = CompletableFuture<() -> Unit>(); val held = CompletableFuture<Unit>()
        val lease = OwnerLease({ desk.ownerInControl = it },
            { session, done -> executor.takeOver(session) { cleanup.complete { executor.controlBarrier(done) } } },
            { executor.controlBarrier(it) }, { it() }, { _, _, state, _ -> if (state == "held") held.complete(Unit) })
        lease.acquire(a, "owner")
        assertFalse(held.isDone)
        device.finishGesture.countDown()
        assertCancelled(acting.done(), completed = 1, code = "owner-in-control")
        val finishCleanup = cleanup.get(2, TimeUnit.SECONDS)
        assertFalse(held.isDone)
        finishCleanup(); held.get(2, TimeUnit.SECONDS)
        assertEquals(listOf("tap"), device.did.toList())
    }
}
