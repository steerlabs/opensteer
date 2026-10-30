package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.ActError
import com.opensteer.agentphone.wire.ActParams
import com.opensteer.agentphone.wire.AndroidPhoneWire
import com.opensteer.agentphone.wire.ComputerUseErrorCode
import com.opensteer.agentphone.wire.ComputerUseOutcome
import com.opensteer.agentphone.wire.DisplayState
import com.opensteer.agentphone.wire.Foreground
import com.opensteer.agentphone.wire.InstalledAppsParams
import com.opensteer.agentphone.wire.IsoTime
import com.opensteer.agentphone.wire.JsonObject
import com.opensteer.agentphone.wire.LoginDispatch
import com.opensteer.agentphone.wire.LoginTextException
import com.opensteer.agentphone.wire.Observation
import com.opensteer.agentphone.wire.PhoneAction
import com.opensteer.agentphone.wire.PhoneTarget
import com.opensteer.agentphone.wire.PhoneText
import com.opensteer.agentphone.wire.PixelRect
import com.opensteer.agentphone.wire.PreparedLoginText
import com.opensteer.agentphone.wire.ScreenshotOutcome
import com.opensteer.agentphone.wire.ScrollDirection
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * The phone's hands: sessions, observations and actions on one display.
 *
 * Observe, act and close run on one executor thread, one at a time, so the
 * latest observation can change only between them. The app list
 * run beside them and only read. The gate flags are written by other threads
 * and read here, so a pause stops a batch at once.
 *
 * Nothing changes the phone without one admission, made immediately before
 * the change, after its target is resolved and every wait is over: the
 * request still stands, the owner has neither paused nor stopped it, the
 * Opensteer app is not in front of a touch, and the time left covers the
 * change, because a dispatched gesture cannot be taken back. A lock screen is
 * an ordinary screen: agents unlock it themselves. An action of several
 * changes is admitted change by change, and a batch cut short reports exactly
 * what it completed.
 *
 * Nothing protected is shared either. What an observation or a capture
 * collects is published only if nothing protected the screen meanwhile —
 * Pause, the Opensteer app coming to the front, the session
 * ending, the request's withdrawal — even if that protection has since lifted.
 */
