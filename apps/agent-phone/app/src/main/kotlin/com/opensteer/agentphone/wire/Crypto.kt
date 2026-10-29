package com.opensteer.agentphone.wire

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * Unpadded base64url, strictly, as `@opensteer/shared/base64url` reads it:
 * a non-canonical spelling — padding, the standard alphabet, a dangling
 * character, nonzero trailing bits — does not decode.
 */
object Base64Url {
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val alphabet = Regex("^[A-Za-z0-9_-]*$")

    fun encode(bytes: ByteArray): String = encoder.encodeToString(bytes)

    fun decode(text: String): ByteArray {
        if (!alphabet.matches(text) || text.length % 4 == 1) throw WireException("Not canonical base64url")
        val bytes = Base64.getUrlDecoder().decode(text)
        if (encode(bytes) != text) throw WireException("Not canonical base64url")
        return bytes
    }
}

object Digests {
    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    /** `tokenDigest` from `@opensteer/core/crypto`: `sha256:<base64url>` of the UTF-8 text. */
    fun tokenDigest(text: String): String = "sha256:" + Base64Url.encode(sha256(text.toByteArray(Charsets.UTF_8)))
}

/**
 * An Ed25519 key, through BouncyCastle's lightweight API: Android has no
 * platform Ed25519 before API 33, and the app runs from API 30.
 *
 * Its public half is spelled as Node spells it — DER SubjectPublicKeyInfo,
 * PEM with one base64 line — because the Host compares PEM text and
 * fingerprints the DER.
 */
class Ed25519Key private constructor(private val privateKey: Ed25519PrivateKeyParameters) {
    val seed: ByteArray get() = privateKey.encoded

    val publicKeyRaw: ByteArray = privateKey.generatePublicKey().encoded

    val spki: ByteArray = SPKI_PREFIX + publicKeyRaw

    val publicKeyPem: String =
        "-----BEGIN PUBLIC KEY-----\n" + Base64.getEncoder().encodeToString(spki) + "\n-----END PUBLIC KEY-----\n"

    /** `sha256:<base64url>` of the DER SPKI: a Runner key's fingerprint. */
    val fingerprint: String = "sha256:" + Base64Url.encode(Digests.sha256(spki))

    /** Two keys are the same key when their public halves are. */
    override fun equals(other: Any?): Boolean = other is Ed25519Key && other.publicKeyRaw.contentEquals(publicKeyRaw)

    override fun hashCode(): Int = publicKeyRaw.contentHashCode()

    override fun toString(): String = "Ed25519Key($fingerprint)"

    fun sign(message: ByteArray): ByteArray = Ed25519Signer().run {
        init(true, privateKey)
        update(message, 0, message.size)
        generateSignature()
    }

    companion object {
        private val SPKI_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

        fun fromSeed(seed: ByteArray): Ed25519Key {
            require(seed.size == 32) { "An Ed25519 seed is 32 bytes" }
            return Ed25519Key(Ed25519PrivateKeyParameters(seed, 0))
        }

        fun generate(random: SecureRandom = SecureRandom()): Ed25519Key = Ed25519Key(Ed25519PrivateKeyParameters(random))
    }
}
