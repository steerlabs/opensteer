package com.opensteer.agentphone.wire

/** A size in pixels. */
data class PixelSize(val width: Int, val height: Int)

/** A rectangle in pixels, edges exclusive at right and bottom. */
data class PixelRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
}

/** Where an action lands, in the cited observation: an element, or a screenshot pixel. */
sealed interface PhoneTarget {
    data class Element(val index: Int) : PhoneTarget
    data class Point(val x: Int, val y: Int) : PhoneTarget
}

enum class Navigation(val wire: String) {
    BACK("back"),
    HOME("home"),
    RECENTS("recents"),
    NOTIFICATIONS("notifications"),
    QUICK_SETTINGS("quickSettings"),
}

enum class ScrollDirection(val wire: String) { UP("up"), DOWN("down"), LEFT("left"), RIGHT("right") }

/** `AndroidPhoneActionSchema`, with Zod's defaults applied. */
sealed interface PhoneAction {
    data class Tap(val target: PhoneTarget, val count: Int) : PhoneAction
    data class LongPress(val target: PhoneTarget, val durationMs: Int) : PhoneAction
    data class Swipe(val from: PhoneTarget, val to: PhoneTarget, val durationMs: Int) : PhoneAction
    data class Drag(val from: PhoneTarget, val to: PhoneTarget, val holdMs: Int, val durationMs: Int) : PhoneAction
    data class Type(val target: PhoneTarget?, val text: PhoneText, val submit: Boolean) : PhoneAction {
        constructor(target: PhoneTarget?, text: String, submit: Boolean) : this(target, PhoneText.Literal(text), submit)
    }
    data class Clear(val target: PhoneTarget) : PhoneAction
    data class Navigate(val to: Navigation) : PhoneAction
    data class Launch(val packageName: String) : PhoneAction
    data class Scroll(val target: PhoneTarget, val direction: ScrollDirection, val amount: Int) : PhoneAction
    data object Wake : PhoneAction
    data class Wait(val ms: Int) : PhoneAction

    /** `androidPhoneTimedActionMs`: holding, moving and waiting, before the phone settles. */
    val timedMs: Long
        get() = when (this) {
            is LongPress -> durationMs.toLong()
            is Swipe -> durationMs.toLong()
            is Drag -> (holdMs + durationMs).toLong()
            is Wait -> ms.toLong()
            is Scroll -> amount.toLong() * AndroidPhoneWire.SCROLL_STEP_MS
            is Tap, is Type, is Clear, is Navigate, is Launch, Wake -> 0
        }
}

data class LoginActIdentity(val runId: String, val actId: String)

data class ActParams(val observationId: String, val actions: List<PhoneAction>, val includeScreenshot: Boolean, val loginContext: LoginActIdentity? = null)

/** `AndroidPhoneInstalledAppsParamsSchema`, with Zod's defaults applied. */
data class InstalledAppsParams(val query: String, val limit: Int, val offset: Long)

/** One app `launch` can open (`AndroidPhoneInstalledAppSchema`). */
data class InstalledApp(val label: String, val packageName: String)

/** One page of the matching apps; `total` counts every match. */
data class InstalledAppsPage(val apps: List<InstalledApp>, val total: Int)

data class Screenshot(val base64: String, val width: Int, val height: Int) {
    fun toJson() = jsonObject(
        "base64" to jsonOf(base64),
        "height" to jsonOf(height),
        "mime" to jsonOf("image/jpeg"),
        "width" to jsonOf(width),
    )
}

/** What became of the screenshot an observation asked for. */
sealed interface ScreenshotOutcome {
    data class Taken(val screenshot: Screenshot) : ScreenshotOutcome
    data object NotRequested : ScreenshotOutcome
    data object Failed : ScreenshotOutcome
}

/** The display as one observation found it. Width and height are pixels in its current rotation. */
data class DisplayState(
    val width: Int,
    val height: Int,
    val rotation: Int,
    val interactive: Boolean,
    val locked: Boolean,
    val secureLock: Boolean,
) {
    val size: PixelSize get() = PixelSize(width, height)
}

