package com.opensteer.phoneconnection.core

import kotlinx.serialization.json.*
import java.nio.ByteBuffer

object FrameCodec {
    const val MAX_FRAME = 8 * 1024 * 1024
    const val MAX_HEADER = 16 * 1024
    fun envelope(header: JsonObject, payload: ByteArray): ByteArray {
        val bytes = header.toString().toByteArray(Charsets.UTF_8)
        Wire.requireThat(bytes.size in 1..MAX_HEADER && payload.isNotEmpty(), "invalid-frame")
        return ByteBuffer.allocate(4 + bytes.size + payload.size).putInt(bytes.size).put(bytes).put(payload).array()
    }
    fun split(bytes: ByteArray): Pair<JsonObject, ByteArray> {
        Wire.requireThat(bytes.size >= 5 && bytes.size <= MAX_FRAME + MAX_HEADER + 4, "invalid-frame")
        val length = ByteBuffer.wrap(bytes, 0, 4).int
        Wire.requireThat(length in 1..MAX_HEADER && length < bytes.size - 4, "invalid-frame")
        return Wire.parse(Wire.decode(bytes.copyOfRange(4, 4 + length)), MAX_HEADER) to bytes.copyOfRange(4 + length, bytes.size)
    }
    fun validateFrame(bytes: ByteArray) {
        Wire.requireThat(bytes.size <= MAX_FRAME, "invalid-frame")
        val (header, _) = split(bytes)
        header.only("capture", "encoding", "frameId", "geometryRevision", "rasterHeight", "rasterWidth", "surfaceId", "viewportHeight", "viewportWidth", "watchToken")
        Wire.requireThat(header.text("encoding") in setOf("jpeg", "png", "webp"), "invalid-frame")
        header.number("frameId"); header.text("surfaceId", max = 512)
        header.number("rasterHeight", 1, 4320); header.number("rasterWidth", 1, 7680)
        header.finite("viewportHeight", Double.MIN_VALUE, 16384.0); header.finite("viewportWidth", Double.MIN_VALUE, 16384.0)
        if (header.containsKey("geometryRevision")) header.number("geometryRevision")
        if (header.containsKey("watchToken")) Wire.requireThat(Wire.uuid.matches(header.text("watchToken")))
        if (header.containsKey("capture")) {
            val capture = header.obj("capture")
            capture.only("width", "height", "revision")
            capture.number("revision")
            Wire.requireThat(capture.finite("width", Double.MIN_VALUE, 16384.0) <= header.finite("viewportWidth", Double.MIN_VALUE, 16384.0) &&
                capture.finite("height", Double.MIN_VALUE, 16384.0) <= header.finite("viewportHeight", Double.MIN_VALUE, 16384.0) && header.containsKey("geometryRevision"))
        }
    }
    fun relay(header: JsonObject, frame: ByteArray): ByteArray {
        validateRelayHeader(header); validateFrame(frame)
        return envelope(header, frame)
    }
    fun decodeRelay(bytes: ByteArray): Pair<JsonObject, ByteArray> {
        val result = split(bytes)
        validateRelayHeader(result.first); validateFrame(result.second)
        return result
    }
    private fun validateRelayHeader(header: JsonObject) {
        header.only("runnerId", "bootId", "connectionId", "connectionGeneration", "connectionLeaseId", "auxiliaryStreamId", "module", "capability", "channelId", "sequence", "type")
        Fence.auxiliary(header)
        Wire.requireThat(header.text("type") == "browser.frame")
        Wire.requireThat(Regex("bch_" + Wire.uuid.pattern).matches(header.text("channelId")))
        header.number("sequence")
        val capability = header.obj("capability")
        capability.only("runtimeId", "capabilityGeneration", "capabilityLeaseId")
        capability.text("runtimeId"); capability.number("capabilityGeneration", 1)
        Wire.requireThat(Regex("bcl_" + Wire.uuid.pattern).matches(capability.text("capabilityLeaseId")))
    }
}
