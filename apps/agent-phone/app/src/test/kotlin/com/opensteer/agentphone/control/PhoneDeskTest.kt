package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.ActParams
import com.opensteer.agentphone.wire.AndroidPhoneWire
import com.opensteer.agentphone.wire.ComputerUseOutcome
import com.opensteer.agentphone.wire.DisplayState
import com.opensteer.agentphone.wire.Foreground
import com.opensteer.agentphone.wire.InstalledAppsParams
import com.opensteer.agentphone.wire.JsonArray
import com.opensteer.agentphone.wire.JsonBool
import com.opensteer.agentphone.wire.JsonNull
import com.opensteer.agentphone.wire.JsonNumber
import com.opensteer.agentphone.wire.JsonObject
import com.opensteer.agentphone.wire.JsonString
import com.opensteer.agentphone.wire.Navigation
import com.opensteer.agentphone.wire.PhoneAction
import com.opensteer.agentphone.wire.PhoneTarget
import com.opensteer.agentphone.wire.PixelRect
import com.opensteer.agentphone.wire.PixelSize
import com.opensteer.agentphone.wire.Screenshot
import com.opensteer.agentphone.wire.ScreenshotOutcome
import com.opensteer.agentphone.wire.ScrollDirection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's hands, against a device that records what it was asked to do
 * and whose monotonic clock moves as its gestures and waits take time.
 * Failure modes, each an agent acting on something it never saw or a phone
 * still busy after its Host gave up:
 *
 * 1. an act citing anything but the session's latest observation reaching
 *    the screen, including one made stale by an act in between;
 * 2. a second session served while another holds the phone;
 * 3. anything of the screen shared, or any action run, while the owner has
 *    paused the phone;
 * 4. a point outside the cited screenshot, an index past its elements, a
 *    rotated display discovered only after some actions already ran;
 * 5. an element that has gone acted on anyway, or the progress before it lost;
 * 6. any of the Opensteer app's own screens shared, or operated: with it in
 *    front an observation shows nothing but its name, a batch that would
 *    touch the screen is refused whole before anything runs, nothing
 *    launches it, and the app coming to the front mid-batch stops the next
 *    touch — while navigating away, launching another app, waking and
 *    waiting still work, so an agent is never stuck there;
 * 7. typing that replaces the field instead of inserting at the cursor, or a
 *    password repeated in what the act reports;
 * 8. a viewer's capture that was being taken as Pause began, shown anyway;
 * 9. a secure keyguard appearing during a wait, an action's settle, or a
 *    scroll step stops actions, or a secure phone is refused;
 * 10. an action started, or a wait or settle still running, after the
 *    request's time is up; a gesture dispatched that cannot finish in the time
 *    left; a cut batch that loses what it did, carries an observation it had
 *    no time for, or calls an effect unknown when it is known (and the reverse);
 * 11. listing apps opening or renewing a session, forgetting the observation
 *    an agent holds, or refused while paused;
 * 12. a change reaching the phone after its request was cancelled, its
 *    session stopped or paused, or the Opensteer app came to
 *    the front: during target resolution, a drag's last hold, or between one
 *    effect of an action and the next — and a drag stopped while held leaving
 *    its finger down;
 * 13. pixels or a tree collected while the screen was protected published:
 *    Pause or the Opensteer app arriving during the collection, a
 *    gate that closed and reopened meanwhile, or the discarded collection left
 *    citable — in an observation, an act's last one or a viewer's capture;
 * 14. the time left read twice inside a wait, so a negative sleep throws and
 *    the batch's progress is lost; a tree walk or a wake started without the
 *    time to finish; a scroll step started without the time for its swipe;
 * 15. the runtime interrupted while a drag's finger is down, leaving it down;
 * 16. a Run its owner stopped served again under a new session;
 * 17. a withdrawal landing while admission itself reads Android — the app
 *    in front — or while a launch resolves its app, still
 *    followed by the change: a tap, a drag's move, a submit, a launch;
 * 18. a withdrawal or deadline landing during a device mutation's own
 *    preparation still followed by dispatch, or a refused drag move
 *    leaving its contact down;
 * 19. Android refusing a drag's admitted move, which leaves the held finger
 *    down unless it is lifted; or a move Android accepted, finished or not
 *    known to have, followed by a lift it never asked for — including one
 *    the runtime interrupted while waiting for Android's answer;
 * 20. a Run its identity refused while the publication fence was still in
 *    Android's last read, before the desk heard of the Stop, still shown in
 *    that observation or capture;
 * 21. a Stop or Pause landing during the read an early shape rests
 *    on — the dark screen, the Opensteer app in front — still answered with
 *    that shape and left citable, or a viewer told the screen is off rather
 *    than why nothing is shown;
 * 22. an observation that ran out of time before collecting leaving the one
 *    before it citable, or answering the deadline for a request withdrawn
 *    during the same read;
 * 23. a look whose last read ran past the deadline shared anyway: a dark
 *    screen, the Opensteer app in front before or after collecting, or a
 *    viewer's picture.
 */
class PhoneDeskTest {

    // Saved-text failures: malformed later action permits an early tap, wrong outer context,
    // expiry/disconnect during target resolution, readback, echoed value, or nonempty password insertion.
    @Test fun savedTextPreflightRefusesWholeBatchBeforeAnEarlyTap() {
        val v = com.opensteer.agentphone.wire.LoginVectors
        val receiver = v.receiver()
        val binding = v.binding()
        val session = ActiveSession(binding.sessionId, binding.runId, null)
        val id = desk.observe(session, false, budget()).observation().string("observationId")
        val bad = v.envelope().copy(tag = ByteArray(16))
        val params = ActParams(id, listOf(PhoneAction.Tap(PhoneTarget.Element(0), 1), PhoneAction.Type(null, com.opensteer.agentphone.wire.PhoneText.Saved(bad), false)), false)
        val result = desk.act(session, params, budget(), com.opensteer.agentphone.wire.LoginDispatch(receiver, session.runId, session.id, binding.actId, binding.expiresAt))
        assertEquals("failed", result.code())
        assertTrue(device.did.isEmpty())
    }

    @Test fun savedTextUsesFixedReceiptAndDoesNotReadBack() {
        val v = com.opensteer.agentphone.wire.LoginVectors
        val binding = v.binding()
        val session = ActiveSession(binding.sessionId, binding.runId, null)
        val id = desk.observe(session, false, budget()).observation().string("observationId")
        device.elements[1] = device.elements[1].let { (ref, field) -> ref to field.copy(text = "", textLength = 0, password = true, label = "Password") }
        var resolved = 0
        device.duringResolve = { resolved++ }
        val params = ActParams(id, listOf(PhoneAction.Type(PhoneTarget.Element(1), com.opensteer.agentphone.wire.PhoneText.Saved(v.envelope()), false)), false)
        val result = (desk.act(session, params, budget(), com.opensteer.agentphone.wire.LoginDispatch(v.receiver(), session.runId, session.id, binding.actId, binding.expiresAt)) as ComputerUseOutcome.Ok).value as JsonObject
        assertEquals(listOf("Typed saved password"), result.performed())
        assertEquals(1, resolved)
        assertTrue(!com.opensteer.agentphone.wire.JsonText.stringify(result).contains((v.valid.fields.getValue("plaintext") as JsonString).value))
    }

