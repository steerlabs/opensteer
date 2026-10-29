package com.opensteer.agentphone.display

import android.media.MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline
import android.media.MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline

/** Profile requests are hints on some encoders, so verify the emitted SPS before publishing any access unit. */
internal object EncoderPolicy {
    fun configure(attempt: (Int?, Boolean) -> Unit): Pair<Int?, Boolean> {
        val choices = listOf(AVCProfileConstrainedBaseline to true, AVCProfileConstrainedBaseline to false, AVCProfileBaseline to false, null to false)
        var failure: Exception? = null
        for (choice in choices) try { attempt(choice.first, choice.second); return choice }
            catch (error: Exception) { failure = error }
        throw requireNotNull(failure)
    }
    fun ordered(previous: Long, next: Long) = previous <= next
    fun codec(bytes: ByteArray): String? {
        for (i in 0 until bytes.size - 6) {
            if (bytes[i] == 0.toByte() && bytes[i+1] == 0.toByte() && bytes[i+2] == 1.toByte() && bytes[i+3].toInt() and 31 == 7) {
                require(bytes[i+4].toInt() and 255 == 66) { "Encoder output is not Baseline AVC" }
                return "avc1." + (i+4..i+6).joinToString("") { "%02X".format(bytes[it].toInt() and 255) }
            }
        }
        return null
    }
}
