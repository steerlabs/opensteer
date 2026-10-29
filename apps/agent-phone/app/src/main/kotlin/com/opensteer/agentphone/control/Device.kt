package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.DisplayState
import com.opensteer.agentphone.wire.Foreground
import com.opensteer.agentphone.wire.Navigation
import com.opensteer.agentphone.wire.PixelRect
import com.opensteer.agentphone.wire.PixelSize
import com.opensteer.agentphone.wire.ScreenshotOutcome
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** One element of a walk, kept so an action can find exactly that element again — never a guess. */
interface ElementRef

/** A point in display pixels, in the display's current rotation. */
data class DisplayPoint(val x: Int, val y: Int)

/** A point in an observation's screenshot pixels. */
data class ScreenshotPoint(val x: Int, val y: Int)

/** An element as a walk found it, in display pixels. */
data class WalkedElement(
    val depth: Int,
    val role: String,
    val label: String?,
    val bounds: PixelRect,
    val flags: List<String>,
    val ref: ElementRef,
)

/** The elements of the screen, in the order an agent should read them, and how many the limit left out. */
data class Walk(val elements: List<WalkedElement>, val omitted: Int)

/** An element as it is now, which an action targets. */
data class LiveElement(
    val bounds: PixelRect,
    val label: String?,
    val role: String,
    val editable: Boolean,
    val password: Boolean,
    /** The field's own text; password values and hints are never retained. */
    val text: String,
    val selectionStart: Int,
    val selectionEnd: Int,
    val ref: ElementRef,
    /** Kept separately so password insertion and owner editing need no password value. */
    val textLength: Int = text.length,
)

/** One activity a launcher shows, as Android lists it; a package can have several. */
data class LauncherEntry(val packageName: String, val label: String)

/**
 * A request's authority, withdrawn: read at every admission and during every
 * wait, so nothing more is done for it; a dispatched gesture cannot be taken
 * back. The first withdrawal is the one its answer names.
 */
class Cancellation {
    enum class Reason {
        /** The Host cancelled it, closed its session, or lost the stream. */
        CANCELLED,

        /** The owner stopped its Run on the phone. */
        STOPPED,

        /** The owner paused the phone. */
        PAUSED,

        /** Only agent acts are withdrawn when the owner takes control. */
        OWNER_CONTROL,
    }

    private val withdrawn = AtomicReference<Reason?>(null)

    val reason: Reason? get() = withdrawn.get()

    val requested: Boolean get() = withdrawn.get() != null

    fun withdraw(reason: Reason) {
        withdrawn.compareAndSet(null, reason)
    }
}

/**
 * The time one request has left on the phone, on its monotonic clock, and
 * whether it was cancelled. `until` is the request's deadline less the time
 * kept back to answer it, so nothing that waits on it runs into the answer.
 */
class Budget(private val elapsed: () -> Long, val until: Long, val cancel: Cancellation) {
    fun remainingMs(): Long = until - elapsed()

    val expired: Boolean get() = remainingMs() <= 0

    /** Whatever is waiting on Android should stop now. */
    val halted: Boolean get() = cancel.requested || expired

    fun fits(ms: Long): Boolean = remainingMs() >= ms
}

/** What became of something the phone asked Android to do. */
enum class Effect {
    /** Android did it. */
    DONE,

    /** Android refused it, or cancelled it part way. */
    FAILED,

    /** It reached the screen, but whether it took effect could not be learned in time. */
    UNKNOWN,
}

/** A finger `touchDown` left on the screen, which only `move` or `lift` takes off. */
interface Contact

/** An app's resolved launch intent, ready to start without another package lookup. */
interface Launchable

/** The session holding the phone, the Run it belongs to, and the task's title, which the phone's own notification names. */
data class ActiveSession(val id: String, val runId: String, val title: String?)

/**
 * The phone as the desk operates it: the accessibility service on a device,
 * a recording fake in the JVM tests. Every call blocks until done, and none
 * that waits on Android waits past its budget; the desk calls them from its
 * executor threads.
 *
 * Each method that changes the phone prepares its Android arguments and
 * reads any Android state first, then calls `admit` immediately before the
 * effect. Admission may throw to refuse it. No Android read or preparation
 * follows that final decision, so a withdrawal during preparation is seen.
 * A gesture Android took is answered DONE or UNKNOWN, even when the wait for
 * its answer is interrupted: the interrupt is kept, never turned into a
 * gesture that was not made.
 */
