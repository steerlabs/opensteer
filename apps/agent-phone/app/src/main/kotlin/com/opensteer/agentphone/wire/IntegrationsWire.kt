package com.opensteer.agentphone.wire

/** The `ComputerUseErrorCodeSchema` codes a phone answers with, each one an agent can act on. */
enum class ComputerUseErrorCode(val wire: String) {
    PERMISSION_REQUIRED("permission-required"),
    APP_NOT_ALLOWED("app-not-allowed"),
    BUSY("busy"),
    OWNER_IN_CONTROL("owner-in-control"),
    STALE_OBSERVATION("stale-observation"),
    STOPPED_BY_USER("stopped-by-user"),
    UNSUPPORTED("unsupported"),
    APP_NOT_FOUND("app-not-found"),
    FAILED("failed"),
    OUTCOME_UNKNOWN("outcome-unknown"),
}

/** One computer-use frame's answer: a value, or a refusal in computer use's own words. */
sealed interface ComputerUseOutcome {
    data class Ok(val value: Json) : ComputerUseOutcome
    data class Failure(val code: ComputerUseErrorCode, val message: String) : ComputerUseOutcome {
        init {
            require(message.length in 1..1_000) { "A refusal is one sentence of at most 1,000 characters" }
        }
    }
}

enum class PhoneOperation(val wire: String) {
    OBSERVE("observe"),
    ACT("act"),
    CLOSE("close"),
    INSTALLED_APPS("installed_apps"),
}

/** What the Host may send on a phone's `integrations` stream after its welcome. */
sealed interface StreamFrame {
    val fence: AuxiliaryFence

    /** The stream's own lease, which the connection keeps; the module never sees it. */
    data class LeaseRenewed(override val fence: AuxiliaryFence, val streamLeaseExpiresAt: String) : StreamFrame
}

/** What the module handles: every stream frame but the lease. */
sealed interface IntegrationsMessage : StreamFrame {
    /** A non-session app call; a phone serves none. */
    data class Invoke(override val fence: AuxiliaryFence, val requestId: String) : IntegrationsMessage

    /** `definitionId` is null for a frame meant for a Mac, which names no definition. */
    data class ComputerUse(
        override val fence: AuxiliaryFence,
        val access: String?,
        val definitionId: String?,
        val operation: String,
        val params: JsonObject,
        val requestId: String,
        /** The Run asking, which an owner's Stop refuses from then on. */
        val runId: String,
        val sessionId: String,
        val threadTitle: String?,
        val timeoutMs: Long,
    ) : IntegrationsMessage

    /** Independent owner-view authority: never an activeSession or a Run. */
    data class ComputerView(
        override val fence: AuxiliaryFence,
        val viewId: String,
        val generation: Long,
        val leaseDurationMs: Long,
        val operation: String,
        val display: String,
        val requestId: String,
        val timeoutMs: Long,
    ) : IntegrationsMessage

    data class Cancel(override val fence: AuxiliaryFence, val requestId: String) : IntegrationsMessage

    /** The Host persisted this exact owner Stop; ordinary cleanup is not an acknowledgement. */
    data class StopRecorded(override val fence: AuxiliaryFence, val runId: String, val sessionId: String) : IntegrationsMessage

    data class McpOpen(override val fence: AuxiliaryFence, val sessionId: String) : IntegrationsMessage
    data class McpMessage(override val fence: AuxiliaryFence, val sessionId: String) : IntegrationsMessage
    data class McpClose(override val fence: AuxiliaryFence, val sessionId: String) : IntegrationsMessage
}

/** One operation's line in `runner.integrations.status`. */
data class OperationStatus(val operation: String, val state: String, val detail: String?)

/**
 * What a phone reports it can do: the catalog's three operations, all ready
 * while the runtime runs and the phone is not paused. The runtime only runs
 * while the accessibility service is connected, so there is no other state
 * to report: without the service there is no stream to report on.
 */
object PhoneStatus {
    /** Clients show it beside the phone's name; the Host builds its own sentence for agents from the state. */
    const val PAUSED_DETAIL = "Paused on the phone"
    private val OPERATIONS = listOf("observe", "act", "release")

    fun operations(paused: Boolean): List<OperationStatus> = OPERATIONS.map {
        if (paused) OperationStatus(it, "unavailable", PAUSED_DETAIL) else OperationStatus(it, "ready", null)
    }
}

/** The phone's side of `packages/protocol/src/computer-apps.ts`. */
object IntegrationsWire {
    const val MAX_FRAME_BYTES = 1_024 * 1_024
    const val MAX_CONCURRENT = 4
    private const val MAX_TIMEOUT_MS = 60_000L
    private val ACCESS = setOf("read", "read-write")
    private val PHONE_OPERATIONS = PhoneOperation.entries.map { it.wire }.toSet()
    private val COMPUTER_USE_OPERATIONS = setOf("permissions", "installed_apps", "resolve_app", "observe", "capture", "act", "close")

