package com.opensteer.phoneconnection

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.system.OsConstants
import com.opensteer.phoneconnection.core.*
import kotlinx.serialization.json.*
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.util.encoders.Base64
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class IdentityStore(context: Context) {
    private val directory = File(context.noBackupFilesDir, "phone-connection").apply { mkdirs() }
    private val file = AtomicBytes(File(directory, "identity.v1.sealed"), ::syncDirectory)
    private val denial = AtomicBytes(File(directory, "retiring.v1.json"), ::syncDirectory)
    // Outlives the identity: a signed leave is delivered after the seed is gone.
    private val leave = AtomicBytes(File(directory, "leave.v1.json"), ::syncDirectory)
    private val alias = "opensteer-mobile-phone-connection-v1"

    @Synchronized fun load(): JsonObject? {
        denial.read()?.let { bytes ->
            val marker = Wire.parse(Wire.decode(bytes), 4096)
            marker.only("version", "state", "deploymentId", "runnerId")
            Wire.requireThat(marker.number("version") == 1L && marker.text("state") == "retiring", "identity-unavailable")
            Wire.requireThat(Regex("dep_" + Wire.uuid.pattern).matches(marker.text("deploymentId")) && Regex("rnr_" + Wire.uuid.pattern).matches(marker.text("runnerId")), "identity-unavailable")
            return marker
        }
        val bytes = file.read() ?: return null
        Wire.requireThat(bytes.size in 29..65536, "identity-unavailable")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return Wire.parse(Wire.decode(cipher.doFinal(bytes, 12, bytes.size - 12)), 65536).also {
            Wire.requireThat(it.number("version") == 1L && it.text("state") in setOf("prepared", "pending", "enrolled", "retiring"), "identity-unavailable")
            it.text("deploymentId"); it.text("runnerId"); it.text("seed"); it.text("mintKey")
        }
    }
    @Synchronized fun save(identity: JsonObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(true))
        file.write(cipher.iv + cipher.doFinal(identity.toString().toByteArray(Charsets.UTF_8)))
    }
    @Synchronized fun prepare(deploymentId: String): JsonObject {
        val current = load()
        if (current != null) {
            Wire.requireThat(current.text("state") != "retiring", "erasure-pending")
            Wire.requireThat(current.text("deploymentId") == deploymentId, "enrolled-elsewhere")
            return current
        }
        val key = Ed25519PrivateKeyParameters(SecureRandom())
        val identity = Wire.fields("version" to JsonPrimitive(1), "deploymentId" to JsonPrimitive(deploymentId),
            "runnerId" to JsonPrimitive("rnr_" + UUID.randomUUID()), "seed" to JsonPrimitive(Wire.encode64(key.encoded)),
            "mintKey" to JsonPrimitive("android-enroll:" + UUID.randomUUID()), "state" to JsonPrimitive("prepared"))
        replay(identity).initialize()
        save(identity)
        return identity
    }
    @Synchronized fun forget() {
        val identity = File(directory, "identity.v1.sealed")
        Wire.requireThat(!identity.exists() || identity.delete(), "identity-unavailable")
        syncDirectory(directory)
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
        val marker = File(directory, "retiring.v1.json")
        Wire.requireThat(!marker.exists() || marker.delete(), "identity-unavailable")
        syncDirectory(directory)
    }
    @Synchronized fun retire(identity: JsonObject) {
        denial.write(Wire.fields("version" to JsonPrimitive(1), "state" to JsonPrimitive("retiring"),
            "deploymentId" to identity.getValue("deploymentId"), "runnerId" to identity.getValue("runnerId")).toString().toByteArray(Charsets.UTF_8))
    }
    fun replay(identity: JsonObject) = ReplayLedger(AtomicBytes(File(directory, identity.text("runnerId") + ".replay.v1.json"), ::syncDirectory))
    fun publicKey(identity: JsonObject): String {
        val key = Ed25519PrivateKeyParameters(Wire.decode64(identity.text("seed")), 0)
        val spki = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00) + key.generatePublicKey().encoded
        return "-----BEGIN PUBLIC KEY-----\n" + Base64.toBase64String(spki) + "\n-----END PUBLIC KEY-----\n"
    }
    fun fingerprint(identity: JsonObject): String {
        val pem = publicKey(identity)
        return Wire.digest(Base64.decode(pem.substringAfter("-----BEGIN PUBLIC KEY-----\n").substringBefore('\n')))
    }
    fun sign(identity: JsonObject, value: JsonArray): String {
        val seed = Wire.decode64(identity.text("seed"))
        try { return Proofs.sign(seed, value) } finally { seed.fill(0) }
    }
    @Synchronized fun saveLeave(obligation: JsonObject) { leave.write(obligation.toString().toByteArray(Charsets.UTF_8)) }
    @Synchronized fun pendingLeave(): JsonObject? {
        val bytes = leave.read()?.takeIf { it.isNotEmpty() } ?: return null
        return Wire.parse(Wire.decode(bytes), 4096).also {
            it.only("version", "deploymentId", "runnerId", "hostUrl", "issuedAt", "signature")
            Wire.requireThat(it.number("version") == 1L, "identity-unavailable")
        }
    }
    @Synchronized fun completeLeave(runnerId: String) {
        if (pendingLeave()?.text("runnerId") != runnerId) return
        val file = File(directory, "leave.v1.json")
        Wire.requireThat(!file.exists() || file.delete(), "identity-unavailable")
        syncDirectory(directory)
    }
    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        Wire.requireThat(create, "identity-unavailable")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
            generateKey()
        }
    }
    private fun syncDirectory(directory: File) {
        val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
        try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
    }
}