interface Device {
    fun display(): DisplayState

    /** The app in front, this one included, labelled as the launcher labels it. */
    fun foreground(): Foreground?

    fun contentlessHelperShowing(): Boolean = false

    /** Walks every window but this app's own, keeping at most `limit` elements; null if the budget ran out first. */
    fun walk(limit: Int, budget: Budget): Walk?

    /**
     * The whole display, scaled to `size`, as JPEG whose base64 fits
     * `maxBase64Length`; `Failed` if none came in time. A picture
     * never takes the turn an agent's observation needs.
     */
    fun screenshot(size: PixelSize, maxBase64Length: Int, budget: Budget): ScreenshotOutcome

    /** The element now, or null when it has gone or is no longer what the walk saw. */
    fun resolve(ref: ElementRef): LiveElement?

    /** The editable element with input focus, if any. */
    fun focusedInput(): LiveElement?

    fun tap(point: DisplayPoint, count: Int, budget: Budget, admit: () -> Unit): Effect

    fun press(point: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit): Effect

    fun swipe(from: DisplayPoint, to: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit): Effect

    /** Puts a finger down at `point` and leaves it there; null when Android refused it, so no finger is down. */
    fun touchDown(point: DisplayPoint, holdMs: Int, budget: Budget, admit: () -> Unit): Contact?

    /** Moves a held finger to `to` over `durationMs`, then lifts it. */
    fun move(contact: Contact, to: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit): Effect

    /**
     * Lifts a held finger where it is. It is the one gesture made for a
     * request after its authority or time is gone, because it ends a touch
     * rather than starting one.
     */
    fun lift(contact: Contact)

    /** Gives the field input focus, as tapping into it would. */
    fun focus(element: LiveElement, admit: () -> Unit): Boolean

    fun setText(element: LiveElement, text: String, admit: () -> Unit): Boolean

    fun setSelection(element: LiveElement, start: Int, end: Int, admit: () -> Unit): Boolean

    fun imeEnter(element: LiveElement, admit: () -> Unit): Boolean

    fun navigate(to: Navigation, admit: () -> Unit): Boolean

    /** Resolves the app before admission; null when the package has no launchable activity here. */
    fun launchable(packageName: String): Launchable?

    fun start(app: Launchable, admit: () -> Unit): Boolean

    /** Turns the screen on, and dismisses a lock screen that needs no credential. */
    fun wake(budget: Budget, admit: () -> Unit): Effect

    fun pause(ms: Long)

    /** Every launcher activity in this app's own Android user, which `launch` can open. */
    fun launcherEntries(): List<LauncherEntry>

    companion object {
        /** One touch of a tap, and the spacing between a double tap's two. */
        const val TAP_MS = 50L
        const val DOUBLE_TAP_SPACING_MS = 150L

        /** How long a tap of `count` touches takes on the screen. */
        fun tapMs(count: Int): Long = (count - 1) * DOUBLE_TAP_SPACING_MS + TAP_MS

        /** The longest `wake` waits: its activity's own lifetime and the grace for it to go. */
        const val WAKE_MS = WakeActivity.LONGEST_MS + 1_000L
    }
}

/**
 * Android's answer to a gesture it took, waited for at most `waitMs`: DONE or
 * FAILED as Android said, UNKNOWN when it did not say in time. An interrupt
 * during the wait is UNKNOWN as well — the gesture is on the screen, and is
 * never undone — and the interrupt is kept for whoever runs this thread.
 */
fun gestureAnswer(answered: CountDownLatch, completed: AtomicBoolean, waitMs: Long): Effect {
    val said = try {
        answered.await(waitMs.coerceAtLeast(0), TimeUnit.MILLISECONDS)
    } catch (interrupted: InterruptedException) {
        Thread.currentThread().interrupt()
        false
    }
    return when {
        !said -> Effect.UNKNOWN
        completed.get() -> Effect.DONE
        else -> Effect.FAILED
    }
}
