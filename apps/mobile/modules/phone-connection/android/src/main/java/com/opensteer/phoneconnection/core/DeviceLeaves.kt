package com.opensteer.phoneconnection.core

import kotlinx.serialization.json.*

class DeviceLeaves(private val storage: DurableBytes) {
    @Synchronized fun pending(): List<JsonObject> {
        val bytes = storage.read()?.takeIf { it.isNotEmpty() } ?: return emptyList()
        val value = Json.parseToJsonElement(Wire.decode(bytes))
        val entries = if (value is JsonArray) value.toList() else listOf(value)
        return entries.map {
            val leave = it as? JsonObject ?: throw Refused("identity-unavailable")
            Wire.requireThat(leave.number("version") == 1L, "identity-unavailable")
            leave.text("deploymentId"); leave.text("runnerId"); leave.text("hostUrl"); leave.text("issuedAt"); leave.text("signature")
            leave
        }
    }
    @Synchronized fun persist(leave: JsonObject) {
        val entries = pending()
        if (entries.any { it["runnerId"] == leave["runnerId"] }) return
        write(entries + leave)
    }
    @Synchronized fun complete(runnerId: String) { write(pending().filter { it.text("runnerId") != runnerId }) }
    fun <T> leave(fence: () -> Unit, sign: () -> JsonObject?, erase: () -> T): Pair<T, Boolean> {
        fence()
        val proof = sign()
        if (proof != null) persist(proof)
        return erase() to (proof != null)
    }
    private fun write(entries: List<JsonObject>) { storage.write(JsonArray(entries).toString().toByteArray(Charsets.UTF_8)) }
}
