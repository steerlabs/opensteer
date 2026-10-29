package com.opensteer.agentphone.wire

import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** No cryptographic or parser diagnostic may carry a saved value into runtime logs. */
class LoginTextException(message: String = "Saved login text was refused; request sign-in again.") : RuntimeException(message)

private inline fun <T> loginChecked(block: () -> T): T = try { block() }
catch (error: LoginTextException) { throw error }
catch (_: Exception) { throw LoginTextException() }

private val connectionPattern = Regex("^[A-Za-z0-9._:-]{1,128}$")
private val actPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
private val loginFields = setOf("username", "password", "code")

sealed interface PhoneText {
    data class Literal(val value: String) : PhoneText
    data class Saved(val envelope: SealedLoginEnvelope) : PhoneText
}

data class LoginBinding(
    val connectionId: String,
    val connectionGeneration: Long,
    val runId: String,
    val sessionId: String,
    val actId: String,
    val actionIndex: Int,
    val field: String,
    val expiresAt: Long,
) {
    fun toJson() = jsonObject(
        "version" to jsonOf(1), "connectionId" to jsonOf(connectionId),
        "connectionGeneration" to jsonOf(connectionGeneration), "runId" to jsonOf(runId),
        "sessionId" to jsonOf(sessionId), "actId" to jsonOf(actId),
        "actionIndex" to jsonOf(actionIndex), "field" to jsonOf(field), "expiresAt" to jsonOf(expiresAt),
    )

    internal fun replayId() = listOf(connectionId, connectionGeneration.toString(), runId, sessionId, actId, actionIndex.toString())

    companion object {
        fun decode(value: Json): LoginBinding = loginChecked {
            val f = Fields.of(value, "binding")
            check(f.int("version", 1, 1) == 1L)
            LoginBinding(
                f.string("connectionId", pattern = connectionPattern), f.int("connectionGeneration", 1),
                f.string("runId", pattern = Ids.run), f.string("sessionId", pattern = Ids.computerUseSession),
                f.string("actId", pattern = actPattern), f.int("actionIndex", 0, 31).toInt(),
                f.enum("field", loginFields), f.int("expiresAt", 1),
            ).also { f.end() }
        }
    }
}

data class SealedLoginEnvelope(
    val binding: LoginBinding,
    val senderPublicKey: ByteArray,
    val salt: ByteArray,
    val nonce: ByteArray,
    val ciphertext: ByteArray,
    val tag: ByteArray,
) {
    companion object {
        fun decode(value: Json): SealedLoginEnvelope = loginChecked {
            val f = Fields.of(value, "sealed")
            fun bytes(name: String, size: Int) = Base64Url.decode(f.string(name, max = (size * 4 + 2) / 3)).also { check(it.size == size) }
            SealedLoginEnvelope(
                LoginBinding.decode(f.raw("binding")), bytes("senderPublicKey", 65).also { loginPublicKey(it) },
                bytes("salt", 32), bytes("nonce", 12),
                Base64Url.decode(f.string("ciphertext", max = 21846)).also { check(it.size <= 16384) }, bytes("tag", 16),
            ).also { f.end() }
        }
    }
}

private fun ecParameters(): ECParameterSpec = AlgorithmParameters.getInstance("EC").apply {
    init(ECGenParameterSpec("secp256r1"))
}.getParameterSpec(ECParameterSpec::class.java)

private fun loginPublicKey(raw: ByteArray): java.security.PublicKey {
    check(raw.size == 65 && raw[0] == 4.toByte())
    val parameters = ecParameters()
    val x = BigInteger(1, raw.copyOfRange(1, 33))
    val y = BigInteger(1, raw.copyOfRange(33, 65))
    val prime = (parameters.curve.field as java.security.spec.ECFieldFp).p
    check(x < prime && y < prime)
    check(y.modPow(BigInteger.valueOf(2), prime) == (x.modPow(BigInteger.valueOf(3), prime) + parameters.curve.a * x + parameters.curve.b).mod(prime))
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), parameters))
}

/** The expected identities come from the authenticated dispatch, never from its ciphertext. */
data class LoginDispatch(
    val receiver: LoginTextReceiver,
    val runId: String,
    val sessionId: String,
    val actId: String,
    val deadline: Long,
) {
    fun preflight(actions: List<PhoneAction>): Map<Int, PreparedLoginText> {
        val saved = actions.mapIndexedNotNull { index, action ->
            val text = (action as? PhoneAction.Type)?.text as? PhoneText.Saved ?: return@mapIndexedNotNull null
            val b = text.envelope.binding
            index to (text.envelope to b.copy(runId = runId, sessionId = sessionId, actId = actId, actionIndex = index))
        }
        val prepared = receiver.preflight(saved.map { it.second }, deadline)
        return saved.mapIndexed { i, entry -> entry.first to prepared[i] }.toMap()
    }
}

/** A claim holds ciphertext only. Plaintext is opened afresh at the final ACTION_SET_TEXT route. */
class PreparedLoginText internal constructor(
    private val receiver: LoginTextReceiver,
    private val envelope: SealedLoginEnvelope,
    private val deadline: Long,
) {
    private val used = AtomicBoolean(false)
    val field: String get() = envelope.binding.field
    fun requireLive() = receiver.requireLive(envelope.binding, deadline)
    fun <T> useText(type: (CharArray) -> T): T {
        if (!used.compareAndSet(false, true)) throw LoginTextException()
        val text = receiver.open(envelope, deadline)
        return try { type(text) } finally { text.fill('\u0000') }
    }
}