data class Foreground(val packageName: String, val label: String?)

/** The tree text of one observation and how much of the screen it names. */
data class Tree(val text: String, val elementCount: Int, val truncated: Boolean)

/**
 * One `AndroidPhoneObservation`. It is built only through the three
 * factories, each the one shape the schema allows for its case: a dark
 * screen or the Opensteer app in front shares no elements and
 * no picture and says why.
 */
class Observation private constructor(
    val capturedAt: String,
    val observationId: String,
    val display: DisplayState,
    val geometry: PixelSize,
    val foreground: Foreground?,
    val tree: String,
    val elementCount: Int,
    val truncated: Boolean,
    val screenshot: Screenshot?,
    val screenshotUnavailable: String?,
) {
    fun toJson(): JsonObject = jsonObject(
        "capturedAt" to jsonOf(capturedAt),
        "elementCount" to jsonOf(elementCount),
        "foreground" to (
            foreground?.let { jsonObject("label" to jsonOrNull(it.label), "packageName" to jsonOf(it.packageName)) }
                ?: JsonNull
            ),
        "geometry" to jsonObject("height" to jsonOf(geometry.height), "width" to jsonOf(geometry.width)),
        "locked" to jsonOf(display.locked),
        "observationId" to jsonOf(observationId),
        "rotation" to jsonOf(display.rotation),
        "screen" to jsonOf(if (display.interactive) "on" else "off"),
        "screenshot" to (screenshot?.toJson() ?: JsonNull),
        "screenshotUnavailable" to jsonOrNull(screenshotUnavailable),
        "secureLock" to jsonOf(display.secureLock),
        "tree" to jsonOf(tree),
        "truncated" to jsonOf(truncated),
    )

    companion object {
        /** A dark screen: nothing to share until `wake` turns it on. */
        fun screenOff(capturedAt: String, observationId: String, display: DisplayState, geometry: PixelSize): Observation {
            require(!display.interactive) { "A screen-off observation is of a dark screen" }
            return Observation(capturedAt, observationId, display, geometry, null, "", 0, false, null, "screen-off")
        }

        /** The Opensteer app in front: its screens are the owner's, so nothing is shared but its name. */
        fun opensteerApp(capturedAt: String, observationId: String, display: DisplayState, geometry: PixelSize, foreground: Foreground): Observation {
            require(display.interactive) { "A dark screen is observed with screenOff" }
            require(foreground.packageName == AndroidPhoneWire.AGENT_PHONE_PACKAGE) { "Only the Opensteer app's own screens are hidden this way" }
            return Observation(capturedAt, observationId, display, geometry, foreground, "", 0, false, null, "opensteer-app")
        }

        fun visible(
            capturedAt: String,
            observationId: String,
            display: DisplayState,
            geometry: PixelSize,
            foreground: Foreground?,
            tree: Tree,
            screenshot: ScreenshotOutcome,
        ): Observation {
            require(display.interactive) { "A dark screen is observed with screenOff" }
            require(foreground?.packageName != AndroidPhoneWire.AGENT_PHONE_PACKAGE) { "The Opensteer app in front is observed with opensteerApp" }
            val (picture, reason) = when (screenshot) {
                is ScreenshotOutcome.Taken -> {
                    require(screenshot.screenshot.width == geometry.width && screenshot.screenshot.height == geometry.height) {
                        "An observation's geometry is its screenshot's size"
                    }
                    screenshot.screenshot to null
                }
                ScreenshotOutcome.NotRequested -> null to "not-requested"
                ScreenshotOutcome.Failed -> null to "failed"
            }
            return Observation(
                capturedAt, observationId, display, geometry, foreground,
                tree.text, tree.elementCount, tree.truncated, picture, reason,
            )
        }
    }
}

