package com.opensteer.agentphone.update

import com.opensteer.agentphone.wire.Fields
import com.opensteer.agentphone.wire.JsonNull
import com.opensteer.agentphone.wire.WireException
import java.security.MessageDigest

/** Protocol 1 is independent of integrations admission, so a refused phone can repair itself. */
data class UpdateOffer(
    val sha256: String,
    val size: Long,
    val versionCode: Long,
    val versionName: String,
    val minSdk: Long,
    val signer: String,
) {
    companion object {
        const val MAX_BYTES = 24L * 1024 * 1024
        private val digest = Regex("[a-f0-9]{64}")

        fun decode(text: String): UpdateOffer? {
            val envelope = Fields.parse(text, "phoneUpdate")
            envelope.literal("type", "host.agent-phone.update")
            if (envelope.int("protocolVersion") != 1L) throw WireException("Unsupported phone update protocol")
            val raw = envelope.raw("release")
            envelope.end()
            if (raw == JsonNull) return null
            val release = Fields.of(raw, "release")
            val manifestJson = release.string("manifestJson", min = 1, max = 16_384)
            val receipt = release.obj("receipt")
            release.end()
            val manifest = Fields.parse(manifestJson, "manifest")
            manifest.literal("packageName", "com.opensteer.agentphone")
            manifest.literal("buildType", "release")
            val offer = UpdateOffer(
                sha256 = manifest.string("apkSha256", pattern = digest),
                size = manifest.int("apkSize", 1, MAX_BYTES),
                versionCode = manifest.int("versionCode", 1, Int.MAX_VALUE.toLong()),
                versionName = manifest.string("versionName", min = 1, max = 64),
                minSdk = manifest.int("minSdk", 30, Int.MAX_VALUE.toLong()),
                signer = manifest.string("signingCertSha256", pattern = digest),
            )
            manifest.end()
            if (receipt.int("schemaVersion") != 1L) throw WireException("Unsupported phone release receipt")
            receipt.string("sourceRevision", pattern = Regex("[a-f0-9]{40}"))
            val version = receipt.string("version", pattern = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)"))
            val sha = receipt.string("apkSha256", pattern = digest)
            val size = receipt.int("apkSize", 1, MAX_BYTES)
            val signer = receipt.string("signingCertSha256", pattern = digest)
            val manifestSha = receipt.string("manifestSha256", pattern = digest)
            receipt.end()
            val parts = version.split('.').map(String::toLong)
            if (sha != offer.sha256 || size != offer.size || signer != offer.signer || version != offer.versionName ||
                parts[1] >= 1000 || parts[2] >= 1000 || parts[0] * 1_000_000 + parts[1] * 1000 + parts[2] != offer.versionCode ||
                manifestSha != sha256(manifestJson.toByteArray(Charsets.UTF_8))) throw WireException("Phone release receipt mismatch")
            return offer
        }

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
