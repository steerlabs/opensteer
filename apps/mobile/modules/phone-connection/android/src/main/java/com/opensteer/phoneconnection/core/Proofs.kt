package com.opensteer.phoneconnection.core

import kotlinx.serialization.json.*
import java.net.URI

object Proofs {
    fun origin(raw: String): String {
        val uri = try { URI(raw) } catch (_: Exception) { throw Refused("invalid-target") }
        Wire.requireThat(uri.scheme == "https" && uri.host != null && uri.rawUserInfo == null &&
            uri.rawQuery == null && uri.rawFragment == null && uri.rawPath in setOf("", "/") &&
            uri.host !in setOf("localhost", "127.0.0.1", "::1", "[::1]"), "invalid-target")
        return raw.trimEnd('/')
    }
    fun challenge(frame: JsonObject, auxiliary: Boolean): JsonArray {
        Wire.requireThat(frame.text("type") == if (auxiliary) "host.auxiliary.challenge" else "host.challenge")
        frame.time("expiresAt")
        if (auxiliary) {
            frame.only("challengeId", "expiresAt", "hostSessionId", "module", "nonce", "type")
            Wire.requireThat(frame.text("module") == "browser")
        } else Wire.requireThat(runCatching { frame.number("proofFormatVersion") }.getOrNull() == 2L, "needs-update")
        Wire.requireThat(Regex("rch_" + Wire.uuid.pattern).matches(frame.text("challengeId")))
        for (key in listOf("nonce", "hostSessionId")) Wire.requireThat(Regex("[A-Za-z0-9_-]{32,255}").matches(frame.text(key)))
        return JsonArray(listOf("challengeId", frame.text("challengeId"), "challengeNonce", frame.text("nonce"),
            "hostSessionId", frame.text("hostSessionId"), "challengeExpiresAt", frame.text("expiresAt")).map(::JsonPrimitive))
    }
    fun primary(challenge: JsonObject, descriptor: JsonObject, fingerprint: String, token: String?): JsonArray {
        val proof = this.challenge(challenge, false)
        return JsonArray(listOf(JsonPrimitive(if (token == null) "opensteer-runner-auth-v2" else "opensteer-runner-enroll-v2")) + proof +
            listOf(JsonPrimitive("descriptor"), descriptor) +
            if (token == null) emptyList() else listOf(JsonPrimitive("publicKeyFingerprint"), JsonPrimitive(fingerprint),
                JsonPrimitive("enrollmentTokenHash"), JsonPrimitive(Wire.digest(token.toByteArray(Charsets.UTF_8)))))
    }
    fun auxiliary(challenge: JsonObject, runnerId: String, bootId: String, ticket: String): JsonArray =
        JsonArray(listOf(JsonPrimitive("opensteer-runner-auxiliary-v1")) + this.challenge(challenge, true) +
            listOf("challengeModule", "browser", "runnerId", runnerId, "bootId", bootId, "module", "browser", "ticketDigest", Wire.digest(ticket.toByteArray(Charsets.UTF_8))).map(::JsonPrimitive))
}
