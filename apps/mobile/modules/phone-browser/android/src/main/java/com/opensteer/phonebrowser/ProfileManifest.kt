package com.opensteer.phonebrowser

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal data class ProfileBinding(val deploymentId: String, val runnerId: String, val storageInstanceId: String, val profileId: String, val bindingId: String) {
  fun fields(): Map<String, Any> = mapOf("version" to 1, "deploymentId" to deploymentId, "runnerId" to runnerId, "storageInstanceId" to storageInstanceId, "profileId" to profileId, "bindingId" to bindingId, "engine" to "android-webview")
  fun json() = JSONObject().put("version", 1).put("deploymentId", deploymentId).put("runnerId", runnerId).put("storageInstanceId", storageInstanceId).put("profileId", profileId).put("bindingId", bindingId).put("engine", "android-webview")
}

internal data class ProfileEntry(val handle: String, val name: String, val binding: ProfileBinding, val guest: Boolean, val initialized: Boolean, val deletionId: String?, val deleted: Boolean) {
  fun json() = JSONObject().put("handle", handle).put("name", name).put("binding", binding.json()).put("guest", guest).put("initialized", initialized).put("deletionId", deletionId ?: JSONObject.NULL).put("deleted", deleted)
}

internal class ProfileManifest(read: () -> String?, private val write: (String) -> Unit) {
  private val maximumBytes = 1048576
  val storageInstanceId: String
  private var entries: List<ProfileEntry>

  init {
    val text = read()
    try {
      if (text == null) {
        storageInstanceId = UUID.randomUUID().toString()
        entries = emptyList()
        persist(entries)
      } else {
        if (text.toByteArray(Charsets.UTF_8).size > maximumBytes) throw BrowserFailure("profile-manifest-corrupt")
        val json = JSONObject(text)
        if (json.getInt("version") != 1) throw BrowserFailure("profile-manifest-corrupt")
        storageInstanceId = json.getString("storageInstanceId")
        UUID.fromString(storageInstanceId)
        val rows = json.getJSONArray("entries")
        entries = List(rows.length()) { index ->
          val row = rows.getJSONObject(index)
          val binding = row.getJSONObject("binding")
          val handle = row.getString("handle")
          UUID.fromString(handle)
          val name = row.getString("name")
          if (name != "opensteer_pb_" + handle.replace("-", "")) throw BrowserFailure("profile-manifest-corrupt")
          if (binding.getString("engine") != "android-webview") throw BrowserFailure("profile-manifest-corrupt")
          ProfileEntry(handle, name, ProfileBinding(binding.getString("deploymentId"), binding.getString("runnerId"), binding.getString("storageInstanceId"), binding.getString("profileId"), binding.getString("bindingId")), row.getBoolean("guest"), row.getBoolean("initialized"), if (row.isNull("deletionId")) null else row.getString("deletionId"), row.getBoolean("deleted"))
        }
        if (entries.map { it.handle }.toSet().size != entries.size || entries.map { it.binding.bindingId }.toSet().size != entries.size) throw BrowserFailure("profile-manifest-corrupt")
        val compacted = entries.filterNot { it.guest && it.deleted }
        if (compacted.size != entries.size) replace(compacted)
      }
    } catch (error: BrowserFailure) { throw error }
    catch (error: Exception) { throw BrowserFailure("profile-manifest-corrupt") }
  }

  fun all() = entries.toList()
  fun retireDeployment(deploymentId: String) {
    replace(entries.map { entry ->
      if (entry.binding.deploymentId == deploymentId && entry.deletionId == null)
        entry.copy(deletionId = UUID.randomUUID().toString())
      else entry
    })
  }
  fun requireGuestsErased(deploymentId: String) {
    if (entries.any { it.binding.deploymentId == deploymentId && it.guest && !it.deleted })
      throw com.opensteer.phoneconnection.core.Refused("erasure-pending")
  }
  fun inventory(deploymentId: String, runnerId: String) = entries.filter { it.binding.deploymentId == deploymentId && it.binding.runnerId == runnerId && !it.guest }
  fun byHandle(handle: String) = entries.find { it.handle == handle } ?: throw BrowserFailure("profile-missing")
  fun find(binding: ProfileBinding): ProfileEntry? {
    val entry = entries.find { it.binding.bindingId == binding.bindingId } ?: return null
    if (entry.binding != binding) throw BrowserFailure("forbidden")
    return entry
  }
  fun create(binding: ProfileBinding, initialized: Boolean, guest: Boolean): ProfileEntry {
    if (binding.storageInstanceId != storageInstanceId) throw BrowserFailure("profile-missing")
    find(binding)?.let { return it }
    if (initialized) throw BrowserFailure("profile-missing")
    val handle = UUID.randomUUID().toString()
    val entry = ProfileEntry(handle, "opensteer_pb_" + handle.replace("-", ""), binding, guest, false, if (guest) "guest:$handle" else null, false)
    val reserved = encoded((entries + entry).map { if (it.deletionId == null) it.copy(deletionId = "0".repeat(36)) else it })
    if (reserved.toByteArray(Charsets.UTF_8).size > maximumBytes) throw BrowserFailure("profile-manifest-full")
    replace(entries + entry)
    return entry
  }
  fun initialized(handle: String): ProfileEntry = update(handle) { it.copy(initialized = true) }
  fun tombstone(handle: String, deletionId: String): ProfileEntry = update(handle) { it.copy(deletionId = deletionId) }
  fun deleted(handle: String): ProfileEntry {
    val entry = byHandle(handle).copy(deleted = true)
    replace(if (entry.guest) entries.filterNot { it.handle == handle } else entries.map { if (it.handle == handle) entry else it })
    return entry
  }
  private fun update(handle: String, transform: (ProfileEntry) -> ProfileEntry): ProfileEntry {
    val next = transform(byHandle(handle))
    replace(entries.map { if (it.handle == handle) next else it })
    return next
  }
  private fun replace(next: List<ProfileEntry>) { persist(next); entries = next }
  private fun encoded(next: List<ProfileEntry>) = JSONObject().put("version", 1).put("storageInstanceId", storageInstanceId).put("entries", JSONArray(next.map { it.json() })).toString()
  private fun persist(next: List<ProfileEntry>) {
    val text = encoded(next)
    if (text.toByteArray(Charsets.UTF_8).size > maximumBytes) throw BrowserFailure("profile-manifest-full")
    write(text)
  }
}

internal class GuestSessionProfiles {
  private data class Owner(val deploymentId: String, val runnerId: String, val sessionId: String)
  private val values = mutableMapOf<Owner, java.util.concurrent.CompletableFuture<ProfileEntry>>()
  @Synchronized fun getOrCreate(deploymentId: String, runnerId: String, sessionId: String, create: () -> java.util.concurrent.CompletableFuture<ProfileEntry>): java.util.concurrent.CompletableFuture<ProfileEntry> {
    val owner = Owner(deploymentId, runnerId, sessionId)
    values[owner]?.let { return it }
    val pending = create()
    values[owner] = pending
    pending.whenComplete { _, error -> if (error != null) synchronized(this) { values.remove(owner, pending) } }
    return pending
  }
  @Synchronized fun remove(handle: String) { values.entries.removeAll { it.value.isDone && !it.value.isCompletedExceptionally && it.value.getNow(null)?.handle == handle } }
}
