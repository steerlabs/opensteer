package com.opensteer.agentphone.control

import android.annotation.SuppressLint
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.opensteer.agentphone.PhoneState
import com.opensteer.agentphone.RuntimeReport
import com.opensteer.agentphone.RuntimeLink
import com.opensteer.agentphone.key
import com.opensteer.agentphone.runner.ConnectionOwner
import com.opensteer.agentphone.runner.HostDiscovery
import com.opensteer.agentphone.runner.IntegrationsModule
import com.opensteer.agentphone.runner.NoDelaySocketFactory
import com.opensteer.agentphone.runner.PhoneIdentity
import com.opensteer.agentphone.runner.RunnerConnection
import com.opensteer.agentphone.runner.StreamOutbox
import com.opensteer.agentphone.ui.StatusNotification
import com.opensteer.agentphone.wire.ConnectionState
import com.opensteer.agentphone.wire.HostTarget
import com.opensteer.agentphone.wire.Issue
import okhttp3.OkHttpClient
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Everything the phone does for its Deployment, owned by the accessibility
 * service and alive exactly while it is bound: the connection, the hands,
 * the ongoing notification and the wake lock that keeps
 * heartbeats going with the screen off.
 *
 * The service builds a new one on every `onServiceConnected` and tears it
 * down on unbind or destroy — whoever suspended the service, Android, the
 * owner or a crash — so a re-bound service starts over from the stored
 * identity with nothing left from before.
 */
class PhoneRuntime(private val service: AgentPhoneAccessibilityService, private val phone: PhoneState) : ConnectionOwner {
    private val client = OkHttpClient.Builder()
        .socketFactory(NoDelaySocketFactory())
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()
    private val gestures = AndroidGestures(service)
    private val device = AccessibilityDevice(service, gestures)
    private val desk = PhoneDesk(
        device,
        System::currentTimeMillis,
        mintObservationId = { "obs_" + UUID.randomUUID().toString().replace("-", "") },
        // Asked from the executor's threads: the identity serving the phone now says.
        refused = { runId -> session?.module?.refuses(runId) == true },
    )
    /** This phone's connection to its Host; setup tells it when the stored identity changed. */
    val connection = RunnerConnection(
        sockets = client,
        discovery = HostDiscovery(client),
        record = phone,
        runtimeVersion = requireNotNull(service.packageManager.getPackageInfo(service.packageName, 0).versionName),
        updater = com.opensteer.agentphone.update.PhoneSelfUpdater(service, client, phone::load) { words ->
            val identity = phone.load()
            linkChanged(identity?.target, ConnectionState.NEEDS_UPDATE, Issue(com.opensteer.agentphone.wire.IssueCode.NEEDS_UPDATE, words))
        },
        owner = this,
        elapsed = SystemClock::elapsedRealtime,
        log = { Log.i(TAG, it) },
        deviceName = {
            Settings.Global.getString(service.contentResolver, Settings.Global.DEVICE_NAME)?.trim()?.takeIf { it.isNotEmpty() }
                ?.take(120) ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(120).ifEmpty { "Android phone" }
        },
    )
    private val alarms = MonotonicAlarms(SystemClock::elapsedRealtime)
    private val executor = PhoneExecutor(desk, SystemClock::elapsedRealtime, alarms, post = { connection.post(it) }, log = { Log.w(TAG, it) })
    private val display = com.opensteer.agentphone.display.DisplayStream(service, client, desk, executor, device, gestures)
    private val notification = StatusNotification(service)
    private val wakeLock = service.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "opensteer:agent-phone")

    /** The module for one identity. Runtime thread only. */
    private class Session(var identity: PhoneIdentity, val module: IntegrationsModule)

    @Volatile
    private var session: Session? = null
    private var link = RuntimeLink()

    /**
     * Set first by `stop`: a runtime thread that outlives it must take no wake
     * lock and post no notification, which nothing would take back.
     */
    @Volatile
    private var stopping = false
    private val deviceNameObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) { connection.identityChanged() }
    }

    fun start() {
        service.contentResolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.DEVICE_NAME), false, deviceNameObserver)
        desk.protectionChanged = display::protectionChanged
        desk.paused = phone.settings.paused
        wakeLock.setReferenceCounted(false)
        connection.start()
    }

    fun stop() {
        service.contentResolver.unregisterContentObserver(deviceNameObserver)
        stopping = true
        display.close()
        connection.stop()
        executor.shutdown()
        gestures.close()
        alarms.shutdown()
        client.dispatcher.executorService.shutdown()
        // Evicting closes TLS sockets, which writes to the network; Android
        // unbinds the service on its main thread, where that I/O is refused.
        thread(name = "opensteer-connection-pool-close") { client.connectionPool.evictAll() }
        if (wakeLock.isHeld) wakeLock.release()
        notification.cancel()
    }

    fun pausedChanged(paused: Boolean) = connection.post {
        executor.setPaused(paused)
        session?.module?.refreshStatus()
    }

    fun stopSession(sessionId: String) = connection.post {
        executor.stopSession(sessionId)
    }

    /** The Opensteer app came to the front, so what the desk is collecting may hold its screens. */
    fun ownAppShown() = desk.ownAppShown()

    fun windowChanged(own: Boolean) = desk.windowChanged(own)

    fun windowsChanged() = desk.windowsChanged()

    fun editingChanged() = display.editingChanged()

    override fun useIdentity(identity: PhoneIdentity?) {
        if (stopping) return
        link = link.useIdentity(identity)
        val current = session
        if (identity != null && current != null && current.identity.key == identity.key && current.identity.runnerKey == identity.runnerKey) {
            current.identity = identity
            settled()
            return
        }
        current?.module?.detach()
        session = identity?.let(::open)
        settled()
    }

    /** Heartbeats and retries must keep going with the screen off, but only while there are any. */
    @SuppressLint("WakelockTimeout")
    override fun keepAwake(needed: Boolean) {
        if (stopping) return
        if (needed && !wakeLock.isHeld) wakeLock.acquire()
        if (!needed && wakeLock.isHeld) wakeLock.release()
    }

    private fun open(identity: PhoneIdentity): Session {
        val outbox = StreamOutbox()
        lateinit var module: IntegrationsModule
        val operations = executor.forOwner(authorityChanged = display::authorityChanged) { stopped -> module.sessionStopped(stopped.id, stopped.runId) }
        module = IntegrationsModule(
            outbox,
            operations,
            stops = phone.settings.stopJournal(identity.runnerId),
            paused = { phone.settings.paused },
            log = { Log.i(TAG, it) },
            display = { message -> display.handle(message, identity.hostUrl, operations) { frame -> connection.post {
                if (outbox.attached?.fence == message.fence) outbox.attached?.send(frame)
            } } },
            displayAvailable = { android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS).codecInfos.any { info -> info.isEncoder && info.supportedTypes.any { it.equals("video/avc", ignoreCase = true) } } },
            displayLost = display::lost,
        )
        return Session(identity, module)
    }

    override val module: IntegrationsModule get() = requireNotNull(session).module

    override fun linkChanged(target: HostTarget?, connection: ConnectionState, issue: Issue?) {
        if (stopping) return
        link = link.changed(target, connection, issue)
        settled()
    }

    override fun settled() {
        if (stopping) return
        val report = RuntimeReport(
            link = link,
            session = desk.activeSession,
        )
        phone.publish(report)
        notification.show(report, phone.settings.paused)
    }

    private companion object {
        const val TAG = "AgentPhone"
    }
}