    @Test fun savedTextDeviceFailuresNeverEchoReleasedValues() {
        val v = com.opensteer.agentphone.wire.LoginVectors
        val binding = v.binding()
        val session = ActiveSession(binding.sessionId, binding.runId, null)
        val id = desk.observe(session, false, budget()).observation().string("observationId")
        device.afterSetText = { throw IllegalStateException((v.valid.fields.getValue("plaintext") as JsonString).value) }
        val params = ActParams(id, listOf(PhoneAction.Type(null, com.opensteer.agentphone.wire.PhoneText.Saved(v.envelope()), false)), false)
        val result = (desk.act(session, params, budget(), com.opensteer.agentphone.wire.LoginDispatch(v.receiver(), session.runId, session.id, binding.actId, binding.expiresAt)) as ComputerUseOutcome.Ok).value as JsonObject
        assertEquals("outcome-unknown", result.errorCode())
        assertTrue(!com.opensteer.agentphone.wire.JsonText.stringify(result).contains((v.valid.fields.getValue("plaintext") as JsonString).value))
    }

    @Test fun disconnectedSavedTextDoesNotEvenFocusItsTarget() {
        val v = com.opensteer.agentphone.wire.LoginVectors
        val receiver = v.receiver()
        val binding = v.binding()
        val session = ActiveSession(binding.sessionId, binding.runId, null)
        val id = desk.observe(session, false, budget()).observation().string("observationId")
        device.duringResolve = { receiver.invalidate() }
        val params = ActParams(id, listOf(PhoneAction.Type(PhoneTarget.Element(1), com.opensteer.agentphone.wire.PhoneText.Saved(v.envelope()), false)), false)
        val result = (desk.act(session, params, budget(), com.opensteer.agentphone.wire.LoginDispatch(receiver, session.runId, session.id, binding.actId, binding.expiresAt)) as ComputerUseOutcome.Ok).value as JsonObject
        assertEquals("failed", result.errorCode())
        assertTrue(device.did.isEmpty())
    }

    private class Ref(val name: String) : ElementRef

    private object Finger : Contact

    private class App(val packageName: String) : Launchable

    private class FakeDevice : Device {
        /** The phone's monotonic clock, which gestures and waits move forward. */
        var now = 1_000_000L
        var display = DisplayState(1080, 2400, 0, interactive = true, locked = false, secureLock = false)
        var ownApp = false
        var foregroundReads = 0
        var missingForeground = false
        var helper = false
        /** Runs while a screenshot is being taken, for what changes meanwhile. */
        var duringScreenshot: () -> Unit = {}
        /** Runs after a navigation, for an app that comes to the front because of it. */
        var afterNavigate: () -> Unit = {}
        var duringPause: () -> Unit = {}
        var afterSwipe: () -> Unit = {}
        var duringResolve: () -> Unit = {}
        var afterSetText: () -> Unit = {}
        var afterSelect: () -> Unit = {}
        var duringLaunchable: () -> Unit = {}
        var duringPrepare: (String) -> Unit = {}
        /** Thrown from the edit lane, as the device does while a person holds a key. */
        var editRefusal: Exception? = null
        override fun <T> edit(action: () -> T): T {
            editRefusal?.let { throw it }
            return action()
        }
        /** Runs once Android has taken a drag's move, before its answer: an interrupt then. */
        var afterMoveTaken: () -> Unit = {}
        var segmentMove = false

        /** Runs once inside the next `display()` or `foreground()`, as a withdrawal landing during that blocking read. */
        var duringNextRead: (() -> Unit)? = null

        private fun read() {
            val hook = duringNextRead ?: return
            duringNextRead = null
            hook()
        }
        /** The walk ran out of its budget part way. */
        var walkStalls = false
        /** What Android makes of every gesture from now on. */
        var gestures = Effect.DONE
        var launcher = emptyList<LauncherEntry>()
        val elements = mutableListOf<Pair<Ref, LiveElement>>()
        val alive = mutableSetOf<String>()
        val did = mutableListOf<String>()

        fun add(name: String, bounds: PixelRect, label: String?, editable: Boolean = false, password: Boolean = false, text: String = "") {
            val ref = Ref(name)
            elements += ref to LiveElement(bounds, label, if (editable) "edittext" else "button", editable, password, text, -1, -1, ref)
            alive += name
        }

        override fun display(): DisplayState {
            read()
            return display
        }
        override fun contentlessHelperShowing() = helper
        override fun foreground(): Foreground? {
            foregroundReads++
            read()
            if (missingForeground) return null
            return if (ownApp) Foreground(AndroidPhoneWire.AGENT_PHONE_PACKAGE, "Opensteer Agent Phone") else Foreground("com.example.app", "Example")
        }
        override fun walk(limit: Int, budget: Budget): Walk? = if (walkStalls) null else Walk(
            elements.map { (ref, live) ->
                WalkedElement(0, live.role, live.label, live.bounds, if (live.editable) listOf("editable") else listOf("clickable"), ref)
            },
            omitted = 0,
        )
        override fun screenshot(size: PixelSize, maxBase64Length: Int, budget: Budget): ScreenshotOutcome {
            duringScreenshot()
            return ScreenshotOutcome.Taken(Screenshot("/9j/", size.width, size.height))
        }
        override fun resolve(ref: ElementRef): LiveElement? {
            duringResolve()
            return elements.firstOrNull { it.first === ref && ref is Ref && ref.name in alive }?.second
        }
        override fun focusedInput(): LiveElement? = elements.firstOrNull { it.second.editable }?.second
        override fun tap(point: DisplayPoint, count: Int, budget: Budget, admit: () -> Unit) = changing("tap", admit) {
            gesture("tap ${point.x},${point.y} x$count", Device.tapMs(count))
        }
        override fun press(point: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit) = changing("press", admit) {
            gesture("press ${point.x},${point.y}", durationMs.toLong())
        }
        override fun swipe(from: DisplayPoint, to: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit) = changing("swipe", admit) {
            gesture("swipe ${from.x},${from.y}->${to.x},${to.y}", durationMs.toLong()).also { afterSwipe() }
        }
        override fun touchDown(point: DisplayPoint, holdMs: Int, budget: Budget, admit: () -> Unit): Contact = changing("touchDown", admit) {
            did += "touchDown ${point.x},${point.y}"
            Finger
        }
        override fun move(contact: Contact, to: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit) = changing("move", admit) {
            if (segmentMove) {
                now += durationMs / 2
                admit()
                gesture("move ${to.x},${to.y}", durationMs.toLong() - durationMs / 2).also { afterMoveTaken() }
            } else gesture("move ${to.x},${to.y}", durationMs.toLong()).also { afterMoveTaken() }
        }
        override fun lift(contact: Contact) {
            did += "lift"
        }
        override fun focus(element: LiveElement, admit: () -> Unit) = changing("focus", admit) { record("focus") }
        override fun setText(element: LiveElement, text: String, admit: () -> Unit) = changing("setText", admit) {
            record("setText $text").also { afterSetText() }
        }
        override fun setSelection(element: LiveElement, start: Int, end: Int, admit: () -> Unit) = changing("setSelection", admit) {
            record("select $start-$end").also { afterSelect() }
        }
        override fun imeEnter(element: LiveElement, admit: () -> Unit) = changing("imeEnter", admit) { record("enter") }
        override fun navigate(to: Navigation, admit: () -> Unit) = changing("navigate", admit) { record("navigate $to").also { afterNavigate() } }
        override fun launchable(packageName: String): Launchable {
            duringLaunchable()
            return App(packageName)
        }
        override fun start(app: Launchable, admit: () -> Unit) = changing("start", admit) { record("launch ${(app as App).packageName}") }
        override fun wake(budget: Budget, admit: () -> Unit) = changing("wake", admit) { gesture("wake", 0) }
        override fun pause(ms: Long) {
            // As `Thread.sleep` does.
            require(ms >= 0) { "timeout value is negative" }
            now += ms
            duringPause()
        }
        override fun launcherEntries() = launcher

