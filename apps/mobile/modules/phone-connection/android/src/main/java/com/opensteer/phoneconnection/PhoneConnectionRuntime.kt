package com.opensteer.phoneconnection

import android.content.Context
import android.os.Build
import android.os.SystemClock
import com.opensteer.phoneconnection.core.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Date
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.ScheduledFuture

interface PhoneBrowserEndpoint {
    fun qualification(deploymentId: String, runnerId: String): JsonObject
    fun fence(epoch: Int)
    fun eraseDeployment(deploymentId: String, epoch: Int): CompletableFuture<JsonArray>
}

class PhoneConnectionRuntime private constructor(context: Context) {
    private val storage = IdentityStore(context.applicationContext)
    private val worker = ScheduledThreadPoolExecutor(1).apply { removeOnCancelPolicy = true }
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES).callTimeout(20, TimeUnit.SECONDS).build()
    private val bootId = "rbt_" + UUID.randomUUID()
    private val version = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0"
    private var identity: JsonObject? = null
    private var endpoint: PhoneBrowserEndpoint? = null
    private var observer: ((JsonObject) -> Unit)? = null
    private var eventObserver: ((JsonObject) -> Unit)? = null
    private var retireObserver: ((String) -> Unit)? = null
    private var foreground = false
    private var activityForeground = false
    private var storageUnavailable = false
    private var connection = "none"
    private var issue: String? = null
    private var revision = 0
    private var generation = 0L
    private var retryDelay = 1000L
    private var retryAt: String? = null
    private var primary: WebSocket? = null
    private var auxiliary: WebSocket? = null
    private var primaryFence: Fence? = null
    @Volatile private var primaryEnd = 0L
    private var primaryInterval = 0L
    private var auxiliaryInterval = 0L
    private var primaryHeartbeatAt = 0L
    private var auxiliaryHeartbeatAt = 0L
    private data class HostClock(val serverAt: Long, val tickAt: Long)
    @Volatile private var hostClock: HostClock? = null
    private var pulse: ScheduledFuture<*>? = null
    private var handshakeDeadline: ScheduledFuture<*>? = null
    private var ticketRequest: String? = null
    private var auxiliaryTicket: String? = null
    private val admission = Admission(::now) { primaryEnd > now() }
    private var transport: BrowserTransport? = null

    init {
        try { identity = storage.load(); configureTransport() }
        catch (_: Exception) { storageUnavailable = true; issue = "failed"; connection = "stopped" }
    }
    @Synchronized fun observe(snapshot: ((JsonObject) -> Unit)?, events: ((JsonObject) -> Unit)?, retiring: ((String) -> Unit)?) {
        observer = snapshot; eventObserver = events; retireObserver = retiring; publish()
    }
    @Synchronized fun snapshot(): JsonObject {
        val held = identity?.takeUnless { it.text("state") in setOf("prepared", "retiring") }
        val enrollment = held?.let { value -> JsonObject(value.filterKeys {
            it in setOf("deploymentId", "deploymentName", "runnerId", "name", "enrollmentId", "hostUrl")
        } + ("state" to JsonPrimitive(value.text("state")))) }
        return Wire.fields("revision" to JsonPrimitive(revision), "supported" to JsonPrimitive(endpoint != null),
            "unsupportedReason" to JsonNull, "deviceName" to JsonPrimitive(Build.MODEL), "enrollment" to (enrollment ?: JsonNull),
            "connection" to JsonPrimitive(connection), "retryAt" to (retryAt?.let(::JsonPrimitive) ?: JsonNull),
            "issue" to (issue?.let(::JsonPrimitive) ?: JsonNull), "issueMessage" to JsonNull,
            "permissions" to Wire.fields("apple-calendar" to JsonPrimitive("not-determined"), "apple-contacts" to JsonPrimitive("not-determined"), "apple-reminders" to JsonPrimitive("not-determined")),
            "working" to JsonPrimitive(0), "pendingErasure" to JsonPrimitive(identity?.get("state") == JsonPrimitive("retiring")))
    }
    @Synchronized fun registerBrowser(browser: PhoneBrowserEndpoint): CompletableFuture<PhoneConnectionRuntime> {
        Wire.requireThat(!storageUnavailable, "identity-unavailable")
        Wire.requireThat(endpoint == null || endpoint === browser, "browser-already-registered")
        endpoint = browser
        browser.fence(admission.epoch)
        val result = CompletableFuture<PhoneConnectionRuntime>()
        val current = identity
        if (current?.get("state") == JsonPrimitive("retiring")) {
            completeRetirement().whenComplete { _, error ->
                if (error != null) result.completeExceptionally(Refused("erasure-pending"))
                else synchronized(this) { result.complete(this); publish() }
            }
        } else {
            configureTransport()
            result.complete(this)
            publish()
        }
        return result
    }
    @Synchronized fun unregisterBrowser(browser: PhoneBrowserEndpoint) {
        if (endpoint !== browser) return
        close("browser-unavailable")
        endpoint = null
        transport = null
        publish()
    }
    @Synchronized fun epoch(): Int = admission.epoch
    @Synchronized fun prepare(deploymentId: String): JsonObject {
        Wire.requireThat(endpoint != null, "unsupported")
        identity = storage.prepare(deploymentId)
        configureTransport()
        val current = identity!!
        publish()
        return Wire.fields("runnerId" to current.getValue("runnerId"), "mintKey" to current.getValue("mintKey"))
    }
    fun enrollFromHost(origin: String, authorization: String, deploymentId: String, name: String, apiVersion: Int): CompletableFuture<JsonObject> {
        val result = CompletableFuture<JsonObject>()
        val (expected, enrollmentGeneration) = synchronized(this) {
            Wire.requireThat(foreground && identity?.text("deploymentId") == deploymentId, "not-foreground")
            Wire.requireThat(identity!!.text("state") in setOf("prepared", "pending"), "not-prepared")
            identity!! to generation
        }
        val target = Proofs.origin(origin)
        val command = Wire.fields("type" to JsonPrimitive("runner.enrollment.createPhone"), "name" to JsonPrimitive(name), "idempotencyKey" to expected.getValue("mintKey"))
        worker.execute {
            try {
                synchronized(this) { Wire.requireThat(identity == expected && foreground && generation == enrollmentGeneration, "retired-enrollment") }
                val response = try { request(target + "/v1/rpc/commands.dispatch", command, authorization, 65536, apiVersion) }
                    catch (_: java.io.IOException) {
                        synchronized(this) { Wire.requireThat(identity == expected && foreground && generation == enrollmentGeneration, "retired-enrollment") }
                        request(target + "/v1/rpc/commands.dispatch", command, authorization, 65536, apiVersion)
                    }
                if (response["ok"] != JsonPrimitive(true)) {
                    val reason = ((response["error"] as? JsonObject)?.get("reason") as? JsonPrimitive)?.content
                    throw Refused(if (reason == "personal-remote-access-off") "remote-access-off" else "enrollment-refused")
                }
                val minted = response.obj("data")
                Wire.requireThat(minted.text("type") == "runner.enrollment.createPhone")
                val pairing = minted.obj("pairing")
                Wire.requireThat(pairing.text("deploymentId") == deploymentId, "host-mismatch")
                Proofs.origin(pairing.text("hostUrl", max = 8192))
                minted.time("expiresAt")
                synchronized(this) {
                    Wire.requireThat(identity == expected && foreground && generation == enrollmentGeneration, "retired-enrollment")
                    identity = JsonObject(expected + mapOf("state" to JsonPrimitive("pending"), "deploymentName" to pairing.getValue("deploymentName"),
                        "hostUrl" to pairing.getValue("hostUrl"), "hostInstanceId" to pairing.getValue("hostInstanceId"),
                        "enrollmentId" to minted.getValue("enrollmentId"), "expiresAt" to minted.getValue("expiresAt"),
                        "enrollmentToken" to JsonPrimitive(minted.text("token", max = 8192)), "name" to JsonPrimitive(name)))
                    storage.save(identity!!); connect(); publish()
                }
                result.complete(Wire.fields("enrollmentId" to minted.getValue("enrollmentId")))
            } catch (error: Exception) { result.completeExceptionally(error as? Refused ?: Refused("host-unreachable")) }
        }
        return result
    }
    @Synchronized fun discardPendingEnrollment(): JsonObject {
        val current = identity ?: throw Refused("not-prepared")
        Wire.requireThat(current.text("state") != "enrolled" && current.text("state") != "retiring", "not-prepared")
        close("enrollment-replaced")
        identity = JsonObject((current - setOf("enrollmentToken", "enrollmentId", "expiresAt")) + mapOf("state" to JsonPrimitive("prepared"), "mintKey" to JsonPrimitive("android-enroll:" + UUID.randomUUID())))
        storage.save(identity!!); publish()
        return Wire.fields("mintKey" to identity!!.getValue("mintKey"))
    }
    @Synchronized fun retarget(pairing: JsonObject) {
        val current = identity ?: throw Refused("not-prepared")
        Wire.requireThat(pairing.text("deploymentId") == current.text("deploymentId") && pairing.text("hostInstanceId") == current.text("hostInstanceId"), "wrong-deployment")
        Proofs.origin(pairing.text("hostUrl", max = 8192))
        close("route-changed")
        identity = JsonObject(current + ("hostUrl" to pairing.getValue("hostUrl")))
        storage.save(identity!!); connect(); publish()
    }
    @Synchronized fun disconnect(): JsonObject {
        val current = identity ?: return Wire.fields("deploymentId" to JsonNull, "runnerId" to JsonNull)
        val deploymentId = current.text("deploymentId")
        try {
            retirement(current).begin(deploymentId)
        } catch (_: Exception) {
            issue = "failed"
        } finally { connection = "stopped"; publish() }
        retireObserver?.invoke(deploymentId)
        return Wire.fields("deploymentId" to current.getValue("deploymentId"), "runnerId" to current.getValue("runnerId"))
    }
    fun completeRetirement(): CompletableFuture<Unit> {
        val current: JsonObject
        synchronized(this) {
            current = identity ?: return CompletableFuture.completedFuture(Unit)
            Wire.requireThat(current.text("state") == "retiring", "not-retiring")
        }
        return retirement(current).finish(current.text("deploymentId")).thenApply { erased ->
            Wire.requireThat(erased, "erasure-pending")
        }
    }
    private fun retirement(current: JsonObject) = Retirement(
        persist = {
            synchronized(this) {
                identity = JsonObject(current + ("state" to JsonPrimitive("retiring")))
                storage.retire(current)
            }
        },
        fence = { synchronized(this) { close("deployment-removed") } },
        erase = { deploymentId ->
            val browser = synchronized(this) { endpoint ?: throw Refused("erasure-pending") }
            val epoch = synchronized(this) { admission.epoch }
            browser.eraseDeployment(deploymentId, epoch).thenApply { remaining ->
                Wire.requireThat(remaining.size <= 128, "erasure-unavailable")
                remaining.all {
                    val profile = it as? JsonObject ?: throw Refused("erasure-unavailable")
                    val binding = profile.obj("binding")
                    Wire.requireThat(binding["deploymentId"] == current["deploymentId"] && binding["runnerId"] == current["runnerId"], "erasure-unavailable")
                    when (profile.text("phase")) {
                        "ready" -> false
                        "deleted" -> {
                            Wire.requireThat(profile["erasure"] in setOf(JsonPrimitive("pending-restart"), JsonPrimitive("deleted")), "erasure-unavailable")
                            profile["erasure"] == JsonPrimitive("deleted")
                        }
                        else -> throw Refused("erasure-unavailable")
                    }
                }
            }
        },
        forget = {
            synchronized(this) {
                Wire.requireThat(identity?.get("runnerId") == current["runnerId"] && identity?.get("deploymentId") == current["deploymentId"] && identity?.get("state") == JsonPrimitive("retiring"), "retired-enrollment")
                storage.forget(); identity = null; transport = null; connection = "none"; publish()
            }
        },
    )
    @Synchronized fun setActivityForeground(active: Boolean) {
        activityForeground = active
        setForeground(active)
    }
    @Synchronized fun setForeground(active: Boolean) {
        Wire.requireThat(!active || activityForeground, "not-foreground")
        if (foreground == active) {
            if (active) connect()
            if (active && admission.fence != null) transport?.reportOnline()
            return
        }
        foreground = active
        admission.active = active
        if (!active) { close("inactive"); connection = if (identity == null) "none" else "background" }
        else connect()
        publish()
    }
    @Synchronized fun fence(reason: String): Int {
        if (reason in setOf("initialize", "inactive", "disposed", "deployment-removed", "lease-expired")) {
            close(reason)
            if (reason == "inactive") {
                foreground = false; admission.active = false
            } else if (reason in setOf("initialize", "lease-expired")) connect()
            return admission.epoch
        }
        return transport?.fence() ?: admission.advance().also { endpoint?.fence(it) }
    }
    @Synchronized fun requireEpoch(epoch: Int) { Wire.requireThat(epoch == admission.epoch, "retired-epoch") }
    @Synchronized fun browser() = transport ?: throw Refused("not-prepared")
    @Synchronized fun qualify(deploymentId: String, runnerId: String): JsonObject {
        Wire.requireThat(identity?.text("deploymentId") == deploymentId && identity?.text("runnerId") == runnerId && identity?.text("state") != "retiring", "wrong-deployment")
        return endpoint?.qualification(deploymentId, runnerId) ?: throw Refused("unsupported")
    }
    fun now(): Long = hostClock?.let { it.serverAt + SystemClock.elapsedRealtime() - it.tickAt } ?: System.currentTimeMillis()
    private fun configureTransport() {
        val current = identity ?: return
        if (current.text("state") == "retiring") return
        if (transport != null) return
        val qualification = endpoint?.qualification(current.text("deploymentId"), current.text("runnerId")) ?: return
        transport = BrowserTransport(admission, AttachTickets(qualification.text("runtimeId"), storage.replay(current), ::now), worker,
            { event -> eventObserver?.invoke(event) }, { epoch -> endpoint?.fence(epoch) })
    }
    @Synchronized private fun publish() { revision += 1; observer?.invoke(snapshot()) }
    @Synchronized private fun close(reason: String) {
        generation += 1
        pulse?.cancel(false); pulse = null
        handshakeDeadline?.cancel(false); handshakeDeadline = null
        if (transport != null) transport!!.offline(reason)
        else {
            val epoch = admission.advance()
            endpoint?.fence(epoch)
        }
        primary?.cancel(); auxiliary?.cancel(); primary = null; auxiliary = null; primaryFence = null
        auxiliaryTicket = null; ticketRequest = null; primaryEnd = 0; retryAt = null
        primaryHeartbeatAt = 0; auxiliaryHeartbeatAt = 0
    }
    @Synchronized private fun connect() {
        val current = identity ?: return
        if (!foreground || primary != null || current.text("state") !in setOf("pending", "enrolled") || transport == null) return
        val qualification = endpoint?.qualification(current.text("deploymentId"), current.text("runnerId")) ?: return
        if (qualification["browser"] != JsonPrimitive(true) || qualification["sharedControl"] != JsonPrimitive(true)) return
        val attempt = ++generation
        connection = "connecting"; issue = null
        worker.execute {
            try {
                val origin = Proofs.origin(current.text("hostUrl", max = 8192))
                val discovery = request(origin + "/.well-known/opensteer", null, null, 16384).obj("authority").obj("document")
                Wire.requireThat(discovery.text("deploymentId") == current.text("deploymentId") && discovery.text("hostInstanceId") == current.text("hostInstanceId"), "host-mismatch")
                synchronized(this) {
                    if (!current(attempt)) return@execute
                    primary = http.newWebSocket(Request.Builder().url(origin.replaceFirst("https://", "wss://") + "/internal/v1/runners").build(), listener(attempt, false))
                    handshakeDeadline = worker.schedule({ fail(attempt, Refused("host-unreachable")) }, 20, TimeUnit.SECONDS)
                }
            } catch (error: Exception) { fail(attempt, error) }
        }
    }
    private fun listener(attempt: Long, browser: Boolean) = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) { worker.execute {
            try { synchronized(this@PhoneConnectionRuntime) {
                if (!current(attempt) || (if (browser) auxiliary else primary) !== webSocket) return@execute
                val frame = Wire.parse(text)
                if (browser) browserFrame(webSocket, frame, attempt) else primaryFrame(webSocket, frame, attempt)
            } } catch (error: Exception) { fail(attempt, error) }
        } }
        override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) { fail(attempt, Refused("protocol-error")) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { fail(attempt, Refused("host-unreachable")) }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { fail(attempt, Refused(if (code == 4010) "removed" else "host-unreachable")) }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null); onClosed(webSocket, code, "") }
    }
    @Synchronized private fun current(attempt: Long) = foreground && generation == attempt && identity?.text("state") in setOf("pending", "enrolled")
    private fun descriptor(): JsonObject {
        val current = identity ?: throw Refused("not-prepared")
        val qualified = endpoint!!.qualification(current.text("deploymentId"), current.text("runnerId"))
        Wire.requireThat(qualified["browser"] == JsonPrimitive(true) && qualified["sharedControl"] == JsonPrimitive(true) &&
            qualified["platform"] == JsonPrimitive("android"), "unsupported")
        val browser = linkedMapOf<String, JsonElement>("runtimeId" to qualified.getValue("runtimeId"), "wireVersion" to JsonPrimitive(1),
            "localProfileStorage" to Wire.fields("storageInstanceId" to qualified.getValue("storageInstanceId"), "engine" to JsonPrimitive("android-webview")))
        for (key in listOf("navigationVersion", "navigationAttributionVersion", "workspaceTabRestoreVersion", "popupFollowVersion", "targetControl", "rasterDemand", "basicInput", "surfaceState")) browser[key] = JsonPrimitive(1)
        if (qualified["sharedControl"] == JsonPrimitive(true)) browser["sharedControl"] = JsonPrimitive(1)
        if (qualified["cdpBoundary"] == JsonPrimitive(true)) browser["cdpBoundary"] = JsonPrimitive(1)
        if (qualified["fileStaging"] == JsonPrimitive(true)) browser["fileStaging"] = JsonPrimitive(true)
        return Wire.fields("bootId" to JsonPrimitive(bootId), "runnerId" to current.getValue("runnerId"), "runnerKind" to JsonPrimitive("local"),
            "runtimeVersion" to JsonPrimitive(version), "name" to current.getValue("name"), "capabilities" to JsonArray(emptyList()),
            "device" to Wire.fields("form" to JsonPrimitive("phone"), "platform" to JsonPrimitive("android")), "modules" to Wire.fields("browser" to JsonObject(browser)))
    }
    private fun primaryFrame(socket: WebSocket, frame: JsonObject, attempt: Long) {
        refusal(frame)
        val current = identity ?: throw Refused("not-prepared")
        when (frame.text("type")) {
            "host.challenge" -> {
                Wire.requireThat(primaryFence == null)
                Wire.requireThat(hostClock == null || frame.time("expiresAt") > now(), "protocol-error")
                val descriptor = descriptor()
                val token = if (current.text("state") == "pending") current.text("enrollmentToken", max = 8192) else null
                val proof = linkedMapOf<String, JsonElement>("challengeId" to frame.getValue("challengeId"), "descriptor" to descriptor, "proofFormatVersion" to JsonPrimitive(2),
                    "type" to JsonPrimitive(if (token == null) "runner.authenticate" else "runner.enroll"),
                    "signature" to JsonPrimitive(storage.sign(current, Proofs.primary(frame, descriptor, storage.fingerprint(current), token))))
                if (token != null) {
                    proof["publicKeyPem"] = JsonPrimitive(storage.publicKey(current))
                    proof["credential"] = Wire.fields("kind" to JsonPrimitive("host-enrollment-token"), "enrollmentToken" to JsonPrimitive(token))
                }
                send(socket, JsonObject(proof))
            }
            "host.welcome" -> {
                Wire.requireThat(primaryFence == null)
                val fence = Fence.primary(frame)
                Wire.requireThat(fence.fields["runnerId"] == current["runnerId"] && fence.fields["bootId"] == JsonPrimitive(bootId))
                val modules = frame["allowedModules"] as? JsonArray ?: throw Refused("invalid-wire")
                Wire.requireThat(modules.map { it.jsonPrimitive.content }.toSet() == setOf("browser", "integrations"))
                primaryFence = fence
                hostClock = HostClock(frame.time("serverTime"), SystemClock.elapsedRealtime())
                primaryEnd = frame.time("connectionLeaseExpiresAt")
                Wire.requireThat(primaryEnd > now())
                primaryInterval = frame.number("heartbeatIntervalMs", 1000, 300000)
                val previousGeneration = (current["lastConnectionGeneration"] as? JsonPrimitive)?.longOrNull ?: 0L
                Wire.requireThat(fence.fields.number("connectionGeneration", 1) > previousGeneration, "retired-primary")
                identity = JsonObject((current - "enrollmentToken") + mapOf("state" to JsonPrimitive("enrolled"),
                    "lastConnectionGeneration" to fence.fields.getValue("connectionGeneration")))
                storage.save(identity!!)
                val requestId = "browser:" + UUID.randomUUID()
                ticketRequest = requestId
                send(socket, JsonObject(fence.fields + mapOf("type" to JsonPrimitive("runner.auxiliary.ticket-request"), "module" to JsonPrimitive("browser"), "requestId" to JsonPrimitive(requestId))))
                heartbeat(attempt)
                publish()
            }
            "host.connection.lease-renewed" -> {
                Wire.requireThat(Fence.primary(frame) == primaryFence && primaryEnd > now(), "retired-primary")
                primaryEnd = maxOf(primaryEnd, frame.time("connectionLeaseExpiresAt"))
            }
            "host.auxiliary.ticket" -> {
                Wire.requireThat(Fence.primary(frame) == primaryFence && frame.text("requestId") == ticketRequest && frame.text("module") == "browser" && auxiliary == null)
                Wire.requireThat(frame.time("expiresAt") > now())
                auxiliaryTicket = frame.text("ticket", max = 8192)
                val origin = Proofs.origin(current.text("hostUrl", max = 8192)).replaceFirst("https://", "wss://")
                auxiliary = http.newWebSocket(Request.Builder().url(origin + "/internal/v1/runners/auxiliary/browser").build(), listener(attempt, true))
            }
            else -> throw Refused("protocol-error")
        }
    }
    private fun browserFrame(socket: WebSocket, frame: JsonObject, attempt: Long) {
        refusal(frame)
        when (frame.text("type")) {
            "host.auxiliary.challenge" -> {
                val current = identity ?: throw Refused("not-prepared")
                Wire.requireThat(frame.time("expiresAt") > now(), "protocol-error")
                val ticket = auxiliaryTicket ?: throw Refused("retired-ticket")
                send(socket, Wire.fields("type" to JsonPrimitive("runner.auxiliary.authenticate"), "bootId" to JsonPrimitive(bootId), "runnerId" to current.getValue("runnerId"),
                    "challengeId" to frame.getValue("challengeId"), "module" to JsonPrimitive("browser"), "ticket" to JsonPrimitive(ticket),
                    "signature" to JsonPrimitive(storage.sign(current, Proofs.auxiliary(frame, current.text("runnerId"), bootId, ticket)))))
                auxiliaryTicket = null
            }
            "host.auxiliary.welcome" -> {
                Wire.requireThat(admission.fence == null && Fence.primary(frame) == primaryFence)
                auxiliaryInterval = frame.number("heartbeatIntervalMs", 1000, 300000)
                browser().online(socket, frame)
                handshakeDeadline?.cancel(false); handshakeDeadline = null
                retryDelay = 1000; retryAt = null; connection = "online"; publish()
                send(primary!!, JsonObject(primaryFence!!.fields + mapOf("type" to JsonPrimitive("runner.modules.report"), "modules" to JsonArray(listOf(
                    Wire.fields("module" to JsonPrimitive("browser"), "readiness" to JsonPrimitive("ready"), "detail" to JsonNull, "checkedAt" to JsonPrimitive(iso(now()))))))))
                heartbeat(attempt)
            }
            "host.auxiliary.lease-renewed" -> browser().renew(frame)
            else -> browser().receive(frame)
        }
    }
    @Synchronized private fun heartbeat(attempt: Long) {
        if (!current(attempt)) return
        pulse?.cancel(false); pulse = null
        val at = now()
        if (primaryEnd <= at || (admission.fence != null && admission.deadline <= at)) { fail(attempt, Refused("lease-expired")); return }
        val fence = primaryFence ?: return
        if (at - primaryHeartbeatAt >= primaryInterval) {
            primaryHeartbeatAt = maxOf(at, primaryHeartbeatAt + 1)
            send(primary!!, JsonObject(fence.fields + mapOf("type" to JsonPrimitive("runner.heartbeat"), "sentAt" to JsonPrimitive(iso(primaryHeartbeatAt)),
                "activeRunIds" to JsonArray(emptyList()), "activeTriggerOccurrenceIds" to JsonArray(emptyList()), "activeWatchActivationIds" to JsonArray(emptyList()))))
        }
        if (admission.fence != null && at - auxiliaryHeartbeatAt >= auxiliaryInterval) {
            auxiliaryHeartbeatAt = maxOf(at, auxiliaryHeartbeatAt + 1)
            send(auxiliary!!, JsonObject(admission.fence!!.fields + mapOf("type" to JsonPrimitive("runner.auxiliary.heartbeat"), "sentAt" to JsonPrimitive(iso(auxiliaryHeartbeatAt)))))
        }
        val delay = minOf(primaryInterval, primaryEnd - at, if (admission.fence == null) primaryInterval else minOf(auxiliaryInterval, admission.deadline - at))
        pulse = worker.schedule({ try { heartbeat(attempt) } catch (error: Exception) { fail(attempt, error) } }, maxOf(1, delay), TimeUnit.MILLISECONDS)
    }
    @Synchronized private fun fail(attempt: Long, error: Exception) {
        if (!current(attempt)) return
        val reason = when (val refused = (error as? Refused)?.reason) {
            "invalid-wire", "invalid-key" -> "protocol-error"
            null -> "host-unreachable"
            else -> refused
        }
        close(reason)
        issue = when (reason) {
            "removed", "host-mismatch", "needs-update", "enrollment-expired", "enrollment-refused", "protocol-error", "profile-mismatch", "remote-access-off" -> reason
            else -> "host-unreachable"
        }
        if (reason == "removed") { disconnect(); issue = "removed"; publish(); return }
        val terminal = reason in setOf("host-mismatch", "needs-update", "enrollment-expired", "enrollment-refused", "protocol-error", "profile-mismatch", "remote-access-off")
        connection = if (terminal) "stopped" else "retrying"
        if (!terminal) {
            val witness = generation
            retryAt = iso(System.currentTimeMillis() + retryDelay)
            worker.schedule({ synchronized(this) { if (generation == witness && foreground) connect() } }, retryDelay, TimeUnit.MILLISECONDS)
            retryDelay = minOf(retryDelay * 2, 30000)
        }
        publish()
    }
    private fun refusal(frame: JsonObject) {
        if (frame["type"] !in setOf(JsonPrimitive("host.error"), JsonPrimitive("host.auxiliary.rejected"))) return
        val reason = (frame.obj("error")["reason"] as? JsonPrimitive)?.content
        throw Refused(when (reason) {
            "runner-identity-revoked" -> "removed"
            "runner-enrollment-expired" -> "enrollment-expired"
            "runner-enrollment-refused" -> "enrollment-refused"
            "runner-proof-format-mismatch" -> "needs-update"
            "runner-device-profile-mismatch" -> "profile-mismatch"
            "personal-remote-access-off" -> "remote-access-off"
            else -> "enrollment-refused"
        })
    }
    private fun send(socket: WebSocket, message: JsonObject) { Wire.requireThat(socket.send(message.toString()), "stream-gone") }
    private fun request(url: String, body: JsonObject?, authorization: String?, maxBytes: Int, apiVersion: Int? = null): JsonObject {
        val request = Request.Builder().url(url).header("Accept", "application/json").apply {
            if (authorization != null) header("Authorization", authorization)
            if (apiVersion != null) header("x-opensteer-api-version", apiVersion.toString())
            if (body != null) post(body.toString().toRequestBody("application/json".toMediaType()))
        }.build()
        return http.newCall(request).execute().use { response ->
            Wire.requireThat(response.code == 200 || (body != null && response.code in 400..499), "host-unreachable")
            val source = response.body.source()
            source.request((maxBytes + 1).toLong())
            Wire.requireThat(source.buffer.size <= maxBytes)
            val bytes = source.readByteArray()
            Wire.requireThat(bytes.size <= maxBytes)
            Wire.parse(Wire.decode(bytes), maxBytes)
        }
    }
    companion object {
        @Volatile private var instance: PhoneConnectionRuntime? = null
        @Synchronized fun get(context: Context): PhoneConnectionRuntime = instance ?: PhoneConnectionRuntime(context).also { instance = it }
        private fun iso(at: Long) = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(Date(at))
    }
}
