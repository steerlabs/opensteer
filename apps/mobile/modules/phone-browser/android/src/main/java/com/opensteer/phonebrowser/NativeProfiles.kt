package com.opensteer.phonebrowser

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.system.Os
import android.system.OsConstants
import android.util.AtomicFile
import android.webkit.WebView
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.util.concurrent.CompletableFuture

internal class NativeProfiles(context: Context) {
  private val file = AtomicFile(File(context.noBackupFilesDir, "phone-browser/manifest.json"))
  val manifest: ProfileManifest
  private val loaded = mutableMapOf<String, Profile>()
  private val activeGuests = mutableSetOf<String>()
  private val denied = mutableSetOf<String>()
  val startupDeleted = mutableListOf<String>()

  init {
    val names = ProfileStore.getInstance().allProfileNames
    val persisted = try { file.openRead().bufferedReader().use { it.readText() } } catch (_: java.io.FileNotFoundException) { null }
    if (persisted == null && names.any { it.startsWith("opensteer_pb_") }) throw BrowserFailure("profile-manifest-missing")
    manifest = ProfileManifest({ persisted }, { text ->
      file.baseFile.parentFile!!.mkdirs()
      val stream = file.startWrite()
      try {
        stream.write(text.toByteArray(Charsets.UTF_8))
        stream.fd.sync()
        file.finishWrite(stream)
        val directory = Os.open(file.baseFile.parentFile!!.absolutePath, OsConstants.O_RDONLY, 0)
        try { Os.fsync(directory) } finally { Os.close(directory) }
      } catch (error: Throwable) { file.failWrite(stream); throw BrowserFailure("profile-manifest-write-failed") }
    })
    for (entry in manifest.all().filter { it.deletionId != null }) {
      if (ProfileStore.getInstance().allProfileNames.contains(entry.name)) {
        if (!ProfileStore.getInstance().deleteProfile(entry.name)) throw BrowserFailure("profile-erasure-failed")
      }
      if (ProfileStore.getInstance().allProfileNames.contains(entry.name)) throw BrowserFailure("profile-erasure-failed")
      if (!entry.deleted) manifest.deleted(entry.handle)
      startupDeleted.add(entry.handle)
    }
  }

  fun ensure(binding: ProfileBinding, initialized: Boolean, guest: Boolean, gate: EpochGate? = null, epoch: Int = -1, canCommit: () -> Unit = {}): CompletableFuture<ProfileEntry> {
    val previous = manifest.find(binding)
    if (previous != null && previous.guest != guest) throw BrowserFailure("forbidden")
    val entry = previous ?: manifest.create(binding, initialized, guest)
    if (initialized && !entry.initialized) throw BrowserFailure("profile-missing")
    if (entry.deleted || denied.contains(entry.handle) || entry.deletionId != null && !(entry.guest && activeGuests.contains(entry.handle))) {
      if (previous != null || !entry.guest) throw BrowserFailure("profile-erasing")
    }
    if (entry.initialized && !ProfileStore.getInstance().allProfileNames.contains(entry.name)) throw BrowserFailure("profile-missing")
    if (entry.guest) activeGuests.add(entry.handle)
    try {
      val profile = loaded.getOrPut(entry.handle) { ProfileStore.getInstance().getOrCreateProfile(entry.name) }
      if (entry.initialized) {
        if (!hasMarker(profile, entry)) throw BrowserFailure("profile-missing")
        return CompletableFuture.completedFuture(entry)
      }
      val result = CompletableFuture<ProfileEntry>()
      profile.cookieManager.setCookie("https://phone-browser.invalid", "__Host-opensteer_profile=${entry.handle}; Path=/; Secure; HttpOnly; SameSite=Strict") { accepted ->
        try {
          val finish = {
            canCommit()
            if (denied.contains(entry.handle) || manifest.byHandle(entry.handle).deleted) throw BrowserFailure("profile-erasing")
            if (!accepted) throw BrowserFailure("profile-unavailable")
            profile.cookieManager.flush()
            manifest.initialized(entry.handle)
          }
          result.complete(if (gate != null) gate.execute(epoch, finish) else finish())
        } catch (error: Throwable) { result.completeExceptionally(error) }
      }
      return result
    } catch (error: Throwable) { activeGuests.remove(entry.handle); if (error is BrowserFailure) throw error; throw BrowserFailure("profile-unavailable") }
  }

