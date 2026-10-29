package com.opensteer.agentphone.wire

/** The Host's challenge on a primary connection. */
data class RunnerChallenge(val challengeId: String, val expiresAt: String, val hostSessionId: String, val nonce: String)

/** The Host's challenge on a freshly opened module stream. */
data class AuxiliaryChallenge(
    val challengeId: String,
    val expiresAt: String,
    val hostSessionId: String,
    val module: String,
    val nonce: String,
)

/**
 * What this phone says it is when it connects. The versioned integrations
 * descriptor binds its advertised live display capability. A phone runs no
 * agents, offers only its screen through `integrations`, and
 * is a local computer shaped like a phone.
 */
data class RunnerDescriptor(val bootId: String, val name: String, val runnerId: String, val runtimeVersion: String, val loginText: Boolean = false, val editing: Boolean = false, val displayCut: Boolean = false) {
    fun toJson(): JsonObject = jsonObject(
        "bootId" to jsonOf(bootId),
        "capabilities" to jsonArray(),
        "device" to jsonObject("form" to jsonOf(DEVICE_FORM), "platform" to jsonOf(PLATFORM)),
        "modules" to jsonObject(
            "integrations" to jsonObject(
                *(if (loginText) arrayOf("loginText" to jsonOf(1)) else emptyArray()),
                *(if (editing) arrayOf("editing" to jsonOf(1)) else emptyArray()),
                *(if (editing && displayCut) arrayOf("displayCut" to jsonOf(1)) else emptyArray()),
                "platform" to jsonOf(PLATFORM),
                "protocolVersion" to jsonOf(INTEGRATIONS_PROTOCOL_VERSION),
            ),
        ),
        "name" to jsonOf(name),
        "runnerId" to jsonOf(runnerId),
        "runnerKind" to jsonOf(RUNNER_KIND),
        "runtimeVersion" to jsonOf(runtimeVersion),
    )

    companion object {
        const val DEVICE_FORM = "phone"
        const val PLATFORM = "android"
        const val RUNNER_KIND = "local"
        const val INTEGRATIONS_PROTOCOL_VERSION = 4
        const val MODULE = "integrations"
    }
}

/**
 * The proofs of `@opensteer/runner-auth`, transcript for transcript.
 *
 * Each is `canonicalJson([domain, ...payload])` in UTF-8, signed with
 * Ed25519, in unpadded base64url. The Host rebuilds the same transcript from
 * the raw wire descriptor, so the order and spelling of every element here is part of
 * the protocol.
 */
object Proofs {
    const val RUNNER_PROOF_FORMAT_VERSION = 2L
    private const val AUTHENTICATION_DOMAIN = "opensteer-runner-auth-v2"
    private const val ENROLLMENT_DOMAIN = "opensteer-runner-enroll-v2"
    private const val AUXILIARY_DOMAIN = "opensteer-runner-auxiliary-v1"

    fun runnerAuthentication(key: Ed25519Key, challenge: RunnerChallenge, descriptor: RunnerDescriptor): String =
        runnerAuthentication(key, challenge, descriptor.toJson())

    fun runnerAuthentication(key: Ed25519Key, challenge: RunnerChallenge, descriptor: JsonObject): String =
        sign(key, AUTHENTICATION_DOMAIN, runnerPayload(challenge, descriptor))

    fun runnerEnrollment(key: Ed25519Key, challenge: RunnerChallenge, descriptor: RunnerDescriptor, enrollmentToken: String): String =
        runnerEnrollment(key, challenge, descriptor.toJson(), enrollmentToken)

    fun runnerEnrollment(key: Ed25519Key, challenge: RunnerChallenge, descriptor: JsonObject, enrollmentToken: String): String = sign(
        key, ENROLLMENT_DOMAIN,
        runnerPayload(challenge, descriptor) + listOf(
            jsonOf("publicKeyFingerprint"), jsonOf(key.fingerprint),
            jsonOf("enrollmentTokenHash"), jsonOf(Digests.tokenDigest(enrollmentToken)),
        ),
    )

    fun auxiliary(key: Ed25519Key, challenge: AuxiliaryChallenge, runnerId: String, bootId: String, ticket: String): String =
        sign(
            key,
            AUXILIARY_DOMAIN,
            listOf(
                "challengeId", challenge.challengeId,
                "challengeNonce", challenge.nonce,
                "hostSessionId", challenge.hostSessionId,
                "challengeExpiresAt", challenge.expiresAt,
                "challengeModule", challenge.module,
                "runnerId", runnerId,
                "bootId", bootId,
                "module", RunnerDescriptor.MODULE,
                "ticketDigest", Digests.tokenDigest(ticket),
            ).map(::jsonOf),
        )

    private fun runnerPayload(challenge: RunnerChallenge, descriptor: JsonObject): List<Json> = listOf(
        jsonOf("challengeId"), jsonOf(challenge.challengeId),
        jsonOf("challengeNonce"), jsonOf(challenge.nonce),
        jsonOf("hostSessionId"), jsonOf(challenge.hostSessionId),
        jsonOf("challengeExpiresAt"), jsonOf(challenge.expiresAt),
        jsonOf("descriptor"), descriptor,
    )

    private fun sign(key: Ed25519Key, domain: String, payload: List<Json>): String {
        val transcript = CanonicalJson.encode(JsonArray(listOf(jsonOf(domain)) + payload))
        return Base64Url.encode(key.sign(transcript.toByteArray(Charsets.UTF_8)))
    }
}
