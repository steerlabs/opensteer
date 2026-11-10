package com.opensteer.phoneconnection.core

import kotlinx.serialization.json.*
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.util.encoders.Base64
import java.util.UUID

class AttachTickets(val runtimeId: String, private val ledger: ReplayLedger, private val now: () -> Long) {
    private data class Ticket(val token: String, val epoch: Int, val fence: Fence, val channelId: String,
        var verified: Verified? = null)
    data class Verified(val claims: JsonObject, val digest: String, val state: ReplayState)
    data class Permit(val epoch: Int, val fence: Fence, val channelId: String, val claims: JsonObject)
    private val pending = mutableMapOf<String, Ticket>()
    private val permits = mutableMapOf<String, Permit>()
    private var keys = emptyMap<String, Ed25519PublicKeyParameters>()

    @Synchronized fun setKeys(values: JsonArray) {
        Wire.requireThat(values.size in 1..4)
        val next = values.map {
            val item = it as? JsonObject ?: throw Refused("invalid-wire")
            item.only("keyId", "publicKeyPem")
            val id = item.text("keyId")
            Wire.requireThat(Regex("[A-Za-z0-9._:-]{1,255}").matches(id))
            id to publicKey(item.text("publicKeyPem", max = 2048))
        }
        Wire.requireThat(next.map { it.first }.distinct().size == next.size)
        keys = next.toMap()
    }
    @Synchronized fun hold(token: String, epoch: Int, fence: Fence, channelId: String): String {
        Wire.requireThat(pending.size < 128 && token.toByteArray(Charsets.UTF_8).size <= 16384, "capacity")
        return UUID.randomUUID().toString().also { pending[it] = Ticket(token, epoch, fence, channelId) }
    }
    @Synchronized fun verify(handle: String, epoch: Int, fence: Fence): Verified {
        val ticket = pending[handle] ?: throw Refused("retired-ticket")
        Wire.requireThat(ticket.epoch == epoch && ticket.fence == fence, "retired-ticket")
        val claims = verifyToken(ticket.token, runtimeId, now(), keys)
        val verified = Verified(claims, Wire.digest(ticket.token.toByteArray(Charsets.UTF_8)), ledger.read())
        ticket.verified = verified
        return verified
    }
    @Synchronized fun commit(handle: String, epoch: Int, fence: Fence, digest: String, transition: ReplayState): String {
        val ticket = pending[handle] ?: throw Refused("retired-ticket")
        val verified = ticket.verified ?: throw Refused("unverified-ticket")
        val at = now()
        Wire.requireThat(ticket.epoch == epoch && ticket.fence == fence && digest == verified.digest, "retired-ticket")
        validateTimes(verified.claims, runtimeId, at)
        Wire.requireThat(verified.claims.time("operationExpiresAt") > at, "operation-expired")
        Wire.requireThat(transition.highWaterAt <= at + 5000 && transition.highWaterAt >= at - 5000, "unavailable")
        ledger.commit(verified.state, transition, verified.claims.text("nonce", 16), verified.claims.time("expiresAt"), transition.highWaterAt)
        pending.remove(handle)
        return UUID.randomUUID().toString().also {
            permits[it] = Permit(epoch, fence, ticket.channelId, verified.claims)
        }
    }
    @Synchronized fun permit(handle: String, epoch: Int, fence: Fence): Permit {
        val permit = permits[handle] ?: throw Refused("retired-permit")
        Wire.requireThat(permit.epoch == epoch && permit.fence == fence && permit.claims.time("operationExpiresAt") > now(), "retired-permit")
        validateTimes(permit.claims, runtimeId, now())
        return permit
    }
    @Synchronized fun retireChannel(channelId: String) {
        pending.entries.removeAll { it.value.channelId == channelId }
        permits.entries.removeAll { it.value.channelId == channelId }
    }
    @Synchronized fun retire(clearKeys: Boolean = false) {
        pending.clear(); permits.clear()
        if (clearKeys) keys = emptyMap()
    }

