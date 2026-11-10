package com.opensteer.phonebrowser

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import androidx.webkit.ProfileStore
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal class BrowserDownloads(private val context: Context, private val pool: PhoneBrowserPool, private val activity: () -> Activity?, private val emit: (Map<String, Any?>) -> Unit) {
  private data class Download(val id: String, val tab: NativeTab, val epoch: Int, val file: File, val name: String, val stopped: AtomicBoolean = AtomicBoolean(), @Volatile var connection: HttpURLConnection? = null)
  private var root: File? = null
  private fun key(value: String) = UUID.nameUUIDFromBytes(value.toByteArray(Charsets.UTF_8)).toString()
  fun bind(deploymentId: String) { root = File(context.filesDir, "phone-browser/downloads/${key(deploymentId)}").apply { mkdirs() } }
  private val worker = Executors.newFixedThreadPool(2)
  @Volatile private var active = true
  private val entries = ConcurrentHashMap<String, Download>()
  fun install(tab: NativeTab, view: android.webkit.WebView) {
    view.setDownloadListener { url, userAgent, disposition, mime, _ ->
      try {
        if (active && tab.view === view && pool.ledger.state(tab.id) == TabState.LIVE) {
          pool.downloadStarted(tab)
          start(tab, url, userAgent, disposition, mime)
        }
      } catch (_: Exception) {
        emit(pool.ref(tab) + mapOf("type" to "download", "downloadId" to UUID.randomUUID().toString(), "state" to "failed", "name" to "download", "received" to 0))
      }
    }
  }
  private fun start(tab: NativeTab, url: String, userAgent: String, disposition: String?, mime: String?) {
    validateBrowserUrl(url)
    if (tab.downloadRequestMethod != "GET") throw BrowserFailure("unsupported-operation")
    if (entries.values.count { !it.stopped.get() } >= 8) throw BrowserFailure("too-large")
    val name = android.webkit.URLUtil.guessFileName(url, disposition, mime).replace(Regex("[^\\p{L}\\p{N} ._()-]"), "_").take(160).ifBlank { "download" }
    val id = UUID.randomUUID().toString()
    val sessionRoot = File(root ?: throw BrowserFailure("browser-unavailable"),key(tab.sessionId)).apply { mkdirs() }
    val folder = File(sessionRoot, id).apply { mkdirs() }
    val entry = Download(id, tab, pool.gate.epoch, File(folder, name), name)
    entries[entry.id] = entry
    val initiator = tab.committedUrl
    val cookies = ProfileStore.getInstance().getProfile(tab.profileName)?.cookieManager ?: throw BrowserFailure("profile-missing")
    worker.execute {
      var received = 0L
      var total = -1L
      fun event(state: String) {
        pool.main.post {
          if (pool.gate.epoch == entry.epoch && pool.tabs[tab.id] === tab) emit(pool.ref(tab) + mapOf("type" to "download", "downloadId" to entry.id, "state" to state, "name" to name, "received" to received) + if (total >= 0) mapOf("total" to total) else emptyMap())
        }
      }
      try {
        event("receiving")
        var current = URI(url)
        var response: HttpURLConnection? = null
        for (redirect in 0..10) {
          if (entry.stopped.get()) throw BrowserFailure("cancelled")
          pool.gate.check(entry.epoch)
          validateBrowserUrl(current.toString())
          val connection = current.toURL().openConnection() as HttpURLConnection
          response = connection; entry.connection = connection
          connection.instanceFollowRedirects = false
          connection.useCaches = false
          connection.connectTimeout = 10000; connection.readTimeout = 10000
          connection.setRequestProperty("User-Agent", userAgent)
          if (DownloadCookies.maySend(initiator,current.toString())) cookies.getCookie(current.toString())?.let { connection.setRequestProperty("Cookie", it) }
          val status = connection.responseCode
          if (DownloadCookies.maySend(initiator,current.toString())) connection.headerFields.entries.filter { it.key?.equals("Set-Cookie", true) == true }.flatMap { it.value }.forEach { cookies.setCookie(current.toString(), it) }
          if (status in listOf(301,302,303,307,308)) {
            val location = connection.getHeaderField("Location") ?: throw BrowserFailure("download-failed")
            current = current.resolve(location); connection.disconnect(); response = null
          } else break
        }
        val connection = response ?: throw BrowserFailure("download-failed")
        if (connection.responseCode !in 200..299) throw BrowserFailure("download-failed")
        total = connection.contentLengthLong
        if (total > 536870912) throw BrowserFailure("too-large")
        connection.inputStream.use { input -> entry.file.outputStream().use { output ->
          val buffer = ByteArray(65536)
          var published = 0L
          while (true) {
            if (entry.stopped.get()) throw BrowserFailure("cancelled")
            pool.gate.check(entry.epoch)
            val count = input.read(buffer)
            if (count < 0) break
            received += count
            if (received > 536870912) throw BrowserFailure("too-large")
            output.write(buffer, 0, count)
            if (received - published >= 1048576) { event("receiving"); published = received }
          }
          output.fd.sync()
        } }
        if (total >= 0 && total != received) throw BrowserFailure("download-failed")
        pool.gate.check(entry.epoch)
        event("complete")
        pool.main.post {
          if (pool.gate.epoch == entry.epoch && tab.hostId != null && pool.tabs[tab.id] === tab) activity()?.let { owner ->
            AlertDialog.Builder(owner).setTitle("Download complete").setMessage(name).setNegativeButton("Keep", null).setPositiveButton("Share") { _, _ ->
              if (pool.gate.epoch == entry.epoch && entry.file.isFile) {
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.phonebrowser.downloads", entry.file)
                owner.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime ?: "application/octet-stream").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null))
              }
            }.show()
          }
        }
      } catch (_: Exception) { entry.file.delete(); event("failed") }
      finally { entry.connection?.disconnect(); entry.connection = null; entry.stopped.set(true) }
    }
  }
  fun cancel(session: String, id: String) {
    val entry = entries[id]
    if (entry == null) {
      try { UUID.fromString(id) } catch (_: Exception) { throw BrowserFailure("forbidden") }
      val folder = File(File(root ?: throw BrowserFailure("browser-unavailable"),key(session)),id)
      if (!folder.exists()) throw BrowserFailure("not-found")
      if (!folder.deleteRecursively()) throw BrowserFailure("file-cleanup-failed")
      return
    }
    if (entry.tab.sessionId != session) throw BrowserFailure("forbidden")
    entry.stopped.set(true); entry.connection?.disconnect(); entry.file.delete()
  }
  fun finish(session: String) {
    entries.values.filter { it.tab.sessionId == session }.forEach { cancel(session, it.id); entries.remove(it.id) }
    root?.let { File(it,key(session)).deleteRecursively() }
  }
  fun retire(tab: NativeTab) {
    entries.values.filter { it.tab === tab }.forEach { cancel(tab.sessionId,it.id); entries.remove(it.id) }
  }
  fun erase() { stop(); entries.clear(); root?.let { if (it.exists() && !it.deleteRecursively()) throw BrowserFailure("file-cleanup-failed") } }
  fun foreground(value: Boolean) { active = value; if (!value) stop() }
  fun stop() { active = false; entries.values.filter { !it.stopped.get() }.forEach { it.stopped.set(true); it.connection?.disconnect() } }
  fun close() { stop(); worker.shutdownNow() }
}

internal fun validateBrowserUrl(url: String): String {
  if (url.length > 8192) throw BrowserFailure("too-large")
  val uri = try { URI(url) } catch (_: Exception) { throw BrowserFailure("invalid-url") }
  if (uri.scheme?.lowercase() !in setOf("https", "http") || uri.host.isNullOrBlank() || uri.rawUserInfo != null) throw BrowserFailure("unsupported-operation")
  return url
}
