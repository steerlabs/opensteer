package com.opensteer.agentphone.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.opensteer.agentphone.wire.DisplayState
import com.opensteer.agentphone.wire.Foreground
import com.opensteer.agentphone.wire.Ids
import com.opensteer.agentphone.wire.Navigation
import com.opensteer.agentphone.wire.PixelRect
import com.opensteer.agentphone.wire.PixelSize
import com.opensteer.agentphone.wire.Screenshot
import com.opensteer.agentphone.wire.ScreenshotOutcome
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * The phone as the accessibility service sees and moves it. Every method
 * blocks until Android has answered, or until the request's budget is spent,
 * and is called from the desk's executor threads, never the main thread.
 */
class AccessibilityDevice(private val service: AccessibilityService, private val gestures: AndroidGestures) : Device {
    private val main = Handler(Looper.getMainLooper())
    private val power = service.getSystemService(PowerManager::class.java)
    private val keyguard = service.getSystemService(KeyguardManager::class.java)
    private val displays = service.getSystemService(DisplayManager::class.java)
    private val turns = ScreenshotTurns()

    /**
     * An element exactly as the walk found it. The node is the element's own
     * accessibility identity, so `refresh` finds that element or nothing; the
     * rest is what it showed, so a recycled view now showing something else
     * is refused rather than mistaken for it.
     */
    private class NodeRef(
        val node: AccessibilityNodeInfo,
        val windowId: Int,
        val className: String?,
        val viewId: String?,
        val text: String?,
        val description: String?,
        val hint: String?,
        val editable: Boolean,
        val password: Boolean,
    ) : ElementRef

    override fun display(): DisplayState {
        val display = displays.getDisplay(Display.DEFAULT_DISPLAY)
        val metrics = DisplayMetrics()
        // The logical size in the current rotation, which gestures and screenshots use.
        @Suppress("DEPRECATION")
        display.getRealMetrics(metrics)
        return DisplayState(
            width = metrics.widthPixels,
            height = metrics.heightPixels,
            rotation = display.rotation * 90,
            interactive = power.isInteractive,
            locked = keyguard.isKeyguardLocked,
            secureLock = keyguard.isDeviceSecure,
        )
    }

    override fun contentlessHelperShowing() = WakeActivity.showing || com.opensteer.agentphone.display.ProjectionActivity.showing

