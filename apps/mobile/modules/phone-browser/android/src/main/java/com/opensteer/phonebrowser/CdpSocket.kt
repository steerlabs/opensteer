package com.opensteer.phonebrowser

import android.net.LocalSocket
import android.net.LocalSocketAddress
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.SecureRandom
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean

internal fun nativeSocket(name: String): LocalSocket {
  val socket = LocalSocket()
  try {
    socket.connect(LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT))
    socket.soTimeout = 5000
    return socket
  } catch (error: Throwable) { socket.close(); throw error }
}

internal fun nativeHeaders(input: InputStream): String {
  val result = StringBuilder()
  while (!result.endsWith("\r\n\r\n")) {
    val next = input.read()
    if (next < 0) throw java.io.EOFException("EOF in headers")
    result.append(next.toChar())
    check(result.length <= 16384) { "oversized headers" }
  }
  return result.toString()
}

internal fun nativeHttp(name: String, path: String): String = nativeSocket(name).use { socket ->
  socket.outputStream.write("GET $path HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".toByteArray())
  val headers = nativeHeaders(socket.inputStream)
  check(headers.startsWith("HTTP/1.1 200")) { headers }
  val length = Regex("Content-Length:\\s*(\\d+)", RegexOption.IGNORE_CASE).find(headers)?.groupValues?.get(1)?.toInt()
    ?: error("no content length")
  check(length <= 1048576)
  String(nativeRead(socket.inputStream, length), Charsets.UTF_8)
}

internal fun awaitNativeDiscovery(name: String): String {
  val completion = CompletableFuture<String>()
  val worker = Executors.newSingleThreadScheduledExecutor()
  val deadline = android.os.SystemClock.elapsedRealtime() + 3000
  val attempt = object : Runnable {
    override fun run() {
      if (completion.isDone) return
      try { completion.complete(nativeHttp(name, "/json")) }
      catch (error: IOException) {
        if ((error is java.io.EOFException || error.message?.contains("Connection refused") == true) && android.os.SystemClock.elapsedRealtime() < deadline) {
          worker.schedule(this, 10, TimeUnit.MILLISECONDS)
        } else completion.completeExceptionally(error)
      } catch (error: Throwable) { completion.completeExceptionally(error) }
    }
  }
  worker.execute(attempt)
  return try { completion.get(4, TimeUnit.SECONDS) } finally { completion.cancel(true); worker.shutdownNow() }
}

private fun nativeRead(input: InputStream, size: Int): ByteArray {
  val result = ByteArray(size)
  var offset = 0
  while (offset < size) {
    val count = input.read(result, offset, size - offset)
    check(count > 0) { "EOF in body" }
    offset += count
  }
  return result
}

internal class NativeCdpSocket(name: String, path: String, private val event: (JSONObject) -> Unit = {}) : AutoCloseable {
  private val socket = nativeSocket(name)
  private val input = socket.inputStream
  private val output = socket.outputStream
  private val pending = ConcurrentHashMap<Int, CompletableFuture<JSONObject>>()
  private val writer = Executors.newSingleThreadExecutor()
  private val writeDeadlines = Executors.newSingleThreadScheduledExecutor()
  private val sequence = AtomicInteger()
  private val closed = AtomicBoolean()
  private val disconnected = CompletableFuture<Unit>()
  private val random = SecureRandom()
  private val reader: Thread

