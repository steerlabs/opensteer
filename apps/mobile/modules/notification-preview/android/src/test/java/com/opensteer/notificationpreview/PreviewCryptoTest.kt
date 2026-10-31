package com.opensteer.notificationpreview
import org.junit.Test
import org.junit.Assert.*
import java.io.File
import java.time.Instant
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
class PreviewCryptoTest {
  private fun fixture(): Map<String, String> {
    val file = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
      .map { File(it, "packages/core/src/fixtures/notification-preview-v1.json") }.first { it.isFile }
    // The fixture fields used here are ASCII; plaintext is compared as bytes below.
    return Regex("\"(\\w+)\"\\s*:\\s*\"([^\"\\\\]*)\"").findAll(file.readText()).associate { it.groupValues[1] to it.groupValues[2] }
  }
  private fun aad(f: Map<String, String>) = PreviewCrypto.aad(f, f.getValue("keyId"))
  @Test fun sharedVectorAndRejections() {
    val f = fixture(); val now = Instant.EPOCH
    fun open(fields: Map<String, String> = f, cipher: String = f.getValue("ciphertext"), key: String? = f["key"], marker: String = "install", time: Instant = now) =
      PreviewCrypto.open(key, f.getValue("nonce"), cipher, aad(fields), f.getValue("expiresAt"), "install", marker, time)
    val plain = "{\"version\":1,\"title\":\"Opensteer\",\"body\":\"Build passed. You can review it.\"}".toByteArray()
    assertArrayEquals(plain, open())
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(PreviewCrypto.decode(f.getValue("key"),32,32),"AES"), GCMParameterSpec(128,PreviewCrypto.decode(f.getValue("nonce"),12,12)))
    cipher.updateAAD(aad(f)); assertEquals(f["ciphertext"], PreviewCrypto.encode(cipher.doFinal(plain)))
    for (name in listOf("deploymentId","notificationId","installationId","keyId","kind","deepLink","expiresAt")) {
      assertThrows(Exception::class.java) { open(f + (name to f.getValue(name) + "x")) }
    }
    assertThrows(Exception::class.java) { open(cipher = "A" + f.getValue("ciphertext").drop(1)) }
    assertThrows(Exception::class.java) { open(key = null) }
    assertThrows(Exception::class.java) { open(marker = "old") }
    assertThrows(Exception::class.java) { open(time = Instant.parse(f.getValue("expiresAt"))) }
  }
}