/** Why an act stopped, said as computer use says it. */
data class ActError(val code: ComputerUseErrorCode, val message: String)

/** The phone's half of the computer-use contract in `packages/protocol/src/android-phone.ts`. */
object AndroidPhoneWire {
    const val DEFINITION_ID = "android-phone"
    /** `agentPhonePackageName`: this app, which an observation names when it is in front. */
    const val AGENT_PHONE_PACKAGE = "com.opensteer.agentphone"
    const val SCROLL_STEP_MS = 350L
    const val MAX_TIMED_ACTION_MS = 40_000L
    const val MAX_ACTIONS = 32
    const val MAX_ELEMENTS = 1_500
    const val TREE_MAX_BYTES = 32_000
    const val SCREENSHOT_MAX_BASE64 = 600_000
    const val SCREENSHOT_MAX_LONG_SIDE = 1_440
    const val SCREENSHOT_MAX_PIXELS = 1_150_000
    const val PERFORMED_MAX_LENGTH = 160
    const val APPS_MAX_QUERY_LENGTH = 240
    const val APPS_MAX_LIMIT = 100
    const val APPS_DEFAULT_LIMIT = 50
    const val APP_LABEL_MAX_LENGTH = 200

    fun observationResult(observation: Observation): JsonObject = jsonObject("observation" to observation.toJson())

    fun actResult(error: ActError?, observation: Observation?, performed: List<String>): JsonObject {
        require(error != null || observation != null) { "A successful action batch includes its resulting observation" }
        require(performed.size <= MAX_ACTIONS && performed.all { it.length in 1..PERFORMED_MAX_LENGTH })
        return jsonObject(
            "error" to (error?.let { jsonObject("code" to jsonOf(it.code.wire), "message" to jsonOf(it.message)) } ?: JsonNull),
            "observation" to (observation?.toJson() ?: JsonNull),
            "performed" to JsonArray(performed.map(::jsonOf)),
        )
    }

    fun installedAppsResult(page: InstalledAppsPage): JsonObject {
        require(page.apps.size <= APPS_MAX_LIMIT && page.total >= page.apps.size)
        return jsonObject(
            "apps" to JsonArray(page.apps.map { jsonObject("label" to jsonOf(it.label), "packageName" to jsonOf(it.packageName)) }),
            "total" to jsonOf(page.total),
        )
    }

    /** `AndroidPhoneInstalledAppsParamsSchema`. */
    fun decodeInstalledAppsParams(params: JsonObject): InstalledAppsParams {
        val fields = Fields.of(params, "params")
        val result = InstalledAppsParams(
            query = fields.optionalString("query", max = APPS_MAX_QUERY_LENGTH) ?: "",
            limit = (fields.optionalInt("limit", 1, APPS_MAX_LIMIT.toLong()) ?: APPS_DEFAULT_LIMIT.toLong()).toInt(),
            offset = fields.optionalInt("offset", 0) ?: 0,
        )
        fields.end()
        return result
    }

    /** `ComputerUseDispatchObserveParamsSchema`. */
    fun decodeObserveParams(params: JsonObject): Boolean {
        val fields = Fields.of(params, "params")
        val includeScreenshot = fields.bool("includeScreenshot")
        fields.end()
        return includeScreenshot
    }

    /** Capture and close take nothing. */
    fun decodeEmptyParams(params: JsonObject) {
        Fields.of(params, "params").end()
    }

