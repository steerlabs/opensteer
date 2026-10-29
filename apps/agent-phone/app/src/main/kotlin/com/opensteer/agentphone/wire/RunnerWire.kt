package com.opensteer.agentphone.wire

/** The exact primary connection a frame belongs to (`RunnerConnectionFenceSchema`). */
data class RunnerFence(
    val bootId: String,
    val connectionGeneration: Long,
    val connectionId: String,
    val connectionLeaseId: String,
    val runnerId: String,
) {
    fun fields(): Array<Pair<String, Json>> = arrayOf(
        "bootId" to jsonOf(bootId),
        "connectionGeneration" to jsonOf(connectionGeneration),
        "connectionId" to jsonOf(connectionId),
        "connectionLeaseId" to jsonOf(connectionLeaseId),
        "runnerId" to jsonOf(runnerId),
    )
}

/** The exact module stream a frame belongs to (`RunnerAuxiliaryFrameFenceSchema`); a phone's is always `integrations`. */
data class AuxiliaryFence(val fence: RunnerFence, val auxiliaryStreamId: String) {
    fun fields(): Array<Pair<String, Json>> =
        fence.fields() + arrayOf("auxiliaryStreamId" to jsonOf(auxiliaryStreamId), "module" to jsonOf(RunnerDescriptor.MODULE))
}

/** `ProtocolErrorSchema`. `reason` tells refusals apart where the wording must not. */
data class ProtocolError(val code: String, val message: String, val reason: String?, val retryable: Boolean)

/** What the Host may say on a phone's primary connection. */
sealed interface HostMessage {
    data class Challenge(val challenge: RunnerChallenge) : HostMessage

    data class Welcome(
        val fence: RunnerFence,
        val allowedModules: List<String>,
        val connectionLeaseExpiresAt: String,
        val heartbeatIntervalMs: Long,
        val serverTime: String,
    ) : HostMessage

    data class LeaseRenewed(val fence: RunnerFence, val connectionLeaseExpiresAt: String) : HostMessage

    data class AuxiliaryTicket(val fence: RunnerFence, val module: String, val requestId: String, val ticket: String) : HostMessage

    data class Error(val error: ProtocolError) : HostMessage

    /** A message for a Runner that runs agents or workspaces; a phone runs neither and refuses it. */
    data object Unexpected : HostMessage
}

/** What the Host may say on a module stream before it is welcomed. */
sealed interface AuxiliaryHandshake {
    data class Challenge(val challenge: AuxiliaryChallenge) : AuxiliaryHandshake
    data class Welcome(
        val fence: AuxiliaryFence,
        val heartbeatIntervalMs: Long,
        val serverTime: String,
        val streamLeaseExpiresAt: String,
        val loginText: Boolean = false,
    ) : AuxiliaryHandshake
    data class Rejected(val error: ProtocolError) : AuxiliaryHandshake
}

/** The primary connection's frames (`packages/protocol/src/runner.ts`) and the module stream's handshake. */
object RunnerWire {
    private val MODULE_NAMES = setOf("agents", "browser", "integrations", "messaging", "shell")
    private val AUXILIARY_MODULES = MODULE_NAMES - "agents"
    private val ERROR_CODES = setOf("bad_message", "conflict", "forbidden", "internal", "not_found")

