package com.opensteer.phoneconnection.core

import kotlinx.serialization.json.*
import java.io.File
import java.io.FileOutputStream

data class ReplayState(val highWaterAt: Long, val entries: List<Pair<String, Long>>) {
    fun json() = Wire.fields("version" to JsonPrimitive(1), "highWaterAt" to JsonPrimitive(highWaterAt),
        "entries" to JsonArray(entries.map { Wire.fields("nonce" to JsonPrimitive(it.first), "expiresAt" to JsonPrimitive(it.second)) }))
    fun claim(nonce: String, expiresAt: Long, now: Long, capacity: Int): ReplayState {
        Wire.requireThat(nonce.length in 16..255 && now >= highWaterAt && now >= 0 && expiresAt > now && expiresAt <= Wire.MAX_SAFE, "unavailable")
        val active = entries.filter { it.second > now }
        Wire.requireThat(active.none { it.first == nonce }, "already-used")
        Wire.requireThat(active.size < capacity, "full")
        return ReplayState(now, active + (nonce to expiresAt))
    }
    companion object {
        fun parse(value: JsonObject, capacity: Int): ReplayState {
            value.only("version", "highWaterAt", "entries")
            Wire.requireThat(value.number("version") == 1L, "unavailable")
            val entries = value["entries"] as? JsonArray ?: throw Refused("unavailable")
            Wire.requireThat(entries.size <= capacity, "unavailable")
            val parsed = entries.map {
                val entry = it as? JsonObject ?: throw Refused("unavailable")
                entry.only("nonce", "expiresAt")
                entry.text("nonce", 16) to entry.number("expiresAt", 1)
            }
            Wire.requireThat(parsed.map { it.first }.distinct().size == parsed.size, "unavailable")
            return ReplayState(value.number("highWaterAt"), parsed)
        }
    }
}

interface DurableBytes {
    fun read(): ByteArray?
    fun write(bytes: ByteArray)
}

class ReplayLedger(private val storage: DurableBytes, val capacity: Int = 4096) {
    @Synchronized fun initialize() {
        Wire.requireThat(storage.read() == null, "unavailable")
        storage.write(ReplayState(0, emptyList()).json().toString().toByteArray(Charsets.UTF_8))
    }
    @Synchronized fun read(): ReplayState = try {
        val bytes = storage.read() ?: throw Refused("unavailable")
        Wire.requireThat(bytes.size <= 2_097_152, "unavailable")
        ReplayState.parse(Wire.parse(Wire.decode(bytes), 2_097_152), capacity)
    } catch (_: Exception) { throw Refused("unavailable") }

    @Synchronized fun commit(expected: ReplayState, proposed: ReplayState, nonce: String, expiresAt: Long, now: Long) {
        Wire.requireThat(read() == expected, "unavailable")
        val next = expected.claim(nonce, expiresAt, now, capacity)
        Wire.requireThat(next == proposed, "unavailable")
        storage.write(next.json().toString().toByteArray(Charsets.UTF_8))
    }
}

class AtomicBytes(private val file: File, private val syncDirectory: (File) -> Unit) : DurableBytes {
    override fun read(): ByteArray? = if (file.exists()) file.readBytes() else null
    override fun write(bytes: ByteArray) {
        val temporary = File(file.parentFile, file.name + ".next")
        FileOutputStream(temporary).use { stream -> stream.write(bytes); stream.fd.sync() }
        Wire.requireThat(temporary.renameTo(file), "unavailable")
        syncDirectory(file.parentFile!!)
    }
}