    /** `AndroidPhoneDispatchActParamsSchema`. */
    fun decodeActParams(params: JsonObject): ActParams {
        val fields = Fields.of(params, "params")
        val actions = fields.array("actions", min = 1, max = MAX_ACTIONS).mapIndexed { index, value ->
            decodeAction(Fields.of(value, "params.actions[$index]"))
        }
        val result = ActParams(
            observationId = fields.string("observationId", min = 1, max = 64),
            actions = actions,
            includeScreenshot = fields.bool("includeScreenshot"),
            loginContext = if (fields.has("loginContext")) fields.obj("loginContext").let { context ->
                LoginActIdentity(context.string("runId", pattern = Ids.run), context.string("actId", pattern = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))).also { context.end() }
            } else null,
        )
        fields.end()
        for ((index, action) in actions.withIndex()) {
            val saved = (action as? PhoneAction.Type)?.text as? PhoneText.Saved ?: continue
            val binding = saved.envelope.binding
            if (result.loginContext?.runId != binding.runId || result.loginContext.actId != binding.actId || index != binding.actionIndex) {
                throw WireException("Saved login text does not match this batch.")
            }
        }
        if (actions.sumOf { it.timedMs } > MAX_TIMED_ACTION_MS) {
            throw WireException(
                "A batch may hold, move and wait for at most $MAX_TIMED_ACTION_MS ms in total; split it into more batches",
            )
        }
        return result
    }

    private fun decodeAction(fields: Fields): PhoneAction {
        val action = when (fields.string("type")) {
            "tap" -> PhoneAction.Tap(
                target(fields, "target"),
                (fields.optionalInt("count", 1, 2) ?: 1).toInt(),
            )
            "longPress" -> PhoneAction.LongPress(target(fields, "target"), (fields.optionalInt("durationMs", 400, 5_000) ?: 800).toInt())
            "swipe" -> PhoneAction.Swipe(
                target(fields, "from"),
                target(fields, "to"),
                (fields.optionalInt("durationMs", 50, 5_000) ?: 300).toInt(),
            )
            "drag" -> PhoneAction.Drag(
                target(fields, "from"),
                target(fields, "to"),
                holdMs = (fields.optionalInt("holdMs", 400, 3_000) ?: 600).toInt(),
                durationMs = (fields.optionalInt("durationMs", 100, 5_000) ?: 600).toInt(),
            )
            "type" -> PhoneAction.Type(
                target = if (fields.has("target")) target(fields, "target") else null,
                text = decodeText(fields.raw("text")),
                submit = fields.optionalBool("submit") ?: false,
            )
            "clear" -> PhoneAction.Clear(target(fields, "target"))
            "navigate" -> PhoneAction.Navigate(
                fields.string("to").let { name -> Navigation.entries.firstOrNull { it.wire == name } ?: fields.fail("to", "is not a navigation") },
            )
            "launch" -> PhoneAction.Launch(fields.string("packageName", min = 3, max = 255, pattern = Ids.androidPackage))
            "scroll" -> PhoneAction.Scroll(
                target(fields, "target"),
                fields.string("direction").let { name ->
                    ScrollDirection.entries.firstOrNull { it.wire == name } ?: fields.fail("direction", "is not a direction")
                },
                fields.int("amount", 1, 20).toInt(),
            )
            "wake" -> PhoneAction.Wake
            "wait" -> PhoneAction.Wait(fields.int("ms", 1, 5_000).toInt())
            else -> fields.fail("type", "is not an Android phone action")
        }
        fields.end()
        return action
    }

    private fun decodeText(value: Json): PhoneText {
        if (value is JsonString) {
            if (value.value.length !in 1..5_000) throw WireException("Literal text is outside its size limit.")
            return PhoneText.Literal(value.value)
        }
        try {
            val fields = Fields.of(value, "text")
            return PhoneText.Saved(SealedLoginEnvelope.decode(fields.raw("sealed"))).also { fields.end() }
        } catch (_: Exception) {
            throw WireException("Saved login text could not be read.")
        }
    }

    private fun target(fields: Fields, key: String): PhoneTarget {
        val target = fields.obj(key)
        val result = if (target.has("index")) {
            PhoneTarget.Element(target.int("index", 0, (MAX_ELEMENTS - 1).toLong()).toInt())
        } else {
            PhoneTarget.Point(target.int("x", 0, 10_000).toInt(), target.int("y", 0, 10_000).toInt())
        }
        target.end()
        return result
    }
}
