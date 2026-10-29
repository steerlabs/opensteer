package com.opensteer.agentphone.wire

import java.net.URI

/** Where a phone reaches its Deployment (`AgentPhoneHostTargetSchema`), as that Deployment's Host gives it. */
data class HostTarget(val deploymentId: String, val deploymentName: String, val hostInstanceId: String, val hostUrl: String)

/** What setup hands the phone over USB (`AgentPhonePairingSchema`); the token is the one secret in it. */
data class Pairing(
    val deploymentId: String,
    val deploymentName: String,
    val enrollmentId: String,
    val enrollmentToken: String,
    val expiresAt: String,
    val hostInstanceId: String,
    val hostUrl: String,
    val runnerName: String,
) {
    override fun toString() = "Pairing(deploymentId=$deploymentId, enrollmentId=$enrollmentId, hostUrl=$hostUrl)"
}

enum class ConnectionState(val wire: String) {
    UNPAIRED("unpaired"),
    PAIRING("pairing"),
    CONNECTING("connecting"),
    ONLINE("online"),
    OFFLINE("offline"),
    NEEDS_UPDATE("needs-update"),
    REMOVED("removed"),
}

/** `AgentPhoneIssueCodeSchema`. */
enum class IssueCode(val wire: String) {
    ENROLLMENT_EXPIRED("enrollment-expired"),
    ENROLLMENT_REFUSED("enrollment-refused"),
    HOST_UNREACHABLE("host-unreachable"),
    HOST_MISMATCH("host-mismatch"),
    REMOTE_ACCESS_OFF("remote-access-off"),
    REMOVED("removed"),
    ACCESSIBILITY_OFF("accessibility-off"),
    PROTOCOL_ERROR("protocol-error"),
    NEEDS_UPDATE("needs-update"),
    FAILED("failed"),
}

/** Why the phone is not, or not yet, working for its Deployment, in words both setup and the phone show. */
data class Issue(val code: IssueCode, val detail: String) {
    init {
        require(detail.length in 1..500)
    }
}

/** The pairing as status may show it: everything but the token. */
data class PairingSummary(val deploymentId: String, val deploymentName: String, val enrollmentId: String, val hostUrl: String, val runnerId: String)

/** `AgentPhoneSetupStatusSchema`, which travels in a broadcast's result data and so carries no secret. */
data class SetupStatus(
    val accessibilityEnabled: Boolean,
    val accessibilityConnected: Boolean,
    val versionCode: Int,
    val versionName: String,
    val batteryOptimizationExempt: Boolean,
    val connection: ConnectionState,
    val issue: Issue?,
    val pairing: PairingSummary?,
    val paused: Boolean,
)

object SetupWire {
    const val VERSION = 1

    /** The base64url JSON of `AgentPhonePairingSchema`, from the `payload` extra. */
    fun decodePairing(payload: String): Pairing {
        val fields = Fields.parse(utf8(payload, "pairing"), "pairing")
        val pairing = Pairing(
            deploymentId = fields.string("deploymentId", pattern = Ids.deployment),
            deploymentName = name(fields, "deploymentName"),
            enrollmentId = fields.string("enrollmentId", min = 1, max = 256),
            enrollmentToken = fields.string("enrollmentToken", min = 32, max = 4_096),
            expiresAt = fields.isoTime("expiresAt"),
            hostInstanceId = fields.string("hostInstanceId", pattern = Ids.hostInstance),
            hostUrl = fields.string("hostUrl").also { if (!isPhoneHostUrl(it)) fields.fail("hostUrl", "is not an origin a phone may use") },
            // Zod trims the name before it checks it, so the phone keeps exactly what the Host keeps.
            runnerName = name(fields, "runnerName"),
        )
        fields.int("version", min = VERSION.toLong(), max = VERSION.toLong())
        fields.end()
        return pairing
    }

    /** RETARGET's `payload`: the base64url JSON of `AgentPhoneHostTargetSchema`, and nothing else. */
    fun decodeHostTarget(payload: String): HostTarget {
        val fields = Fields.parse(utf8(payload, "address"), "target")
        val target = HostTarget(
            deploymentId = fields.string("deploymentId", pattern = Ids.deployment),
            deploymentName = name(fields, "deploymentName"),
            hostInstanceId = fields.string("hostInstanceId", pattern = Ids.hostInstance),
            hostUrl = fields.string("hostUrl").also { if (!isPhoneHostUrl(it)) fields.fail("hostUrl", "is not an origin a phone may use") },
        )
        fields.end()
        return target
    }

    fun encodeStatus(status: SetupStatus): JsonObject = jsonObject(
        "accessibility" to jsonObject(
            "enabled" to jsonOf(status.accessibilityEnabled),
            "connected" to jsonOf(status.accessibilityConnected),
        ),
        "app" to jsonObject("versionCode" to jsonOf(status.versionCode), "versionName" to jsonOf(status.versionName)),
        "batteryOptimizationExempt" to jsonOf(status.batteryOptimizationExempt),
        "connection" to jsonOf(status.connection.wire),
        "issue" to (status.issue?.let { jsonObject("code" to jsonOf(it.code.wire), "detail" to jsonOf(it.detail)) } ?: JsonNull),
        "pairing" to (
            status.pairing?.let {
                jsonObject(
                    "deploymentId" to jsonOf(it.deploymentId),
                    "deploymentName" to jsonOf(it.deploymentName),
                    "enrollmentId" to jsonOf(it.enrollmentId),
                    "hostUrl" to jsonOf(it.hostUrl),
                    "runnerId" to jsonOf(it.runnerId),
                )
            } ?: JsonNull
            ),
        "paused" to jsonOf(status.paused),
        "version" to jsonOf(VERSION),
    )

    private fun name(fields: Fields, key: String): String = fields.string(key).jsTrim().also {
        if (it.isEmpty() || it.length > 120) fields.fail(key, "is not a 1-120 character name")
    }

    private fun utf8(payload: String, what: String): String = try {
        Base64Url.decode(payload).toString(Charsets.UTF_8)
    } catch (error: WireException) {
        throw WireException("The $what payload is not base64url")
    }

    /**
     * `AgentPhoneHostUrlSchema`: a bare, normalized origin — what
     * `new URL(value).origin` gives back unchanged — over HTTPS, or over HTTP
     * only to the phone's own loopback address.
     */
    fun isPhoneHostUrl(value: String): Boolean {
        val uri = try {
            URI(value)
        } catch (error: Exception) {
            return false
        }
        val scheme = uri.scheme ?: return false
        val host = uri.host ?: return false
        if (scheme != "https" && scheme != "http") return false
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return false
        if (!uri.rawPath.isNullOrEmpty()) return false
        if (host != host.lowercase()) return false
        val defaultPort = if (scheme == "https") 443 else 80
        if (uri.port == defaultPort) return false
        val origin = "$scheme://$host" + if (uri.port == -1) "" else ":${uri.port}"
        if (origin != value) return false
        return scheme == "https" || isLoopbackHost(host)
    }

    /** `isLoopbackHostname` for the spellings a normalized origin can hold. */
    private fun isLoopbackHost(host: String): Boolean {
        val name = host.removeSuffix(".").removePrefix("[").removeSuffix("]")
        if (name == "localhost" || (name.endsWith(".localhost") && name != ".localhost")) return true
        if (name == "::1") return true
        if (Regex("^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$").matches(name)) return true
        val octets = name.split('.')
        return octets.size == 4 && octets.all { it.toIntOrNull() in 0..255 && it == it.toIntOrNull().toString() } && octets[0] == "127"
    }
}
