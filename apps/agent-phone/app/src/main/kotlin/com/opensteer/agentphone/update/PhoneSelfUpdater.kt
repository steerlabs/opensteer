package com.opensteer.agentphone.update

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.opensteer.agentphone.BuildConfig
import com.opensteer.agentphone.runner.PhoneIdentity
import com.opensteer.agentphone.runner.PhoneUpdater
import com.opensteer.agentphone.runner.PhoneUpdateResult
import com.opensteer.agentphone.wire.Fields
import com.opensteer.agentphone.wire.HostMessage
import com.opensteer.agentphone.wire.JsonText
import com.opensteer.agentphone.wire.RunnerDescriptor
import com.opensteer.agentphone.wire.RunnerWire
import com.opensteer.agentphone.wire.jsonObject
import com.opensteer.agentphone.wire.jsonOf
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.File
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/** Only the paired origin and enrolled key can fetch a release; no update frame carries a URL. */
class PhoneSelfUpdater(
    private val context: Context,
    private val client: OkHttpClient,
    private val currentIdentity: () -> PhoneIdentity?,
    private val status: (String) -> Unit,
) : PhoneUpdater {
    private sealed interface Frame {
        class Text(val value: String) : Frame
        class Binary(val value: ByteString) : Frame
        data object Closed : Frame
    }
    private val journal = UpdateInstaller(context)
    private var checkedFor: String? = null
    private var checkedAt = Long.MIN_VALUE / 2
    @Volatile private var active: WebSocket? = null
    @Volatile private var cancelled = false

    override fun cancel() { cancelled = true; active?.cancel() }

    private fun pendingResult(state: String) = PhoneUpdateResult.Pending(
        if (state == "awaiting-user") "Tap Update to finish updating Agent Phone." else "Updating Agent Phone…",
    )

    override fun check(identity: PhoneIdentity, required: Boolean): PhoneUpdateResult {
        if (!identity.enrolled) return PhoneUpdateResult.Current
        val key = "${identity.runnerId} ${identity.hostUrl}"
        val now = SystemClock.elapsedRealtime()
        journal.finishIfInstalled()
        if (journal.takeCancelled(identity)) return PhoneUpdateResult.Pending("Update cancelled. Opensteer will try again.")
        if (journal.pendingState(identity) == null && !required && key == checkedFor && now - checkedAt < TimeUnit.HOURS.toMillis(6)) return PhoneUpdateResult.Current
        checkedFor = key
        checkedAt = now
        cancelled = false
        var offered = false
        var release: UpdateOffer? = null
        var socket: WebSocket? = null
        val file = File(context.cacheDir, "agent-phone-update.apk")
        val queue = ArrayBlockingQueue<Frame>(4)
        val deadline = now + TimeUnit.MINUTES.toMillis(10)
        fun samePairing(): Boolean {
            val current = currentIdentity()
            return current?.runnerId == identity.runnerId && current.runnerKey == identity.runnerKey && current.target == identity.target
        }
        fun next(): Frame {
            while (!cancelled && samePairing()) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                check(remaining > 0) { "The update timed out" }
                val frame = queue.poll(minOf(remaining, 1000), TimeUnit.MILLISECONDS) ?: continue
                check(frame != Frame.Closed) { "The update connection closed" }
                return frame
            }
            error("The update was cancelled")
        }
        fun text(): String = (next() as? Frame.Text)?.value ?: error("Expected update metadata")
        fun sendState(state: String) {
            val offer = release ?: return
            socket?.send(JsonText.stringify(jsonObject("type" to jsonOf("phone.update.status"), "apkSha256" to jsonOf(offer.sha256), "state" to jsonOf(state))))
        }
        try {
            val listener = object : WebSocketListener() {
                private fun receive(frame: Frame, ws: WebSocket) { if (!queue.offer(frame, 5, TimeUnit.SECONDS)) { ws.cancel(); queue.clear(); queue.offer(Frame.Closed) } }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (text.length > 32_768) { webSocket.cancel(); receive(Frame.Closed, webSocket) }
                    else receive(Frame.Text(text), webSocket)
                }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    if (bytes.size > 65_536) { webSocket.cancel(); receive(Frame.Closed, webSocket) }
                    else receive(Frame.Binary(bytes), webSocket)
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { receive(Frame.Closed, webSocket) }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null); receive(Frame.Closed, webSocket) }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { receive(Frame.Closed, webSocket) }
            }
            socket = client.newWebSocket(Request.Builder().url("${identity.hostUrl}/internal/v1/runners/agent-phone-update").build(), listener)
            active = socket
            val challenge = (RunnerWire.decodeHostMessage(text()) as? HostMessage.Challenge)?.challenge ?: error("No update challenge")
            val version = context.packageManager.getPackageInfo(context.packageName, 0)
            val descriptor = RunnerDescriptor("rbt_${UUID.randomUUID()}", identity.runnerName, identity.runnerId, requireNotNull(version.versionName))
            check(socket.send(JsonText.stringify(RunnerWire.authenticate(challenge, descriptor, identity.runnerKey))))
            val offerText = text()
            // Remember the offered digest even when another metadata check refuses it.
            release = runCatching { UpdateOffer.decode(offerText) }.getOrElse {
                offered = true
                throw it
            }
            val offer = release ?: return PhoneUpdateResult.Current
            if (offer.versionCode == version.longVersionCode) return PhoneUpdateResult.Current
            offered = true
            check(offer.versionCode > version.longVersionCode) { "Downgrades are refused" }
            check(offer.signer == BuildConfig.AGENT_PHONE_UPDATE_SIGNER) { "The update signer is not the pinned release signer" }
            check(offer.minSdk <= android.os.Build.VERSION.SDK_INT) { "The update needs a newer Android version" }
            val pending = journal.pending(identity, offer)
            if (!pending) journal.begin(identity, offer)
            status("Updating Agent Phone…")
            if (!pending) {
            check(socket.send(JsonText.stringify(jsonObject("type" to jsonOf("phone.update.download"), "apkSha256" to jsonOf(offer.sha256)))))
            var size = 0L
            file.outputStream().use { output ->
                while (size < offer.size) {
                    val bytes = (next() as? Frame.Binary)?.value ?: error("The APK download ended early")
                    size += bytes.size
                    check(size <= offer.size) { "The update APK is oversized" }
                    output.write(bytes.toByteArray())
                }
            }
            val complete = Fields.parse(text(), "download")
            complete.literal("type", "host.agent-phone.update.downloaded")
            complete.end()
            check(samePairing())
            journal.verify(file, offer)
            sendState("installing")
            journal.install(file, offer, ::samePairing)
            } else sendState(journal.state())
            var previous = if (pending) journal.state() else "installing"
            while (!cancelled && samePairing() && SystemClock.elapsedRealtime() < deadline) {
                val state = journal.state()
                if (state != previous) {
                    sendState(state)
                    previous = state
                }
                if (state == "awaiting-user") {
                    status("Tap Update to finish updating Agent Phone.")
                    return pendingResult(state)
                }
                check(state != "failed") { "Android refused or cancelled the update" }
                if (state == "idle") return PhoneUpdateResult.Pending("The update finished. Waiting for Android to reconnect the app.")
                Thread.sleep(200)
            }
            // A committed Android session outlives this bounded network attempt.
            if (samePairing()) journal.pendingState(identity)?.let { return pendingResult(it) }
            journal.abandon()
            error("The update was not completed in ten minutes")
        } catch (error: Exception) {
            if (samePairing()) {
                journal.pendingState(identity)?.let { state ->
                    sendState(state)
                    if (state == "awaiting-user") status("Tap Update to finish updating Agent Phone.")
                    return pendingResult(state)
                }
            } else {
                journal.abandon()
                return PhoneUpdateResult.Current
            }
            if (offered || required) {
                journal.failed()
                sendState("failed")
                Log.w("AgentPhone", "Agent Phone self-update failed: ${error.message}")
                return PhoneUpdateResult.Failed("Agent Phone couldn’t update. Run setup over USB to try again.")
            }
            // A Host without update support does not prevent the existing Runner connection.
            return PhoneUpdateResult.Current
        } finally {
            file.delete()
            socket?.close(1000, "Phone update check finished")
            active = null
        }
    }
}