/** One authenticated live stream's in-memory key and atomic replay ledger. */
class LoginTextReceiver internal constructor(
    private var privateKey: PrivateKey?,
    val key: JsonObject,
    private val clock: () -> Long,
) {
    private val claims = HashMap<List<String>, Long>()
    private var lastNow = Long.MIN_VALUE
    private val connectionId = (key.fields.getValue("connectionId") as JsonString).value
    private val connectionGeneration = (key.fields.getValue("connectionGeneration") as JsonNumber).value.toLong()

    private fun now(): Long = maxOf(clock(), lastNow).also { lastNow = it }

    @Synchronized fun invalidate() {
        val old = privateKey
        privateKey = null
        claims.clear()
        try { old?.destroy() } catch (_: Exception) { /* JCA providers may not support destroying in-memory keys. */ }
    }

    @Synchronized fun requireLive(binding: LoginBinding, deadline: Long = MAX_SAFE_INTEGER) {
        val now = now()
        if (privateKey == null)
            throw LoginTextException("The saved-login receiver disconnected; request sign-in again.")
        if (binding.connectionId != connectionId || binding.connectionGeneration != connectionGeneration)
            throw LoginTextException("Saved login text belongs to another phone connection; request sign-in again.")
        if (binding.expiresAt <= now)
            throw LoginTextException("Saved login text expired; request sign-in again.")
        // The issuers cap lifetime. A live envelope may outlast this dispatch's
        // independently reconstructed deadline; each deadline gates its own work.
        if (deadline <= now)
            throw LoginTextException("The saved login act deadline passed; request sign-in again.")
    }

    @Synchronized fun preflight(entries: List<Pair<SealedLoginEnvelope, LoginBinding>>, deadline: Long = MAX_SAFE_INTEGER): List<PreparedLoginText> = loginChecked {
        for ((envelope, expected) in entries) {
            check(envelope.binding == expected)
            open(envelope, deadline).fill('\u0000')
        }
        for ((envelope, _) in entries) requireLive(envelope.binding, deadline)
        val current = now()
        claims.entries.removeAll { it.value <= current }
        val ids = entries.map { it.first.binding.replayId() }
        check(ids.toSet().size == ids.size && ids.none { it in claims })
        for ((envelope, _) in entries) claims[envelope.binding.replayId()] = envelope.binding.expiresAt
        entries.map { PreparedLoginText(this, it.first, deadline) }
    }

    @Synchronized internal fun open(envelope: SealedLoginEnvelope, deadline: Long): CharArray = loginChecked {
        requireLive(envelope.binding, deadline)
        val shared = KeyAgreement.getInstance("ECDH").run {
            init(privateKey)
            doPhase(loginPublicKey(envelope.senderPublicKey), true)
            generateSecret()
        }
        var prk: ByteArray? = null
        var derived: ByteArray? = null
        var plaintext: ByteArray? = null
        try {
            check(shared.size == 32 && envelope.salt.size == 32 && envelope.nonce.size == 12 && envelope.tag.size == 16 && envelope.ciphertext.size <= 16384)
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(envelope.salt, "HmacSHA256"))
            prk = mac.doFinal(shared)
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            derived = mac.doFinal("opensteer/login-text/v1".toByteArray(Charsets.UTF_8) + byteArrayOf(1))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(derived, "AES"), GCMParameterSpec(128, envelope.nonce))
            cipher.updateAAD(CanonicalJson.encode(envelope.binding.toJson()).toByteArray(Charsets.UTF_8))
            plaintext = cipher.doFinal(envelope.ciphertext + envelope.tag)
            val chars = CharArray(plaintext.size)
            try {
                val output = CharBuffer.wrap(chars)
                val decoder = Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                check(decoder.decode(ByteBuffer.wrap(plaintext), output, true).isUnderflow)
                check(decoder.flush(output).isUnderflow)
                check(output.position() <= 4096)
                chars.copyOf(output.position())
            } finally { chars.fill('\u0000') }
        } finally {
            shared.fill(0); prk?.fill(0); derived?.fill(0); plaintext?.fill(0)
        }
    }

    companion object {
        fun generate(connectionId: String, generation: Long, clock: () -> Long): LoginTextReceiver = loginChecked {
            check(connectionPattern.matches(connectionId) && generation in 1..MAX_SAFE_INTEGER)
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            val public = pair.public as ECPublicKey
            fun coordinate(value: BigInteger) = value.toByteArray().takeLast(32).toByteArray().let { ByteArray(32 - it.size) + it }
            val raw = byteArrayOf(4) + coordinate(public.w.affineX) + coordinate(public.w.affineY)
            LoginTextReceiver(pair.private, jsonObject(
                "version" to jsonOf(1), "connectionId" to jsonOf(connectionId),
                "connectionGeneration" to jsonOf(generation), "publicKey" to jsonOf(Base64Url.encode(raw)),
            ), clock)
        }
    }
}