  init {
    try {
    output.write(("GET $path HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: cGhvbmUtcHJvb2YtMDAwMQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").toByteArray())
    check(nativeHeaders(input).startsWith("HTTP/1.1 101")) { "upgrade refused" }
    socket.soTimeout = 0
    } catch (error: Throwable) { socket.close(); writer.shutdownNow(); writeDeadlines.shutdownNow(); throw error }
    reader = Thread({
      val fragments = ByteArrayOutputStream()
      try {
        while (!closed.get()) {
          val first = input.read()
          val second = input.read()
          check(first >= 0 && second >= 0) { "websocket EOF" }
          var size = (second and 127).toLong()
          if (size == 126L) size = ((input.read() shl 8) or input.read()).toLong()
          else if (size == 127L) {
            size = 0
            repeat(8) { size = (size shl 8) or input.read().toLong() }
          }
          check(size in 0..8388608 && fragments.size() + size <= 8388608)
          check(second and 128 == 0)
          val bytes = nativeRead(input, size.toInt())
          val opcode = first and 15
          if (opcode == 8) break
          if (opcode == 9) { writeFrame(10, bytes); continue }
          if (opcode == 1 || opcode == 0) {
            fragments.write(bytes)
            if (first and 128 != 0) {
              val message = JSONObject(fragments.toString("UTF-8"))
              fragments.reset()
              if (message.has("id")) pending.remove(message.getInt("id"))?.complete(message) else event(message)
            }
          }
        }
      } catch (error: Exception) {
        pending.values.forEach { it.completeExceptionally(error) }
      } finally {
        closed.set(true)
        socket.close()
        writer.shutdownNow()
        writeDeadlines.shutdownNow()
        pending.values.forEach { it.completeExceptionally(IllegalStateException("pipe closed")) }
        pending.clear()
        disconnected.complete(Unit)
      }
    }, "phone-browser-cdp").apply { start() }
  }

  @Synchronized private fun writeFrame(opcode: Int, bytes: ByteArray) {
    val expiration = writeDeadlines.schedule({ close() }, 1, TimeUnit.SECONDS)
    try {
    output.write(128 or opcode)
    when {
      bytes.size < 126 -> output.write(128 or bytes.size)
      bytes.size < 65536 -> { output.write(254); output.write(bytes.size shr 8); output.write(bytes.size and 255) }
      else -> { output.write(255); for (index in 7 downTo 0) output.write((bytes.size.toLong() shr (8 * index)).toInt() and 255) }
    }
    val mask = ByteArray(4).also(random::nextBytes)
    output.write(mask)
    output.write(ByteArray(bytes.size) { index -> (bytes[index].toInt() xor mask[index % 4].toInt()).toByte() })
    output.flush()
    } finally { expiration.cancel(false) }
  }

  fun submit(method: String, params: JSONObject = JSONObject(), sessionId: String? = null, gate: EpochGate? = null, epoch: Int = -1, authorize: ((() -> Unit) -> Unit) = { it() }): CompletableFuture<JSONObject> {
    if (closed.get()) throw BrowserFailure("target-closed")
    val id = sequence.incrementAndGet()
    val response = CompletableFuture<JSONObject>()
    pending[id] = response
    val main = android.os.Handler(android.os.Looper.getMainLooper())
    val expiration = Runnable { response.completeExceptionally(BrowserFailure("outcome-unknown")) }
    main.postDelayed(expiration,6000)
    response.whenComplete { _, _ -> main.removeCallbacks(expiration); pending.remove(id) }
    try {
      val message = JSONObject().put("id", id).put("method", method).put("params", params)
      if (sessionId != null) message.put("sessionId", sessionId)
      val bytes = message.toString().toByteArray()
      if (bytes.size > 524288) throw BrowserFailure("too-large")
      writer.execute {
        try {
          val send = {
            if (closed.get()) throw BrowserFailure("target-closed")
            if (response.isDone) throw BrowserFailure("outcome-unknown")
            authorize { writeFrame(1, bytes) }
          }
          if (gate == null) send() else gate.execute(epoch, send)
        } catch (error: Throwable) { response.completeExceptionally(error) }
      }
    } catch (error: Throwable) { pending.remove(id); response.completeExceptionally(error) }
    return response
  }

  fun call(method: String, params: JSONObject = JSONObject(), sessionId: String? = null): JSONObject = submit(method, params, sessionId).get(6, TimeUnit.SECONDS)

  override fun close() {
    closed.set(true)
    socket.close()
    writer.shutdownNow()
    writeDeadlines.shutdownNow()
    pending.values.forEach { it.completeExceptionally(BrowserFailure("target-closed")) }; pending.clear()
  }
  fun awaitDisconnection() { disconnected.get(2, TimeUnit.SECONDS) }
}