    companion object {
        fun publicKey(pem: String): Ed25519PublicKeyParameters {
            val prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
            Wire.requireThat(pem.startsWith("-----BEGIN PUBLIC KEY-----\n") && pem.trimEnd().endsWith("-----END PUBLIC KEY-----"))
            val encoded = pem.removePrefix("-----BEGIN PUBLIC KEY-----\n").substringBefore("-----END PUBLIC KEY-----").filterNot { it.isWhitespace() }
            val bytes = try { Base64.decode(encoded) } catch (_: Exception) { throw Refused("invalid-key") }
            Wire.requireThat(bytes.size == 44 && bytes.copyOfRange(0, 12).contentEquals(prefix), "invalid-key")
            return Ed25519PublicKeyParameters(bytes, 12)
        }
        fun verifyToken(token: String, runtimeId: String, now: Long, keys: Map<String, Ed25519PublicKeyParameters>): JsonObject {
            Wire.requireThat(token.toByteArray(Charsets.UTF_8).size <= 16384 && Regex("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+").matches(token), "invalid-ticket")
            val parts = token.split('.')
            val header = Wire.parse(Wire.decode(Wire.decode64(parts[0])), 16384)
            header.only("alg", "kid", "typ")
            Wire.requireThat(header.text("alg") == "EdDSA" && header.text("typ") == "opensteer-browser-attach+jwt", "invalid-ticket")
            val key = keys[header.text("kid")] ?: throw Refused("invalid-ticket")
            val signature = Wire.decode64(parts[2])
            Wire.requireThat(signature.size == 64, "invalid-ticket")
            val bytes = (parts[0] + "." + parts[1]).toByteArray(Charsets.UTF_8)
            val signer = Ed25519Signer().apply { init(false, key); update(bytes, 0, bytes.size) }
            Wire.requireThat(signer.verifySignature(signature), "invalid-ticket")
            val claims = Wire.parse(Wire.decode(Wire.decode64(parts[1])), 16384)
            claims.only("access", "audience", "passkeys", "navigationVersion", "wireVersion", "operationExpiresAt", "remainingBudgetMs", "initialNavigation", "navigationAttributionVersion", "editingVersion", "basicInput", "surfaceState", "clipboard", "workspaceTabRestoreVersion", "popupFollowVersion", "initialSurfaceId", "dormantSurfaceIds", "expiresAt", "identity", "issuedAt", "nonce", "runtimeId", "sessionId", "subject", "viewport")
            Wire.requireThat(claims.text("audience") == "opensteer-browser-runtime" && claims.number("wireVersion") == 1L)
            Wire.requireThat(claims.text("access") in setOf("read", "read-write"))
            claims.text("nonce", 16); claims.text("subject"); claims.text("sessionId")
            claims.number("remainingBudgetMs", 1, 20_000); claims.time("operationExpiresAt")
            try { validateClaims(claims) } catch (_: Exception) { throw Refused("invalid-ticket") }
            validateTimes(claims, runtimeId, now)
            return claims
        }
        fun validateTimes(claims: JsonObject, runtimeId: String, now: Long) {
            val issued = claims.time("issuedAt"); val expires = claims.time("expiresAt")
            Wire.requireThat(claims.text("runtimeId") == runtimeId && issued <= now + 5000 && expires > now && expires > issued && expires - issued <= 300_000, "invalid-ticket")
        }
        private fun validateClaims(claims: JsonObject) {
            Wire.requireThat(Regex("bsn_[0-9a-fA-F-]{36}").matches(claims.text("sessionId")))
            for (key in listOf("passkeys", "navigationVersion", "navigationAttributionVersion", "basicInput", "surfaceState", "workspaceTabRestoreVersion", "popupFollowVersion")) {
                if (claims.containsKey(key)) Wire.requireThat(claims.number(key) == 1L)
            }
            if (claims.containsKey("editingVersion")) claims.number("editingVersion", 1, 2)
            if (claims["editingVersion"] == JsonPrimitive(2)) Wire.requireThat(claims["clipboard"] in setOf(JsonPrimitive(true), JsonPrimitive(false)))
            else Wire.requireThat(!claims.containsKey("clipboard"))
            if (claims.containsKey("initialSurfaceId")) claims.text("initialSurfaceId", max = 512)
            if (claims.containsKey("dormantSurfaceIds")) {
                val surfaces = claims["dormantSurfaceIds"] as? JsonArray ?: throw Refused("invalid-ticket")
                Wire.requireThat(surfaces.size <= 63)
                for (surface in surfaces) {
                    val value = surface as? JsonPrimitive ?: throw Refused("invalid-ticket")
                    Wire.requireThat(value.isString && value.content.length in 1..512)
                }
            }
            if (claims.containsKey("viewport")) {
                val viewport = claims.obj("viewport")
                viewport.only("width", "height")
                Wire.requireThat(viewport.number("width", 1, 7680) * viewport.number("height", 1, 4320) <= 16777216)
            }
            if (claims.containsKey("initialNavigation")) {
                val navigation = claims.obj("initialNavigation")
                navigation.only("operationKey", "url", "navigationId")
                navigation.text("operationKey")
                if (navigation.containsKey("navigationId")) Wire.requireThat(Wire.uuid.matches(navigation.text("navigationId")))
                if (navigation.containsKey("url")) {
                    val uri = java.net.URI(navigation.text("url", max = 8192))
                    Wire.requireThat(uri.scheme in setOf("http", "https") && uri.host != null && uri.rawUserInfo == null)
                }
            }
            val identity = claims.obj("identity")
            when (identity.text("kind")) {
                "fresh" -> identity.only("kind")
                "profile-local" -> {
                    identity.only("kind", "binding", "initialized", "readyUrl")
                    Wire.requireThat(identity["initialized"] in setOf(JsonPrimitive(true), JsonPrimitive(false)))
                    Wire.requireThat(java.net.URI(identity.text("readyUrl", max = 8192)).isAbsolute)
                    val binding = identity.obj("binding")
                    binding.only("version", "deploymentId", "profileId", "runnerId", "storageInstanceId", "bindingId", "engine")
                    Wire.requireThat(binding.number("version") == 1L)
                    for ((key, prefix) in listOf("deploymentId" to "dep_", "profileId" to "bpr_", "runnerId" to "rnr_"))
                        Wire.requireThat(Regex(prefix + Wire.uuid.pattern).matches(binding.text(key)))
                    for (key in listOf("storageInstanceId", "bindingId")) Wire.requireThat(Wire.uuid.matches(binding.text(key)))
                    Wire.requireThat(binding.text("engine") in setOf("electron", "chromium", "wkwebview", "android-webview"))
                }
                else -> throw Refused("invalid-ticket")
            }
        }
    }
}
