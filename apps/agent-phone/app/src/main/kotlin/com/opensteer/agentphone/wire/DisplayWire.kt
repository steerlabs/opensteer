package com.opensteer.agentphone.wire

import java.nio.ByteBuffer

sealed interface DisplaySource {
    data class Task(val sessionId: String) : DisplaySource
    data class Owner(val viewId: String, val generation: Long) : DisplaySource
    fun json(): JsonObject = when (this) {
        is Task -> jsonObject("kind" to jsonOf("task-session"), "sessionId" to jsonOf(sessionId))
        is Owner -> jsonObject("kind" to jsonOf("owner-view"), "viewId" to jsonOf(viewId), "generation" to jsonOf(generation))
    }
}
sealed interface DisplayMessage : IntegrationsMessage {
    val streamId: String
    data class Start(override val fence: AuxiliaryFence, override val streamId: String,
        val dataTicket: String, val maxLongSide: Int, val maxFps: Int, val revision: Long, val sources: List<DisplaySource>, val editingVersion: Int? = null, val displayCut: Int? = null, val sharedInput: Int? = null, val phoneOwnerControl: Int? = null, val inputSources: List<DisplaySource>? = null, val displayProfile: Int? = null, val maxBitrate: Int? = null) : DisplayMessage
    data class Stop(override val fence: AuxiliaryFence, override val streamId: String) : DisplayMessage
    data class Refresh(override val fence: AuxiliaryFence, override val streamId: String) : DisplayMessage
    data class Demand(override val fence: AuxiliaryFence, override val streamId: String, val revision: Long, val sources: List<DisplaySource>, val inputSources: List<DisplaySource>? = null, val maxBitrate: Int? = null) : DisplayMessage
    data class Control(override val fence: AuxiliaryFence, val sessionId: String, override val streamId: String, val controlId: String, val action: String) : DisplayMessage
    data class Input(override val fence: AuxiliaryFence, val sessionId: String?, override val streamId: String,
        val geometry: Long, val sequence: Long, val events: List<DisplayInput>, val controlId: String? = null, val source: DisplaySource = DisplaySource.Task(requireNotNull(sessionId)), val sourceAddressed: Boolean = false) : DisplayMessage
    data class InputReset(override val fence: AuxiliaryFence, val sessionId: String?, override val streamId: String, val source: DisplaySource = DisplaySource.Task(requireNotNull(sessionId)), val sourceAddressed: Boolean = false) : DisplayMessage
    data class Power(override val fence: AuxiliaryFence, override val streamId: String, val source: DisplaySource, val sequence: Long, val action: String) : DisplayMessage
}
sealed interface DisplayInput {
    data class Pointer(val phase: String, val x: Double, val y: Double, val t: Double) : DisplayInput
    data class Scroll(val x: Double, val y: Double, val dx: Double, val dy: Double) : DisplayInput
    data class Nav(val to: String) : DisplayInput
    data class Insert(val text: String) : DisplayInput
    data class Delete(val count: Int) : DisplayInput
    data object Submit : DisplayInput
    data class Key(val action: String, val code: String, val key: String, val modifiers: List<String>, val location: Int?, val repeat: Boolean?, val text: String?) : DisplayInput
    data class Command(val command: String) : DisplayInput
    data class Edit(val contextId: String, val text: String, val before: String, val after: String) : DisplayInput
    data class Cut(val contextId: String) : DisplayInput
    data object Copy : DisplayInput
    data class Paste(val text: String) : DisplayInput
    data object UnsupportedPaste : DisplayInput
}
data class DisplayAck(val sequence: Long)
data class DisplayMediaHeader(val streamId: String, val generation: Long, val sequence: Long, val ptsUs: Long,
    val key: Boolean, val codec: String?, val width: Int, val height: Int) {
    fun json(): JsonObject {
        require(Ids.displayStream.matches(streamId) && generation in 1..MAX_SAFE_INTEGER && sequence in 0..MAX_SAFE_INTEGER && ptsUs in 0..MAX_SAFE_INTEGER)
        require(width > 0 && height > 0 && key == (codec != null))
        require(codec == null || Regex("^avc1\\.[0-9A-Fa-f]{6}$").matches(codec))
        return JsonObject(linkedMapOf<String, Json>("streamId" to jsonOf(streamId), "generation" to jsonOf(generation),
            "sequence" to jsonOf(sequence), "ptsUs" to jsonOf(ptsUs), "key" to jsonOf(key)).apply {
            if (codec != null) put("codec", jsonOf(codec))
            put("width", jsonOf(width)); put("height", jsonOf(height))
        })
    }
    companion object {
        fun read(value: JsonObject): DisplayMediaHeader {
            val f = Fields.of(value, "media")
            return DisplayMediaHeader(f.string("streamId", pattern = Ids.displayStream), f.int("generation", 1), f.int("sequence", 0),
                f.int("ptsUs", 0), f.bool("key"), f.optionalString("codec"), f.int("width", 1, Int.MAX_VALUE.toLong()).toInt(),
                f.int("height", 1, Int.MAX_VALUE.toLong()).toInt()).also { f.end(); it.json() }
        }
    }
}