  fun serving(handle: String): ProfileEntry {
    val entry = manifest.byHandle(handle)
    if (entry.deleted || denied.contains(handle) || entry.deletionId != null && !(entry.guest && activeGuests.contains(handle))) throw BrowserFailure("profile-erasing")
    if (!entry.initialized || !ProfileStore.getInstance().allProfileNames.contains(entry.name)) throw BrowserFailure("profile-missing")
    val profile = loaded.getOrPut(entry.handle) { ProfileStore.getInstance().getOrCreateProfile(entry.name) }
    if (!hasMarker(profile, entry)) throw BrowserFailure("profile-missing")
    return entry
  }

  private fun hasMarker(profile: Profile, entry: ProfileEntry): Boolean = profile.cookieManager.getCookie("https://phone-browser.invalid")
    ?.split(';')?.any { it.trim() == "__Host-opensteer_profile=${entry.handle}" } == true

  fun flush() { loaded.values.forEach { it.cookieManager.flush() } }

  fun erase(binding: ProfileBinding, deletionId: String, close: (String) -> Unit): CompletableFuture<Map<String, String>> {
    val entry = manifest.find(binding) ?: throw BrowserFailure("profile-missing")
    denied.add(entry.handle)
    try { manifest.tombstone(entry.handle, deletionId) }
    finally { activeGuests.remove(entry.handle); close(entry.name) }
    if (entry.deleted) return CompletableFuture.completedFuture(mapOf("state" to "deleted", "deletionId" to deletionId))
    val result = CompletableFuture<Map<String, String>>()
    val profile = loaded[entry.handle]
    if (profile == null) result.complete(mapOf("state" to "pending-restart", "deletionId" to deletionId))
    else {
      profile.webStorage.deleteAllData()
      profile.cookieManager.removeAllCookies {
        try { profile.cookieManager.flush(); result.complete(mapOf("state" to "pending-restart", "deletionId" to deletionId)) }
        catch (error: Exception) { result.completeExceptionally(BrowserFailure("profile-clear-failed")) }
      }
    }
    return result
  }

  fun list(deploymentId: String) = manifest.all().filter { it.binding.deploymentId == deploymentId && !it.guest }.map { entry ->
    if (entry.deletionId == null) mapOf("phase" to "ready", "binding" to entry.binding.fields())
    else mapOf("phase" to "deleted", "binding" to entry.binding.fields(), "deletionId" to entry.deletionId, "erasure" to if (entry.deleted) "deleted" else "pending-restart")
  }

  fun guestActive(handle: String) = activeGuests.contains(handle)
  fun endGuest(handle: String, close: (String) -> Unit): CompletableFuture<Map<String, String>> {
    val entry = manifest.byHandle(handle)
    if (!entry.guest) throw BrowserFailure("forbidden")
    return erase(entry.binding, entry.deletionId!!, close)
  }

}

internal object BrowserStartup {
  var providerVersion: String? = null
  var reason: String? = "not-initialized"
  var profiles: NativeProfiles? = null
  var firstViewCreated = false
  fun start(context: Context) {
    BrowserDebugging.configure(context)
    try {
      providerVersion = WebViewCompat.getCurrentWebViewPackage(context)?.versionName
      if (Build.VERSION.SDK_INT < 26 || (providerVersion?.substringBefore('.')?.toIntOrNull() ?: 0) < 133 || !WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
        reason = "unsupported-webview"
        return
      }
      profiles = NativeProfiles(context)
      val abandoned = java.io.File(context.noBackupFilesDir,"phone-browser/files")
      if (abandoned.exists() && !abandoned.deleteRecursively()) throw BrowserFailure("file-cleanup-failed")
      reason = null
    } catch (error: BrowserFailure) { reason = error.reason }
    catch (error: Exception) { reason = "profile-unavailable" }
    finally { if (profiles != null) try { BrowserDebugging.set(false) } catch (_: Exception) { } }
  }
}

class PhoneBrowserStartupProvider : ContentProvider() {
  override fun onCreate(): Boolean { context?.let(BrowserStartup::start); return true }
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
