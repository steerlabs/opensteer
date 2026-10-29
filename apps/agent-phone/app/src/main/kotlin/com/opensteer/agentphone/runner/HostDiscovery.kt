package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.Fields
import com.opensteer.agentphone.wire.WireException
import okhttp3.Call
import okhttp3.Request
import java.io.IOException

/**
 * Confirms, before the phone first uses an address — to spend its one-use
 * enrollment token there, or after setup moved an enrolled phone to it — that
 * the server answering there is that Deployment's Host:
 * `/.well-known/opensteer` names its Deployment and Host instance, and both
 * must be the ones the owner's session gave the phone. TLS has already said
 * who the server is; this says it is the right Opensteer.
 */
class HostDiscovery(private val calls: Call.Factory) {
    sealed interface Result {
        data object Matches : Result
        data class Mismatch(val detail: String) : Result
        data class Unreachable(val detail: String) : Result
    }

    @Volatile
    private var call: Call? = null

    /** Once the runtime is stopping, no read starts and none in progress finishes. */
    @Volatile
    private var cancelled = false

    fun check(identity: PhoneIdentity): Result {
        val request = Request.Builder().url("${identity.hostUrl}/.well-known/opensteer").header("Accept", "application/json").build()
        val text = try {
            val started = calls.newCall(request).also { call = it }
            // A cancel between deciding to read and starting the read must still stop it.
            if (cancelled) started.cancel()
            started.execute().use { response ->
                if (!response.isSuccessful) return Result.Unreachable("Opensteer did not identify itself at ${identity.hostUrl} (HTTP ${response.code}).")
                val body = response.body.source()
                if (body.request(MAX_BYTES + 1)) return Result.Unreachable("${identity.hostUrl} sent an unexpected response.")
                body.readUtf8()
            }
        } catch (error: IOException) {
            return Result.Unreachable("Could not reach ${identity.hostUrl}: ${error.message ?: error.javaClass.simpleName}")
        } finally {
            call = null
        }
        val (deploymentId, hostInstanceId) = try {
            // The descriptor is tolerant of additions, so only the two identifiers are read.
            val document = Fields.parse(text, "descriptor").obj("authority").obj("document")
            document.optionalString("deploymentId") to document.optionalString("hostInstanceId")
        } catch (error: WireException) {
            return Result.Unreachable("${identity.hostUrl} answered, but not as Opensteer.")
        }
        return if (deploymentId == identity.deploymentId && hostInstanceId == identity.hostInstanceId) {
            Result.Matches
        } else {
            Result.Mismatch("${identity.hostUrl} is not the Opensteer this phone was set up for. Run setup again from that Opensteer.")
        }
    }

    /** Stops a read in progress, and every later one, for a runtime that is shutting down. */
    fun cancel() {
        cancelled = true
        call?.cancel()
    }

    private companion object {
        const val MAX_BYTES = 16_384L
    }
}