    fun decode(text: String): StreamFrame {
        val fields = Fields.parse(text, "integrations")
        val type = fields.string("type")
        val fence = RunnerWire.auxiliaryFence(fields)
        val message = when (type) {
            "host.auxiliary.lease-renewed" -> {
                if (fields.has("browserAttachPublicKeys")) fields.fail("browserAttachPublicKeys", "belongs to a browser stream")
                StreamFrame.LeaseRenewed(fence, fields.isoTime("streamLeaseExpiresAt"))
            }
            "host.integrations.display.demand", "host.integrations.display.start", "host.integrations.display.stop", "host.integrations.display.refresh",
            "host.integrations.display.control", "host.integrations.display.input" -> DisplayWire.decode(type, fields, fence)
            "host.integrations.invoke" -> {
                fields.enum("access", ACCESS)
                fields.objectValue("arguments")
                fields.string("contract", pattern = Ids.contract)
                fields.string("definitionId", min = 1, max = 64, pattern = Ids.definitionId)
                mcpIdentifier(fields, "operation")
                fields.int("timeoutMs", 1, MAX_TIMEOUT_MS)
                IntegrationsMessage.Invoke(fence, fields.string("requestId", pattern = Ids.requestId))
            }
            "host.integrations.computer-view" -> computerView(fields, fence)
            "host.integrations.computer-use" -> computerUse(fields, fence)
            "host.integrations.cancel" -> IntegrationsMessage.Cancel(fence, fields.string("requestId", pattern = Ids.requestId))
            "host.integrations.computer-use-stop-recorded" -> IntegrationsMessage.StopRecorded(
                fence,
                fields.string("runId", pattern = Ids.run),
                fields.string("sessionId", pattern = Ids.computerUseSession),
            )
            "host.integrations.mcp.open" -> {
                // The launch is refused unread: this phone runs no MCP server, whatever it names.
                fields.objectValue("launch")
                fields.string("serverId", min = 1)
                IntegrationsMessage.McpOpen(fence, fields.string("sessionId", pattern = Ids.uuid))
            }
            "host.integrations.mcp.message" -> {
                fields.raw("message")
                IntegrationsMessage.McpMessage(fence, fields.string("sessionId", pattern = Ids.uuid))
            }
            "host.integrations.mcp.close" -> IntegrationsMessage.McpClose(fence, fields.string("sessionId", pattern = Ids.uuid))
            else -> fields.fail("type", "is not an integrations message")
        }
        fields.end()
        return message
    }

    private fun mcpIdentifier(fields: Fields, key: String): String =
        fields.string(key, min = 1, max = 512).also { if ('\u0000' in it) fields.fail(key, "contains a null byte") }

    /**
     * `HostIntegrationsComputerUseSchema` with its refinement for phones and
     * for Macs. The params are read by the operation they belong to, so ones
     * this phone cannot read refuse that request rather than the stream.
     */
    private fun computerView(fields: Fields, fence: AuxiliaryFence): IntegrationsMessage.ComputerView {
        if (fields.int("version", 1, 1) != 1L) fields.fail("version", "is not supported")
        val targetFields = fields.obj("target")
        targetFields.literal("kind", "phone")
        val display = targetFields.string("display", min = 1, max = 255)
        targetFields.end()
        return IntegrationsMessage.ComputerView(
            fence = fence,
            viewId = fields.string("viewId", pattern = Ids.computerView),
            generation = fields.int("generation", 1),
            leaseDurationMs = fields.int("leaseDurationMs", 1, 600_000),
            operation = fields.enum("operation", setOf("open", "close", "renew")),
            display = display,
            requestId = fields.string("requestId", pattern = Ids.requestId),
            timeoutMs = fields.int("timeoutMs", 1, MAX_TIMEOUT_MS),
        )
    }

    fun computerViewResult(fence: AuxiliaryFence, requestId: String, outcome: ComputerUseOutcome): JsonObject = jsonObject(
        *fence.fields(),
        "requestId" to jsonOf(requestId),
        "result" to when (outcome) {
            is ComputerUseOutcome.Ok -> jsonObject("kind" to jsonOf("ok"), "value" to outcome.value)
            is ComputerUseOutcome.Failure -> jsonObject(
                "kind" to jsonOf("error"),
                "code" to jsonOf(when (outcome.code) {
                    ComputerUseErrorCode.UNSUPPORTED -> "unsupported"
                    ComputerUseErrorCode.PERMISSION_REQUIRED -> "permission-required"
                    else -> "unavailable"
                }),
                "message" to jsonOf(outcome.message),
            )
        },
        "type" to jsonOf("runner.integrations.computer-view-result"),
    )