object DisplayWire {
    const val UNACKED_BYTES = 1_048_576
    const val UNACKED_MS = 500L
    const val MAX_PAYLOAD = 4 * 1_048_576
    const val MAX_HEADER = 16 * 1024

    fun decode(type: String, f: Fields, fence: AuxiliaryFence): DisplayMessage {
        val stream = f.string("streamId", pattern = Ids.displayStream)
        if (type !in setOf("host.integrations.display.control", "host.integrations.display.input", "host.integrations.display.input-reset", "host.integrations.display.power")) f.literal("display", "main")
        return when (type) {
            "host.integrations.display.start" -> DisplayMessage.Start(fence, stream,
                f.string("dataTicket", pattern = Ids.ticket), f.int("maxLongSide", 320, 1920).toInt(), f.int("maxFps", 1, 60).toInt(), f.int("revision", 0), sources(f), f.optionalInt("editingVersion", 1, 1)?.toInt(), f.optionalInt("displayCut", 1, 1)?.toInt(), f.optionalInt("sharedInput", 1, 1)?.toInt(), f.optionalInt("phoneOwnerControl", 1, 1)?.toInt(), if (f.has("inputSources")) sources(f, "inputSources") else null, f.optionalInt("displayProfile", 1, 1)?.toInt(), bitrate(f)).also { start ->
                    if ((start.displayProfile == 1) != f.has("maxBitrate")) f.fail("maxBitrate", "requires profile negotiation")
                    if ((start.phoneOwnerControl == 1) != (start.inputSources != null) || start.inputSources?.any { it !in start.sources } == true) f.fail("inputSources", "requires negotiated input authority within demand")
                }
            "host.integrations.display.stop" -> DisplayMessage.Stop(fence, stream)
            "host.integrations.display.refresh" -> DisplayMessage.Refresh(fence, stream)
            "host.integrations.display.demand" -> DisplayMessage.Demand(fence, stream, f.int("revision", 0), sources(f), if (f.has("inputSources")) sources(f, "inputSources") else null, bitrate(f)).also { demand -> if (demand.inputSources?.any { it !in demand.sources } == true) f.fail("inputSources", "must belong to demand") }
            "host.integrations.display.control" -> DisplayMessage.Control(fence, f.string("sessionId", pattern = Ids.computerUseSession), stream, f.string("controlId", pattern = Ids.displayControl),
                f.enum("action", setOf("acquire", "release")))
            "host.integrations.display.input" -> {
                val address = address(f)
                DisplayMessage.Input(fence, (address.first as? DisplaySource.Task)?.sessionId, stream,
                    f.int("geometry", 1), f.int("sequence", 0), f.array("events", 1, 64).map(::event), f.optionalString("controlId", pattern = Ids.displayControl), address.first, address.second)
            }
            "host.integrations.display.input-reset" -> {
                val address = address(f)
                DisplayMessage.InputReset(fence, (address.first as? DisplaySource.Task)?.sessionId, stream, address.first, address.second)
            }
            "host.integrations.display.power" -> DisplayMessage.Power(fence, stream, source(f.raw("source")), f.int("sequence", 0), f.enum("action", setOf("wake", "lock")))
            else -> f.fail("type", "is not a display message")
        }
    }
    private fun bitrate(f: Fields): Int? {
        if (!f.has("maxBitrate")) return null
        val value = f.raw("maxBitrate")
        return if (value == JsonNull) null else Fields.of(jsonObject("value" to value), "maxBitrate").int("value", 400_000, 4_000_000).toInt()
    }
    private fun address(f: Fields): Pair<DisplaySource, Boolean> {
        if (f.has("source") == f.has("sessionId")) f.fail("source", "requires exactly one input address")
        return if (f.has("source")) source(f.raw("source")) to true else DisplaySource.Task(f.string("sessionId", pattern = Ids.computerUseSession)) to false
    }
    internal fun source(value: Json): DisplaySource {
        val source = Fields.of(value, "display.source")
        val result = when (source.string("kind")) {
            "task-session" -> DisplaySource.Task(source.string("sessionId", pattern = Ids.computerUseSession))
            "owner-view" -> DisplaySource.Owner(source.string("viewId", pattern = Ids.computerView), source.int("generation", 1))
            else -> source.fail("kind", "is not a display authority")
        }
        source.end(); return result
    }
    private fun sources(f: Fields, key: String = "sources"): List<DisplaySource> = f.array(key, 0, 8).map(::source).distinct()
    fun ack(text: String): DisplayAck {
        val f = Fields.parse(text, "display")
        f.literal("type", "display.ack")
        return DisplayAck(f.int("sequence", 0)).also { f.end() }
    }
    fun event(value: Json): DisplayInput {
        val f = Fields.of(value, "display.input")
        fun number(key: String, min: Double, max: Double): Double {
            val n = (f.raw(key) as? JsonNumber)?.value ?: f.fail(key, "is not a number")
            if (!n.isFinite() || n < min || n > max) f.fail(key, "is out of range")
            return n
        }
        val event = when (f.string("kind")) {
            "pointer" -> DisplayInput.Pointer(f.enum("phase", setOf("down", "move", "up", "cancel")),
                number("x", 0.0, 1.0), number("y", 0.0, 1.0), number("t", 0.0, MAX_SAFE_INTEGER.toDouble()))
            "scroll" -> DisplayInput.Scroll(number("x", 0.0, 1.0), number("y", 0.0, 1.0), number("dx", -1.0, 1.0), number("dy", -1.0, 1.0))
            "nav" -> DisplayInput.Nav(f.enum("to", setOf("back", "home", "recents", "notifications")))
            "text" -> when {
                f.has("insert") -> DisplayInput.Insert(f.string("insert", 1, 1000))
                f.has("deleteBackward") -> DisplayInput.Delete(f.int("deleteBackward", 1, 100).toInt())
                else -> { if (!f.bool("submit")) f.fail("submit", "is not true"); DisplayInput.Submit }
            }
            "key" -> DisplayInput.Key(f.enum("action", setOf("down", "up")), f.string("code", 0, 100), f.string("key", 0, 100),
                f.stringArray("modifiers", 5).also { values -> if (values.any { it !in setOf("alt", "control", "meta", "shift", "primary") }) f.fail("modifiers", "is not an editing modifier") },
                f.optionalInt("location", 0, 3)?.toInt(), f.optionalBool("repeat"), f.optionalString("text", 1, 64))
            "command" -> DisplayInput.Command(f.enum("command", editingCommands))
            "edit" -> {
                val edit = f.obj("edit")
                DisplayInput.Edit(edit.string("contextId", pattern = Ids.uuid), edit.string("text", 0, 10000), edit.string("before", 0, 10000), edit.string("after", 0, 10000))
                    .also { if (it.text.isEmpty() && it.before.isEmpty() && it.after.isEmpty()) edit.fail("text", "is an empty edit"); edit.end() }
            }
            "cut" -> DisplayInput.Cut(f.string("contextId", pattern = Ids.uuid))
            "copy" -> DisplayInput.Copy
            "paste" -> if (f.has("items")) {
                var total = 0L
                f.array("items", 1, 16).forEach { value ->
                    val item = Fields.of(value, "display.input.paste.item")
                    item.string("type", 1, 255, Regex("^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$"))
                    item.optionalString("name", 1, 255)
                    total += item.int("size", 0, 16L * 1024 * 1024)
                    item.end()
                }
                if (total > 16L * 1024 * 1024) f.fail("items", "exceeds the clipboard byte bound")
                DisplayInput.UnsupportedPaste
            } else DisplayInput.Paste(f.string("text", 1, 30000))
            else -> f.fail("kind", "is not an input event")
        }
        f.end()
        return event
    }
    private val editingCommands = setOf("selectAll", "undo", "redo", "moveBackward", "moveForward", "moveUp", "moveDown",
        "moveWordLeft", "moveWordRight", "moveWordLeftAndModifySelection", "moveWordRightAndModifySelection",
        "moveToLeftEndOfLine", "moveToRightEndOfLine", "moveToLeftEndOfLineAndModifySelection", "moveToRightEndOfLineAndModifySelection",
        "moveToBeginningOfLine", "moveToEndOfLine", "moveToBeginningOfLineAndModifySelection", "moveToEndOfLineAndModifySelection",
        "moveToBeginningOfParagraph", "moveToEndOfParagraph", "moveToBeginningOfParagraphAndModifySelection", "moveToEndOfParagraphAndModifySelection",
        "moveToBeginningOfDocument", "moveToEndOfDocument", "moveToBeginningOfDocumentAndModifySelection", "moveToEndOfDocumentAndModifySelection",
        "deleteBackward", "deleteForward", "deleteWordBackward", "deleteWordForward", "deleteToBeginningOfLine", "deleteToEndOfLine", "deleteToEndOfParagraph", "transpose", "yank")
    fun editingReply(message: DisplayMessage.Input, kind: String, vararg fields: Pair<String, Json>): JsonObject =
        JsonObject(linkedMapOf(*message.fence.fields(), "type" to jsonOf("runner.integrations.display.$kind"),
            "streamId" to jsonOf(message.streamId), *(if (message.sourceAddressed) arrayOf("source" to message.source.json()) else arrayOf("sessionId" to jsonOf(requireNotNull(message.sessionId)))),
            "geometry" to jsonOf(message.geometry), *fields))
    fun editingContext(fence: AuxiliaryFence, streamId: String, sessionId: String?, geometry: Long, context: JsonObject, source: DisplaySource? = null): JsonObject =
        JsonObject(linkedMapOf(*fence.fields(), "type" to jsonOf("runner.integrations.display.editing"), "streamId" to jsonOf(streamId),
            *(source?.let { arrayOf("source" to it.json()) } ?: arrayOf("sessionId" to jsonOf(requireNotNull(sessionId)))), "geometry" to jsonOf(geometry), "context" to context))
    fun powerResult(message: DisplayMessage.Power, dispatched: Boolean): JsonObject =
        JsonObject(linkedMapOf(*message.fence.fields(), "type" to jsonOf("runner.integrations.display.power-result"),
            "streamId" to jsonOf(message.streamId), "source" to message.source.json(), "sequence" to jsonOf(message.sequence),
            "outcome" to jsonOf(if (dispatched) "dispatched" else "refused")).apply { if (!dispatched) put("reason", jsonOf("unavailable")) })
    fun media(header: DisplayMediaHeader, payload: ByteArray): ByteArray {
        require(payload.size in 1..MAX_PAYLOAD)
        val bytes = JsonText.stringify(header.json()).toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_HEADER)
        return ByteBuffer.allocate(4 + bytes.size + payload.size).putInt(bytes.size).put(bytes).put(payload).array()
    }
    fun state(fence: AuxiliaryFence, streamId: String, state: String, reason: String?, generation: Long,
        width: Int, height: Int, rotation: Int): JsonObject = JsonObject(linkedMapOf(*fence.fields(),
        "type" to jsonOf("runner.integrations.display.state"), "display" to jsonOf("main"), "streamId" to jsonOf(streamId),
        "state" to jsonOf(state)).apply {
        if (reason != null) put("reason", jsonOf(reason))
        put("generation", jsonOf(generation)); put("width", jsonOf(width)); put("height", jsonOf(height)); put("rotation", jsonOf(rotation))
    })
    fun sourceEnded(fence: AuxiliaryFence, streamId: String, source: DisplaySource, reason: String): JsonObject =
        JsonObject(linkedMapOf(*fence.fields(), "type" to jsonOf("runner.integrations.display.source-ended"),
            "display" to jsonOf("main"), "streamId" to jsonOf(streamId), "source" to source.json(), "reason" to jsonOf(reason)))
    fun controlState(fence: AuxiliaryFence, sessionId: String, streamId: String, controlId: String, state: String, reason: String?): JsonObject =
        JsonObject(linkedMapOf(*fence.fields(), "type" to jsonOf("runner.integrations.display.control-state"),
            "streamId" to jsonOf(streamId), "sessionId" to jsonOf(sessionId), "controlId" to jsonOf(controlId), "state" to jsonOf(state)).apply {
            if (reason != null) put("reason", jsonOf(reason))
        })
}
