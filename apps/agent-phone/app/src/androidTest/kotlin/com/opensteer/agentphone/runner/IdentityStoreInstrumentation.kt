package com.opensteer.agentphone.runner

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import android.util.AtomicFile
import com.opensteer.agentphone.wire.Base64Url
import com.opensteer.agentphone.wire.Ed25519Key
import com.opensteer.agentphone.wire.Pairing
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Persistence regression on a dedicated, unpaired device, before the full
 * phone journey: this deliberately uses and wipes the production identity
 * file and Keystore alias. It refuses an existing identity. `am instrument
 * -w com.opensteer.agentphone.test/com.opensteer.agentphone.runner.IdentityStoreInstrumentation`
 * prints a JSON result suitable for saving beside the journey's artifacts.
 *
 * Failure modes, declared before implementing migration and conditional wipe:
 * 1. a revoked current identity leaves its encrypted file or Keystore key;
 * 2. a changed generation, forgotten enrollment token, confirmed address,
 *    renamed Deployment or moved route prevents a legitimate revoke;
 * 3. an old revoke deletes a new pairing, including one that shares every
 *    lineage field but one: runner, Deployment, enrollment or Runner key;
 * 4. revoking an empty slot creates or deletes unrelated identity material;
 * 5. comparison and deletion let a concurrent PAIR save slip between them,
 *    so the new pairing loses its file or becomes unreadable;
 * 6. the v1 reader loses pairing or the unspent enrollment token, the v2
 *    writer keeps the approval seed, or a restart cannot read its ciphertext;
 * 7. the v2 reader accepts an obsolete seed, unknown fields or versions.
 */
class IdentityStoreInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        val store = IdentityStore(targetContext.noBackupFilesDir)
        val results = JSONArray()
        var ownsSlot = false
        var failure: Throwable? = null
        try {
            check(store.load() == null) { "This regression requires a dedicated, unpaired device." }
            ownsSlot = true
            val original = PhoneIdentity.create(
                Pairing(
                    deploymentId = "dep_55555555-5555-4555-8555-555555555555",
                    deploymentName = "Test Mac",
                    enrollmentId = "ren_original",
                    enrollmentToken = "t".repeat(40),
                    expiresAt = "2026-10-11T12:10:00.000Z",
                    hostInstanceId = "hst_66666666-6666-4666-8666-666666666666",
                    hostUrl = "https://example.invalid",
                    runnerName = "Persistence fixture",
                ),
            )

            for (identity in listOf(original, original.confirmed().welcomed(7))) {
                case(results, "v1 migration preserves ${if (identity.enrolled) "enrolled" else "pending"} identity and writes only v2") {
                    store.save(identity)
                    val legacy = JSONObject()
                        .put("version", 1)
                        .put("approvalKeySeed", Base64Url.encode(Ed25519Key.generate().seed))
                        .put("runnerId", identity.runnerId)
                        .put("runnerKeySeed", Base64Url.encode(identity.runnerKey.seed))
                        .put("lastConnectionGeneration", identity.lastConnectionGeneration)
                        .put("deploymentId", identity.deploymentId)
                        .put("deploymentName", identity.deploymentName)
                        .put("hostInstanceId", identity.hostInstanceId)
                        .put("hostUrl", identity.hostUrl)
                        .put("hostVerified", identity.hostVerified)
                        .put("enrollmentId", identity.enrollmentId)
                        .put("runnerName", identity.runnerName)
                        .put("enrollmentToken", identity.enrollmentToken ?: JSONObject.NULL)
                    writeSealed(legacy.toString())
                    val migrated = IdentityStore(targetContext.noBackupFilesDir).load()
                    check(migrated == identity)
                    store.save(checkNotNull(migrated))
                    val written = JSONObject(readSealed())
                    check(written.getInt("version") == 2)
                    check(!written.has("approvalKeySeed"))
                    check(runCatching { PhoneIdentity.fromJson(JSONObject(written.toString()).put("approvalKeySeed", "obsolete").toString()) }.isFailure)
                    check(runCatching { PhoneIdentity.fromJson(JSONObject(written.toString()).put("unknown", true).toString()) }.isFailure)
                    check(runCatching { PhoneIdentity.fromJson(JSONObject(written.toString()).put("version", 3).toString()) }.isFailure)
                    check(IdentityStore(targetContext.noBackupFilesDir).load() == identity)
                    check(keyExists())
                }
            }

            case(results, "current revocation erases the file and key") {
                store.save(original)
                check(keyExists())
                check(store.wipeIfCurrent(original))
                check(store.load() == null)
                check(!keyExists())
            }

            case(results, "current lineage survives mutable generation and target changes") {
                val current = (original.confirmed().welcomed(7).retarget(original.target.copy(
                    deploymentName = "Renamed Mac",
                    hostInstanceId = "hst_77777777-7777-4777-8777-777777777777",
                    hostUrl = "https://moved.example.invalid",
                )) as Retarget.Moved).identity.confirmed().copy(runnerName = "Renamed phone")
                store.save(current)
                check(store.wipeIfCurrent(original))
                check(store.load() == null)
                check(!keyExists())
            }

            val replacements = listOf(
                "runner" to original.copy(runnerId = "rnr_88888888-8888-4888-8888-888888888888"),
                "Deployment" to original.copy(deploymentId = "dep_99999999-9999-4999-8999-999999999999"),
                "enrollment" to original.copy(enrollmentId = "ren_replacement"),
                "Runner key" to original.copy(runnerKey = Ed25519Key.generate()),
            )
            for ((changed, replacement) in replacements) {
                case(results, "a stale revoke preserves the replacement $changed") {
                    store.save(replacement)
                    check(!store.wipeIfCurrent(original))
                    check(store.load() == replacement)
                    check(keyExists())
                }
            }

            case(results, "an empty slot stays empty") {
                store.wipe()
                check(!store.wipeIfCurrent(original))
                check(store.load() == null)
                check(!keyExists())
            }

            case(results, "concurrent pairing cannot be deleted by an old revoke") {
                val replacement = original.copy(enrollmentId = "ren_concurrent")
                repeat(32) {
                    store.save(original)
                    val start = CountDownLatch(1)
                    val failed = AtomicReference<Throwable?>()
                    val revoke = Thread {
                        try {
                            start.await()
                            store.wipeIfCurrent(original)
                        } catch (error: Throwable) {
                            failed.compareAndSet(null, error)
                        }
                    }
                    val pair = Thread {
                        try {
                            start.await()
                            store.save(replacement)
                        } catch (error: Throwable) {
                            failed.compareAndSet(null, error)
                        }
                    }
                    revoke.start()
                    pair.start()
                    start.countDown()
                    revoke.join()
                    pair.join()
                    failed.get()?.let { throw it }
                    check(store.load() == replacement) { "The replacement identity was lost in iteration $it." }
                    check(keyExists())
                }
            }
        } catch (error: Throwable) {
            failure = error
        } finally {
            if (ownsSlot) store.wipe()
        }
        val report = JSONObject().put("cases", results).put("passed", failure == null)
        failure?.let { report.put("error", "${it.javaClass.simpleName}: ${it.message}") }
        finish(if (failure == null) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
            putString("stream", "\n${report.toString(2)}\n")
        })
    }

    private fun case(results: JSONArray, name: String, run: () -> Unit) {
        try {
            run()
            results.put(JSONObject().put("name", name).put("passed", true))
        } catch (error: Throwable) {
            results.put(JSONObject().put("name", name).put("passed", false))
            throw error
        }
    }

    private fun keyExists(): Boolean = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        .containsAlias("opensteer-agent-phone-identity")

    private fun identityKey(): SecretKey = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        .getKey("opensteer-agent-phone-identity", null) as SecretKey

    private fun writeSealed(text: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, identityKey())
        val file = AtomicFile(File(targetContext.noBackupFilesDir, "identity.v1.sealed"))
        val stream = file.startWrite()
        try {
            stream.write(cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8)))
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    private fun readSealed(): String {
        val sealed = File(targetContext.noBackupFilesDir, "identity.v1.sealed").readBytes()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, identityKey(), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
        return cipher.doFinal(sealed, 12, sealed.size - 12).toString(Charsets.UTF_8)
    }
}
