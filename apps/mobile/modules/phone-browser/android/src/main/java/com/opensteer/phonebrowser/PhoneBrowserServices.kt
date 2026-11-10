package com.opensteer.phonebrowser

import com.opensteer.phoneconnection.BrowserTransport
import com.opensteer.phoneconnection.core.Refused
import com.opensteer.phoneconnection.core.text
import kotlinx.serialization.json.*

internal class PhoneBrowserServices(
  private val gate: EpochGate,
  private val transport: () -> BrowserTransport,
  private val binding: (String) -> Map<String, Any>,
  private val current: (PhoneBrowserArtifact) -> Boolean,
  private val rejectedFrame: (PhoneBrowserArtifact) -> Unit
) : PhoneBrowserAuthority, PhoneBrowserSink {
  private fun <Result> admitted(epoch: Int, action: (BrowserTransport) -> Result): Result {
    gate.check(epoch)
    return try { action(transport()).also { gate.check(epoch) } }
    catch (_: Refused) { throw BrowserFailure("forbidden") }
  }
  override fun requireAllocation(epoch: Int, permit: String, sessionId: String?, storeHandle: String?, binding: Map<String, Any>?, initialized: Boolean?) = admitted(epoch) { writer ->
    val claims = writer.allocationPermit(epoch, permit).claims
    if (sessionId != null && claims.text("sessionId") != sessionId) throw BrowserFailure("forbidden")
    val identity = claims["identity"] as? JsonObject ?: throw BrowserFailure("forbidden")
    val expected = binding ?: storeHandle?.let(this.binding)
    if (expected != null) {
      if (identity["kind"] != JsonPrimitive("profile-local") || identity["binding"] != nativeJson(expected)) throw BrowserFailure("forbidden")
      if (initialized != null && identity["initialized"] != JsonPrimitive(initialized)) throw BrowserFailure("forbidden")
    } else if (identity["kind"] != JsonPrimitive("fresh")) throw BrowserFailure("forbidden")
  }
  override fun requireCdp(epoch: Int, channelId: String, actorToken: String): PhoneBrowserCdpGrant = admitted(epoch) { writer ->
    val agent = writer.requireAgent(epoch, channelId, actorToken)
    PhoneBrowserCdpGrant(agent.attachmentId, agent.sessionId)
  }
  override fun viewerActor(epoch: Int, channelId: String, sessionId: String): String? = admitted(epoch) {
    it.viewer(epoch, channelId, sessionId, true); null
  }
  override fun requireViewer(epoch: Int, channelId: String, sessionId: String, control: Boolean) = admitted(epoch) {
    it.viewer(epoch, channelId, sessionId, control); Unit
  }
  override fun requireAttachment(epoch: Int, attachmentId: String, sessionId: String, tabId: String) = admitted(epoch) {
    it.requireAttachment(epoch, attachmentId, sessionId); Unit
  }
  override fun acknowledge(epoch: Int, channelId: String, token: String) = admitted(epoch) { it.ack(epoch, channelId, token) }
  override fun deliver(artifact: PhoneBrowserArtifact) = admitted(artifact.epoch) { writer ->
    if (!current(artifact)) throw BrowserFailure("stale-document")
    val completed: (Boolean) -> Unit = { accepted -> if (!accepted && artifact.token != null) rejectedFrame(artifact) }
    if (artifact.requestId != null) {
      val attachment = artifact.attachmentId ?: throw BrowserFailure("forbidden")
      writer.requireAttachment(artifact.epoch, attachment, artifact.sessionId, artifact.channelId)
      writer.capture(artifact.epoch, artifact.channelId, artifact.requestId, artifact.bytes, attachment, { current(artifact) }, completed)
    } else {
      writer.viewer(artifact.epoch, artifact.channelId, artifact.sessionId, false)
      val geometry = artifact.geometry
      val header = nativeJson(mapOf("surfaceId" to artifact.tabId, "frameId" to artifact.captureRevision,
        "geometryRevision" to artifact.geometryRevision, "rasterWidth" to artifact.width, "rasterHeight" to artifact.height,
        "viewportWidth" to geometry.width, "viewportHeight" to geometry.height,
        "capture" to mapOf("revision" to artifact.captureRevision, "width" to geometry.width, "height" to geometry.height),
        "encoding" to artifact.mimeType.removePrefix("image/"), "watchToken" to (artifact.token ?: throw BrowserFailure("forbidden")))) as JsonObject
      writer.frame(artifact.epoch, artifact.channelId, header, artifact.bytes, { current(artifact) }, completed)
    }
  }
}

internal fun nativeJson(value: Any?): JsonElement = when (value) {
  null -> JsonNull
  is String -> JsonPrimitive(value)
  is Boolean -> JsonPrimitive(value)
  is Number -> JsonPrimitive(value)
  is Map<*, *> -> JsonObject(value.entries.associate { (key, item) -> (key as String) to nativeJson(item) })
  is List<*> -> JsonArray(value.map(::nativeJson))
  else -> throw BrowserFailure("forbidden")
}
