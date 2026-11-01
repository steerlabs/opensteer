package com.opensteer.notificationpreview

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.time.Instant
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object PreviewCrypto {
  fun jsonArray(values: List<String>): String =
    values.joinToString(",", "[", "]") { value ->
      val escaped = buildString {
        for (character in value) when (character.code) {
          34 -> {
            append(92.toChar())
            append(character)
          }
          92 -> {
            append(92.toChar())
            append(character)
          }
          8 -> {
            append(92.toChar())
            append('b')
          }
          12 -> {
            append(92.toChar())
            append('f')
          }
          10 -> {
            append(92.toChar())
            append('n')
          }
          13 -> {
            append(92.toChar())
            append('r')
          }
          9 -> {
            append(92.toChar())
            append('t')
          }
          else ->
            if (character.code < 32) {
              append(92.toChar())
              append("u%04x".format(character.code))
            } else append(character)
        }
      }
      34.toChar().toString() + escaped + 34.toChar()
    }

  fun aad(fields: Map<String, String>, keyId: String): ByteArray =
    jsonArray(
        listOf(
          "opensteer-notification-preview-v1",
          fields.getValue("deploymentId"),
          fields.getValue("notificationId"),
          fields.getValue("installationId"),
          keyId,
          fields.getValue("kind"),
          fields.getValue("deepLink"),
          fields.getValue("expiresAt"),
        )
      )
      .toByteArray(Charsets.UTF_8)

  fun encode(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

  fun decode(value: String, min: Int, max: Int): ByteArray {
    require(value.matches(Regex("^[A-Za-z0-9_-]+$")))
    val bytes = Base64.getUrlDecoder().decode(value)
    require(bytes.size in min..max && encode(bytes) == value)
    return bytes
  }

  fun open(
    key: String?,
    nonce: String,
    ciphertext: String,
    aad: ByteArray,
    expiresAt: String,
    marker: String,
    recordMarker: String,
    now: Instant = Instant.now(),
  ): ByteArray {
    require(marker.isNotEmpty() && marker == recordMarker && key != null)
    require(
      expiresAt.matches(
        Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$")
      )
    )
    require(Instant.parse(expiresAt).isAfter(now))
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      SecretKeySpec(decode(key, 32, 32), "AES"),
      GCMParameterSpec(128, decode(nonce, 12, 12)),
    )
    cipher.updateAAD(aad)
    val plain = cipher.doFinal(decode(ciphertext, 17, 2064))
    require(plain.size <= 2048)
    Charsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(plain))
    return plain
  }
}
