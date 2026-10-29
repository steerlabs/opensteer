package com.opensteer.agentphone.display

import android.content.Context
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Surface
import com.opensteer.agentphone.control.DisplayGate
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

data class EncodedPicture(val generation: Long, val ptsUs: Long, val key: Boolean, val codec: String?, val width: Int,
    val height: Int, val rotation: Int, val payload: ByteArray)

/** The projection has one VirtualDisplay for its entire lifetime, including protection and geometry changes. */
class ProjectionCapture(private val context: Context, private val projection: MediaProjection, private val ended: () -> Unit) {
    val gate = DisplayGate()
    @Volatile var onFrame: (EncodedPicture) -> Unit = {}
    @Volatile var onFailure: (Throwable) -> Unit = {}
    @Volatile var onResize: () -> Unit = {}
    private var display: VirtualDisplay? = null
    private var encoder: Encoder? = null
    private var stopped = false
    var width = 0
        private set
    var height = 0
        private set
    var rotation = 0
        private set
    var encoderName = ""
        private set
    var hardware = false
        private set
    private class Encoder(val codec: MediaCodec, val surface: Surface, val width: Int, val height: Int, val rotation: Int) {
        var generation = 0L
        var sps = ByteArray(0)
        var pps = ByteArray(0)
        var config = ByteArray(0)
        var codecString: String? = null
        var ptsUs = -1L
    }
    private val callback = object : MediaProjection.Callback() {
        override fun onStop() { if (stop()) onFailure(ProjectionEnded()) }
        override fun onCapturedContentResize(width: Int, height: Int) = onResize()
    }
    init { projection.registerCallback(callback, Handler(Looper.getMainLooper())) }