class PhoneDesk(
    private val device: Device,
    private val wallClock: () -> Long,
    private val mintObservationId: () -> String,
    /**
     * Whether the owner stopped `runId` under the identity serving the phone:
     * none is served again, under any session. The identity's to say, so a
     * new pairing starts with none of its predecessor's.
     */
    private val refused: (runId: String) -> Boolean,
) {
    /** Counts every time the screen became protected, so a collection can tell it was taken across one. */
    private val protection = AtomicLong()

    @Volatile var protectionChanged: (Boolean) -> Unit = {}
    @Volatile private var ownWindow = false
    @Volatile private var ownerDisplay: DisplayState? = null

    private fun changed() = protectionChanged(paused || ownWindow || ownerDisplay?.let { !it.interactive || it.locked } == true)

    fun displayProtection(): String? = when {
        paused -> "paused"
        ownWindow -> "opensteer-app"
        ownerDisplay?.locked == true -> "locked-screen"
        ownerDisplay?.interactive == false -> "screen-off"
        else -> null
    }

    fun displayTaskLive(sessionId: String): Boolean = activeSession?.let {
        it.id == sessionId && sessionId !in withdrawn && !refused(it.runId)
    } == true

    /** Shared owner/agent gate; the caller rechecks its own authority after these Android reads. */
    fun gate(touch: Boolean): ActError? {
        val since = ownAppProtection.get()
        val own = touch && ownAppInFront()
        return when {
            paused -> ActError(ComputerUseErrorCode.STOPPED_BY_USER, PAUSED)
            touch && (own || ownAppProtection.get() != since) -> ActError(ComputerUseErrorCode.APP_NOT_ALLOWED, OWN_APP)
            else -> null
        }
    }

    fun ownerAdmission(sessionId: String, touch: Boolean): Boolean {
        val session = activeSession ?: return false
        val display = ownerDisplay ?: return false
        return session.id == sessionId && activeSession == session && refusal(session) == null &&
            !paused && display.interactive && !display.locked && (!touch || !ownWindow)
    }

    /** Refresh on window/power events and a slow safety poll; pointer admission never fetches the tree. */
    fun displayChanged(display: DisplayState) {
        val before = ownerDisplay
        ownerDisplay = display
        if (before?.locked != display.locked || before.interactive != display.interactive) changed()
    }

    fun windowsChanged() {
        displayChanged(device.display())
        if (device.contentlessHelperShowing()) return
        val foreground = device.foreground() ?: return
        val own = foreground.packageName == AndroidPhoneWire.AGENT_PHONE_PACKAGE
        if (own != ownWindow) windowChanged(own)
    }

    fun windowChanged(own: Boolean) {
        if (own) ownAppShown() else { ownWindow = false; changed() }
    }

    /** An own-app event during Android's state reads must still protect the next touch. */
    private val ownAppProtection = AtomicLong()

    /** Paused by the owner on this phone; nothing is shared or done. */
    @Volatile
    var paused = false
        set(value) {
            if (value) protection.incrementAndGet()
            field = value
            changed()
        }

    /** Sessions the Host closed whose cleanup still waits its turn: unusable from the moment of closing. */
    private val withdrawn: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** The session holding the phone, if any. */
    @Volatile
    var activeSession: ActiveSession? = null
        private set(value) { field = value; changed() }

    private class Snapshot(
        val observationId: String,
        val sessionId: String,
        val display: DisplayState,
        val mapping: ScreenMapping,
        val elements: List<WalkedElement>,
    )

    /** The one observation an act may cite. Executor thread only. */
    private var latest: Snapshot? = null

    fun observe(session: ActiveSession, includeScreenshot: Boolean, budget: Budget): ComputerUseOutcome {
        refusal(session)?.let { return failure(it.code, it.message) }
        holder(session.id)?.let { return it }
        activeSession = session
        return when (val look = observeNow(session, includeScreenshot, budget)) {
            is Look.Seen -> ComputerUseOutcome.Ok(AndroidPhoneWire.observationResult(look.observation))
            is Look.Withheld -> failure(look.error.code, look.error.message)
        }
    }

    fun act(session: ActiveSession, params: ActParams, budget: Budget, login: LoginDispatch? = null): ComputerUseOutcome {
        refusal(session)
            ?.let { return failure(it.code, it.message) }
        holder(session.id)?.let { return it }
        val snapshot = latest
        if (snapshot == null || snapshot.observationId != params.observationId || snapshot.sessionId != session.id) {
            return failure(ComputerUseErrorCode.STALE_OBSERVATION, "Observation ${params.observationId} is not this phone's latest; observe again.")
        }
        activeSession = session
        val display = device.display()
        if (display.rotation != snapshot.display.rotation || display.width != snapshot.display.width || display.height != snapshot.display.height) {
            return failure(ComputerUseErrorCode.STALE_OBSERVATION, "The screen rotated or changed size since that observation; observe again.")
        }
        refuseOwnApp(params)?.let { return it }
        validate(params, snapshot)?.let { return it }
        val hasSaved = params.actions.any { it is PhoneAction.Type && it.text is PhoneText.Saved }
        val saved = if (hasSaved) {
            if (login == null) return failure(ComputerUseErrorCode.UNSUPPORTED, "Update Agent Phone and the Host to type saved logins.")
            try {
                if (login.runId != session.runId || login.sessionId != session.id) throw LoginTextException()
                login.preflight(params.actions)
            } catch (error: LoginTextException) {
                return failure(ComputerUseErrorCode.FAILED, error.message!!)
            }
        } else emptyMap()
        // From the first action on, the cited observation describes a screen that may be gone.
        latest = null
        val performed = ArrayList<String>()
        var error: ActError? = null
        for ((index, action) in params.actions.withIndex()) {
            error = interruption(budget, session) ?: when (val step = perform(action, snapshot, session, budget, saved[index])) {
                is Step.Done -> {
                    performed += step.performed
                    pause(SETTLE_MS, budget, session)
                }
                is Step.Refused -> step.error
            }
            if (error != null) break
        }
        // A pause, a Stop or the deadline that came during the last settle ends the batch too.
        if (error == null) error = interruption(budget, session)
        // Nothing more of the screen is shared once the batch was stopped, withdrawn or out of time.
        val withheld = budget.cancel.requested || refusal(session) != null || budget.expired
        val look = if (withheld) null else observeNow(session, params.includeScreenshot, budget)
        val observation = (look as? Look.Seen)?.observation
        if (observation == null && error == null) {
            error = (look as? Look.Withheld)?.error ?: interruption(budget, session) ?: ActError(ComputerUseErrorCode.FAILED, OUT_OF_TIME)
        }
        return ComputerUseOutcome.Ok(AndroidPhoneWire.actResult(error, observation, performed))
    }

    /** The Host closed `sessionId`: from now on nothing is done or shown for it, though its cleanup waits its turn. */
    fun withdraw(sessionId: String) {
        withdrawn += sessionId
        protection.incrementAndGet()
        changed()
    }

    /** Lets go of the phone once its turn comes; a session that holds nothing here is already let go. */
    fun close(sessionId: String): ComputerUseOutcome {
        if (activeSession?.id == sessionId) {
            protection.incrementAndGet()
            activeSession = null
            latest = null
        }
        withdrawn -= sessionId
        return ComputerUseOutcome.Ok(JsonObject(emptyMap()))
    }

    /** The apps `launch` can open. It reads no screen and touches no session, so a paused phone answers too. */
    fun installedApps(params: InstalledAppsParams): ComputerUseOutcome =
        ComputerUseOutcome.Ok(AndroidPhoneWire.installedAppsResult(LaunchableApps.page(device.launcherEntries(), params)))

    /** The Opensteer app came to the front: whatever was being collected may hold its screens. */
    fun ownAppShown() {
        ownWindow = true
        ownAppProtection.incrementAndGet()
        protection.incrementAndGet()
        protectionChanged(true)
    }

    /** The owner stopped the Run holding the phone, which its identity now refuses: nothing being collected for it is shared. */
    fun runStopped() {
        protection.incrementAndGet()
        changed()
    }

    /** Ends whatever session holds the phone, returning it so the Host can be told. */
    fun endSession(): ActiveSession? {
        protection.incrementAndGet()
        val ended = activeSession
        activeSession = null
        latest = null
        changed()
        return ended
    }

    /** An accepted local Stop cleans up only the holder it captured, even if earlier cleanup already ran. */
    fun endSession(expected: ActiveSession) {
        if (activeSession == expected) endSession()
    }

    /** What keeps `session` from being served at all: Pause, its Run stopped by the owner, or its closing. */
    private fun refusal(session: ActiveSession): ActError? = when {
        paused -> ActError(ComputerUseErrorCode.STOPPED_BY_USER, PAUSED)
        refused(session.runId) -> ActError(ComputerUseErrorCode.STOPPED_BY_USER, STOPPED)
        session.id in withdrawn -> ActError(ComputerUseErrorCode.FAILED, ENDED)
        else -> null
    }

    /** The answer for a request whose authority was withdrawn. */
    private fun withdrawal(reason: Cancellation.Reason): ActError = when (reason) {
        Cancellation.Reason.CANCELLED -> ActError(ComputerUseErrorCode.OUTCOME_UNKNOWN, CANCELLED)
        Cancellation.Reason.STOPPED -> ActError(ComputerUseErrorCode.STOPPED_BY_USER, STOPPED)
        Cancellation.Reason.PAUSED -> ActError(ComputerUseErrorCode.STOPPED_BY_USER, PAUSED)
    }

    /** Only local state: safe as the final authority decision after Android has finished all blocking reads. */
    private fun authority(budget: Budget, session: ActiveSession): ActError? {
        budget.cancel.reason?.let { return withdrawal(it) }
        return refusal(session)
            ?: (if (activeSession != session) ActError(ComputerUseErrorCode.FAILED, ENDED) else null)
    }

    /** Why the batch must stop now. */
    private fun interruption(budget: Budget, session: ActiveSession): ActError? =
        authority(budget, session)
            ?: if (budget.expired) ActError(ComputerUseErrorCode.FAILED, OUT_OF_TIME) else null

    /**
     * The one check before a change to the phone, made after its target is
     * resolved, every wait is over and Android has prepared the effect. The
     * foreground read precedes the final local authority and clock
     * decision; the device mutates immediately after this returns.
     */
    private fun admission(budget: Budget, session: ActiveSession, ms: Long, what: String, touch: Boolean): ActError? {
        authority(budget, session)?.let { return it }
        val gated = gate(touch)
        return authority(budget, session)
            ?: gated
            ?: (if (budget.expired) ActError(ComputerUseErrorCode.FAILED, OUT_OF_TIME) else null)
            ?: if (budget.fits(ms)) null else ActError(ComputerUseErrorCode.FAILED, "Too little time was left for the $what, so it did not start.")
    }

    private fun admit(budget: Budget, session: ActiveSession, ms: Long, what: String, touch: Boolean) {
        admission(budget, session, ms, what, touch)?.let { throw Refusal(it) }
    }

    /** An admission refused after the action had already changed something: the reason, and what had happened. */
    private fun admitPartway(budget: Budget, session: ActiveSession, ms: Long, what: String, touch: Boolean, happened: String) {
        admission(budget, session, ms, what, touch)?.let { refuse(it.code, "${it.message} $happened") }
    }

    private fun holder(sessionId: String): ComputerUseOutcome? {
        val active = activeSession?.id
        return if (active != null && active != sessionId) failure(ComputerUseErrorCode.BUSY, "Another task is using this phone.") else null
    }

    /** What one look at the screen may share. */
    private sealed interface Look {
        data class Seen(val observation: Observation) : Look

        /** Nothing may be shared, for this reason. */
        data class Withheld(val error: ActError) : Look
    }

    /** What protected the screen while it was being collected, if anything did. */
    private sealed interface Guard {
        data class OwnApp(val foreground: Foreground) : Guard

        data class Withhold(val error: ActError) : Guard
    }

    /**
     * What keeps a look of `session` from being shared now, from local state
     * only: decided after the last Android read the look rests on, as in
     * admission, so whatever landed while that read blocked is seen.
     */
    private fun standing(session: ActiveSession, budget: Budget): Guard? {
        budget.cancel.reason?.let { return Guard.Withhold(withdrawal(it)) }
        refusal(session)?.let { return Guard.Withhold(it) }
        if (activeSession?.id != session.id) return Guard.Withhold(ActError(ComputerUseErrorCode.FAILED, ENDED))
        return null
    }

    /**
     * The publication fence, read after collecting and before publishing: the
     * protections now, the app actually in front now, and whether any
     * protection began since `since`, which a gate that has reopened since
     * cannot undo.
     */
    private fun guard(session: ActiveSession, budget: Budget, since: Long): Guard? {
        val foreground = device.foreground()
        standing(session, budget)?.let { return it }
        if (foreground?.packageName == AndroidPhoneWire.AGENT_PHONE_PACKAGE) return Guard.OwnApp(foreground)
        if (protection.get() != since) return Guard.Withhold(ActError(ComputerUseErrorCode.FAILED, PROTECTED))
        return null
    }

    /**
     * One look at the screen. The protected shapes — a dark
     * screen, the Opensteer app — share nothing but why; anything else is
     * collected first and published only if `guard` finds nothing protected
     * it meanwhile, and a look that is not published leaves nothing citable.
     */
    private fun observeNow(session: ActiveSession, includeScreenshot: Boolean, budget: Budget): Look {
        // A new look replaces the one an act may cite; only a look that is shared becomes citable.
        latest = null
        val since = protection.get()
        val display = device.display()
        val geometry = ScreenGeometry.fit(display.size, AndroidPhoneWire.SCREENSHOT_MAX_LONG_SIDE, AndroidPhoneWire.SCREENSHOT_MAX_PIXELS)
        val mapping = ScreenMapping(display.size, geometry)
        val capturedAt = IsoTime.format(wallClock())
        val observationId = mintObservationId()
        fun ownAppShape(foreground: Foreground): Look {
            // Actable, but only to leave: navigating, launching another app,
            // waking and waiting name nothing on this screen.
            latest = Snapshot(observationId, session.id, display, mapping, emptyList())
            return Look.Seen(Observation.opensteerApp(capturedAt, observationId, display, geometry, foreground))
        }
        // A look is shared only with time left once its last read is over.
        fun timely(shape: () -> Look): Look =
            if (budget.expired) Look.Withheld(ActError(ComputerUseErrorCode.FAILED, OUT_OF_TIME_OBSERVING)) else shape()
        fun decided(guard: Guard): Look = when (guard) {
            is Guard.OwnApp -> timely { ownAppShape(guard.foreground) }
            is Guard.Withhold -> Look.Withheld(guard.error)
        }
        // Each answer is decided after the last read it rests on: here, the display.
        standing(session, budget)?.let { return decided(it) }
        if (!display.interactive) {
            return timely {
                // Actable: `wake` is the answer to it.
                latest = Snapshot(observationId, session.id, display, mapping, emptyList())
                Look.Seen(Observation.screenOff(capturedAt, observationId, display, geometry))
            }
        }
        val foreground = device.foreground()
        // And here, the app in front.
        standing(session, budget)?.let { return decided(it) }
        if (foreground?.packageName == AndroidPhoneWire.AGENT_PHONE_PACKAGE) return timely { ownAppShape(foreground) }
        if (budget.expired) return Look.Withheld(ActError(ComputerUseErrorCode.FAILED, OUT_OF_TIME_OBSERVING))
        val walk = device.walk(AndroidPhoneWire.MAX_ELEMENTS, budget)
        val tree = walk?.let { found ->
            TreeWriter.write(found.elements.map { TreeElement(it.depth, it.role, it.label, mapping.toScreenshot(it.bounds), it.flags) }, found.omitted)
        }
        val screenshot = when {
            tree == null -> ScreenshotOutcome.NotRequested
            includeScreenshot -> device.screenshot(geometry, AndroidPhoneWire.SCREENSHOT_MAX_BASE64, budget)
            else -> ScreenshotOutcome.NotRequested
        }
        return when (val guard = guard(session, budget, since)) {
            // A walk or picture that did not finish before the deadline is the budget spent, not Android failing.
            null -> if (walk == null || tree == null || budget.expired) {
                Look.Withheld(ActError(ComputerUseErrorCode.FAILED, OUT_OF_TIME_OBSERVING))
            } else {
                // Only the elements the tree names are targets; the rest were never shown.
                latest = Snapshot(observationId, session.id, display, mapping, walk.elements.take(tree.elementCount))
                Look.Seen(Observation.visible(capturedAt, observationId, display, geometry, foreground, tree, screenshot))
            }
            else -> decided(guard)
        }
    }

    /**
     * The Opensteer app is the owner's, so nothing launches it, and while it
     * is in front a batch that would touch the screen is refused whole,
     * before anything runs. Leaving it — navigating, launching another app,
     * waking, waiting — is always allowed, so an agent is never stuck there.
     */
    private fun refuseOwnApp(params: ActParams): ComputerUseOutcome? = when {
        params.actions.any { it is PhoneAction.Launch && it.packageName == AndroidPhoneWire.AGENT_PHONE_PACKAGE } ->
            failure(ComputerUseErrorCode.APP_NOT_ALLOWED, OWN_APP_LAUNCH)
        params.actions.any { it.pointsAtScreen() } && ownAppInFront() ->
            failure(ComputerUseErrorCode.APP_NOT_ALLOWED, OWN_APP)
        else -> null
    }

    private fun PhoneAction.pointsAtScreen() = this !is PhoneAction.Navigate && this !is PhoneAction.Launch &&
        this != PhoneAction.Wake && this !is PhoneAction.Wait

    private fun ownAppInFront() = if (device.contentlessHelperShowing()) ownWindow else device.foreground()?.packageName == AndroidPhoneWire.AGENT_PHONE_PACKAGE

    /** The whole batch, checked before its first action: a refusal here means nothing happened. */
    private fun validate(params: ActParams, snapshot: Snapshot): ComputerUseOutcome? {
        for (action in params.actions) {
            for (target in targets(action)) {
                when (target) {
                    is PhoneTarget.Element -> if (target.index >= snapshot.elements.size) {
                        return failure(
                            ComputerUseErrorCode.FAILED,
                            "Element [${target.index}] is not in observation ${snapshot.observationId}, which names ${snapshot.elements.size} elements.",
                        )
                    }
                    is PhoneTarget.Point -> if (snapshot.mapping.toDisplay(target.x, target.y) == null) {
                        val size = snapshot.mapping.screenshot
                        return failure(
                            ComputerUseErrorCode.FAILED,
                            "Point (${target.x}, ${target.y}) is outside the ${size.width}×${size.height} screenshot of observation ${snapshot.observationId}.",
                        )
                    }
                }
            }
        }
        return null
    }

    private fun targets(action: PhoneAction): List<PhoneTarget> = when (action) {
        is PhoneAction.Tap -> listOf(action.target)
        is PhoneAction.LongPress -> listOf(action.target)
        is PhoneAction.Swipe -> listOf(action.from, action.to)
        is PhoneAction.Drag -> listOf(action.from, action.to)
        is PhoneAction.Type -> listOfNotNull(action.target)
        is PhoneAction.Clear -> listOf(action.target)
        is PhoneAction.Scroll -> listOf(action.target)
        is PhoneAction.Navigate, is PhoneAction.Launch, PhoneAction.Wake, is PhoneAction.Wait -> emptyList()
    }

    private sealed interface Step {
        data class Done(val performed: String) : Step
        data class Refused(val error: ActError) : Step
    }

    /** Where a target is on the display now, and how a person would name it. */
    private class Located(val point: DisplayPoint, val bounds: PixelRect?, val name: ElementName?, val shown: ScreenshotPoint?, val live: LiveElement?)

    private class Refusal(val error: ActError) : Exception(error.message)

    private fun refuse(code: ComputerUseErrorCode, message: String): Nothing = throw Refusal(ActError(code, message))

    private fun perform(action: PhoneAction, snapshot: Snapshot, session: ActiveSession, budget: Budget, saved: PreparedLoginText?): Step = try {
        Step.Done(run(action, snapshot, session, budget, saved))
    } catch (refusal: Refusal) {
        Step.Refused(refusal.error)
    } catch (error: PersonContactException) {
        Step.Refused(ActError(ComputerUseErrorCode.FAILED, error.message!!))
    } catch (error: LoginTextException) {
        Step.Refused(ActError(ComputerUseErrorCode.FAILED, error.message!!))
    } catch (interrupted: InterruptedException) {
        throw interrupted
    } catch (error: Exception) {
        if (saved == null) throw error
        Step.Refused(ActError(ComputerUseErrorCode.OUTCOME_UNKNOWN, "The saved login may have been typed; observe to see."))
    }

    private fun run(action: PhoneAction, snapshot: Snapshot, session: ActiveSession, budget: Budget, saved: PreparedLoginText?): String = when (action) {
        is PhoneAction.Tap -> {
            val at = locate(action.target, snapshot)
            var admitted = false
            effect(device.tap(at.point, action.count, budget) {
                // A multi-tap's later strokes repeat every check, but not the time already admitted.
                admit(budget, session, if (admitted) 0 else Device.tapMs(action.count), "tap", touch = true)
                admitted = true
            }, "tap")
            Performed.tap(at.name, at.shown, action.count)
        }
        is PhoneAction.LongPress -> {
            val at = locate(action.target, snapshot)
            effect(device.press(at.point, action.durationMs, budget) { admit(budget, session, action.durationMs.toLong(), "long press", touch = true) }, "long press")
            Performed.longPressed(at.name, at.shown)
        }
        is PhoneAction.Swipe -> {
            val from = locate(action.from, snapshot)
            val to = locate(action.to, snapshot)
            effect(device.swipe(from.point, to.point, action.durationMs, budget) { admit(budget, session, action.durationMs.toLong(), "swipe", touch = true) }, "swipe")
            Performed.swiped(shownPoint(from, snapshot), shownPoint(to, snapshot))
        }
        is PhoneAction.Drag -> drag(action, snapshot, session, budget)
        is PhoneAction.Type -> device.edit { type(action, snapshot, session, budget, saved) }
        is PhoneAction.Clear -> device.edit {
            val field = editable(locate(action.target, snapshot), action.target, snapshot)
            if (!device.setText(field, "") { admit(budget, session, 0, "clear", touch = true) }) {
                refuse(ComputerUseErrorCode.UNSUPPORTED, "${describe(field)} did not accept being cleared.")
            }
            Performed.cleared(ElementName(field.label, field.role))
        }
        is PhoneAction.Navigate -> {
            if (!device.navigate(action.to) { admit(budget, session, 0, "navigation", touch = false) }) {
                refuse(ComputerUseErrorCode.FAILED, "The phone did not perform ${action.to.wire}.")
            }
            Performed.navigate(action.to)
        }
        is PhoneAction.Launch -> {
            val app = device.launchable(action.packageName)
                ?: refuse(ComputerUseErrorCode.APP_NOT_FOUND, "No app with the package name ${action.packageName} can be opened on this phone.")
            if (!device.start(app) { admit(budget, session, 0, "launch", touch = false) }) {
                refuse(ComputerUseErrorCode.APP_NOT_FOUND, "No app with the package name ${action.packageName} can be opened on this phone.")
            }
            Performed.launched(action.packageName)
        }
        is PhoneAction.Scroll -> scroll(action, snapshot, session, budget)
        PhoneAction.Wake -> {
            when (device.wake(budget) { admit(budget, session, Device.WAKE_MS, "wake", touch = false) }) {
                Effect.DONE -> Unit
                Effect.FAILED -> refuse(ComputerUseErrorCode.FAILED, "The screen did not turn on.")
                Effect.UNKNOWN -> refuse(ComputerUseErrorCode.OUTCOME_UNKNOWN, "The screen may have turned on; observe to see.")
            }
            Performed.woke()
        }
        is PhoneAction.Wait -> {
            pause(action.ms.toLong(), budget, session)?.let { throw Refusal(it) }
            Performed.waited(action.ms)
        }
    }

    /** A gesture already on the screen is waited for and reported as it went. */
    private fun effect(effect: Effect, what: String) {
        when (effect) {
            Effect.DONE -> Unit
            Effect.FAILED -> refuse(ComputerUseErrorCode.FAILED, "The $what was interrupted.")
            Effect.UNKNOWN -> refuse(ComputerUseErrorCode.OUTCOME_UNKNOWN, "The $what may have taken effect; observe to see.")
        }
    }

    /**
     * Presses, holds while the item lifts, then moves without lifting. The
     * move is admitted on its own once the hold is over. Whatever ends the
     * drag after the press and before Android takes the move — a withdrawal,
     * the owner, the clock, an interrupt, or Android refusing the move — lifts
     * the finger where it pressed, the one gesture still made then. A move
     * Android took, finished or not known to have, ends the stroke itself.
     */
    private fun drag(action: PhoneAction.Drag, snapshot: Snapshot, session: ActiveSession, budget: Budget): String {
        val from = locate(action.from, snapshot)
        val to = locate(action.to, snapshot)
        val contact = device.touchDown(from.point, action.holdMs, budget) {
            admit(budget, session, (action.holdMs + action.durationMs).toLong(), "drag", touch = true)
        } ?: refuse(ComputerUseErrorCode.FAILED, "The drag was interrupted.")
        var moved: Effect? = null
        try {
            val stop = pause(action.holdMs.toLong(), budget, session)
            if (stop != null) refuse(stop.code, "${stop.message} The drag's press was lifted without moving.")
            var moveBudget: Long? = null
            moved = device.move(contact, to.point, action.durationMs, budget) {
                val remaining = budget.remainingMs()
                val elapsed = moveBudget?.let { it - remaining } ?: 0L
                // Every continuation rechecks authority, but already-dispatched motion has spent its duration.
                val needed = (action.durationMs - elapsed).coerceAtLeast(32)
                admitPartway(budget, session, needed, "drag's move", touch = true, "The drag's press was lifted without moving.")
                if (moveBudget == null) moveBudget = remaining
            }
            if (moved == Effect.FAILED) interruption(budget, session)?.let { refuse(it.code, it.message) }
            effect(moved, "drag")
        } finally {
            if (moved == null || moved == Effect.FAILED) device.lift(contact)
        }
        return Performed.dragged(from.name, shownPoint(from, snapshot), shownPoint(to, snapshot))
    }

    /**
     * Inserts at the field's cursor with `ACTION_SET_TEXT`, which replaces
     * the whole text, so the new text is computed here and the cursor put
     * back after it. A field that refuses that is `unsupported`; there is no
     * second way of typing to fall back on. Focusing, setting the text,
     * placing the cursor and submitting are each admitted on their own.
     */
    private fun type(action: PhoneAction.Type, snapshot: Snapshot, session: ActiveSession, budget: Budget, saved: PreparedLoginText?): String {
        fun typingAdmission() {
            admit(budget, session, 0, "typing", touch = true)
            saved?.requireLive()
        }
        val field = when (val target = action.target) {
            null -> device.focusedInput()
                ?: refuse(ComputerUseErrorCode.UNSUPPORTED, "No field has input focus; tap one first or name it as the target.")
            else -> editable(locate(target, snapshot), target, snapshot)
        }
        // A password field's text is masked, so the phone cannot insert into what it cannot read.
        if (field.password && field.textLength > 0) {
            refuse(ComputerUseErrorCode.UNSUPPORTED, "${describe(field)} already holds a password; clear it first.")
        }
        if (action.target != null && !device.focus(field) { typingAdmission() }) {
            refuse(ComputerUseErrorCode.UNSUPPORTED, if (saved != null) "The field cannot take input focus." else "${describe(field)} cannot take input focus.")
        }
        fun insert(text: String): Int {
            val insertion = TextInsertion.insert(field.text, field.selectionStart, field.selectionEnd, text)
            if (!device.setText(field, insertion.text) { typingAdmission() }) {
                refuse(ComputerUseErrorCode.UNSUPPORTED, if (saved != null) "The field did not accept saved login text." else "${describe(field)} did not accept typed text.")
            }
            return insertion.cursor
        }
        val cursor = when (val text = action.text) {
            is PhoneText.Literal -> insert(text.value)
            is PhoneText.Saved -> requireNotNull(saved).useText { insert(it.concatToString()) }
        }
        val typed = if (action.submit) "The text was typed but not submitted." else "The text was typed."
        // The text is in; where the cursor lands only shapes the next insertion.
        device.setSelection(field, cursor, cursor) { admitPartway(budget, session, 0, "cursor", touch = true, typed) }
        if (action.submit) {
            if (!device.imeEnter(field) { admitPartway(budget, session, 0, "submit", touch = true, typed) }) {
                refuse(ComputerUseErrorCode.UNSUPPORTED, "The text was typed, but ${describe(field)} has no keyboard action to submit with.")
            }
        }
        return if (saved != null) "Typed saved ${saved.field}" else Performed.typed((action.text as PhoneText.Literal).value, ElementName(field.label, field.role), field.password, action.submit)
    }

    /**
     * Scrolls in steps of one swipe each, inside the content under the target:
     * the target itself when it scrolls, else the innermost scrolling element
     * around it, so a row of a list scrolls the list rather than the row. It
     * starts only if every step fits the time left, and each step is admitted
     * on its own.
     */
    private fun scroll(action: PhoneAction.Scroll, snapshot: Snapshot, session: ActiveSession, budget: Budget): String {
        val at = locate(action.target, snapshot)
        admit(budget, session, action.amount * AndroidPhoneWire.SCROLL_STEP_MS, "${action.amount} scroll steps", touch = true)
        val scrollsItself = (action.target as? PhoneTarget.Element)?.let { "scrollable" in snapshot.elements[it.index].flags } == true
        val area = at.bounds?.takeIf { scrollsItself } ?: scrollableUnder(at.point, snapshot)
            ?: PixelRect(0, 0, snapshot.display.width, snapshot.display.height)
        val centreX = (area.left + area.right) / 2
        val centreY = (area.top + area.bottom) / 2
        val near = { start: Int, length: Int -> start + length / 4 }
        val far = { start: Int, length: Int -> start + length * 3 / 4 }
        // The finger moves against the content: to bring what is below into view, it swipes up.
        val (from, to) = when (action.direction) {
            ScrollDirection.DOWN -> DisplayPoint(centreX, far(area.top, area.height)) to DisplayPoint(centreX, near(area.top, area.height))
            ScrollDirection.UP -> DisplayPoint(centreX, near(area.top, area.height)) to DisplayPoint(centreX, far(area.top, area.height))
            ScrollDirection.RIGHT -> DisplayPoint(far(area.left, area.width), centreY) to DisplayPoint(near(area.left, area.width), centreY)
            ScrollDirection.LEFT -> DisplayPoint(near(area.left, area.width), centreY) to DisplayPoint(far(area.left, area.width), centreY)
        }
        repeat(action.amount) { step ->
            when (device.swipe(from, to, SCROLL_SWIPE_MS, budget) {
                admitPartway(budget, session, SCROLL_SWIPE_MS.toLong(), "scroll step", touch = true, "Scrolling had moved $step of ${action.amount} steps.")
            }) {
                Effect.DONE -> Unit
                Effect.FAILED -> refuse(ComputerUseErrorCode.FAILED, "Scrolling was interrupted after $step steps.")
                Effect.UNKNOWN -> refuse(ComputerUseErrorCode.OUTCOME_UNKNOWN, "Scrolling may have moved past step $step; observe to see.")
            }
            pause(AndroidPhoneWire.SCROLL_STEP_MS - SCROLL_SWIPE_MS, budget, session)
                ?.let { refuse(it.code, "${it.message} Scrolling had moved ${step + 1} of ${action.amount} steps.") }
        }
        return Performed.scrolled(action.direction, at.name, action.amount)
    }

    /**
     * Waits `ms`, yielding at once to a withdrawal, the owner or the deadline,
     * without interrupting a gesture Android may already have dispatched. The
     * time left is read once per slice, so the slice is never negative.
     */
    private fun pause(ms: Long, budget: Budget, session: ActiveSession): ActError? {
        var remaining = ms
        while (remaining > 0) {
            interruption(budget, session)?.let { return it }
            val left = budget.remainingMs()
            if (left <= 0) return ActError(ComputerUseErrorCode.FAILED, OUT_OF_TIME)
            val slice = minOf(remaining, CANCELLATION_POLL_MS, left)
            device.pause(slice)
            remaining -= slice
        }
        return null
    }

    private fun locate(target: PhoneTarget, snapshot: Snapshot): Located = when (target) {
        is PhoneTarget.Element -> {
            val walked = snapshot.elements[target.index]
            val live = device.resolve(walked.ref) ?: refuse(
                ComputerUseErrorCode.FAILED,
                "Element [${target.index}]${walked.label?.let { " \"${it.take(40)}\"" } ?: ""} is no longer on screen; observe again.",
            )
            Located(centre(live.bounds), live.bounds, ElementName(live.label, live.role), null, live)
        }
        is PhoneTarget.Point -> Located(
            requireNotNull(snapshot.mapping.toDisplay(target.x, target.y)),
            null,
            null,
            ScreenshotPoint(target.x, target.y),
            null,
        )
    }

    /** A point target for typing names the field under it in the cited observation. */
    private fun editable(at: Located, target: PhoneTarget, snapshot: Snapshot): LiveElement {
        val live = at.live ?: snapshot.elements
            .filter { "editable" in it.flags && it.bounds.contains(at.point) }
            .minByOrNull { it.bounds.width.toLong() * it.bounds.height }
            ?.let { device.resolve(it.ref) }
            ?: refuse(ComputerUseErrorCode.UNSUPPORTED, "Nothing that takes text is at ${describe(target)}.")
        if (!live.editable) refuse(ComputerUseErrorCode.UNSUPPORTED, "${describe(live)} does not take text.")
        return live
    }

    private fun scrollableUnder(point: DisplayPoint, snapshot: Snapshot): PixelRect? = snapshot.elements
        .filter { "scrollable" in it.flags && it.bounds.contains(point) }
        .minByOrNull { it.bounds.width.toLong() * it.bounds.height }
        ?.bounds

    private fun shownPoint(at: Located, snapshot: Snapshot): ScreenshotPoint = at.shown ?: snapshot.mapping.toScreenshot(
        PixelRect(at.point.x, at.point.y, at.point.x, at.point.y),
    ).let { ScreenshotPoint(it.left, it.top) }

    private fun centre(bounds: PixelRect) = DisplayPoint((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2)

    private fun PixelRect.contains(point: DisplayPoint) = point.x in left until right && point.y in top until bottom

    private fun describe(element: LiveElement): String = element.label?.takeIf { it.isNotBlank() }?.let { "\"${it.take(40)}\"" } ?: "The ${element.role}"

    private fun describe(target: PhoneTarget): String = when (target) {
        is PhoneTarget.Element -> "element [${target.index}]"
        is PhoneTarget.Point -> "(${target.x}, ${target.y})"
    }

    private fun failure(code: ComputerUseErrorCode, message: String) = ComputerUseOutcome.Failure(code, message)

    companion object {
        /** Long enough for a tap's ripple, a keyboard or a screen transition to begin before the next action. */
        const val SETTLE_MS = 250L
        private const val CANCELLATION_POLL_MS = 50L
        private const val SCROLL_SWIPE_MS = 300
        const val PAUSED = "Paused on the phone: its owner has stopped agents from using it."
        const val STOPPED = "The phone's owner stopped this task on the phone."
        const val CANCELLED = "The request was cancelled before the batch completed."
        const val OUT_OF_TIME = "The request ran out of time; the actions after the last one performed did not run. Observe to see the screen."
        private const val ENDED = "The session ended while the phone was working for it; nothing more is done or shown for it."
        private const val PROTECTED =
            "The screen was protected while the phone looked at it, so nothing of that look is shared; observe again."
        private const val OUT_OF_TIME_OBSERVING = "The request ran out of time before the phone finished observing; observe again."
        const val OWN_APP =
            "The Opensteer Agent Phone app is in front, and agents may not operate it. Navigate home or launch another app first."
        const val OWN_APP_LAUNCH = "Agents may not open the Opensteer Agent Phone app; launch another app."
    }
}
