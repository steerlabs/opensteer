package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.Base64Url
import com.opensteer.agentphone.wire.Ed25519Key
import com.opensteer.agentphone.wire.Fields
import com.opensteer.agentphone.wire.HostTarget
import com.opensteer.agentphone.wire.Ids
import com.opensteer.agentphone.wire.JsonObject
import com.opensteer.agentphone.wire.Pairing
import com.opensteer.agentphone.wire.jsonObject
import com.opensteer.agentphone.wire.jsonOf
import com.opensteer.agentphone.wire.jsonOrNull
import java.util.UUID

/**
 * Everything that makes this phone the same Runner across restarts: its id,
 * its Runner key, the Deployment it was paired
 * with, and how far it got.
 *
 * It exists from the moment a pairing is accepted — before the first
 * enrollment — so an enrollment whose answer was lost is retried with the
 * same token and the same identity, which the Host accepts as the same
 * enrollment. The token is kept only until the Host first welcomes the phone.
 *
 * Its address is used only once it has answered as this Deployment's Host:
 * `hostVerified` is false for a pairing's address until then, and again
 * after setup moves an enrolled phone to a new one.
 */
data class PhoneIdentity(
    val runnerId: String,
    val runnerKey: Ed25519Key,
    val lastConnectionGeneration: Long,
    val deploymentId: String,
    val deploymentName: String,
    val hostInstanceId: String,
    val hostUrl: String,
    val hostVerified: Boolean,
    val enrollmentId: String,
    val runnerName: String,
    /** Present until the first welcome; never after. */
    val enrollmentToken: String?,
) {
    val enrolled: Boolean get() = lastConnectionGeneration > 0

    /** Where this phone reaches its Deployment. */
    val target: HostTarget get() = HostTarget(deploymentId, deploymentName, hostInstanceId, hostUrl)

    /** The same pairing setup sent before, which a repeated PAIR must not disturb. */
    fun sameEnrollment(pairing: Pairing) = deploymentId == pairing.deploymentId && enrollmentId == pairing.enrollmentId

    /** A new pairing for a phone that never enrolled: same identity, new token. */
    fun repaired(pairing: Pairing) = copy(
        deploymentId = pairing.deploymentId,
        deploymentName = pairing.deploymentName,
        hostInstanceId = pairing.hostInstanceId,
        hostUrl = pairing.hostUrl,
        hostVerified = false,
        enrollmentId = pairing.enrollmentId,
        runnerName = pairing.runnerName,
        enrollmentToken = pairing.enrollmentToken,
    )

    /** The Host welcomed this phone: the token has done its work and is forgotten. */
    fun welcomed(connectionGeneration: Long) = copy(lastConnectionGeneration = connectionGeneration, enrollmentToken = null)

    /** The address answered as this Deployment's Host; the phone may connect there. */
    fun confirmed() = copy(hostVerified = true)

    /**
     * What RETARGET does to this identity. A phone of that Deployment moves,
     * whether enrolled or still waiting for its first welcome, and only its
     * name and address change: the Runner, its key, its enrollment and any
     * token it has not yet spent stay, so the Host sees the same computer, or
     * the same enrollment, arrive by another route. The new address is
     * confirmed by discovery before it is used.
     */
    fun retarget(to: HostTarget): Retarget = when {
        to.deploymentId != deploymentId -> Retarget.OtherDeployment
        to == target && hostVerified -> Retarget.Unchanged
        else -> Retarget.Moved(copy(deploymentName = to.deploymentName, hostInstanceId = to.hostInstanceId, hostUrl = to.hostUrl, hostVerified = false))
    }

    fun toJson(): JsonObject = jsonObject(
        "deploymentId" to jsonOf(deploymentId),
        "deploymentName" to jsonOf(deploymentName),
        "enrollmentId" to jsonOf(enrollmentId),
        "enrollmentToken" to jsonOrNull(enrollmentToken),
        "hostInstanceId" to jsonOf(hostInstanceId),
        "hostUrl" to jsonOf(hostUrl),
        "hostVerified" to jsonOf(hostVerified),
        "lastConnectionGeneration" to jsonOf(lastConnectionGeneration),
        "runnerId" to jsonOf(runnerId),
        "runnerKeySeed" to jsonOf(Base64Url.encode(runnerKey.seed)),
        "runnerName" to jsonOf(runnerName),
        "version" to jsonOf(VERSION),
    )

    override fun toString() = "PhoneIdentity(runnerId=$runnerId, deploymentId=$deploymentId, enrolled=$enrolled)"

    companion object {
        private const val VERSION = 2

        fun create(pairing: Pairing) = PhoneIdentity(
            runnerId = "rnr_${UUID.randomUUID()}",
            runnerKey = Ed25519Key.generate(),
            lastConnectionGeneration = 0,
            deploymentId = pairing.deploymentId,
            deploymentName = pairing.deploymentName,
            hostInstanceId = pairing.hostInstanceId,
            hostUrl = pairing.hostUrl,
            hostVerified = false,
            enrollmentId = pairing.enrollmentId,
            runnerName = pairing.runnerName,
            enrollmentToken = pairing.enrollmentToken,
        )

        fun fromJson(text: String): PhoneIdentity {
            val fields = Fields.parse(text, "identity")
            val version = fields.int("version", 1, VERSION.toLong())
            // Version 1 also kept the retired approval key: read so the strict parse accepts it, then drop it.
            if (version == 1L) fields.string("approvalKeySeed")
            val identity = PhoneIdentity(
                runnerId = fields.string("runnerId", pattern = Ids.runner),
                runnerKey = Ed25519Key.fromSeed(Base64Url.decode(fields.string("runnerKeySeed"))),
                lastConnectionGeneration = fields.int("lastConnectionGeneration", 0),
                deploymentId = fields.string("deploymentId", pattern = Ids.deployment),
                deploymentName = fields.string("deploymentName", min = 1, max = 120),
                hostInstanceId = fields.string("hostInstanceId", pattern = Ids.hostInstance),
                hostUrl = fields.string("hostUrl"),
                hostVerified = fields.bool("hostVerified"),
                enrollmentId = fields.string("enrollmentId", min = 1),
                runnerName = fields.string("runnerName", min = 1),
                enrollmentToken = fields.stringOrNull("enrollmentToken", min = 1),
            )
            fields.end()
            return identity
        }
    }
}

/** RETARGET's decision about the identity a phone holds. */
sealed interface Retarget {
    /** The phone works for another Deployment; setup must unpair it there first. */
    data object OtherDeployment : Retarget

    /** No identity to move: setup pairs this phone instead. */
    data object NotEnrolled : Retarget

    /** Already at that address, and it answered as this Deployment's Host: nothing changes. */
    data object Unchanged : Retarget

    /** The same identity at the new address, which the runtime confirms before connecting. */
    data class Moved(val identity: PhoneIdentity) : Retarget
}