        private fun <T> changing(action: String, admit: () -> Unit, change: () -> T): T {
            duringPrepare(action)
            admit()
            return change()
        }

        private fun gesture(action: String, ms: Long): Effect {
            did += action
            now += ms
            return gestures
        }

        private fun record(action: String): Boolean {
            did += action
            return true
        }
    }

    private val device = FakeDevice().apply {
        add("send", PixelRect(100, 200, 300, 400), "Send")
        add("field", PixelRect(0, 1000, 1080, 1100), "Message", editable = true, text = "hel")
    }
    private var ids = 0
    /** The Runs the identity serving the phone has stopped, which the desk asks about. */
    private val refusedRuns = mutableSetOf<String>()
    private val desk = PhoneDesk(
        device,
        wallClock = { 1_760_184_000_000L },
        mintObservationId = { "obs_${++ids}" },
        refused = { it in refusedRuns },
    )

    /** The owner stops `runId`: its identity refuses it, and the desk hears a Run was stopped. */
    private fun stopRun(runId: String) {
        refusedRuns += runId
        desk.runStopped()
    }
    private val a = "cus_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val b = "cus_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private val runA = "run_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val runB = "run_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    private fun held(session: String, title: String? = "Groceries") = ActiveSession(session, if (session == a) runA else runB, title)

    /** `ms` of work time from now, on the device's clock. */
    private fun budget(ms: Long = 60_000) = Budget({ device.now }, device.now + ms, Cancellation())

    private fun observe(session: String = a, title: String? = "Groceries") =
        desk.observe(held(session, title), includeScreenshot = true, budget = budget())
    private fun act(observationId: String, vararg actions: PhoneAction, session: String = a, time: Budget = budget(), shot: Boolean = false) =
        desk.act(held(session), ActParams(observationId, actions.toList(), includeScreenshot = shot), time)
    private fun actValue(observationId: String, vararg actions: PhoneAction, time: Budget = budget(), shot: Boolean = false) =
        (act(observationId, *actions, time = time, shot = shot) as ComputerUseOutcome.Ok).value as JsonObject

    private fun ComputerUseOutcome.observation() =
        ((this as ComputerUseOutcome.Ok).value as JsonObject).fields.getValue("observation") as JsonObject
    private fun ComputerUseOutcome.code() = (this as ComputerUseOutcome.Failure).code.wire
    private fun JsonObject.string(key: String) = (fields.getValue(key) as JsonString).value
    private fun JsonObject.performed() = (fields.getValue("performed") as JsonArray).items.map { (it as JsonString).value }
    private fun JsonObject.errorCode() = (fields.getValue("error") as JsonObject).string("code")



    // Failures: an expired/cancelled capture budget ends a valid lease; a late frame escapes the publication fence.




    @Test
    fun refusesAnythingButTheLatestObservationBeforeActing() {
        val first = observe().observation().string("observationId")
        assertEquals("stale-observation", act("obs_unknown", PhoneAction.Wake).code())
        val second = act(first, PhoneAction.Tap(PhoneTarget.Element(0), 1))
        assertTrue(second is ComputerUseOutcome.Ok)
        val before = device.did.size
        assertEquals("stale-observation", act(first, PhoneAction.Tap(PhoneTarget.Element(0), 1)).code())
        assertEquals(before, device.did.size)
    }

    @Test
    fun servesOneSessionAtATimeAndKeepsItsTaskTitleWithIt() {
        observe(a, title = "Groceries")
        assertEquals(held(a, "Groceries"), desk.activeSession)
        assertEquals("busy", observe(b).code())
        assertEquals(ComputerUseOutcome.Ok(JsonObject(emptyMap())), desk.close(a))
        assertEquals(null, desk.activeSession)
        assertTrue(observe(b, title = null) is ComputerUseOutcome.Ok)
        assertEquals(held(b, null), desk.activeSession)
    }

    @Test
    fun validatesTheWholeBatchBeforeTheFirstAction() {
        val id = observe().observation().string("observationId")
        assertEquals("failed", act(id, PhoneAction.Wake, PhoneAction.Tap(PhoneTarget.Point(648, 10), 1)).code())
        assertEquals("failed", act(id, PhoneAction.Wake, PhoneAction.Tap(PhoneTarget.Element(2), 1)).code())
        device.display = device.display.copy(rotation = 90, width = 2400, height = 1080)
        assertEquals("stale-observation", act(id, PhoneAction.Wake).code())
        device.display = DisplayState(1080, 2400, 0, interactive = true, locked = true, secureLock = true)
        val locked = observe().observation().string("observationId")
        val result = actValue(locked, PhoneAction.Wake, PhoneAction.Tap(PhoneTarget.Point(100, 100), 1))
        assertEquals(JsonNull, result.fields.getValue("error"))
        assertEquals(2, result.performed().size)
        assertEquals(listOf("wake", "tap 167,167 x1"), device.did)
        assertEquals(JsonBool(true), (result.fields.getValue("observation") as JsonObject).fields.getValue("locked"))
        assertEquals(JsonBool(true), (result.fields.getValue("observation") as JsonObject).fields.getValue("secureLock"))
    }

    @Test
    fun secureKeyguardDuringAWaitAllowsLaterActions() {
        val id = observe().observation().string("observationId")
        device.duringPause = { device.display = device.display.copy(locked = true, secureLock = true) }
        val result = actValue(id, PhoneAction.Wait(5_000), PhoneAction.Tap(PhoneTarget.Point(100, 100), 1))
        assertEquals(JsonNull, result.fields.getValue("error"))
        assertEquals(2, result.performed().size)
        assertEquals(listOf("tap 167,167 x1"), device.did)
    }

