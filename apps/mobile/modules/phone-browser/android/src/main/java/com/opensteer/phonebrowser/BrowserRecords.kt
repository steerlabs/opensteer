package com.opensteer.phonebrowser

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// Expo's Int converter truncates doubles, so authority counters arrive as doubles and are checked first.
open class EpochRecord : Record {
  @Field(key = "epoch") var encodedEpoch = -1.0
  var epoch: Int get() = NativeIntegers.parse(encodedEpoch, Int.MAX_VALUE.toLong()).toInt()
    set(value) { encodedEpoch = value.toDouble() }
}
open class TabRef : EpochRecord() {
  @Field var sessionId: String = ""
  @Field var tabId: String = ""
  @Field(key = "generation") var encodedGeneration = -1.0
  var generation: Int get() = NativeIntegers.parse(encodedGeneration, Int.MAX_VALUE.toLong()).toInt()
    set(value) { encodedGeneration = value.toDouble() }
}
open class DocumentRef : TabRef() {
  @Field var documentId: String = ""
  @Field(key = "geometryRevision") var encodedGeometryRevision = -1.0
  var geometryRevision: Long get() = NativeIntegers.parse(encodedGeometryRevision)
    set(value) { encodedGeometryRevision = value.toDouble() }
}
class InitializeRecord : EpochRecord() { @Field var deploymentId = ""; @Field var runnerId = "" }
class ForegroundRecord : EpochRecord() { @Field var active = false }
class AgentRecord : EpochRecord() { @Field var channelId = ""; @Field var sessionId = ""; @Field var attachmentId = ""; @Field var actorToken = ""; @Field var backend = "" }
class DetachAgentRecord : EpochRecord() { @Field var attachmentId = "" }
class BindingRecord : Record {
  @Field var version = 0
  @Field var deploymentId = ""
  @Field var profileId = ""
  @Field var runnerId = ""
  @Field var storageInstanceId = ""
  @Field var bindingId = ""
  @Field var engine = ""
  internal fun binding(): ProfileBinding {
    if (version != 1 || engine != "android-webview" || listOf(deploymentId, profileId, runnerId, storageInstanceId, bindingId).any { it.isBlank() || it.length > 256 }) throw BrowserFailure("forbidden")
    return ProfileBinding(deploymentId, runnerId, storageInstanceId, profileId, bindingId)
  }
}
class ProfileRecord : EpochRecord() {
  @Field var binding = BindingRecord()
  @Field var initialized = false
  @Field var allocationPermit = ""
  @Field var deletionId = ""
}
class DeploymentRecord : EpochRecord() { @Field var deploymentId = "" }
class ViewportRecord : Record { @Field var width = 0; @Field var height = 0 }
class RestoreRecord : Record {
  @Field var sessionId = ""
  @Field(key = "generation") var encodedGeneration = -1.0
  val generation: Int get() = NativeIntegers.parse(encodedGeneration, Int.MAX_VALUE.toLong()).toInt()
}
class CreateTabRecord : EpochRecord() {
  @Field var sessionId = ""
  @Field var tabId = ""
  @Field var allocationPermit = ""
  @Field var storeHandle: String? = null
  @Field var state = "live"
  @Field var viewport = ViewportRecord()
  @Field var url: String? = null
  @Field var navigationId: String? = null
  @Field var restoreFrom: RestoreRecord? = null
}
class SuspendRecord : TabRef() { @Field var state = "retained" }
class MountRecord : TabRef() {
  @Field var hostId = ""
  @Field var presentationGeneration = -1
  @Field var interactive = true
}
class UnmountRecord : TabRef() { @Field var presentationGeneration = -1 }
class ResizeRecord : DocumentRef() { @Field var width = 0; @Field var height = 0 }
class NavigateRecord : DocumentRef() {
  @Field var kind = ""
  @Field var url: String? = null
  @Field var ignoreCache = false
  @Field var navigationId: String? = null
}
class DialogRecord : DocumentRef() { @Field var dialogId = ""; @Field var accept = false; @Field var promptText: String? = null }
class UploadRecord : DocumentRef() { @Field var chooserId = ""; @Field var stagedFileIds: List<String> = emptyList() }
class ViewerRecord : DocumentRef() { @Field var channelId = ""; @Field var message: Map<String, Any?> = emptyMap() }
class DemandRecord : TabRef() {
  @Field var channelId = ""
  @Field var density = 1.0
  @Field var frames = false
  @Field var frameWindow: Int? = null
  @Field var maxFps = 8
}
class AckRecord : TabRef() { @Field var channelId = ""; @Field var token = "" }
class ClipRecord : Record { @Field var x = 0.0; @Field var y = 0.0; @Field var width = 0.0; @Field var height = 0.0 }
class CaptureRecord : DocumentRef() {
  @Field var channelId = ""
  @Field var requestId = ""
  @Field var attachmentId = ""
  @Field var format = "jpeg"
  @Field var quality: Double? = null
  @Field var clip: ClipRecord? = null
}
class AuthorizeRecord : EpochRecord() { @Field var channelId = ""; @Field var actorToken = ""; @Field var attachmentId = "" }
class OpenPipeRecord : DocumentRef() { @Field var attachmentId = "" }
class SendCdpRecord : DocumentRef() {
  @Field var pipeHandle = ""
  @Field var id = 0
  @Field var method = ""
  @Field var params: Map<String, Any?> = emptyMap()
}
class ClosePipeRecord : EpochRecord() { @Field var pipeHandle = "" }
class ReleaseCdpRecord : EpochRecord() { @Field var attachmentId = "" }
class StageRecord : EpochRecord() {
  @Field var attachmentId = ""
  @Field var sessionId = ""
  @Field var fileId = ""
  @Field var name = ""
  @Field var offset = 0L
  @Field var data = ""
  @Field var size: Long? = null
}
class SessionFilesRecord : EpochRecord() { @Field var sessionId = "" }
class CancelDownloadRecord : EpochRecord() { @Field var sessionId = ""; @Field var downloadId = "" }