    fun decodeHostMessage(text: String): HostMessage {
        val fields = Fields.parse(text, "host")
        val message = when (fields.string("type")) {
            "host.challenge" -> {
                if (fields.optionalInt("proofFormatVersion") != Proofs.RUNNER_PROOF_FORMAT_VERSION) {
                    throw WireException(
                        "Runner proof format differs. Update Opensteer on the Host and update Agent Phone over USB once for proof format v2.",
                        reason = "runner-proof-format-mismatch",
                    )
                }
                HostMessage.Challenge(
                    RunnerChallenge(
                        challengeId = fields.string("challengeId", pattern = Ids.challenge),
                        expiresAt = fields.isoTime("expiresAt"),
                        hostSessionId = fields.string("hostSessionId", pattern = Ids.nonce),
                        nonce = fields.string("nonce", pattern = Ids.nonce),
                    ),
                )
            }
            "host.welcome" -> {
                // A phone serves no environment, but the welcome is read whole.
                fields.stringArray("environmentIds", max = 100, item = Ids.environment)
                HostMessage.Welcome(
                    fence = fence(fields),
                    allowedModules = fields.stringArray("allowedModules", max = 5).also {
                        if (it.isEmpty() || !MODULE_NAMES.containsAll(it)) fields.fail("allowedModules", "names no known module")
                    },
                    connectionLeaseExpiresAt = fields.isoTime("connectionLeaseExpiresAt"),
                    heartbeatIntervalMs = fields.int("heartbeatIntervalMs", 1_000, 300_000),
                    serverTime = fields.isoTime("serverTime"),
                )
            }
            "host.connection.lease-renewed" -> HostMessage.LeaseRenewed(fence(fields), fields.isoTime("connectionLeaseExpiresAt"))
            "host.auxiliary.ticket" -> {
                // The Host judges the ticket's expiry when the stream presents it.
                fields.isoTime("expiresAt")
                HostMessage.AuxiliaryTicket(
                    fence = fence(fields),
                    module = fields.enum("module", AUXILIARY_MODULES),
                    requestId = fields.string("requestId", pattern = Ids.requestId),
                    ticket = fields.string("ticket", max = 8_192, pattern = Ids.ticket),
                )
            }
            "host.error" -> HostMessage.Error(protocolError(fields.obj("error")))
            else -> return HostMessage.Unexpected
        }
        fields.end()
        return message
    }

    fun decodeAuxiliaryHandshake(text: String): AuxiliaryHandshake {
        val fields = Fields.parse(text, "auxiliary")
        val message = when (fields.string("type")) {
            "host.auxiliary.challenge" -> AuxiliaryHandshake.Challenge(
                AuxiliaryChallenge(
                    challengeId = fields.string("challengeId", pattern = Ids.challenge),
                    expiresAt = fields.isoTime("expiresAt"),
                    hostSessionId = fields.string("hostSessionId", pattern = Ids.nonce),
                    module = fields.enum("module", AUXILIARY_MODULES),
                    nonce = fields.string("nonce", pattern = Ids.nonce),
                ),
            )
            "host.auxiliary.welcome" -> {
                val fence = auxiliaryFence(fields)
                // Only a browser stream carries attach keys; a phone never opens one.
                if (fields.has("browserAttachPublicKeys")) fields.fail("browserAttachPublicKeys", "belongs to a browser stream")
                AuxiliaryHandshake.Welcome(
                    fence = fence,
                    heartbeatIntervalMs = fields.int("heartbeatIntervalMs", 1_000, 300_000),
                    serverTime = fields.isoTime("serverTime"),
                    streamLeaseExpiresAt = fields.isoTime("streamLeaseExpiresAt"),
                    loginText = fields.optionalInt("loginText", 1, 1) == 1L,
                )
            }
            "host.auxiliary.rejected" -> AuxiliaryHandshake.Rejected(protocolError(fields.obj("error")))
            else -> fields.fail("type", "is not an auxiliary handshake message")
        }
        fields.end()
        return message
    }

    fun fence(fields: Fields) = RunnerFence(
        bootId = fields.string("bootId", pattern = Ids.boot),
        connectionGeneration = fields.int("connectionGeneration", 1, MAX_SAFE_INTEGER),
        connectionId = fields.string("connectionId", pattern = Ids.connection),
        connectionLeaseId = fields.string("connectionLeaseId", pattern = Ids.lease),
        runnerId = fields.string("runnerId", pattern = Ids.runner),
    )

    /** A phone's only module stream is `integrations`; a fence naming another is not for it. */
    fun auxiliaryFence(fields: Fields): AuxiliaryFence {
        val fence = AuxiliaryFence(fence(fields), fields.string("auxiliaryStreamId", pattern = Ids.auxiliaryStream))
        fields.literal("module", RunnerDescriptor.MODULE)
        return fence
    }