    @Test
    fun secureKeyguardDuringSettleAllowsLaterActions() {
        val id = observe().observation().string("observationId")
        device.afterNavigate = { device.display = device.display.copy(locked = true, secureLock = true) }
        val result = actValue(id, PhoneAction.Navigate(Navigation.HOME), PhoneAction.Tap(PhoneTarget.Point(100, 100), 1))
        assertEquals(JsonNull, result.fields.getValue("error"))
        assertEquals(2, result.performed().size)
        assertEquals(listOf("navigate HOME", "tap 167,167 x1"), device.did)
    }

    @Test
    fun secureKeyguardDuringScrollAllowsAllSwipes() {
        val id = observe().observation().string("observationId")
        device.afterSwipe = { device.display = device.display.copy(locked = true, secureLock = true) }
        val result = actValue(id, PhoneAction.Scroll(PhoneTarget.Point(100, 100), ScrollDirection.DOWN, 3))
        assertEquals(JsonNull, result.fields.getValue("error"))
        assertEquals(1, result.performed().size)
        assertEquals(3, device.did.size)
        assertTrue(device.did.all { it.startsWith("swipe ") })
    }

    @Test
    fun aSecurePhoneCanActWhileUnlockedLockedAndUnlockedAgain() {
        device.display = device.display.copy(secureLock = true)
        var id = observe().observation().string("observationId")
        assertEquals(JsonNull, actValue(id, PhoneAction.Tap(PhoneTarget.Point(100, 100), 1)).fields.getValue("error"))
        device.display = device.display.copy(locked = true)
        id = observe().observation().string("observationId")
        assertEquals(JsonNull, actValue(id, PhoneAction.Wake).fields.getValue("error"))
        device.display = device.display.copy(locked = false)
        id = observe().observation().string("observationId")
        assertEquals(JsonNull, actValue(id, PhoneAction.Tap(PhoneTarget.Point(100, 100), 1)).fields.getValue("error"))
        assertEquals(3, device.did.size)
    }

    @Test
    fun stopsAtAnElementThatHasGoneAndReportsTheProgressBeforeIt() {
        val id = observe().observation().string("observationId")
        device.alive.remove("send")
        val result = actValue(id, PhoneAction.Navigate(Navigation.HOME), PhoneAction.Tap(PhoneTarget.Element(0), 1))
        assertEquals(listOf("Pressed Home"), result.performed())
        assertEquals("failed", result.errorCode())
        assertTrue(result.fields.getValue("observation") is JsonObject)
        assertEquals(listOf("navigate HOME"), device.did)
    }

    @Test
    fun aBatchCutByTheDeadlineKeepsWhatItDidAndStartsNothingMore() {
        val id = observe().observation().string("observationId")
        val start = device.now
        val result = actValue(
            id,
            PhoneAction.Tap(PhoneTarget.Element(0), 1),
            PhoneAction.Wait(3_000),
            PhoneAction.Tap(PhoneTarget.Point(100, 100), 1),
            time = budget(2_000),
        )
        assertEquals("failed", result.errorCode())
        assertEquals(listOf("Tapped \"Send\""), result.performed())
        assertEquals(JsonNull, result.fields.getValue("observation"))
        assertEquals(listOf("tap 200,300 x1"), device.did)
        // The wait ended at the deadline, not when it would have.
        assertEquals(2_000L, device.now - start)
    }

    @Test
    fun aGestureThatCannotFinishInTheTimeLeftNeverStarts() {
        val id = observe().observation().string("observationId")
        val result = actValue(
            id,
            PhoneAction.Navigate(Navigation.HOME),
            PhoneAction.LongPress(PhoneTarget.Point(100, 100), 2_000),
            PhoneAction.Tap(PhoneTarget.Point(100, 100), 1),
            time = budget(1_000),
        )
        assertEquals("failed", result.errorCode())
        assertEquals(listOf("Pressed Home"), result.performed())
        assertEquals(listOf("navigate HOME"), device.did)
        // Time was left to look, so the agent sees where it stopped.
        assertTrue(result.fields.getValue("observation") is JsonObject)
        val scroll = observe().observation().string("observationId")
        val scrolled = actValue(scroll, PhoneAction.Scroll(PhoneTarget.Point(100, 100), ScrollDirection.DOWN, 5), time = budget(1_000))
        assertEquals("failed", scrolled.errorCode())
        assertEquals(listOf("navigate HOME"), device.did)
    }

    @Test
    fun aGestureWhoseEffectCannotBeEstablishedIsTheOnlyUnknownOutcome() {
        val id = observe().observation().string("observationId")
        device.gestures = Effect.UNKNOWN
        val result = actValue(id, PhoneAction.Tap(PhoneTarget.Element(0), 1), PhoneAction.Tap(PhoneTarget.Point(100, 100), 1))
        assertEquals("outcome-unknown", result.errorCode())
        assertEquals(0, result.performed().size)
        assertEquals(listOf("tap 200,300 x1"), device.did)
        assertTrue(result.fields.getValue("observation") is JsonObject)
    }

    @Test
    fun anActWithNoTimeLeftToObserveReturnsNoObservationAndSaysWhy() {
        val id = observe().observation().string("observationId")
        // The tap and its settle use the whole budget.
        val result = actValue(id, PhoneAction.Tap(PhoneTarget.Point(100, 100), 1), time = budget(Device.tapMs(1) + PhoneDesk.SETTLE_MS))
        assertEquals("failed", result.errorCode())
        assertEquals(listOf("Tapped at (100, 100)"), result.performed())
        assertEquals(JsonNull, result.fields.getValue("observation"))
    }

    @Test
    fun showsNothingOfTheOpensteerAppButItsName() {
        device.ownApp = true
        val hidden = observe().observation()
        assertEquals("opensteer-app", hidden.string("screenshotUnavailable"))
        assertEquals("", hidden.string("tree"))
        assertEquals(0L, (hidden.fields.getValue("elementCount") as JsonNumber).value.toLong())
        assertEquals(JsonBool(false), hidden.fields.getValue("truncated"))
        assertEquals(JsonNull, hidden.fields.getValue("screenshot"))
        assertEquals(AndroidPhoneWire.AGENT_PHONE_PACKAGE, (hidden.fields.getValue("foreground") as JsonObject).string("packageName"))
    }

