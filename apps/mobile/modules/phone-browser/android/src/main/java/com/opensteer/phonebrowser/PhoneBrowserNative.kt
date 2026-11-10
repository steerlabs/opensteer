package com.opensteer.phonebrowser

/** Installed by the native connection owner after it has verified attachment authority. */
data class PhoneBrowserCdpGrant(val attachmentId: String, val sessionId: String)

interface PhoneBrowserAuthority {
  fun requireAllocation(epoch: Int, permit: String, sessionId: String?, storeHandle: String?, binding: Map<String, Any>? = null, initialized: Boolean? = null)
  fun requireCdp(epoch: Int, channelId: String, actorToken: String): PhoneBrowserCdpGrant
  fun viewerActor(epoch: Int, channelId: String, sessionId: String): String? = null
  fun requireAttachment(epoch: Int, attachmentId: String, sessionId: String, tabId: String)
  fun requireViewer(epoch: Int, channelId: String, sessionId: String, control: Boolean = false)
  fun acknowledge(epoch: Int, channelId: String, token: String)
}

data class PhoneBrowserGeometry(
  val width: Double, val height: Double, val scale: Double,
  val offsetX: Double, val offsetY: Double, val scrollX: Double, val scrollY: Double,
  val nativeWidth: Int, val nativeHeight: Int, val pixelsPerCssUnit: Double, val keyboardHeight: Int
)

data class PhoneBrowserArtifact(
  val reference: String,
  val epoch: Int,
  val sessionId: String,
  val tabId: String,
  val generation: Int,
  val documentId: String,
  val geometryRevision: Long,
  val captureRevision: Long,
  val width: Int,
  val height: Int,
  val mimeType: String,
  val geometry: PhoneBrowserGeometry,
  val bytes: ByteArray,
  val channelId: String,
  val requestId: String?,
  val attachmentId: String?,
  val token: String?,
  val isCurrent: () -> Boolean
)

/** The sink sends bytes directly, and must revalidate the supplied epoch before delivery. */
interface PhoneBrowserSink { fun deliver(artifact: PhoneBrowserArtifact) }

object PhoneBrowserNative {
  @Volatile var fence: ((String) -> Int)? = null
    internal set
  @Volatile var currentEpoch: (() -> Int)? = null
    internal set
  @Volatile var qualificationEvidence: (() -> Map<String, Any?>)? = null
    internal set
  @Volatile var authority: PhoneBrowserAuthority? = null
  @Volatile var sink: PhoneBrowserSink? = null
  @Volatile internal var shareDownload: ((String) -> Unit)? = null
}
