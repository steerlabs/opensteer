package com.opensteer.agentphone.runner

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.opensteer.agentphone.wire.JsonText
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * This phone's identity on disk: one file in no-backup storage, written
 * atomically, its contents sealed with AES-GCM under a key the Android
 * Keystore holds and never releases. A copied file is useless off this
 * phone, and backups exclude it besides.
 *
 * Every method is synchronized: the setup thread writes pairings and the
 * runtime thread writes connection generations.
 */
class IdentityStore(directory: File) {
    private val file = AtomicFile(File(directory, "identity.v1.sealed"))

    @Synchronized
    fun load(): PhoneIdentity? {
        val sealed = try {
            file.readFully()
        } catch (missing: FileNotFoundException) {
            return null
        }
        val iv = sealed.copyOfRange(0, IV_BYTES)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
        return PhoneIdentity.fromJson(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES).toString(Charsets.UTF_8))
    }

    @Synchronized
    fun save(identity: PhoneIdentity) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(JsonText.stringify(identity.toJson()).toByteArray(Charsets.UTF_8))
        val stream = file.startWrite()
        try {
            stream.write(sealed)
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    /** Replaces the stored identity only if it is still `expected`: an unpair in between wins. */
    @Synchronized
    fun replace(expected: PhoneIdentity, next: PhoneIdentity): Boolean {
        if (load() != expected) return false
        save(next)
        return true
    }

    /**
     * Clears only the identity whose connection was revoked. USB may have
     * paired another one before the runtime handles the close, so comparison
     * and deletion share this lock. A welcome, rename or retarget still names
     * the same identity: only its stable enrollment and Runner key decide lineage.
     */
    @Synchronized
    fun wipeIfCurrent(expected: PhoneIdentity): Boolean {
        val current = load() ?: return false
        if (current.runnerId != expected.runnerId || current.deploymentId != expected.deploymentId ||
            current.enrollmentId != expected.enrollmentId || current.runnerKey != expected.runnerKey
        ) return false
        wipe()
        return true
    }

    @Synchronized
    fun wipe() {
        file.delete()
        KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(KEY_ALIAS)
    }

    private fun key(): SecretKey {
        val keystore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keystore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "opensteer-agent-phone-identity"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