    override fun foreground(): Foreground? {
        // Android can leave no active window after the keyguard hands the
        // screen back to an app that already had focus; the top application
        // window is then the one in front.
        val root = service.rootInActiveWindow
            ?: service.windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }.maxByOrNull { it.layer }?.root
        val packageName = root?.packageName?.toString() ?: return null
        if (packageName.length !in 3..255 || !Ids.androidPackage.matches(packageName)) return null
        return Foreground(packageName, label(packageName))
    }

    /**
     * The name the launcher shows for a package. The manifest's
     * `QUERY_ALL_PACKAGES` makes every installed package visible here — the
     * launcher, the system UI and apps with no launcher entry, which are in
     * front as often as any other — so a package Android cannot find has just
     * been removed. Android answers an app that declares no label with its
     * package name; that is no label at all.
     */
    private fun label(packageName: String): String? {
        val manager = service.packageManager
        val info = try {
            manager.getApplicationInfo(packageName, 0)
        } catch (removed: PackageManager.NameNotFoundException) {
            return null
        }
        val label = manager.getApplicationLabel(info).toString().trim().take(255)
        return label.takeIf { it.isNotEmpty() && it != packageName }
    }

    override fun walk(limit: Int, budget: Budget): Walk? {
        val elements = ArrayList<WalkedElement>()
        val omitted = AtomicInteger()
        val visits = AtomicInteger()
        var spent = false
        fun visit(node: AccessibilityNodeInfo, depth: Int, windowId: Int) {
            // Each node is a call into the app that owns it, and a hung app answers slowly.
            if (spent || budget.halted) {
                spent = true
                return
            }
            // A tree can be unbounded; past this many nodes nothing more is read.
            if (visits.incrementAndGet() > MAX_VISITS || !node.isVisibleToUser) return
            val bounds = Rect().also(node::getBoundsInScreen)
            val label = treeLabel(node)
            val included = !bounds.isEmpty && (
                label != null || node.isClickable || node.isLongClickable || node.isEditable ||
                    node.isScrollable || node.isCheckable
                )
            if (included) {
                if (elements.size < limit) {
                    elements += WalkedElement(depth, role(node), label, bounds.toPixelRect(), flags(node), ref(node, windowId))
                } else {
                    omitted.incrementAndGet()
                }
            }
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { visit(it, if (included) depth + 1 else depth, windowId) }
            }
        }
        // Topmost first: what covers the screen is what an agent must read first.
        for (window in service.windows.sortedByDescending { it.layer }) {
            if (window.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) continue
            val root = window.root ?: continue
            // This app's own windows, including its Pause switch, are never shown to an agent.
            if (root.packageName?.toString() == service.packageName) continue
            visit(root, 0, window.id)
        }
        return if (spent) null else Walk(elements, omitted.get())
    }

    /**
     * The screenshot Android gives is the screenshot, a secure window's
     * blacked-out pixels included. Agent observations serialize and retry when
     * Android's screenshot interval permits. Human viewing uses MediaProjection.
     */
    override fun screenshot(size: PixelSize, maxBase64Length: Int, budget: Budget): ScreenshotOutcome {
        val full = turns.forAgent(budget.remainingMs()) { capture(budget, retry = true) } ?: return ScreenshotOutcome.Failed
        try {
            val scaled = Bitmap.createScaledBitmap(full, size.width, size.height, true)
            try {
                val bytes = JpegBudget.encode(maxBase64Length) { quality ->
                    ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()
                } ?: return ScreenshotOutcome.Failed
                return ScreenshotOutcome.Taken(Screenshot(JpegBudget.base64(bytes), size.width, size.height))
            } finally {
                if (scaled !== full) scaled.recycle()
            }
        } finally {
            full.recycle()
        }
    }

    /**
     * The display as a software bitmap. Android refuses a service's
     * screenshot that comes sooner than its interval after the last one, and
     * consecutive observations can collide on that, so a refusal for that reason alone is retried once
     * the interval has passed, if `retry` and the budget allow. Every wait ends
     * as soon as the request is withdrawn.
     */
    private fun capture(budget: Budget, retry: Boolean): Bitmap? {
        repeat(2) { attempt ->
            val wait = minOf(SCREENSHOT_WAIT_MS, budget.remainingMs())
            if (wait <= 0 || budget.halted) return null
            val latch = CountDownLatch(1)
            val bitmap = AtomicReference<Bitmap?>()
            val error = AtomicInteger(0)
            service.takeScreenshot(
                Display.DEFAULT_DISPLAY,
                { it.run() },
                object : AccessibilityService.TakeScreenshotCallback {
                    override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                        val buffer = screenshot.hardwareBuffer
                        try {
                            bitmap.set(Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)?.copy(Bitmap.Config.ARGB_8888, false))
                        } finally {
                            buffer.close()
                            latch.countDown()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        error.set(errorCode)
                        latch.countDown()
                    }
                },
            )
            awaitUnlessHalted(latch, wait, budget)
            bitmap.get()?.let { return it }
            if (!retry || attempt == 1 || error.get() != AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) return null
            if (!budget.fits(SCREENSHOT_INTERVAL_MS)) return null
            rest(SCREENSHOT_INTERVAL_MS, budget)
            if (budget.halted) return null
        }
        return null
    }

    /** Sleeps `ms` in slices, waking early once the request is withdrawn. */
    private fun rest(ms: Long, budget: Budget) {
        val deadline = SystemClock.elapsedRealtime() + ms
        while (!budget.halted) {
            val left = deadline - SystemClock.elapsedRealtime()
            if (left <= 0) return
            Thread.sleep(minOf(left, POLL_MS))
        }
    }

    /** Waits for `latch` at most `ms`, in slices, giving up once the request is withdrawn. */
    private fun awaitUnlessHalted(latch: CountDownLatch, ms: Long, budget: Budget) {
        val deadline = SystemClock.elapsedRealtime() + ms
        while (!budget.halted) {
            val left = deadline - SystemClock.elapsedRealtime()
            if (left <= 0 || latch.await(minOf(left, POLL_MS), TimeUnit.MILLISECONDS)) return
        }
    }

    override fun resolve(ref: ElementRef): LiveElement? {
        val element = ref as NodeRef
        val node = element.node
        if (!node.refresh() || !node.isVisibleToUser || node.windowId != element.windowId) return null
        if (node.className?.toString() != element.className || node.viewIdResourceName != element.viewId) return null
        if (node.isEditable != element.editable || node.isPassword != element.password) return null
        if (!element.password && (node.contentDescription?.toString() != element.description || node.hintText?.toString() != element.hint)) return null
        // Current field text can change as its owner types; its semantic label
        // cannot, or a recycled editor would write into another row's field.
        if (!element.password && !element.editable && node.text?.toString() != element.text) return null
        return live(node, element)
    }

    private var ownerFocusFlags = -1
    fun ownerFocusedNode(): AccessibilityNodeInfo? {
        val node = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        val refreshed = node?.refresh() == true
        val focused = refreshed && node?.isFocused == true
        val editable = refreshed && node?.isEditable == true
        val external = refreshed && node?.packageName?.toString() != service.packageName
        val editor = ownerFocusedEditor(service)
        val flags = (if (node != null) 1 else 0) or (if (refreshed) 2 else 0) or
            (if (focused) 4 else 0) or (if (editable) 8 else 0) or (if (external) 16 else 0) or (if (editor != null) 32 else 0)
        if (flags != ownerFocusFlags) {
            ownerFocusFlags = flags
            android.util.Log.d("OpensteerDisplay", "Owner focus found=${node != null} refreshed=$refreshed focused=$focused editable=$editable external=$external resolved=${editor != null}")
        }
        return editor
    }
    fun ownerNode(field: LiveElement): AccessibilityNodeInfo = (field.ref as NodeRef).node

    override fun focusedInput(): LiveElement? = ownerFocusedNode()?.let { live(it, ref(it, it.windowId)) }

    /** Resolve the editor before a tap can move it with the IME. Never retain screen coordinates as focus authority. */
    fun ownerEditorAt(at: DisplayPoint): AccessibilityNodeInfo? {
        fun find(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
            val bounds = Rect().also(node::getBoundsInScreen)
            if (!node.isVisibleToUser || !bounds.contains(at.x, at.y)) return null
            for (index in 0 until node.childCount) node.getChild(index)?.let { find(it)?.let { found -> return found } }
            return node.takeIf { it.isEditable && it.packageName?.toString() != service.packageName }
        }
        for (window in service.windows.sortedByDescending { it.layer }) {
            val root = window.root ?: continue
            find(root)?.let { return it }
            if (window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD && Rect().also(window::getBoundsInScreen).contains(at.x, at.y)) return null
        }
        return null
    }

    fun ownerFocusedInput(expected: AccessibilityNodeInfo?, admit: () -> Unit): LiveElement? {
        val until = SystemClock.elapsedRealtime() + 1000
        do {
            admit()
            val node = ownerFocusedNode()
            if (node != null && (expected == null || node == expected)) return live(node, ref(node, node.windowId))
            Thread.sleep(10)
        } while (SystemClock.elapsedRealtime() < until)
        android.util.Log.d("OpensteerDisplay", "Owner editing refused stage=focus-unavailable targetExpected=${expected != null} currentEditor=${ownerFocusedNode() != null}")
        return null
    }

    private val ownerPassword = OwnerPassword()
    fun clearOwnerText() = ownerPassword.clear()

    fun ownerEdit(field: LiveElement, insert: String?, delete: Int, admit: () -> Unit): Boolean {
        val node = (field.ref as NodeRef).node
        if (!node.refresh() || !node.isFocused || !node.isEditable) {
            android.util.Log.d("OpensteerDisplay", "Owner editing refused stage=field-refresh")
            return false
        }
        if (node.textSelectionStart != field.selectionStart || node.textSelectionEnd != field.selectionEnd ||
            !field.password && (if (node.isShowingHintText) "" else node.text?.toString().orEmpty()) != field.text) {
            android.util.Log.d("OpensteerDisplay", "Owner editing refused stage=field-changed")
            return false
        }
        val edit = if (field.password) ownerPassword.edit(node, field.textLength, field.selectionStart, field.selectionEnd, insert, delete)
            else if (insert != null) TextInsertion.insert(field.text, field.selectionStart, field.selectionEnd, insert)
            else TextInsertion.deleteBackward(field.text, field.selectionStart, field.selectionEnd, delete)
        if (edit == null) {
            android.util.Log.w("OpensteerDisplay", "Owner password edit refused: no IME connection and this lease does not know the field value; empty the field on the phone first")
            return false
        }
        if (!setText(field, edit.text, admit)) {
            android.util.Log.d("OpensteerDisplay", "Owner editing refused stage=set-text")
            ownerPassword.clear()
            return false
        }
        val until = SystemClock.elapsedRealtime() + 1000
        var selectionSent = false
        do {
            admit()
            if (!node.refresh() || !node.isFocused || !node.isEditable || ownerFocusedNode() != node) return false
            val textReady = field.password || (if (node.isShowingHintText) "" else node.text?.toString().orEmpty()) == edit.text
            if (textReady) {
                val atCursor = node.textSelectionStart == edit.cursor && node.textSelectionEnd == edit.cursor ||
                    edit.text.isEmpty() && node.textSelectionStart == -1 && node.textSelectionEnd == -1
                if (atCursor) return true
                if (!selectionSent) {
                    setSelection(field, edit.cursor, edit.cursor, admit)
                    selectionSent = true
                }
            }
            Thread.sleep(10)
        } while (SystemClock.elapsedRealtime() < until)
        android.util.Log.d("OpensteerDisplay", "Owner editing refused stage=cursor-unsettled")
        return false
    }

    override fun tap(point: DisplayPoint, count: Int, budget: Budget, admit: () -> Unit): Effect {
        val gesture = GestureDescription.Builder()
        repeat(count) { gesture.addStroke(GestureDescription.StrokeDescription(at(point), it * Device.DOUBLE_TAP_SPACING_MS, Device.TAP_MS)) }
        return dispatch(gesture.build(), Device.tapMs(count), budget, admit)
    }

    override fun press(point: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit): Effect = dispatch(
        GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(at(point), 0, durationMs.toLong())).build(),
        durationMs.toLong(),
        budget,
        admit,
    )

    override fun swipe(from: DisplayPoint, to: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit): Effect = dispatch(
        GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(line(from, to), 0, durationMs.toLong())).build(),
        durationMs.toLong(),
        budget,
        admit,
    )

    private class Held(val point: DisplayPoint, @Volatile var admit: () -> Unit) : Contact {
        val finished = java.util.concurrent.CompletableFuture<Boolean>()
    }

    override fun touchDown(point: DisplayPoint, holdMs: Int, budget: Budget, admit: () -> Unit): Contact? {
        val held = Held(point, admit)
        val started = java.util.concurrent.CompletableFuture<Boolean>()
        admit()
        gestures.scheduler.down(point, { !budget.halted && runCatching { held.admit() }.isSuccess }, watchdog = false,
            done = { held.finished.complete(it) }, onStarted = { started.complete(it) })
        val accepted = try { started.get(minOf(1500, budget.remainingMs()).coerceAtLeast(1), TimeUnit.MILLISECONDS) }
            catch (_: java.util.concurrent.TimeoutException) { true }
            catch (_: InterruptedException) { Thread.currentThread().interrupt(); true }
        return if (accepted) held else null
    }

    override fun move(contact: Contact, to: DisplayPoint, durationMs: Int, budget: Budget, admit: () -> Unit): Effect {
        val held = contact as Held
        admit()
        held.admit = admit
        val steps = (durationMs / 32).coerceAtLeast(1)
        for (step in 1..steps) gestures.after(durationMs.toLong() * step / steps) {
            if (!held.finished.isDone) {
                val at = DisplayPoint(held.point.x + (to.x - held.point.x) * step / steps,
                    held.point.y + (to.y - held.point.y) * step / steps)
                if (step == steps) gestures.scheduler.up(at) else gestures.scheduler.move(at)
            }
        }
        return try {
            if (held.finished.get(minOf(durationMs + 1500L, budget.remainingMs()).coerceAtLeast(1), TimeUnit.MILLISECONDS)) Effect.DONE else Effect.FAILED
        } catch (_: java.util.concurrent.TimeoutException) { gestures.scheduler.cancel(); Effect.UNKNOWN }
        catch (_: InterruptedException) { gestures.scheduler.cancel(); Thread.currentThread().interrupt(); Effect.UNKNOWN }
    }

    override fun lift(contact: Contact) { gestures.scheduler.cancel() }

    override fun focus(element: LiveElement, admit: () -> Unit): Boolean {
        val node = (element.ref as NodeRef).node
        val focused = node.isFocused
        admit()
        return focused || node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    }

    override fun setText(element: LiveElement, text: String, admit: () -> Unit): Boolean {
        val node = (element.ref as NodeRef).node
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        admit()
        return try { node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) } finally { args.clear() }
    }

    override fun setSelection(element: LiveElement, start: Int, end: Int, admit: () -> Unit): Boolean {
        val node = (element.ref as NodeRef).node
        val args = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end)
        }
        admit()
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, args)
    }

    override fun imeEnter(element: LiveElement, admit: () -> Unit): Boolean {
        val node = (element.ref as NodeRef).node
        val action = AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id
        admit()
        return node.performAction(action)
    }

    override fun navigate(to: Navigation, admit: () -> Unit): Boolean {
        val action = when (to) {
            Navigation.BACK -> AccessibilityService.GLOBAL_ACTION_BACK
            Navigation.HOME -> AccessibilityService.GLOBAL_ACTION_HOME
            Navigation.RECENTS -> AccessibilityService.GLOBAL_ACTION_RECENTS
            Navigation.NOTIFICATIONS -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
            Navigation.QUICK_SETTINGS -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
        }
        admit()
        return service.performGlobalAction(action)
    }

    private class App(val intent: Intent) : Launchable

    override fun launchable(packageName: String): Launchable? = service.packageManager.getLaunchIntentForPackage(packageName)
        ?.let { App(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }

    override fun start(app: Launchable, admit: () -> Unit): Boolean {
        val intent = (app as App).intent
        admit()
        return try {
            service.startActivity(intent)
            true
        } catch (missing: ActivityNotFoundException) {
            false
        } catch (unexported: SecurityException) {
            false
        }
    }

    override fun launcherEntries(): List<LauncherEntry> {
        val manager = service.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        // Without a match flag Android answers for this app's own user only, which is the user `launch` opens apps in.
        val found = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            manager.queryIntentActivities(launcher, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            manager.queryIntentActivities(launcher, 0)
        }
        // Only an activity another app may start is one `launch` can open.
        return found.filter { it.activityInfo.exported }
            .map { LauncherEntry(it.activityInfo.packageName, it.loadLabel(manager).toString()) }
    }

    /**
     * `WakeActivity` turns the screen on and dismisses a lock screen that
     * needs no credential. It is this app's own window, so the wake is done
     * only once it has gone: until then the app in front is Opensteer, which
     * an agent may neither see nor touch.
     */
    override fun wake(budget: Budget, admit: () -> Unit): Effect {
        val alreadyAwake = power.isInteractive && !keyguard.isKeyguardLocked
        val started = WakeActivity.started
        val intent = Intent(service, WakeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
        admit()
        if (alreadyAwake) return Effect.DONE
        service.startActivity(intent)
        waitUntil(WAKE_WAIT_MS, budget) { power.isInteractive }
        if (!keyguard.isDeviceSecure) waitUntil(WAKE_WAIT_MS, budget) { !keyguard.isKeyguardLocked }
        val gone = waitUntil(WakeActivity.LONGEST_MS + WAKE_GONE_GRACE_MS, budget) { WakeActivity.started > started && !WakeActivity.showing }
        return when {
            // Its window may still be up, and with it whether the screen stays on.
            !gone && budget.expired -> Effect.UNKNOWN
            power.isInteractive -> Effect.DONE
            else -> Effect.FAILED
        }
    }

    override fun pause(ms: Long) {
        Thread.sleep(ms)
    }

    /** Polls `condition` for at most `longestMs`, never past the budget nor once the request is withdrawn; true once it holds. */
    private fun waitUntil(longestMs: Long, budget: Budget, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.elapsedRealtime() + minOf(longestMs, budget.remainingMs())
        while (!condition()) {
            val left = deadline - SystemClock.elapsedRealtime()
            if (left <= 0 || budget.halted) return false
            Thread.sleep(minOf(left, POLL_MS))
        }
        return true
    }

    /**
     * Dispatches one gesture and waits for Android's answer — no longer than
     * the budget allows, but past a cancel, because a gesture on the screen
     * cannot be taken back and its completed progress is part of the answer.
     */
    private fun dispatch(gesture: GestureDescription, durationMs: Long, budget: Budget, admit: () -> Unit): Effect {
        val latch = CountDownLatch(1)
        val completed = AtomicBoolean(false)
        val callback = object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription) {
                completed.set(true)
                latch.countDown()
            }

            override fun onCancelled(gestureDescription: GestureDescription) {
                latch.countDown()
            }
        }
        admit()
        if (!service.dispatchGesture(gesture, callback, main)) return Effect.FAILED
        return gestureAnswer(latch, completed, minOf(durationMs + GESTURE_GRACE_MS, budget.remainingMs()))
    }

    private fun live(node: AccessibilityNodeInfo, ref: NodeRef): LiveElement {
        val bounds = Rect().also(node::getBoundsInScreen)
        return LiveElement(
            bounds = bounds.toPixelRect(),
            label = fieldName(node),
            role = role(node),
            editable = node.isEditable,
            password = node.isPassword,
            text = if (node.isShowingHintText || node.isPassword) "" else node.text?.toString() ?: "",
            textLength = if (node.isShowingHintText) 0 else node.text?.length ?: 0,
            selectionStart = node.textSelectionStart,
            selectionEnd = node.textSelectionEnd,
            ref = ref,
        )
    }

    private fun ref(node: AccessibilityNodeInfo, windowId: Int) = NodeRef(
        node = node,
        windowId = windowId,
        className = node.className?.toString(),
        viewId = node.viewIdResourceName,
        text = if (node.isPassword) null else node.text?.toString(),
        description = if (node.isPassword) null else node.contentDescription?.toString(),
        hint = if (node.isPassword) null else node.hintText?.toString(),
        editable = node.isEditable,
        password = node.isPassword,
    )

    /** What the tree shows of an element: its text, else its description, else a field's hint. */
    private fun treeLabel(node: AccessibilityNodeInfo): String? = if (node.isPassword) "Password" else listOfNotNull(
        node.text?.toString(),
        node.contentDescription?.toString(),
        node.hintText?.toString(),
    ).map(String::trim).firstOrNull(String::isNotEmpty)

    /** What a person calls an element: for a field its name, never what was typed into it. */
    private fun fieldName(node: AccessibilityNodeInfo): String? = if (node.isPassword) "Password" else if (node.isEditable) {
        listOfNotNull(node.contentDescription?.toString(), node.hintText?.toString()).map(String::trim).firstOrNull(String::isNotEmpty)
    } else {
        treeLabel(node)
    }

    /** `android.widget.Button` → `button`. */
    private fun role(node: AccessibilityNodeInfo): String =
        node.className?.toString()?.substringAfterLast('.')?.lowercase()?.ifEmpty { null } ?: "view"

    private fun flags(node: AccessibilityNodeInfo): List<String> = buildList {
        if (node.isClickable) add("clickable")
        if (node.isEditable) add("editable")
        if (node.isScrollable) add("scrollable")
        if (node.isCheckable) add(checkedFlag(node))
        if (node.isSelected) add("selected")
        if (node.isFocused) add("focused")
        if (!node.isEnabled) add("disabled")
        if (node.isPassword) add("password")
    }

    /** API 36 adds a partly checked state; earlier releases know only checked or not. */
    private fun checkedFlag(node: AccessibilityNodeInfo): String = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
        when (node.checked) {
            AccessibilityNodeInfo.CHECKED_STATE_TRUE -> "checked"
            AccessibilityNodeInfo.CHECKED_STATE_PARTIAL -> "partly-checked"
            else -> "unchecked"
        }
    } else {
        @Suppress("DEPRECATION")
        if (node.isChecked) "checked" else "unchecked"
    }

    private fun Rect.toPixelRect() = PixelRect(left, top, right, bottom)

    private fun at(point: DisplayPoint) = Path().apply { moveTo(point.x.toFloat(), point.y.toFloat()) }

    private fun line(from: DisplayPoint, to: DisplayPoint) = Path().apply {
        moveTo(from.x.toFloat(), from.y.toFloat())
        lineTo(to.x.toFloat(), to.y.toFloat())
    }

    private companion object {
        const val MAX_VISITS = 6_000
        const val GESTURE_GRACE_MS = 3_000L
        const val LIFT_MS = 10L
        const val SCREENSHOT_WAIT_MS = 5_000L

        /**
         * `AccessibilityService.ACCESSIBILITY_TAKE_SCREENSHOT_REQUEST_INTERVAL_TIMES_MS`,
         * which the SDK hides: a second on Android 11, a third of one since
         * Android 12. Retrying sooner is refused again.
         */
        val SCREENSHOT_INTERVAL_MS = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) 333L else 1_000L) + 50L
        const val WAKE_WAIT_MS = 3_000L
        const val WAKE_GONE_GRACE_MS = 1_000L
        const val POLL_MS = 50L
    }
}

/** A provider can focus its host View while its editable virtual descendant owns input. */
@android.annotation.TargetApi(33)
internal fun ownerFocusedEditor(service: AccessibilityService): AccessibilityNodeInfo? {
    val root = service.rootInActiveWindow ?: return null
    if (!root.refresh()) return null
    var editor: AccessibilityNodeInfo? = null
    var ambiguous = false
    fun find(node: AccessibilityNodeInfo) {
        if (ambiguous) return
        if (node.isFocused && node.isEditable && node.refresh() && node.isFocused && node.isEditable &&
            node.windowId == root.windowId && node.packageName?.toString() != service.packageName) {
            if (editor != null && editor != node) ambiguous = true else editor = node
        }
        for (index in 0 until node.childCount) node.getChild(index)?.let(::find)
    }
    find(root)
    return if (ambiguous) null else editor
}