    private fun computerUse(fields: Fields, fence: AuxiliaryFence): IntegrationsMessage.ComputerUse {
        val access = fields.stringOrNull("access")?.also { if (it !in ACCESS) fields.fail("access", "is not an access level") }
        val app = fields.raw("app")
        if (app != JsonNull && app !is JsonObject) fields.fail("app", "is not an object or null")
        val definitionId = fields.optionalString("definitionId")
        val operation = fields.enum("operation", COMPUTER_USE_OPERATIONS)
        val operated = operation == "observe" || operation == "act"
        if (definitionId != null) {
            if (definitionId != AndroidPhoneWire.DEFINITION_ID) fields.fail("definitionId", "is not android-phone")
            if (app != JsonNull) fields.fail("app", "is named on an Android phone operation")
            if (operation !in PHONE_OPERATIONS) fields.fail("operation", "is not an Android phone operation")
        } else if (operated == (app == JsonNull)) {
            fields.fail("app", "does not match the operation")
        }
        if (operated == (access == null)) fields.fail("access", "does not match the operation")
        return IntegrationsMessage.ComputerUse(
            fence = fence,
            access = access,
            definitionId = definitionId,
            operation = operation,
            params = fields.objectValue("params"),
            requestId = fields.string("requestId", pattern = Ids.requestId),
            runId = fields.string("runId", pattern = Ids.run),
            sessionId = fields.string("sessionId", pattern = Ids.computerUseSession),
            threadTitle = fields.stringOrNull("threadTitle", max = 240),
            timeoutMs = fields.int("timeoutMs", 1, MAX_TIMEOUT_MS),
        )
    }

    fun status(fence: AuxiliaryFence, operations: List<OperationStatus>, displayAvailable: Boolean, loginText: JsonObject? = null): JsonObject = jsonObject(
        *fence.fields(),
        *(loginText?.let { arrayOf("loginText" to it) } ?: emptyArray()),
        "apps" to jsonArray(
            jsonObject(
                "definitionId" to jsonOf(AndroidPhoneWire.DEFINITION_ID),
                "operations" to JsonArray(
                    operations.map {
                        jsonObject(
                            "detail" to jsonOrNull(it.detail),
                            "operation" to jsonOf(it.operation),
                            "remedy" to JsonNull,
                            "state" to jsonOf(it.state),
                        )
                    },
                ),
            ),
        ),
        "captureSupported" to jsonOf(false),
        "displayAvailable" to jsonOf(displayAvailable),
        "type" to jsonOf("runner.integrations.status"),
    )

    fun computerUseResult(fence: AuxiliaryFence, requestId: String, outcome: ComputerUseOutcome): JsonObject = jsonObject(
        *fence.fields(),
        "requestId" to jsonOf(requestId),
        "result" to when (outcome) {
            is ComputerUseOutcome.Ok -> jsonObject("kind" to jsonOf("ok"), "value" to outcome.value)
            is ComputerUseOutcome.Failure -> jsonObject(
                "code" to jsonOf(outcome.code.wire),
                "kind" to jsonOf("error"),
                "message" to jsonOf(outcome.message),
            )
        },
        "type" to jsonOf("runner.integrations.computer-use-result"),
    )

    /**
     * The person stopped this session on the phone, by its notification or by
     * pausing. It names the Run, because it may reach the Host only on a later
     * stream, after the Host forgot the session.
     */
    fun computerUseStopped(fence: AuxiliaryFence, sessionId: String, runId: String): JsonObject = jsonObject(
        *fence.fields(),
        "event" to jsonObject(
            "event" to jsonOf("session.stopped"),
            "params" to jsonObject("reason" to jsonOf("user"), "runId" to jsonOf(runId), "sessionId" to jsonOf(sessionId)),
        ),
        "type" to jsonOf("runner.integrations.computer-use-event"),
    )

    fun invokeUnsupported(fence: AuxiliaryFence, requestId: String): JsonObject = jsonObject(
        *fence.fields(),
        "requestId" to jsonOf(requestId),
        "result" to jsonObject(
            "code" to jsonOf("unsupported"),
            "kind" to jsonOf("error"),
            "message" to jsonOf("This app is not available on an Android phone."),
        ),
        "type" to jsonOf("runner.integrations.result"),
    )

    fun mcpUnapproved(fence: AuxiliaryFence, sessionId: String): JsonObject = jsonObject(
        *fence.fields(),
        "error" to jsonObject(
            "code" to jsonOf("unapproved"),
            "message" to jsonOf("An Android phone runs no MCP servers."),
        ),
        "sessionId" to jsonOf(sessionId),
        "type" to jsonOf("runner.integrations.mcp.closed"),
    )

    /** Whether a frame fits the stream's 1 MiB budget, measured as the Host measures it. */
    fun fits(frame: JsonObject): Boolean = JsonText.stringifyFrame(frame).toByteArray(Charsets.UTF_8).size <= MAX_FRAME_BYTES
}
