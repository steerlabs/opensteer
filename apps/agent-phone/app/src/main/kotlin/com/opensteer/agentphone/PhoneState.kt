package com.opensteer.agentphone

import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.opensteer.agentphone.control.ActiveSession
import com.opensteer.agentphone.control.AgentPhoneAccessibilityService
import com.opensteer.agentphone.control.PhoneRuntime
import com.opensteer.agentphone.runner.ConnectionPolicy
import com.opensteer.agentphone.runner.IdentityStore
import com.opensteer.agentphone.runner.LocalSettings
import com.opensteer.agentphone.runner.PhoneIdentity
import com.opensteer.agentphone.runner.PhoneRecord
import com.opensteer.agentphone.runner.Retarget
import com.opensteer.agentphone.wire.ConnectionState
import com.opensteer.agentphone.wire.HostTarget
import com.opensteer.agentphone.wire.Issue
import com.opensteer.agentphone.wire.IssueCode
import com.opensteer.agentphone.wire.PairingSummary
import com.opensteer.agentphone.wire.SetupStatus
import com.opensteer.agentphone.wire.SetupWire
import com.opensteer.agentphone.wire.WireException
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** What the runtime last said about the identity it works for. */
data class RuntimeReport(
    val link: RuntimeLink,
    /** The session holding the phone, if any. */
    val session: ActiveSession?,
) {
    val deploymentName: String? get() = link.target?.deploymentName

    /** A stored RETARGET cannot borrow a previous target's readiness or issues. */
    fun forIdentity(identity: PhoneIdentity?): RuntimeReport? = takeIf {
        identity != null && link.identityKey == identity.key && link.target == identity.target &&
            (link.connection != ConnectionState.ONLINE || identity.hostVerified)
    }
}

/** A connection state belongs to one target; rebinding it starts a new connection. */
data class RuntimeLink(
    /** The identity this link is about; a report about another one is stale and ignored. */
    val identityKey: String? = null,
    val target: HostTarget? = null,
    val connection: ConnectionState = ConnectionState.CONNECTING,
    val issue: Issue? = null,
) {
    fun useIdentity(identity: PhoneIdentity?): RuntimeLink =
        if (identityKey == identity?.key && target == identity?.target) this
        else RuntimeLink(
            identityKey = identity?.key,
            target = identity?.target,
            connection = when {
                identity == null -> ConnectionState.UNPAIRED
                identity.enrolled -> ConnectionState.CONNECTING
                else -> ConnectionState.PAIRING
            },
        )

    /** An old attempt cannot change the new target's state after a rebind. */
    fun changed(target: HostTarget?, connection: ConnectionState, issue: Issue?): RuntimeLink =
        if (target != this.target) this else copy(connection = connection, issue = issue)
}

val PhoneIdentity.key: String get() = "$runnerId $enrollmentId"

/**
 * The state every part of the app shares: the stored identity and the
 * owner's settings, the runtime while the accessibility service runs it, and
 * what that runtime last reported. Setup commands and the owner's choices
 * run in order on one setup thread, off the main thread and never behind the
 * network. It is also the record the runtime's connection keeps its identity in.
 */