    @Test
    fun refusesEveryTouchOfTheOpensteerAppBeforeAnythingRunsButLetsAnAgentLeave() {
        device.ownApp = true
        val id = observe().observation().string("observationId")
        val point = PhoneTarget.Point(10, 10)
        for (touch in listOf(
            PhoneAction.Tap(point, 1),
            PhoneAction.LongPress(point, 800),
            PhoneAction.Swipe(point, PhoneTarget.Point(20, 20), 300),
            PhoneAction.Drag(point, PhoneTarget.Point(20, 20), 600, 600),
            PhoneAction.Type(null, "hello", submit = false),
            PhoneAction.Clear(point),
            PhoneAction.Scroll(point, ScrollDirection.DOWN, 1),
        )) {
            val refused = act(id, PhoneAction.Navigate(Navigation.HOME), touch) as ComputerUseOutcome.Failure
            assertEquals("app-not-allowed", refused.code.wire)
            assertEquals(PhoneDesk.OWN_APP, refused.message)
        }
        assertEquals("app-not-allowed", act(id, PhoneAction.Launch(AndroidPhoneWire.AGENT_PHONE_PACKAGE)).code())
        assertTrue(device.did.isEmpty())
        val left = act(id, PhoneAction.Wake, PhoneAction.Wait(1), PhoneAction.Navigate(Navigation.HOME), PhoneAction.Launch("com.example.app"))
        assertEquals(JsonNull, ((left as ComputerUseOutcome.Ok).value as JsonObject).fields.getValue("error"))
        assertEquals(listOf("wake", "navigate HOME", "launch com.example.app"), device.did)
    }

    @Test
    fun stopsAtATouchOnceTheOpensteerAppCameToTheFrontMidBatch() {
        val id = observe().observation().string("observationId")
        // Home put the Opensteer app in front, as a tapped notification might.
        device.afterNavigate = { device.ownApp = true }
        val result = actValue(id, PhoneAction.Navigate(Navigation.HOME), PhoneAction.Tap(PhoneTarget.Element(0), 1))
        assertEquals("app-not-allowed", result.errorCode())
        assertEquals(listOf("Pressed Home"), result.performed())
        assertEquals("opensteer-app", (result.fields.getValue("observation") as JsonObject).string("screenshotUnavailable"))
        assertEquals(listOf("navigate HOME"), device.did)
    }



    @Test
    fun listsAppsWithoutTouchingTheSessionOrItsObservationEvenWhilePaused() {
        val id = observe().observation().string("observationId")
        device.launcher = listOf(
            LauncherEntry("com.example.mail", "Mail"),
            LauncherEntry(AndroidPhoneWire.AGENT_PHONE_PACKAGE, "Opensteer Agent Phone"),
        )
        desk.paused = true
        val listed = (desk.installedApps(InstalledAppsParams("", 50, 0)) as ComputerUseOutcome.Ok).value as JsonObject
        assertEquals(1L, (listed.fields.getValue("total") as JsonNumber).value.toLong())
        val app = (listed.fields.getValue("apps") as JsonArray).items.single() as JsonObject
        assertEquals("Mail", app.string("label"))
        assertEquals("com.example.mail", app.string("packageName"))
        desk.paused = false
        assertEquals(held(a, "Groceries"), desk.activeSession)
        // The observation the agent holds is still the one it may act on.
        assertEquals(JsonNull, actValue(id, PhoneAction.Wake).fields.getValue("error"))
    }

    @Test
    fun aDragStoppedInItsLastHeldMomentNeverMovesAndLiftsItsFinger() {
        val drag = PhoneAction.Drag(PhoneTarget.Element(0), PhoneTarget.Point(100, 100), holdMs = 600, durationMs = 600)
        // A cancel landing in the hold's very last sleep.
        var id = observe().observation().string("observationId")
        val time = budget()
        var held = 0L
        device.duringPause = {
            held += 50
            if (held == 600L) time.cancel.withdraw(Cancellation.Reason.CANCELLED)
        }
        val cancelled = actValue(id, drag, time = time)
        assertEquals("outcome-unknown", cancelled.errorCode())
        assertEquals(listOf("touchDown 200,300", "lift"), device.did)

        // A hold that ran slow leaves too little time for the move: the finger is lifted instead.
        device.did.clear()
        id = observe().observation().string("observationId")
        device.duringPause = { device.now += 10 }
        val late = actValue(id, drag, time = budget(1_200))
        assertEquals("failed", late.errorCode())
        assertEquals(listOf("touchDown 200,300", "lift"), device.did)

        // Pause during the hold: the lift is the one gesture still made.
        device.did.clear()
        device.duringPause = {}
        id = observe().observation().string("observationId")
        device.duringPause = { desk.paused = true }
        val paused = actValue(id, drag)
        assertEquals("stopped-by-user", paused.errorCode())
        assertEquals(listOf("touchDown 200,300", "lift"), device.did)
        assertTrue(cancelled.performed().isEmpty() && late.performed().isEmpty() && paused.performed().isEmpty())
    }

    @Test
    fun aDragMoveAndroidRefusesLiftsItsFingerAndAnAcceptedOneIsNeverLifted() {
        val drag = PhoneAction.Drag(PhoneTarget.Element(0), PhoneTarget.Point(100, 100), holdMs = 600, durationMs = 600)
        fun steps() = device.did.map { it.substringBefore(' ') }

        // Android refuses the move: the finger it still holds is lifted.
        var id = observe().observation().string("observationId")
        device.gestures = Effect.FAILED
        assertEquals("failed", actValue(id, drag).errorCode())
        assertEquals(listOf("touchDown", "move", "lift"), steps())

        // A move whose outcome is unknown may be on the screen: nothing follows it.
        device.did.clear()
        device.gestures = Effect.UNKNOWN
        id = observe().observation().string("observationId")
        assertEquals("outcome-unknown", actValue(id, drag).errorCode())
        assertEquals(listOf("touchDown", "move"), steps())

        // A finished move lifted its own finger.
        device.did.clear()
        device.gestures = Effect.DONE
        id = observe().observation().string("observationId")
        assertEquals(JsonNull, actValue(id, drag).fields.getValue("error"))
        assertEquals(listOf("touchDown", "move"), steps())

        // Interrupted while waiting for Android's answer to a move it took: the
        // device reports it unknown and keeps the interrupt; nothing follows it.
        device.did.clear()
        device.gestures = Effect.UNKNOWN
        device.afterMoveTaken = { Thread.currentThread().interrupt() }
        id = observe().observation().string("observationId")
        assertEquals("outcome-unknown", actValue(id, drag).errorCode())
        assertEquals(listOf("touchDown", "move"), steps())
        assertTrue("The interrupt is kept for the executor", Thread.interrupted())
    }

    @Test
    fun nothingReachesThePhoneOnceAuthorityWentDuringTargetResolution() {
        val stops = listOf<Pair<String, (Budget) -> Unit>>(
            "outcome-unknown" to { time -> time.cancel.withdraw(Cancellation.Reason.CANCELLED) },
            "stopped-by-user" to { time -> time.cancel.withdraw(Cancellation.Reason.PAUSED) },
            "stopped-by-user" to { _ -> desk.paused = true },
            "app-not-allowed" to { _ -> device.ownApp = true },
            "stopped-by-user" to { _ -> stopRun(runA) },
        )
        for ((code, stop) in stops) {
            desk.paused = false
            device.ownApp = false
            device.duringResolve = {}
            val id = observe().observation().string("observationId")
            val time = budget()
            device.duringResolve = { stop(time) }
            val result = actValue(id, PhoneAction.Tap(PhoneTarget.Element(0), 1), time = time)
            assertEquals(code, result.errorCode())
            assertTrue(device.did.isEmpty())
        }
    }