    fun protocolError(fields: Fields): ProtocolError {
        val error = ProtocolError(
            code = fields.enum("code", ERROR_CODES),
            message = fields.string("message", min = 1, max = 2_000),
            reason = fields.optionalString("reason", min = 1, max = 120),
            retryable = fields.bool("retryable"),
        )
        fields.end()
        return error
    }

    fun authenticate(challenge: RunnerChallenge, descriptor: RunnerDescriptor, key: Ed25519Key): JsonObject {
        val wireDescriptor = descriptor.toJson()
        return jsonObject(
            "proofFormatVersion" to jsonOf(Proofs.RUNNER_PROOF_FORMAT_VERSION),
            "challengeId" to jsonOf(challenge.challengeId),
            "descriptor" to wireDescriptor,
            "signature" to jsonOf(Proofs.runnerAuthentication(key, challenge, wireDescriptor)),
            "type" to jsonOf("runner.authenticate"),
        )
    }

    fun enroll(challenge: RunnerChallenge, descriptor: RunnerDescriptor, key: Ed25519Key, enrollmentToken: String): JsonObject {
        val wireDescriptor = descriptor.toJson()
        return jsonObject(
            "proofFormatVersion" to jsonOf(Proofs.RUNNER_PROOF_FORMAT_VERSION),
            "challengeId" to jsonOf(challenge.challengeId),
            "credential" to jsonObject("enrollmentToken" to jsonOf(enrollmentToken), "kind" to jsonOf("host-enrollment-token")),
            "descriptor" to wireDescriptor,
            "publicKeyPem" to jsonOf(key.publicKeyPem),
            "signature" to jsonOf(Proofs.runnerEnrollment(key, challenge, wireDescriptor, enrollmentToken)),
            "type" to jsonOf("runner.enroll"),
        )
    }

    /** A phone holds no Runs, triggers or watches, so its heartbeat renews the connection and nothing else. */
    fun heartbeat(fence: RunnerFence, sentAt: String): JsonObject = jsonObject(
        *fence.fields(),
        "activeRunIds" to jsonArray(),
        "activeTriggerOccurrenceIds" to jsonArray(),
        "activeWatchActivationIds" to jsonArray(),
        "sentAt" to jsonOf(sentAt),
        "type" to jsonOf("runner.heartbeat"),
    )

    /** Said once the integrations stream is open: only a module that answered is ready. */
    fun modulesReport(fence: RunnerFence, checkedAt: String): JsonObject = jsonObject(
        *fence.fields(),
        "modules" to jsonArray(
            jsonObject(
                "checkedAt" to jsonOf(checkedAt),
                "detail" to JsonNull,
                "module" to jsonOf(RunnerDescriptor.MODULE),
                "readiness" to jsonOf("ready"),
            ),
        ),
        "type" to jsonOf("runner.modules.report"),
    )

    fun ticketRequest(fence: RunnerFence, requestId: String): JsonObject = jsonObject(
        *fence.fields(),
        "module" to jsonOf(RunnerDescriptor.MODULE),
        "requestId" to jsonOf(requestId),
        "type" to jsonOf("runner.auxiliary.ticket-request"),
    )

    fun auxiliaryAuthenticate(
        challenge: AuxiliaryChallenge,
        key: Ed25519Key,
        runnerId: String,
        bootId: String,
        ticket: String,
    ): JsonObject = jsonObject(
        "bootId" to jsonOf(bootId),
        "challengeId" to jsonOf(challenge.challengeId),
        "module" to jsonOf(RunnerDescriptor.MODULE),
        "runnerId" to jsonOf(runnerId),
        "signature" to jsonOf(Proofs.auxiliary(key, challenge, runnerId, bootId, ticket)),
        "ticket" to jsonOf(ticket),
        "type" to jsonOf("runner.auxiliary.authenticate"),
    )

    fun auxiliaryHeartbeat(fence: AuxiliaryFence, sentAt: String): JsonObject = jsonObject(
        *fence.fields(),
        "sentAt" to jsonOf(sentAt),
        "type" to jsonOf("runner.auxiliary.heartbeat"),
    )
}