class PhoneState(private val context: Context) : PhoneRecord {
    val identities = IdentityStore(context.noBackupFilesDir)
    val settings = LocalSettings(context)
    val setup: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "opensteer-setup") }
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    /** The runtime, present exactly while the accessibility service is connected. */
    @Volatile
    var runtime: PhoneRuntime? = null
        private set

    @Volatile
    var report: RuntimeReport? = null
        private set

    fun runtimeStarted(runtime: PhoneRuntime) {
        this.runtime = runtime
        changed()
    }

    fun runtimeStopped(runtime: PhoneRuntime) {
        if (this.runtime === runtime) this.runtime = null
        report = null
        changed()
    }

    override fun load(): PhoneIdentity? = identities.load()

    override fun replace(expected: PhoneIdentity, next: PhoneIdentity): Boolean = identities.replace(expected, next)

    override fun removeIfCurrent(expected: PhoneIdentity): Boolean {
        if (!identities.wipeIfCurrent(expected)) return false
        settings.removed = true
        return true
    }

    override val removed: Boolean get() = settings.removed

    fun publish(next: RuntimeReport) {
        if (next == report) return
        report = next
        changed()
    }

    /** Calls `listener` on the main thread whenever anything here may have changed. */
    fun addListener(listener: () -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: () -> Unit) {
        listeners -= listener
    }

    fun changed() {
        main.post { listeners.forEach { it() } }
    }

    /**
     * Accepts a pairing from setup. The identity — id and Runner key — is
     * stored before the first enrollment, so a lost answer is retried as the
     * same enrollment. A phone the Host has already welcomed keeps its
     * Deployment until it is explicitly unpaired; a phone that never enrolled
     * keeps its identity and takes the new token.
     */
    fun pair(payload: String?): SetupResult {
        val pairing = try {
            SetupWire.decodePairing(payload ?: throw WireException("The pairing payload is missing"))
        } catch (error: WireException) {
            return SetupResult(SetupResult.INVALID_PAYLOAD, status())
        }
        val current = identities.load()
        when {
            current == null -> identities.save(PhoneIdentity.create(pairing))
            current.sameEnrollment(pairing) && current.enrolled -> return SetupResult(SetupResult.APPLIED, status())
            // Setup retrying the pairing it already sent: the same identity tries the same token again now.
            current.sameEnrollment(pairing) -> Unit
            current.enrolled -> return SetupResult(SetupResult.ALREADY_PAIRED, status())
            else -> identities.save(current.repaired(pairing))
        }
        settings.removed = false
        runtime?.connection?.identityChanged()
        changed()
        return SetupResult(SetupResult.APPLIED, status())
    }

    /**
     * Moves a phone to the address its own Deployment's Host gives now
     * (RETARGET), keeping its identity — an enrolled one, or one still waiting
     * for its first welcome, with its unspent token. The address is stored unconfirmed,
     * and the runtime confirms it answers as that Deployment's Host before it
     * connects there, reporting `host-mismatch` or `host-unreachable` in
     * status otherwise; this thread never waits on the network, so Pause and
     * STATUS stay immediate. The decision and the write happen under the
     * store's lock, so a generation the runtime writes meanwhile is kept.
     */
    fun retarget(payload: String?): SetupResult {
        val target = try {
            SetupWire.decodeHostTarget(payload ?: throw WireException("The address payload is missing"))
        } catch (error: WireException) {
            return SetupResult(SetupResult.INVALID_PAYLOAD, status())
        }
        val decision = synchronized(identities) {
            (identities.load()?.retarget(target) ?: Retarget.NotEnrolled).also {
                if (it is Retarget.Moved) identities.save(it.identity)
            }
        }
        return when (decision) {
            Retarget.OtherDeployment -> SetupResult(SetupResult.ALREADY_PAIRED, status())
            Retarget.NotEnrolled -> SetupResult(SetupResult.NOT_ENROLLED, status())
            Retarget.Unchanged -> SetupResult(SetupResult.APPLIED, status())
            is Retarget.Moved -> {
                runtime?.connection?.identityChanged()
                changed()
                SetupResult(SetupResult.APPLIED, status())
            }
        }
    }

    /** Forgets the pairing, the identity and Runner key; Opensteer sees the phone go offline. */
    fun unpair(): SetupResult {
        com.opensteer.agentphone.update.UpdateInstaller(context).abandon()
        identities.wipe()
        settings.removed = false
        runtime?.connection?.identityChanged()
        changed()
        return SetupResult(SetupResult.APPLIED, status())
    }

    /**
     * `AgentPhoneSetupStatus`, which never carries a secret. An identity the
     * phone can no longer read — its Keystore key gone, its file damaged —
     * is reported, and UNPAIR, which reads nothing, clears it.
     */
    fun status(): SetupStatus {
        val (identity, unreadable) = try {
            identities.load() to false
        } catch (error: Exception) {
            Log.e(TAG, "The stored identity could not be read", error)
            null to true
        }
        val connected = runtime != null
        val report = report?.forIdentity(identity)
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        return SetupStatus(
            accessibilityEnabled = accessibilityEnabled(),
            accessibilityConnected = connected,
            versionCode = packageInfo.longVersionCode.toInt(),
            versionName = requireNotNull(packageInfo.versionName),
            batteryOptimizationExempt = context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName),
            connection = when {
                identity == null -> if (settings.removed) ConnectionState.REMOVED else ConnectionState.UNPAIRED
                connected && report?.link?.connection == ConnectionState.NEEDS_UPDATE -> ConnectionState.NEEDS_UPDATE
                !identity.enrolled -> ConnectionState.PAIRING
                !connected -> ConnectionState.OFFLINE
                else -> report?.link?.connection ?: ConnectionState.CONNECTING
            },
            issue = when {
                unreadable -> Issue(IssueCode.FAILED, UNREADABLE)
                identity == null && settings.removed -> Issue(IssueCode.REMOVED, ConnectionPolicy.REMOVED_DETAIL)
                identity != null && !connected -> Issue(IssueCode.ACCESSIBILITY_OFF, ACCESSIBILITY_OFF)
                else -> report?.link?.issue
            },
            pairing = identity?.let { PairingSummary(it.deploymentId, it.deploymentName, it.enrollmentId, it.hostUrl, it.runnerId) },
            paused = settings.paused,
        )
    }

    fun setPaused(paused: Boolean) {
        onSetupThread {
            settings.paused = paused
            runtime?.pausedChanged(paused)
            changed()
        }
    }

    /** Runs owner work on the setup thread, where a failure is logged rather than ending the app. */
    fun onSetupThread(work: () -> Unit) {
        setup.execute {
            try {
                work()
            } catch (error: Exception) {
                Log.e(TAG, "Setup work failed", error)
            }
        }
    }

    /** Listed in the secure setting that enables accessibility services. */
    private fun accessibilityEnabled(): Boolean {
        val ours = ComponentName(context, AgentPhoneAccessibilityService::class.java)
        val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == ours }
    }

    private companion object {
        const val TAG = "AgentPhone"
        const val UNREADABLE = "This phone could not read its saved identity. Remove it from Opensteer on the phone, then set it up again."
        const val ACCESSIBILITY_OFF = "Turn on Opensteer Agent Phone in the phone's accessibility settings."
    }
}

/**
 * A setup command's answer: an ordered broadcast's result code, and the
 * status after the command as its result data.
 */
data class SetupResult(val code: Int, val status: SetupStatus) {
    companion object {
        /** `Activity.RESULT_OK`: the command was applied (or had already been). */
        const val APPLIED = -1
        /** The PAIR payload is not a valid `AgentPhonePairing`. */
        const val INVALID_PAYLOAD = 1
        /** The phone is enrolled with another pairing; unpair first. */
        const val ALREADY_PAIRED = 2
        /** The action is not one the receiver answers. */
        const val UNKNOWN_COMMAND = 3
        /** The phone could not read or write its own identity. */
        const val FAILED = 4
        /** RETARGET found no identity to move; setup pairs the phone instead. */
        const val NOT_ENROLLED = 5
    }
}

/** The application, which holds the one `PhoneState` of the process. */
class AgentPhoneApp : android.app.Application() {
    lateinit var phone: PhoneState
        private set

    override fun onCreate() {
        super.onCreate()
        phone = PhoneState(this)
    }
}

val Context.phone: PhoneState get() = (applicationContext as AgentPhoneApp).phone