    @Test
    fun eachEffectOfOneActionIsAdmittedOnItsOwn() {
        var id = observe().observation().string("observationId")
        var time = budget()
        device.afterSetText = { time.cancel.withdraw(Cancellation.Reason.CANCELLED) }
        val typed = actValue(id, PhoneAction.Type(PhoneTarget.Element(1), "lo", submit = true), time = time)
        assertEquals("outcome-unknown", typed.errorCode())
        assertTrue((typed.fields.getValue("error") as JsonObject).string("message").contains("typed but not submitted"))
        assertEquals(listOf("focus", "setText hello"), device.did)

        device.afterSetText = {}
        device.did.clear()
        id = observe().observation().string("observationId")
        time = budget()
        device.afterSwipe = { desk.paused = true }
        val scrolled = actValue(id, PhoneAction.Scroll(PhoneTarget.Point(100, 100), ScrollDirection.DOWN, 3), time = time)
        assertEquals("stopped-by-user", scrolled.errorCode())
        assertTrue((scrolled.fields.getValue("error") as JsonObject).string("message").contains("1 of 3"))
        assertEquals(1, device.did.size)
    }

    @Test
    fun aLookTakenWhileThePhoneWasPausedPublishesNothing() {
        val first = observe().observation().string("observationId")
        device.duringScreenshot = { desk.paused = true }
        assertEquals("stopped-by-user", observe().code())
        desk.paused = false
        device.duringScreenshot = {}
        // Nothing of the discarded look, nor the look before it, can be acted on.
        assertEquals("stale-observation", act(first, PhoneAction.Wake).code())
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun aGateThatClosedAndReopenedDuringTheLookStillVoidsIt() {
        observe()
        device.duringScreenshot = {
            desk.paused = true
            desk.paused = false
        }
        assertEquals("failed", observe().code())
        device.duringScreenshot = { desk.ownAppShown() }
        assertEquals("failed", observe().code())
        device.duringScreenshot = {}
        assertTrue(observe() is ComputerUseOutcome.Ok)
    }

    @Test
    fun theOpensteerAppArrivingDuringTheLookShowsNoneOfItsPixels() {
        device.duringScreenshot = { device.ownApp = true }
        val hidden = observe().observation()
        assertEquals("opensteer-app", hidden.string("screenshotUnavailable"))
        assertEquals("", hidden.string("tree"))
        assertEquals(JsonNull, hidden.fields.getValue("screenshot"))

        // The same rule for an act's last look.
        device.ownApp = false
        device.duringScreenshot = {}
        val id = observe().observation().string("observationId")
        device.duringScreenshot = { device.ownApp = true }
        val acted = actValue(id, PhoneAction.Navigate(Navigation.HOME), shot = true)
        assertEquals("opensteer-app", (acted.fields.getValue("observation") as JsonObject).string("screenshotUnavailable"))

    }

    @Test
    fun anActsLastLookTakenWhilePausedIsNotShared() {
        val id = observe().observation().string("observationId")
        device.duringScreenshot = { desk.paused = true }
        val acted = actValue(id, PhoneAction.Navigate(Navigation.HOME), shot = true)
        assertEquals("stopped-by-user", acted.errorCode())
        assertEquals(JsonNull, acted.fields.getValue("observation"))
        assertEquals(listOf("Pressed Home"), acted.performed())
    }

    @Test
    fun aWaitAtTheDeadlineEndsCleanlyWhateverTheClockDoesBetweenReads() {
        val id = observe().observation().string("observationId")
        // Every read of the clock finds it a few milliseconds on, as a stall between two reads would.
        val time = Budget({ device.now.also { device.now += 3 } }, device.now + 400, Cancellation())
        val result = actValue(id, PhoneAction.Tap(PhoneTarget.Point(100, 100), 1), PhoneAction.Wait(5_000), time = time)
        assertEquals("failed", result.errorCode())
        assertEquals(listOf("Tapped at (100, 100)"), result.performed())
    }

    @Test
    fun aWalkOrAWakeWithoutTheTimeToFinishIsNotStarted() {
        observe()
        device.walkStalls = true
        assertEquals("failed", observe().code())
        device.walkStalls = false
        val id = observe().observation().string("observationId")
        val woke = actValue(id, PhoneAction.Wake, time = budget(Device.WAKE_MS - 1))
        assertEquals("failed", woke.errorCode())
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun eachScrollStepNeedsTheTimeForItsSwipe() {
        val id = observe().observation().string("observationId")
        // The steps' swipes run slow, so the time the scroll was admitted with runs out between them.
        device.afterSwipe = { device.now += 600 }
        val scrolled = actValue(id, PhoneAction.Scroll(PhoneTarget.Point(100, 100), ScrollDirection.DOWN, 3), time = budget(3 * 350 + 100))
        assertEquals("failed", scrolled.errorCode())
        assertTrue((scrolled.fields.getValue("error") as JsonObject).string("message").contains("1 of 3"))
        assertEquals(1, device.did.size)
    }

    @Test
    fun aRuntimeInterruptedWhileADragsFingerIsDownLiftsIt() {
        val id = observe().observation().string("observationId")
        device.duringPause = { throw InterruptedException() }
        assertThrows(InterruptedException::class.java) {
            act(id, PhoneAction.Drag(PhoneTarget.Element(0), PhoneTarget.Point(100, 100), holdMs = 600, durationMs = 600))
        }
        assertEquals(listOf("touchDown 200,300", "lift"), device.did)
    }

    @Test
    fun aRunItsOwnerStoppedIsNotServedAgainUnderANewSession() {
        observe()
        stopRun(runA)
        desk.endSession()
        val again = desk.observe(ActiveSession("cus_cccccccc-cccc-4ccc-8ccc-cccccccccccc", runA, "Groceries"), true, budget())
        assertEquals("stopped-by-user", again.code())
        assertTrue(observe(b) is ComputerUseOutcome.Ok)
    }

    @Test
    fun aRunRefusedDuringTheLastReadBeforePublishingSharesNothing() {
        observe()
        // The identity refuses the Run while its Stop is still being written, before the desk hears of it.
        val refuseDuringTheLastRead = { device.duringNextRead = { refusedRuns += runA } }
        device.duringScreenshot = {}
        val id = observe().observation().string("observationId")
        device.duringScreenshot = refuseDuringTheLastRead
        assertEquals("stopped-by-user", observe().code())
        refusedRuns -= runA
        // Nothing of the withheld look is citable; the one before it was replaced.
        assertEquals("stale-observation", act(id, PhoneAction.Wake).code())
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun anEarlyShapeIsDecidedAfterTheReadItRestsOn() {
        observe()
        // A dark screen rests on the display read, during which the owner stops the Run.
        device.display = device.display.copy(interactive = false)
        device.duringNextRead = { refusedRuns += runA }
        assertEquals("stopped-by-user", observe().code())
        refusedRuns -= runA
        // The Opensteer app in front rests on the app read after the display one.
        device.display = device.display.copy(interactive = true)
        device.ownApp = true
        device.duringNextRead = { device.duringNextRead = { refusedRuns += runA } }
        assertEquals("stopped-by-user", observe().code())
        refusedRuns -= runA
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun aLookThatRanOutOfTimeLeavesNothingCitable() {
        val id = observe().observation().string("observationId")
        // The app read after the display one blocks until the deadline has passed.
        val late = budget(1_000)
        device.duringNextRead = { device.duringNextRead = { device.now += 5_000 } }
        assertEquals("failed", desk.observe(held(a), true, late).code())
        assertEquals("stale-observation", act(id, PhoneAction.Wake).code())
        val withdrawn = budget(1_000)
        device.duringNextRead = {
            device.duringNextRead = {
                device.now += 5_000
                withdrawn.cancel.withdraw(Cancellation.Reason.CANCELLED)
            }
        }
        assertEquals("outcome-unknown", desk.observe(held(a), true, withdrawn).code())
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun aLookIsSharedOnlyWithTimeLeftAfterItsLastRead() {
        observe()
        val late = { device.now += 5_000 }
        // A dark screen, its display read running past the deadline.
        device.display = device.display.copy(interactive = false)
        device.duringNextRead = late
        assertEquals("failed", desk.observe(held(a), true, budget(1_000)).code())
        device.display = device.display.copy(interactive = true)
        // The Opensteer app in front, its app read running past the deadline.
        device.ownApp = true
        device.duringNextRead = { device.duringNextRead = late }
        assertEquals("failed", desk.observe(held(a), true, budget(1_000)).code())
        device.ownApp = false
        // The Opensteer app arriving while collecting, found by the last read after the deadline.
        device.duringScreenshot = {
            device.ownApp = true
            late()
        }
        assertEquals("failed", desk.observe(held(a), true, budget(1_000)).code())
        device.ownApp = false
        assertTrue(device.did.isEmpty())
    }

    /** Each way authority can go while admission reads Android, for one session's request. */
    private fun withdrawals(session: ActiveSession, time: Budget): List<Pair<String, () -> Unit>> = listOf(
        "outcome-unknown" to { time.cancel.withdraw(Cancellation.Reason.CANCELLED) },
        "stopped-by-user" to { stopRun(session.runId) },
        "stopped-by-user" to { desk.paused = true },
        "app-not-allowed" to { desk.ownAppShown() },
    )

    /** A session of its own for each attempt, so a Run stopped in one cannot refuse the next before it starts. */
    private fun fresh(index: Int): ActiveSession {
        desk.paused = false
        device.duringResolve = {}
        device.duringPause = {}
        device.duringNextRead = null
        device.did.clear()
        desk.endSession()
        return ActiveSession("cus_0000000$index-0000-4000-8000-000000000000", "run_0000000$index-0000-4000-8000-000000000000", "Groceries")
    }

    private fun lookAndAct(session: ActiveSession, time: Budget, action: PhoneAction): JsonObject {
        val id = (desk.observe(session, true, budget()) as ComputerUseOutcome.Ok).let { (it.value as JsonObject).fields.getValue("observation") as JsonObject }
            .string("observationId")
        return (desk.act(session, ActParams(id, listOf(action), false), time) as ComputerUseOutcome.Ok).value as JsonObject
    }

    @Test
    fun noTapFollowsAWithdrawalDuringAdmissionsOwnReads() {
        repeat(withdrawals(held(a), budget()).size) { index ->
            val session = fresh(index)
            val time = budget()
            val (code, withdraw) = withdrawals(session, time)[index]
            // Resolution is done; the next Android read is admission's own.
            device.duringResolve = { device.duringNextRead = withdraw }
            val result = lookAndAct(session, time, PhoneAction.Tap(PhoneTarget.Element(0), 1))
            assertEquals(code, result.errorCode())
            assertTrue(device.did.isEmpty())
        }
    }

    @Test
    fun noDragMoveFollowsAWithdrawalDuringTheMovesAdmission() {
        val drag = PhoneAction.Drag(PhoneTarget.Element(0), PhoneTarget.Point(100, 100), holdMs = 600, durationMs = 600)
        repeat(withdrawals(held(a), budget()).size) { index ->
            val session = fresh(index)
            val time = budget()
            val (code, withdraw) = withdrawals(session, time)[index]
            var held = 0L
            device.duringPause = {
                held += 50
                // The hold's last slice: the next read is the move's admission.
                if (held == 600L) device.duringNextRead = withdraw
            }
            val result = lookAndAct(session, time, drag)
            assertEquals(code, result.errorCode())
            assertEquals(listOf("touchDown 200,300", "lift"), device.did)
        }
    }

    @Test
    fun noSubmitFollowsAWithdrawalDuringItsAdmission() {
        val id = observe().observation().string("observationId")
        val time = budget()
        device.afterSelect = { device.duringNextRead = { time.cancel.withdraw(Cancellation.Reason.CANCELLED) } }
        val typed = actValue(id, PhoneAction.Type(PhoneTarget.Element(1), "lo", submit = true), time = time)
        assertEquals("outcome-unknown", typed.errorCode())
        assertEquals(listOf("focus", "setText hello", "select 5-5"), device.did)
    }

    @Test
    fun noLaunchFollowsAWithdrawalWhileItsAppIsResolvedOrPrepared() {
        var id = observe().observation().string("observationId")
        var time = budget()
        val resolving = time
        // The withdrawal lands while Android resolves the app.
        device.duringLaunchable = { resolving.cancel.withdraw(Cancellation.Reason.CANCELLED) }
        assertEquals("outcome-unknown", actValue(id, PhoneAction.Launch("com.example.mail"), time = time).errorCode())
        assertTrue(device.did.isEmpty())

        // Or while Android prepares the launch, immediately before admission.
        device.duringLaunchable = {}
        device.duringPrepare = { if (it == "start") desk.paused = true }
        id = observe().observation().string("observationId")
        time = budget()
        assertEquals("stopped-by-user", actValue(id, PhoneAction.Launch("com.example.mail"), time = time).errorCode())
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun aPreparedMutationStillNeedsLiveAuthorityAndTime() {
        val actions = listOf(
            "tap" to PhoneAction.Tap(PhoneTarget.Element(0), 1),
            "imeEnter" to PhoneAction.Type(PhoneTarget.Element(1), "lo", submit = true),
            "start" to PhoneAction.Launch("com.example.mail"),
            "wake" to PhoneAction.Wake,
        )
        for ((index, entry) in actions.withIndex()) {
            val (mutation, action) = entry
            val session = fresh(index)
            val time = budget()
            device.duringPrepare = { if (it == mutation) time.cancel.withdraw(Cancellation.Reason.CANCELLED) }
            assertEquals("outcome-unknown", lookAndAct(session, time, action).errorCode())
            assertEquals(if (mutation == "imeEnter") listOf("focus", "setText hello", "select 5-5") else emptyList<String>(), device.did)
        }
        val session = fresh(4)
        val time = budget()
        device.duringPrepare = { if (it == "tap") device.now = time.until }
        assertEquals("failed", lookAndAct(session, time, PhoneAction.Tap(PhoneTarget.Element(0), 1)).errorCode())
        assertTrue(device.did.isEmpty())
    }

    @Test
    fun aDragMoveDeniedAfterPreparationLiftsItsContact() {
        val session = fresh(0)
        val time = budget()
        device.duringPrepare = { if (it == "move") time.cancel.withdraw(Cancellation.Reason.CANCELLED) }
        val drag = PhoneAction.Drag(PhoneTarget.Element(0), PhoneTarget.Point(100, 100), holdMs = 600, durationMs = 600)
        assertEquals("outcome-unknown", lookAndAct(session, time, drag).errorCode())
        assertEquals(listOf("touchDown 200,300", "lift"), device.did)
    }

    @Test
    fun typesAtTheCursorAndNeverRepeatsAPassword() {
        val id = observe().observation().string("observationId")
        val result = actValue(id, PhoneAction.Type(PhoneTarget.Element(1), "lo", submit = true))
        assertEquals(listOf("focus", "setText hello", "select 5-5", "enter"), device.did)
        assertEquals(listOf("Typed \"lo\" into \"Message\" and submitted"), result.performed())

        device.elements.clear()
        device.did.clear()
        device.add("secret", PixelRect(0, 0, 100, 100), "Password", editable = true, password = true)
        val again = observe().observation().string("observationId")
        val secret = actValue(again, PhoneAction.Type(null, "hunter22", submit = false))
        assertEquals(listOf("Typed 8 characters into \"Password\""), secret.performed())
    }

    @Test
    fun tapsAnElementAtItsCentreAndAPointWhereTheScreenshotSaysIt() {
        val id = observe().observation().string("observationId")
        act(id, PhoneAction.Tap(PhoneTarget.Element(0), 2))
        val next = observe().observation().string("observationId")
        act(next, PhoneAction.Tap(PhoneTarget.Point(324, 720), 1))
        assertEquals(listOf("tap 200,300 x2", "tap 540,1200 x1"), device.did)
    }
    /** A continuation checks the remaining move, rather than requiring the whole move's time again. */
    @Test fun segmentedDragDoesNotSpendItsOriginalDurationAgainAtEachAdmission() {
        val id = observe().observation().string("observationId")
        device.segmentMove = true
        val result = actValue(id, PhoneAction.Drag(PhoneTarget.Element(0), PhoneTarget.Point(100, 100), 600, 600), time = budget(1490))
        assertEquals(JsonNull, result.fields.getValue("error"))
        assertTrue(device.did.any { it.startsWith("move ") })
    }

    @Test fun agentContactDuringPersonTouchReportsTheRetryMessage() {
        val id = observe().observation().string("observationId")
        device.duringPrepare = { if (it == "tap") throw PersonContactException() }
        val result = actValue(id, PhoneAction.Tap(PhoneTarget.Element(0), 1))
        assertEquals("failed", result.errorCode())
        val error = result.fields.getValue("error") as JsonObject
        assertEquals("A person is touching the screen; try again.", error.string("message"))
        assertTrue(device.did.isEmpty())
    }

    @Test fun agentTypingWhileThePersonHoldsAKeyReportsTheRetryMessage() {
        val id = observe().observation().string("observationId")
        device.editRefusal = PersonContactException(PersonContactException.KEY)
        val result = actValue(id, PhoneAction.Type(PhoneTarget.Element(1), com.opensteer.agentphone.wire.PhoneText.Literal("hi"), false))
        assertEquals("failed", result.errorCode())
        val error = result.fields.getValue("error") as JsonObject
        assertEquals("A person is holding a key; try again.", error.string("message"))
        assertTrue(device.did.none { it.startsWith("setText") || it.startsWith("type") })
    }

    @Test fun interruptedTapAndSwipeReportFailureWithoutClaimingProgress() {
        for ((what, action) in listOf("tap" to PhoneAction.Tap(PhoneTarget.Element(0), 1),
            "swipe" to PhoneAction.Swipe(PhoneTarget.Element(0), PhoneTarget.Point(100, 100), 500))) {
            val id = observe().observation().string("observationId")
            device.gestures = Effect.FAILED
            val result = actValue(id, action)
            assertEquals("failed", result.errorCode())
            assertEquals("The $what was interrupted.", (result.fields.getValue("error") as JsonObject).string("message"))
            assertTrue(result.performed().isEmpty())
        }
    }

    @Test fun windowListChangesLiftTheOwnAppProtectionWhenAnotherPackageHasFocus() {
        observe()
        desk.windowChanged(true)
        assertEquals("opensteer-app", desk.displayProtection())
        desk.windowsChanged()
        assertEquals(null, desk.displayProtection())
        device.ownApp = true
        desk.windowsChanged()
        assertEquals("opensteer-app", desk.displayProtection())
    }

    @Test fun ownerAdmissionUsesEventCacheAndStillChecksSessionAndProtection() {
        observe()
        desk.windowsChanged()
        val reads = device.foregroundReads
        repeat(100) { assertTrue(desk.ownerAdmission(a, true)) }
        assertEquals(reads, device.foregroundReads)
        device.ownApp = true; desk.windowsChanged()
        assertTrue(!desk.ownerAdmission(a, true))
        device.ownApp = false; desk.windowsChanged()
        assertTrue(desk.ownerAdmission(a, true))
        desk.paused = true
        assertTrue(!desk.ownerAdmission(a, false))
    }
    @Test fun wakeHelperWindowDoesNotProtectDisplay() {
        observe()
        val changes = mutableListOf<Boolean>(); desk.protectionChanged = { changes += it }
        device.ownApp = true; device.helper = true
        desk.windowsChanged()
        assertEquals(null, desk.displayProtection())
        assertTrue(changes.none { it })
    }

    /** Missing roots and transparent helpers cannot lift protection over Opensteer's underlying UI. */
    @Test fun unknownForegroundAndHelperPreserveOwnAppProtection() {
        observe(); desk.windowChanged(true)
        device.missingForeground = true; desk.windowsChanged()
        assertEquals("opensteer-app", desk.displayProtection())
        device.helper = true; desk.windowsChanged()
        assertEquals("opensteer-app", desk.displayProtection())
    }

}
