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
        if (text.length > 1048576) throw BrowserFailure("profile-manifest-corrupt")
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
      }
    } catch (error: BrowserFailure) { throw error }
    catch (error: Exception) { throw BrowserFailure("profile-manifest-corrupt") }
  }

  fun all() = entries.toList()
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
    replace(entries + entry)
    return entry
  }
  fun initialized(handle: String): ProfileEntry = update(handle) { it.copy(initialized = true) }
  fun tombstone(handle: String, deletionId: String): ProfileEntry = update(handle) { it.copy(deletionId = deletionId) }
  fun deleted(handle: String): ProfileEntry = update(handle) { it.copy(deleted = true) }
  private fun update(handle: String, transform: (ProfileEntry) -> ProfileEntry): ProfileEntry {
    val next = transform(byHandle(handle))
    replace(entries.map { if (it.handle == handle) next else it })
    return next
  }
  private fun replace(next: List<ProfileEntry>) { persist(next); entries = next }
  private fun persist(next: List<ProfileEntry>) { write(JSONObject().put("version", 1).put("storageInstanceId", storageInstanceId).put("entries", JSONArray(next.map { it.json() })).toString()) }
}
