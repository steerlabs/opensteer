package com.opensteer.notificationpreview

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class PreviewStore(context: Context) {
  private val root = File(context.noBackupFilesDir, "notification-preview").also { it.mkdirs() }
  private fun random(size: Int) = PreviewCrypto.encode(ByteArray(size).also { SecureRandom().nextBytes(it) })
  @Synchronized fun marker(): String {
    val file = File(root, "installation")
    if (!file.exists()) write(file, random(18).toByteArray())
    return file.readText().also { require(it.isNotEmpty()) }
  }
  private fun wrappingKey(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
    val alias = "opensteer-notification-preview"
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).setUserAuthenticationRequired(false).build())
    return generator.generateKey()
  }
  private fun file(dep: String): File {
    require(dep.matches(Regex("^dep_[0-9a-f-]{36}$")))
    return File(root, dep)
  }
  fun read(dep: String): JSONObject? {
    val file = file(dep); if (!file.exists()) return null
    val bytes = file.readBytes(); require(bytes.size in 29..4096)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
    cipher.updateAAD(dep.toByteArray())
    val record = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    return record.takeIf { it.getString("marker") == marker() }
  }
  @Synchronized fun key(dep: String): Map<String, String> {
    read(dep)?.let { return mapOf("keyId" to it.getString("keyId"), "key" to it.getString("key")) }
    val record = JSONObject(mapOf("marker" to marker(), "keyId" to random(16), "key" to random(32)))
    val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, wrappingKey()); cipher.updateAAD(dep.toByteArray())
    write(file(dep), cipher.iv + cipher.doFinal(record.toString().toByteArray()))
    return mapOf("keyId" to record.getString("keyId"), "key" to record.getString("key"))
  }
  @Synchronized fun erase(dep: String?) {
    val files = if (dep == null) root.listFiles()?.filter { it.name.startsWith("dep_") } ?: emptyList() else listOf(file(dep))
    files.forEach { require(!it.exists() || it.delete()) }
  }
  @Synchronized fun prepare() {
    marker()
    root.listFiles()?.filter { it.name.startsWith("dep_") }?.forEach { file ->
      if (runCatching { read(file.name) }.getOrNull() == null) erase(file.name)
    }
  }
  private fun write(file: File, bytes: ByteArray) {
    val atomic = AtomicFile(file); val stream = atomic.startWrite()
    try { stream.write(bytes); atomic.finishWrite(stream) } catch (error: Exception) { atomic.failWrite(stream); throw error }
  }
}
