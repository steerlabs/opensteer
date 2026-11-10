package com.opensteer.phonebrowser

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

internal class SessionFiles(private val context: Context) {
  private data class Staged(val session: String, val id: String, val name: String, val file: File, var size: Long?, var written: Long)
  private val root = File(context.noBackupFilesDir, "phone-browser/files/${UUID.randomUUID()}")
  private val staged = mutableMapOf<Pair<String, String>, Staged>()
  private val ended = mutableSetOf<String>()
  private val sessions = mutableMapOf<String, File>()
  fun directory(session: String): File { if (ended.contains(session)) throw BrowserFailure("forbidden"); return sessions.getOrPut(session) { File(root, UUID.randomUUID().toString()).apply { mkdirs() } } }
  fun stage(input: StageRecord): Map<String, Any> {
    try { UUID.fromString(input.fileId) } catch (_: Exception) { throw BrowserFailure("forbidden") }
    if (input.fileId.isBlank() || input.sessionId.isBlank() || input.name.isBlank() || input.name.length > 255 || input.name.contains('/') || input.name.contains('\\') || input.name.any { it.code < 32 } || input.name in setOf(".", "..")) throw BrowserFailure("forbidden")
    if (input.data.length > 349528 || input.offset < 0 || input.size != null && input.size!! !in 0..536870912L) throw BrowserFailure("too-large")
    val bytes = try { Base64.decode(input.data, Base64.NO_WRAP) } catch (_: Exception) { throw BrowserFailure("invalid-file") }
    if (bytes.size > 262144) throw BrowserFailure("too-large")
    val key = input.sessionId to input.fileId
    val old = staged[key]
    if (old == null && input.offset != 0L) throw BrowserFailure("invalid-offset")
    if (old != null && (old.name != input.name || old.written != input.offset || input.size != null && old.size != null && input.size != old.size)) throw BrowserFailure("invalid-offset")
    val total = staged.values.filter { it.session == input.sessionId }.sumOf { it.written }
    if (total + bytes.size > 536870912L) throw BrowserFailure("too-large")
    val entry = old ?: Staged(input.sessionId, input.fileId, input.name, File(File(directory(input.sessionId), input.fileId).apply { mkdirs() }, input.name).apply { createNewFile() }, input.size, 0)
    val expected = entry.size ?: input.size
    if (expected != null && input.offset + bytes.size > expected) throw BrowserFailure("invalid-offset")
    RandomAccessFile(entry.file, "rw").use { file -> file.seek(input.offset); file.write(bytes); file.fd.sync() }
    entry.size = expected; entry.written += bytes.size
    staged[key] = entry
    return mapOf("fileId" to input.fileId, "complete" to (expected != null && entry.written == expected))
  }
  fun choose(session: String, ids: List<String>): List<Triple<Uri, String, Long>> {
    if (ids.size > 32 || ids.toSet().size != ids.size) throw BrowserFailure("too-large")
    return ids.map { id ->
      val entry = staged[session to id] ?: throw BrowserFailure("forbidden")
      if (entry.size == null || entry.written != entry.size || !entry.file.isFile || entry.file.canonicalFile.parentFile?.parentFile != directory(session).canonicalFile) throw BrowserFailure("file-not-ready")
      Triple(Uri.fromFile(entry.file), entry.name, entry.written)
    }
  }
  fun contained(session: String, path: String): Boolean {
    val candidate = File(path)
    return staged.values.any { it.session == session && it.file.absolutePath == path && it.file.canonicalFile == candidate.canonicalFile && it.size == it.written }
  }
  fun finish(session: String) {
    ended.add(session)
    staged.keys.filter { it.first == session }.toList().forEach { staged.remove(it)?.file?.delete() }
    sessions.remove(session)?.deleteRecursively()
  }
  fun close() { staged.clear(); sessions.clear(); if (root.exists() && !root.deleteRecursively()) throw BrowserFailure("file-cleanup-failed") }
}
