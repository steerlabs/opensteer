package com.opensteer.agentphone.display

import android.app.Instrumentation
import android.content.Intent
import android.os.SystemClock
import com.opensteer.agentphone.phone
import com.opensteer.agentphone.control.*
import com.opensteer.agentphone.runner.PhoneCall
import com.opensteer.agentphone.runner.PhoneRequest
import com.opensteer.agentphone.wire.*
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Real accessibility/runtime with a loopback WebSocket peer, on a dedicated unpaired emulator.
 * Failures: data socket never opens, person input bypasses gates or invalidates observations,
 * contacts overlap, reset replays queued work, drag loses its hold, off/on reuses pixels, own-app protection fails to lift,
 * socket failure ends the runtime. Reflection keeps test admission out of the shipping interface.
 */
internal class DisplayRuntimeAcceptance(private val instrumentation: Instrumentation) {
    private val context = instrumentation.targetContext
    private val directory = File(context.filesDir, "display-acceptance")
    private fun until(what: String, timeoutMs: Long = 10000, condition: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + timeoutMs
        while (!condition()) {
            if (SystemClock.elapsedRealtime() >= end) {
                File(directory, "timeout-threads.txt").writeText(Thread.getAllStackTraces().entries.joinToString("\n\n") { (thread, trace) ->
                    "${thread.name}: ${thread.state}\n" + trace.joinToString("\n")
                })
                error("Timed out: $what")
            }
            Thread.sleep(20)
        }
    }
    private inline fun <reified T> field(owner: Any, name: String): T = owner.javaClass.getDeclaredField(name).let {
        it.isAccessible = true; it.get(owner) as T
    }
    private fun JsonObject.obj(key: String) = fields.getValue(key) as JsonObject
    private fun JsonObject.string(key: String) = (fields.getValue(key) as JsonString).value
    private fun JsonObject.number(key: String) = (fields.getValue(key) as JsonNumber).value
    fun run(): String {
        until("application initialized") { runCatching { context.phone }.isSuccess }
        check(context.phone.identities.load() == null) { "Requires an unpaired emulator" }
        val automation = instrumentation.getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        File(directory, "ready").writeText("runtime-bind")
        until("accessibility bound", 30000) { context.phone.runtime != null }
        val runtime = requireNotNull(context.phone.runtime)
        val executor = field<PhoneExecutor>(runtime, "executor")
        val device = field<AccessibilityDevice>(runtime, "device")
        val display = field<DisplayStream>(runtime, "display")
        val desk = field<PhoneDesk>(runtime, "desk")
        val stops = CopyOnWriteArrayList<ActiveSession>()
        val operations = executor.forOwner { stops += it }
        var session = "cus_cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        var stream = "dsp_11111111-1111-4111-8111-111111111111"
        val control = "dcl_22222222-2222-4222-8222-222222222222"
        val run = "run_33333333-3333-4333-8333-333333333333"
        val fence = AuxiliaryFence(RunnerFence("rbt_22222222-2222-4222-8222-222222222222", 7,
            "rcn_99999999-9999-4999-8999-999999999999", "rls_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "rnr_33333333-3333-4333-8333-333333333333"), "rax_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        var request = 0
        fun call(operation: PhoneRequest): ComputerUseOutcome {
            val result = CompletableFuture<ComputerUseOutcome>()
            operations.run(PhoneCall("native-${++request}", session, run, "Native acceptance", operation, SystemClock.elapsedRealtime() + 20000)) { result.complete(it) }
            return result.get(15, TimeUnit.SECONDS)
        }
        fun observe(): JsonObject = ((call(PhoneRequest.Observe(false)) as ComputerUseOutcome.Ok).value as JsonObject).obj("observation")
        fun act(observation: JsonObject, actions: List<PhoneAction>) = call(PhoneRequest.Act(ActParams(observation.string("observationId"), actions, false)))
        fun point(label: String): DisplayPoint {
            val budget = Budget(SystemClock::elapsedRealtime, SystemClock.elapsedRealtime() + 5000, Cancellation())
            val element = requireNotNull(device.walk(250, budget)).elements.first { it.label == label }
            return DisplayPoint((element.bounds.left + element.bounds.right) / 2, (element.bounds.top + element.bounds.bottom) / 2)
        }
        fun receipts(kind: String): List<String> {
            automation.adoptShellPermissionIdentity("android.permission.DUMP")
            try {
                return requireNotNull(context.contentResolver.query(
                    android.net.Uri.parse("content://com.opensteer.agentphone.fixture.receipts/receipts"), null, null, null, null
                )).use { cursor -> buildList {
                    while (cursor.moveToNext()) if (cursor.getString(cursor.getColumnIndexOrThrow("kind")) == kind)
                        add(cursor.getString(cursor.getColumnIndexOrThrow("detail")))
                } }
            } finally { automation.dropShellPermissionIdentity() }
        }
        val observation = observe()
        val dragFrom = point("Drag me"); val dragTo = point("Drop here")
        val geometry = observation.obj("geometry")
        val size = device.display()
        fun target(p: DisplayPoint) = PhoneTarget.Point(p.x * geometry.number("width").toInt() / size.width, p.y * geometry.number("height").toInt() / size.height)
        val drag = act(observation, listOf(PhoneAction.Drag(target(dragFrom), target(dragTo), 650, 600))) as ComputerUseOutcome.Ok
        check((drag.value as JsonObject).fields["error"] == JsonNull) { JsonText.stringify(drag.value) }
        val states = CopyOnWriteArrayList<JsonObject>()
        fun send(message: DisplayMessage) {
            if (message is DisplayMessage.Start) stream = message.streamId
            display.handle(message, "http://127.0.0.1:18765", operations) {
            states += it
            File(directory, "runtime-states.json").writeText(JsonText.stringifyFrame(JsonArray(states.toList())))
            }
        }
        fun state(name: String) = states.lastOrNull { it.fields["state"] == jsonOf(name) }
        fun generation(): Long = requireNotNull(state("live")).number("generation").toLong()
        send(DisplayMessage.Start(fence, stream, "t".repeat(64), 1280, 30, 0, listOf(DisplaySource.Task(session)), editingVersion = 1, displayCut = 1, sharedInput = 1))
        until("live media") { state("live") != null }
        val ownerId = "cvw_88888888-8888-4888-8888-888888888888"
        fun owner(operation: String, generation: Long = 1, leaseMs: Long = 180000, accepted: Boolean = true) {
            val result = CompletableFuture<ComputerUseOutcome>()
            operations.runView(IntegrationsMessage.ComputerView(fence, ownerId, generation, leaseMs, operation, "main", "owner-${++request}", 8000), SystemClock.elapsedRealtime()) { result.complete(it) }
            val answer = result.get(10, TimeUnit.SECONDS) as ComputerUseOutcome.Ok
            check(((answer.value as JsonObject).fields["state"] != null) == accepted) { "Owner $operation generation $generation: ${JsonText.stringify(answer.value)}" }
        }
        owner("open")
        val ownerSource = DisplaySource.Owner(ownerId, 1)
        send(DisplayMessage.Demand(fence, stream, 1, listOf(DisplaySource.Task(session), ownerSource)))
        val producer = field<Any>(display, "current")
        until("owner demand admitted before task close") { field<List<DisplaySource>>(producer, "sources").contains(ownerSource) }
        val beforeTaskEnd = generation()
        call(PhoneRequest.Close)
        until("task source ended independently") { states.any { it.fields["type"] == jsonOf("runner.integrations.display.source-ended") && it.fields["reason"] == jsonOf("session-ended") } }
        check(field<Any>(display, "current") === producer && generation() == beforeTaskEnd && field<Long>(producer, "generation") == beforeTaskEnd) {
            "Demand handoff changed generation from $beforeTaskEnd to ${field<Long>(producer, "generation")}; sources=${field<List<DisplaySource>>(producer, "sources")}"
        }
        session = "cus_99999999-9999-4999-8999-999999999999"
        observe()
        send(DisplayMessage.Demand(fence, stream, 2, listOf(DisplaySource.Task(session), ownerSource)))
        until("replacement task demand admitted") { field<List<DisplaySource>>(producer, "sources").contains(DisplaySource.Task(session)) }
        owner("close")
        until("owner source ended independently") { states.any { it.fields["reason"] == jsonOf("owner-ended") } }
        check(field<Any>(display, "current") === producer && generation() == beforeTaskEnd && field<Long>(producer, "generation") == beforeTaskEnd) {
            "Demand handoff changed generation from $beforeTaskEnd to ${field<Long>(producer, "generation")}; sources=${field<List<DisplaySource>>(producer, "sources")}"
        }
        owner("open", generation = 2, leaseMs = 1500)
        val expiringOwner = DisplaySource.Owner(ownerId, 2)
        send(DisplayMessage.Demand(fence, stream, 3, listOf(DisplaySource.Task(session), expiringOwner)))
        owner("renew", accepted = false)
        owner("close", accepted = false)
        check(operations.displayUnavailable(expiringOwner) == null) { "Old close ended replacement owner lease" }
        until("native monotonic owner expiry") { states.any { it.fields["reason"] == jsonOf("owner-expired") } }
        check(field<Any>(display, "current") === producer && desk.activeSession?.id == session)
        var firstGeneration = generation()
        // Exercise DisplayStream's actual publication queue and WebSocket.send under a close/reset race.
        val active = field<Any>(display, "current")
        val capture = field<ProjectionCapture>(active, "capture")
        val socketField = active.javaClass.getDeclaredField("socket").apply { isAccessible = true }
        val socket = socketField.get(active) as okhttp3.WebSocket
        val sends = java.util.concurrent.atomic.AtomicInteger()
        val probe = java.lang.reflect.Proxy.newProxyInstance(okhttp3.WebSocket::class.java.classLoader,
            arrayOf(okhttp3.WebSocket::class.java)) { _, method, args ->
            if (method.name == "send" && args?.firstOrNull() is okio.ByteString) sends.incrementAndGet()
            method.invoke(socket, *(args ?: emptyArray()))
        } as okhttp3.WebSocket
        val mediaHandler = field<android.os.Handler>(display, "handler")
        val parked = java.util.concurrent.CountDownLatch(1); val unpark = java.util.concurrent.CountDownLatch(1)
        mediaHandler.post { parked.countDown(); check(unpark.await(5, TimeUnit.SECONDS)) }
        check(parked.await(2, TimeUnit.SECONDS))
        val resetMethod = display.javaClass.getDeclaredMethod("reset", active.javaClass).apply { isAccessible = true }
        val pumpMethod = display.javaClass.getDeclaredMethod("pump").apply { isAccessible = true }
        val resetThread = Thread { resetMethod.invoke(display, active) }
        val closeThread = Thread { display.protectionChanged(true) }
        var liftedAt = -1
        try {
            synchronized(capture.gate.lock) {
                socketField.set(active, probe)
                resetThread.start()
                until("reset waiting on publication lock", 1000) { resetThread.state == Thread.State.BLOCKED }
                closeThread.start()
                until("closer waiting on publication lock", 1000) { closeThread.state == Thread.State.BLOCKED }
            }
            resetThread.join(1500); closeThread.join(1500)
            check(!resetThread.isAlive && !closeThread.isAlive)
            check(field<Boolean>(active, "protected")) { "Reset overwrote synchronous protection" }
            val picture = EncodedPicture(firstGeneration, 1, true, "avc1.42C01F", 10, 10, 0, byteArrayOf(1))
            repeat(10) {
                synchronized(capture.gate.lock) {
                    capture.onFrame(picture)
                    // Even a frame queued immediately before close must not reach send.
                    field<ArrayDeque<EncodedPicture>>(active, "queue").add(picture)
                    pumpMethod.invoke(display)
                }
            }
            check(sends.get() == 0) { "Protected media reached WebSocket.send" }
            // Lift while the older protected notification is still queued; it must never overwrite starting/live.
            liftedAt = states.size
            resetMethod.invoke(display, active)
            check(!field<Boolean>(active, "protected"))
        } finally { socketField.set(active, socket); unpark.countDown() }
        until("fresh generation after protection test") { generation() > firstGeneration }
        check(states.drop(liftedAt).none { it.fields["state"] == jsonOf("protected") }) { "Stale protected state overwrote the lift" }

        firstGeneration = generation()
        // The peer delays initial acknowledgement beyond 500ms; recovery must keep this generation.
        Thread.sleep(1200)
        check(generation() == firstGeneration)
        val beforeInterruption = observe()
        val cancelledDrag = CompletableFuture<ComputerUseOutcome>()
        val presses = receipts("chip_touch").count { it == "down" }
        operations.run(PhoneCall("native-${++request}", session, run, "Person interrupts drag",
            PhoneRequest.Act(ActParams(beforeInterruption.string("observationId"),
                listOf(PhoneAction.Drag(target(dragFrom), target(dragTo), 1600, 600)), false)), SystemClock.elapsedRealtime()+10000)) {
            cancelledDrag.complete(it)
        }
        until("agent press in flight") { receipts("chip_touch").count { it == "down" } > presses }
        val tap = point("Record a tap")
        val dimensions = device.display()
        val x = tap.x.toDouble() / (dimensions.width - 1)
        val y = tap.y.toDouble() / (dimensions.height - 1)
        send(DisplayMessage.Input(fence, session, stream, firstGeneration, 0, listOf(DisplayInput.Pointer("down", x, y, 0.0))))
        until("person contact") { receipts("button_touch").lastOrNull() == "down" }
        val cancelled = cancelledDrag.get(3, TimeUnit.SECONDS)
        check(cancelled is ComputerUseOutcome.Ok && (cancelled.value as JsonObject).obj("error").string("message") == "The drag was interrupted.") {
            "Person down did not interrupt the real agent drag: $cancelled"
        }
        val duringTouch = act(observe(), listOf(PhoneAction.Tap(target(tap), 1))) as ComputerUseOutcome.Ok
        check((duringTouch.value as JsonObject).obj("error").string("message") == "A person is touching the screen; try again.")
        val heldObservation = observe()
        send(DisplayMessage.InputReset(fence, session, stream))
        until("reset cancels person contact") { receipts("button_touch").lastOrNull() == "cancel" }
        check((act(heldObservation, listOf(PhoneAction.Wait(1))) as ComputerUseOutcome.Ok).value.let { (it as JsonObject).fields["error"] == JsonNull })
        send(DisplayMessage.Control(fence, session, stream, control, "acquire"))
        until("legacy Host refused") { state("refused")?.fields?.get("reason") == jsonOf("released-by-owner") }
        val replies = states.count { it.fields["type"] == jsonOf("runner.integrations.display.input-result") }
        send(DisplayMessage.Input(fence, session, stream, firstGeneration, 999, listOf(DisplayInput.Nav("home")), controlId = control))
        send(DisplayMessage.Input(fence, session, stream, firstGeneration, 1, listOf(
            DisplayInput.Pointer("down", x, y, 0.0), DisplayInput.Pointer("up", x, y, 1.0))))
        until("legacy input ignored before shared input") { states.count { it.fields["type"] == jsonOf("runner.integrations.display.input-result") } == replies + 1 }
        val editor = point("Type here")
        val ex = editor.x.toDouble() / (dimensions.width - 1)
        val ey = editor.y.toDouble() / (dimensions.height - 1)
        send(DisplayMessage.Input(fence, session, stream, firstGeneration, 2, listOf(
            DisplayInput.Pointer("down", ex, ey, 2.0), DisplayInput.Pointer("up", ex, ey, 3.0))))
        until("owner editor focused") { device.focusedInput() != null }
        send(DisplayMessage.Input(fence, session, stream, firstGeneration, 3, listOf(
            DisplayInput.Insert("owner\uD83D\uDE42"), DisplayInput.Delete(1), DisplayInput.Submit)))
        try {
            until("owner batch insertion/deletion") { device.focusedInput()?.text == "owner" }
        } catch (error: Exception) {
            File(directory, "runtime-states.json").writeText(JsonText.stringifyFrame(JsonArray(states.toList())))
            error("Owner text insertion/deletion failed: focused=${device.focusedInput()}; ${error.message}")
        }

        var sequence = 4L
        fun input(vararg events: DisplayInput) = send(DisplayMessage.Input(fence, session, stream, generation(), sequence++, events.toList()))
        fun pointer(phase: String, at: DisplayPoint, t: Double = SystemClock.elapsedRealtime().toDouble()) =
            DisplayInput.Pointer(phase, at.x.toDouble() / (dimensions.width - 1), at.y.toDouble() / (dimensions.height - 1), t)
        until("editing context before agent edit") { states.any { it.fields["type"] == jsonOf("runner.integrations.display.editing") } }
        val beforeAgentEdit = (states.last { it.fields["type"] == jsonOf("runner.integrations.display.editing") }.fields.getValue("context") as JsonObject).string("contextId")
        val agentEdit = act(observe(), listOf(PhoneAction.Type(null, "-agent", false))) as ComputerUseOutcome.Ok
        check((agentEdit.value as JsonObject).fields["error"] == JsonNull)
        val staleSequence = sequence
        input(DisplayInput.Edit(beforeAgentEdit, "must-not-appear", "", ""))
        until("agent edit rotates person context") { states.any { it.fields["type"] == jsonOf("runner.integrations.display.input-result") &&
            it.fields["sequence"] == jsonOf(staleSequence) && it.fields["outcome"] == jsonOf("stale") } }
        check(device.focusedInput()?.text == "owner-agent")
        // Pointer focus, text and navigation share one owner lane, including one wire batch.
        val password = point("Password")
        input(pointer("down", password), pointer("up", password), DisplayInput.Insert("a"), DisplayInput.Insert("bc"),
            DisplayInput.Delete(1), DisplayInput.Insert("Z"))
        until("exact password receipt") { receipts("password").lastOrNull() == "abZ" }
        check(receipts("text").last() == "owner-agent") { "Password typing reached the previous editor" }
        send(DisplayMessage.InputReset(fence, session, stream))
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            input(DisplayInput.Insert("🙂"), DisplayInput.Delete(1), DisplayInput.Insert("!"))
            until("IME edits existing secret without shadow") { receipts("password").lastOrNull() == "abZ!" }
        } else {
            val writes = receipts("password").size
            input(DisplayInput.Insert("must-refuse")); Thread.sleep(250)
            check(receipts("password").size == writes) { "Unknown existing password was overwritten" }
        }
        // Cancel must deliver CANCEL to the pressed button and never click it.
        val tapsBefore = receipts("button_tap").size
        input(pointer("down", tap)); Thread.sleep(100); input(pointer("cancel", tap))
        until("button ACTION_CANCEL") { receipts("button_touch").contains("cancel") }
        Thread.sleep(200)
        check(receipts("button_tap").size == tapsBefore) { "Cancel clicked the button" }
        input(DisplayInput.Nav("back")); Thread.sleep(300)
        val ownerFrom = point("Drag me"); val ownerTo = point("Drop here")
        val drops = receipts("drop").size
        input(pointer("down", ownerFrom))
        Thread.sleep(1200)
        repeat(10) { n ->
            input(pointer(if (n == 9) "up" else "move", DisplayPoint(ownerFrom.x + (ownerTo.x-ownerFrom.x)*(n+1)/10, ownerFrom.y)))
            Thread.sleep(60)
        }
        until("owner long-press then drop") { receipts("drop").size > drops }
        check(receipts("drop").last() == "target")
        val path = org.json.JSONArray(receipts("drag_path").last())
        check(path.length() >= 3)
        var maxVelocity = 0.0
        for (n in 1 until path.length()) {
            val a = path.getJSONObject(n-1); val b = path.getJSONObject(n)
            val dt = b.getLong("t")-a.getLong("t")
            if (dt > 0) maxVelocity = maxOf(maxVelocity, kotlin.math.abs(b.getDouble("x")-a.getDouble("x"))*1000/dt)
        }
        check(maxVelocity < 5000) { "Owner drag jumped at $maxVelocity px/s" }
        val list = point("Row 3")
        val scrollBefore = receipts("scroll_offset").lastOrNull()?.toInt() ?: 0
        repeat(20) { input(DisplayInput.Scroll(list.x.toDouble()/(dimensions.width-1), list.y.toDouble()/(dimensions.height-1), 0.0, 0.005)) }
        until("wheel distance") { (receipts("scroll_offset").lastOrNull()?.toInt() ?: 0) > scrollBefore + dimensions.height*0.075 }
        Thread.sleep(1200)
        val scrollAfter = receipts("scroll_offset").last().toInt()
        check(scrollAfter-scrollBefore < dimensions.height*0.13) { "Wheel flung: ${scrollAfter-scrollBefore}px" }
        Thread.sleep(400)
        check(receipts("scroll_offset").last().toInt() == scrollAfter) { "Wheel still flinging" }
        File(directory, "owner-gestures.json").writeText("{\"passwordExact\":true,\"cancelDidNotClick\":true,\"longPressDrop\":true,\"maxDragVelocityPxS\":$maxVelocity,\"scrollDistancePx\":${scrollAfter-scrollBefore}}")
        val staleGeometrySequence = sequence++
        send(DisplayMessage.Input(fence, session, stream, firstGeneration - 1, staleGeometrySequence, listOf(DisplayInput.Nav("back"))))
        until("stale geometry refused") { states.any { it.fields["type"] == jsonOf("runner.integrations.display.input-result") &&
            it.fields["sequence"] == jsonOf(staleGeometrySequence) && it.fields["outcome"] == jsonOf("stale") } }
        val resetObservation = observe()
        send(DisplayMessage.InputReset(fence, session, stream))
        check((act(resetObservation, listOf(PhoneAction.Wait(1))) as ComputerUseOutcome.Ok).value.let { (it as JsonObject).fields["error"] == JsonNull })
        val wakeStates = states.size
        val wakeObservation = observe()
        check(act(wakeObservation, listOf(PhoneAction.Wake)) is ComputerUseOutcome.Ok)
        Thread.sleep(500)
        check(generation() == firstGeneration && states.drop(wakeStates).none { it.fields["state"] == jsonOf("protected") }) { "Wake helper protected the display" }
        val touchesBeforeSleep = receipts("button_touch").size
        input(pointer("down", tap))
        until("contact before sleep") { receipts("button_touch").drop(touchesBeforeSleep).contains("down") }
        File(directory, "ready").writeText("runtime-power")
        until("screen-off state") { state("screen-off") != null }
        until("screen-off cancels contact") { receipts("button_touch").drop(touchesBeforeSleep).contains("cancel") }
        until("live after wake") { states.lastOrNull { it.fields["type"] == jsonOf("runner.integrations.display.state") }?.fields?.get("state") == jsonOf("live") }
        check(generation() > firstGeneration) { "Wake reused pre-sleep pixels" }
        firstGeneration = generation()
        val touchesBeforeOwnApp = receipts("button_touch").size
        input(pointer("down", tap))
        until("contact before own app") { receipts("button_touch").drop(touchesBeforeOwnApp).contains("down") }
        val mainMonitor = instrumentation.addMonitor(com.opensteer.agentphone.ui.MainActivity::class.java.name, null, false)
        context.startActivity(Intent(context, com.opensteer.agentphone.ui.MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val mainActivity = requireNotNull(mainMonitor.waitForActivityWithTimeout(3000))
        instrumentation.runOnMainSync {
            mainActivity.findViewById<android.view.View>(com.opensteer.agentphone.R.id.unpair_button).performClick()
        }
        Thread.sleep(150)
        instrumentation.runOnMainSync {
            val dialogs = android.view.inspector.WindowInspector.getGlobalWindowViews().filter {
                it !== mainActivity.window.decorView && it.isShown && it.layoutParams is android.view.WindowManager.LayoutParams
            }
            val secureDialog = dialogs.firstOrNull { (it.layoutParams as android.view.WindowManager.LayoutParams).flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0 }
                ?: error("Unpair dialog is not secure")
            secureDialog.findViewById<android.widget.Button>(android.R.id.button2).performClick()
        }
        instrumentation.removeMonitor(mainMonitor)
        until("own-app protection") { state("protected")?.fields?.get("reason") == jsonOf("opensteer-app") }
        until("own app cancels contact") { receipts("button_touch").drop(touchesBeforeOwnApp).contains("cancel") }
        // Touching Opensteer's own UI is refused by cached admission.
        send(DisplayMessage.Control(fence, session, stream, control, "acquire"))
        until("legacy control refused on own app") { states.lastOrNull { it.fields["controlId"] == jsonOf(control) }?.fields?.get("state") == jsonOf("refused") }
        check(!desk.ownerAdmission(session, true))
        val ownTouches = java.util.concurrent.atomic.AtomicInteger()
        val originalCallback = mainActivity.window.callback
        instrumentation.runOnMainSync {
            mainActivity.window.callback = java.lang.reflect.Proxy.newProxyInstance(android.view.Window.Callback::class.java.classLoader,
                arrayOf(android.view.Window.Callback::class.java)) { _, method, args ->
                if (method.name == "dispatchTouchEvent") ownTouches.incrementAndGet()
                method.invoke(originalCallback, *(args ?: emptyArray()))
            } as android.view.Window.Callback
        }
        try {
            input(pointer("down", tap), pointer("up", tap))
            Thread.sleep(300)
            check(!desk.ownerAdmission(session, true) && ownTouches.get() == 0) { "Owner touch reached Opensteer's window" }
        } finally { instrumentation.runOnMainSync { mainActivity.window.callback = originalCallback } }
        send(DisplayMessage.InputReset(fence, session, stream))
        File(directory, "ready").writeText("runtime-lift")
        until("lift generation") { generation() > firstGeneration }
        val liftedGeneration = generation()
        fun failEncoder() {
            val active = field<Any>(display, "current")
            val capture = field<ProjectionCapture>(active, "capture")
            synchronized(capture.gate.lock) {
                val encoder = field<Any>(capture, "encoder")
                field<android.media.MediaCodec>(encoder, "codec").stop()
            }
        }
        failEncoder()
        File(directory, "ready").writeText("runtime-encoder")
        until("one encoder recovery") { generation() > liftedGeneration }
        val recoveredGeneration = generation()
        failEncoder()
        until("repeated encoder failure") { state("failed")?.fields?.get("reason") == jsonOf("encoder-failed") }
        val beforeRestart = states.size
        send(DisplayMessage.Start(fence, "dsp_44444444-4444-4444-8444-444444444444", "t".repeat(64), 1280, 30, 0, listOf(DisplaySource.Task(session)), editingVersion = 1, displayCut = 1))
        until("fresh stream after encoder failure") { states.drop(beforeRestart).any { it.fields["state"] == jsonOf("live") } }
        val baselineReplies = states.size
        val baselineTaps = receipts("button_tap").size
        send(DisplayMessage.Input(fence, session, stream, generation(), 0, listOf(
            DisplayInput.Pointer("down", x, y, 0.0), DisplayInput.Pointer("up", x, y, 1.0))))
        display.editingChanged()
        val drained = CompletableFuture<Unit>()
        executor.ownerInput { drained.complete(Unit) }; drained.get(3, TimeUnit.SECONDS)
        Thread.sleep(250)
        check(states.drop(baselineReplies).none { it.fields["type"] in setOf(jsonOf("runner.integrations.display.editing"),
            jsonOf("runner.integrations.display.input-result"), jsonOf("runner.integrations.display.clipboard")) })
        check(receipts("button_tap").size == baselineTaps)
        // A peer close is isolated from the runtime and does not end the agent session.
        val connection = java.net.URL("http://127.0.0.1:18765/close").openConnection().apply { connectTimeout = 2000; readTimeout = 2000 }
        connection.getInputStream().use { it.readBytes() }
        until("Host socket shutdown stops projection") { state("stopped") != null }
        check(context.phone.runtime === runtime && desk.activeSession?.id == session)
        val badTicketAt = states.size
        send(DisplayMessage.Start(fence, "dsp_77777777-7777-4777-8777-777777777777", "u".repeat(64), 1280, 30, 0, listOf(DisplaySource.Task(session))))
        until("HTTP socket refusal") { states.drop(badTicketAt).any { it.fields["state"] == jsonOf("failed") && it.fields["reason"] == jsonOf("data-socket-failed") } }
        observe()
        check(stops.isEmpty()) { "Person input stopped the agent Run" }
        context.startActivity(Intent().setClassName("com.opensteer.agentphone.fixture", "com.opensteer.agentphone.fixture.FixtureActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        until("fixture restored before Pause") { device.foreground()?.packageName == "com.opensteer.agentphone.fixture" }
        val beforePause = states.size
        owner("open", generation = 3)
        val survivingOwner = DisplaySource.Owner(ownerId, 3)
        send(DisplayMessage.Start(fence, "dsp_55555555-5555-4555-8555-555555555555", "t".repeat(64), 1280, 30, 0, listOf(DisplaySource.Task(session), survivingOwner), editingVersion = 1, sharedInput = 1))
        until("stream before Pause") { states.drop(beforePause).any { it.fields["state"] == jsonOf("live") } }
        val touchesBeforePause = receipts("button_touch").size
        send(DisplayMessage.Input(fence, session, stream, generation(), 0, listOf(DisplayInput.Pointer("down", x, y, 0.0))))
        until("contact before Pause") { receipts("button_touch").drop(touchesBeforePause).contains("down") }
        executor.setPaused(true)
        until("Pause protects both sources") { states.drop(beforePause).any { it.fields["state"] == jsonOf("protected") && it.fields["reason"] == jsonOf("paused") } }
        until("Pause cancels person contact") { receipts("button_touch").drop(touchesBeforePause).contains("cancel") }
        check(desk.activeSession == null && stops.size == 1)
        check(operations.displayUnavailable(survivingOwner) == null) { "Pause removed independent owner lease" }
        val pausedGeneration = generation()
        executor.setPaused(false)
        until("owner-only resume after Pause") { generation() > pausedGeneration }
        check(desk.activeSession == null)
        owner("close", generation = 3)
        send(DisplayMessage.Stop(fence, stream))
        until("last demand stops projection") { states.lastOrNull { it.fields["type"] == jsonOf("runner.integrations.display.state") }?.fields?.get("state") == jsonOf("stopped") }
        val json = "{\"passed\":true,\"mode\":\"runtime\",\"powerGeneration\":$firstGeneration,\"liftGeneration\":$liftedGeneration,\"encoderRecoveryGeneration\":$recoveredGeneration,\"repeatedEncoderFailure\":true,\"heldContactRefusal\":true,\"resetPreservesObservation\":true,\"dataFailureIsolated\":true,\"nativeOwnerExpiry\":true,\"pausePreservesOwner\":true}"
        File(directory, "runtime-states.json").writeText(JsonText.stringifyFrame(JsonArray(states.toList())))
        File(directory, "runtime.json").writeText(json)
        return json
    }
}