    fun reset(maxLongSide: Int, maxFps: Int, bitrate: Int): Long = synchronized(gate.lock) {
        check(!stopped)
        protect()
        val source = context.getSystemService(DisplayManager::class.java).getDisplay(android.view.Display.DEFAULT_DISPLAY)
        val size = Point()
        @Suppress("DEPRECATION")
        source.getRealSize(size)
        val density = context.resources.displayMetrics.densityDpi
        val info = chooseEncoder()
        val caps = info.getCapabilitiesForType("video/avc")
        val video = requireNotNull(caps.videoCapabilities)
        val aw = max(2, video.widthAlignment)
        val ah = max(2, video.heightAlignment)
        val scale = minOf(1.0, maxLongSide.toDouble() / max(size.x, size.y))
        fun aligned(value: Double, alignment: Int): Int = ((value / alignment).roundToInt() * alignment).coerceAtLeast(alignment)
        var width = aligned(size.x * scale, aw)
        var height = aligned(size.y * scale, ah)
        if (width > maxLongSide) width = maxLongSide / aw * aw
        if (height > maxLongSide) height = maxLongSide / ah * ah
        val codec = MediaCodec.createByCodecName(info.name)
        var surface: Surface? = null
        try {
            val format = MediaFormat.createVideoFormat("video/avc", width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline)
                val macroblocks = ((width + 15) / 16) * ((height + 15) / 16)
                setInteger(MediaFormat.KEY_LEVEL, when {
                    macroblocks <= 3600 -> MediaCodecInfo.CodecProfileLevel.AVCLevel31
                    macroblocks <= 5120 -> MediaCodecInfo.CodecProfileLevel.AVCLevel32
                    macroblocks <= 8192 -> MediaCodecInfo.CodecProfileLevel.AVCLevel4
                    else -> MediaCodecInfo.CodecProfileLevel.AVCLevel5
                })
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, minOf(30, maxFps))
                setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, minOf(30, maxFps).toFloat())
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
                setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                // The input surface resubmits a still picture at this interval, at most ten times,
                // so an encoder that holds a frame back releases the last one of a burst and the
                // still picture is refined; then it sends nothing until the screen changes.
                setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 250_000)
                setInteger(MediaFormat.KEY_PRIORITY, 0)
                setInteger(MediaFormat.KEY_LATENCY, 1)
                setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
            }
            var attempts = 0
            val chosen = EncoderPolicy.configure { profile, optional ->
                if (attempts++ > 0) codec.reset()
                if (profile == null) format.removeKey(MediaFormat.KEY_PROFILE) else format.setInteger(MediaFormat.KEY_PROFILE, profile)
                if (!optional) listOf(MediaFormat.KEY_LOW_LATENCY, MediaFormat.KEY_LATENCY, MediaFormat.KEY_PRIORITY).forEach(format::removeKey)
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            }
            android.util.Log.i("OpensteerDisplay", "Encoder ${info.name} profile=${chosen.first ?: "default"} keys=${format.keys.sorted()}")
            surface = codec.createInputSurface()
            codec.start()
            val current = Encoder(codec, surface, width, height, source.rotation * 90)
            current.generation = gate.reset(current)
            encoder = current
            this.width = width; this.height = height; rotation = current.rotation
            encoderName = info.name; hardware = info.isHardwareAccelerated
            val existing = display
            if (existing == null) display = projection.createVirtualDisplay("Opensteer phone display", width, height, density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null)
            else {
                existing.resize(width, height, density)
                existing.surface = surface
            }
            Thread({ drain(current) }, "opensteer-avc-drain").start()
            current.generation
        } catch (error: Exception) {
            gate.close { encoder = null }
            runCatching { codec.stop() }; codec.release(); surface?.release()
            throw error
        }
    }
    fun protect(drop: () -> Unit = {}) = synchronized(gate.lock) {
        gate.close {
            runCatching { display?.surface = null }
            // Retire synchronously; only the drain thread may release a started codec's output buffers.
            encoder = null
            drop()
        }
    }
    /** Refresh preserves reference history; it marks the next encoded picture as an IDR. */
    fun requestSync() = synchronized(gate.lock) {
        encoder?.let { current ->
            gate.requestKey()
            current.codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
        }
    }
    fun bitrate(value: Int) = synchronized(gate.lock) {
        encoder?.codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, value) })
    }
    fun stop(): Boolean = synchronized(gate.lock) {
        if (stopped) return false
        stopped = true
        protect()
        display?.release(); display = null
        projection.unregisterCallback(callback); projection.stop(); ended()
        true
    }
    private fun chooseEncoder(): MediaCodecInfo {
        val candidates = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { it.isEncoder &&
            it.supportedTypes.any { type -> type.equals("video/avc", true) } &&
            it.getCapabilitiesForType("video/avc").colorFormats.contains(MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface) }
        return candidates.firstOrNull { it.isHardwareAccelerated }
            ?: candidates.firstOrNull()
            ?: error("No AVC Surface encoder")
    }
    private fun drain(current: Encoder) {
        val bufferInfo = MediaCodec.BufferInfo()
        try {
            while (synchronized(gate.lock) { encoder === current && !stopped }) {
                val index = current.codec.dequeueOutputBuffer(bufferInfo, 10_000)
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val format = current.codec.outputFormat
                    val parts = listOfNotNull(format.getByteBuffer("csd-0"), format.getByteBuffer("csd-1"))
                    parts.forEach { updateConfig(current, annex(it.copyBytes())) }
                } else if (index >= 0) {
                    val buffer = current.codec.getOutputBuffer(index)
                    val bytes = if (buffer != null && bufferInfo.size > 0) {
                        buffer.position(bufferInfo.offset); buffer.limit(bufferInfo.offset + bufferInfo.size); annex(buffer.copyBytes())
                    } else ByteArray(0)
                    current.codec.releaseOutputBuffer(index, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        updateConfig(current, bytes)
                    } else if (bytes.isNotEmpty()) {
                        val key = bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                        if (key && (current.codecString == null || current.pps.isEmpty())) error("IDR has no SPS/PPS")
                        require(current.codecString != null) { "Encoder has no verified Baseline SPS" }
                        require(EncoderPolicy.ordered(current.ptsUs, bufferInfo.presentationTimeUs)) { "Encoder reordered pictures" }
                        current.ptsUs = bufferInfo.presentationTimeUs
                        val payload = if (key) current.config + bytes else bytes
                        gate.publish(current, key = key) {
                            onFrame(EncodedPicture(current.generation, bufferInfo.presentationTimeUs.coerceAtLeast(0), key,
                                if (key) current.codecString else null, current.width, current.height, current.rotation, payload))
                        }
                    }
                }
            }
        } catch (error: Exception) {
            val live = synchronized(gate.lock) { encoder === current && !stopped }
            if (live) onFailure(error)
        } finally {
            runCatching { current.codec.stop() }
            runCatching { current.codec.release() }
            current.surface.release()
        }
    }
    private fun updateConfig(current: Encoder, bytes: ByteArray) {
        val starts = ArrayList<Int>()
        var i = 0
        while (i < bytes.size - 3) {
            val length = if (bytes[i] == 0.toByte() && bytes[i + 1] == 0.toByte()) {
                if (bytes[i + 2] == 1.toByte()) 3
                else if (bytes[i + 2] == 0.toByte() && bytes[i + 3] == 1.toByte()) 4 else 0
            } else 0
            if (length != 0) { starts += i; i += length } else i++
        }
        for ((index, start) in starts.withIndex()) {
            val offset = start + if (bytes[start + 2] == 1.toByte()) 3 else 4
            if (offset >= bytes.size) continue
            val nal = bytes.copyOfRange(start, starts.getOrElse(index + 1) { bytes.size })
            when (bytes[offset].toInt() and 31) { 7 -> current.sps = nal; 8 -> current.pps = nal }
        }
        current.config = current.sps + current.pps
        current.codecString = EncoderPolicy.codec(current.sps)
    }
    private fun ByteBuffer.copyBytes(): ByteArray = ByteArray(remaining()).also { duplicate().get(it) }
    private fun annex(bytes: ByteArray): ByteArray {
        if (bytes.size >= 4 && bytes[0] == 0.toByte() && bytes[1] == 0.toByte() &&
            (bytes[2] == 1.toByte() || bytes[2] == 0.toByte() && bytes[3] == 1.toByte())) return bytes
        val output = java.io.ByteArrayOutputStream()
        val input = ByteBuffer.wrap(bytes)
        while (input.remaining() >= 4) {
            val size = input.int
            require(size > 0 && size <= input.remaining()) { "Invalid AVC access unit" }
            output.write(byteArrayOf(0, 0, 0, 1)); val nal = ByteArray(size); input.get(nal); output.write(nal)
        }
        require(!input.hasRemaining())
        return output.toByteArray()
    }
    class ProjectionEnded : RuntimeException("Projection ended")
}
