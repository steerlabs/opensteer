package com.opensteer.phonebrowser

import com.opensteer.phoneconnection.BrowserTransport
import com.opensteer.phoneconnection.core.*
import kotlinx.serialization.json.*
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.util.encoders.Base64
import java.io.File
import java.util.concurrent.Executor

class NativeJoinTest {
  @Test fun queuedMutationsAndStagingRecheckRevocationAndLastPermitDisablesWithoutJavascript() {
    val fixture = Fixture(); fixture.admit(); fixture.agent()
    var debugging = true
    val permits = CdpPermits { debugging = false }
    permits.grant("attachment", 0, fixture.channel)
    fixture.client(Wire.fields("type" to JsonPrimitive("agent.attach"), "attachmentId" to JsonPrimitive("last"), "actorToken" to JsonPrimitive("actor"), "sessionId" to JsonPrimitive(fixture.session), "backend" to JsonPrimitive("cdp")))
    permits.grant("last", 0, fixture.channel)
    fixture.onDetach = { _, id -> permits.remove(id) }
    var mutations = 0
    var staged = 0
    fixture.queue.add(Runnable { assertThrows(BrowserFailure::class.java) { fixture.service.withAttachment(0, "last", fixture.session) { mutations++ } } })
    fixture.queue.add(Runnable { assertThrows(BrowserFailure::class.java) { fixture.service.withAttachment(0, "last", fixture.session) { staged++ } } })
    fixture.writer.detachAgent(0, "attachment")
    assertTrue(debugging)
    fixture.writer.detachAgent(0, "last")
    assertFalse("Debugging shutdown must not wait for the JS detach handler", debugging)
    fixture.drain()
    assertEquals(0, mutations)
    assertEquals(0, staged)
  }
  @Test fun sameRunAttachmentsUseExactIdentityAndRetireOnlyTheirOwnAuthority() {
    val fixture = Fixture(); fixture.admit(); fixture.agent()
    fixture.client(Wire.fields("type" to JsonPrimitive("agent.attach"), "attachmentId" to JsonPrimitive("second"), "actorToken" to JsonPrimitive("actor"), "sessionId" to JsonPrimitive(fixture.session), "backend" to JsonPrimitive("cdp")))
    assertEquals("attachment", fixture.service.requireCdp(0, fixture.channel, "actor", "attachment").attachmentId)
    assertEquals("second", fixture.service.requireCdp(0, fixture.channel, "actor", "second").attachmentId)
    assertThrows(BrowserFailure::class.java) { fixture.service.requireCdp(0, fixture.channel, "wrong-actor", "second") }
    fixture.writer.detachAgent(0, "attachment")
    assertThrows(BrowserFailure::class.java) { fixture.service.requireCdp(0, fixture.channel, "actor", "attachment") }
    assertEquals("second", fixture.service.requireCdp(0, fixture.channel, "actor", "second").attachmentId)
    fixture.writer.detachAgent(0, "second")
    fixture.agent()
    assertEquals("attachment", fixture.service.requireCdp(0, fixture.channel, "actor", "attachment").attachmentId)
  }
  private class Memory : DurableBytes {
    private var bytes: ByteArray? = null
    override fun read() = bytes
    override fun write(bytes: ByteArray) { this.bytes = bytes }
  }
  private class Socket : WebSocket {
    val text = mutableListOf<String>()
    val binary = mutableListOf<ByteArray>()
    override fun request() = Request.Builder().url("https://fixture.invalid").build()
    override fun queueSize() = 0L
    override fun send(text: String): Boolean { this.text.add(text); return true }
    override fun send(bytes: ByteString): Boolean { binary.add(bytes.toByteArray()); return true }
    override fun close(code: Int, reason: String?) = true
    override fun cancel() { }
  }
  private class Fixture {
    fun vector(name: String) = Wire.parse(File(System.getProperty("phone.vectors"), "$name.v1.json").readText(), 100000)
    val fences = vector("fences")
    val tickets = vector("attach-tickets")
    val gate = EpochGate()
    var now = fences.number("now")
    val admission = Admission({ now }).apply { active = true }
    val queue = mutableListOf<Runnable>()
    val socket = Socket()
    val events = mutableListOf<JsonObject>()
    var onDetach: (Int, String) -> Unit = { _, _ -> }
    val writer = BrowserTransport(admission, AttachTickets("phone", ReplayLedger(Memory()).apply { initialize() }) { now },
      Executor { queue.add(it) }, { events.add(it) }, gate::adopt, detachBrowser = { epoch, id -> onDetach(epoch, id) })
    var connected = true
    var page = true
    var tick = 0
    val bindings = mutableMapOf<String, Map<String, Any>>()
    val service = PhoneBrowserServices(gate, { if (connected) writer else throw Refused("not-prepared") }, { bindings[it] ?: throw BrowserFailure("forbidden") },
      { page && it.isCurrent() }, { tick++ })
    val capability = Wire.parse("""{"runtimeId":"phone","capabilityGeneration":1,"capabilityLeaseId":"bcl_11111111-1111-4111-8111-111111111111"}""")
    val channel = "bch_11111111-1111-4111-8111-111111111111"
    val session = "bsn_11111111-1111-4111-8111-111111111111"
    lateinit var permit: String
    fun relay(type: String, fields: JsonObject = JsonObject(emptyMap())) = JsonObject(fences.obj("fence") + fields + ("type" to JsonPrimitive(type)))
    fun client(message: JsonObject) = writer.receive(relay("browser.client-message", Wire.fields("channelId" to JsonPrimitive(channel), "capability" to capability, "message" to message)))
    fun agent() = client(Wire.fields("type" to JsonPrimitive("agent.attach"), "attachmentId" to JsonPrimitive("attachment"), "actorToken" to JsonPrimitive("actor"), "sessionId" to JsonPrimitive(session), "backend" to JsonPrimitive("cdp")))
    fun captureRequest() = client(Wire.fields("type" to JsonPrimitive("cdp.command"), "requestId" to JsonPrimitive("capture"), "actorToken" to JsonPrimitive("actor"), "attachmentId" to JsonPrimitive("attachment"),
      "command" to Wire.fields("method" to JsonPrimitive("Page.captureScreenshot"))))
    fun signed(customClaims: JsonObject): Pair<JsonElement, JsonElement> {
      val key = Ed25519PrivateKeyParameters(ByteArray(32) { 7 }, 0)
      val der = byteArrayOf(0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00) + key.generatePublicKey().encoded
      val pem = JsonPrimitive("-----BEGIN PUBLIC KEY-----\n" + Base64.toBase64String(der) + "\n-----END PUBLIC KEY-----")
      val header = Wire.fields("alg" to JsonPrimitive("EdDSA"), "typ" to JsonPrimitive("opensteer-browser-attach+jwt"), "kid" to JsonPrimitive("fixture"))
      val body = Wire.encode64(Wire.canonical(header).toByteArray()) + "." + Wire.encode64(Wire.canonical(customClaims).toByteArray())
      val signer = Ed25519Signer().apply { init(true, key); val bytes = body.toByteArray(); update(bytes, 0, bytes.size) }
      return pem to JsonPrimitive(body + "." + Wire.encode64(signer.generateSignature()))
    }
    fun operation(customClaims: JsonObject): String {
      val token = signed(customClaims).second
      client(Wire.fields("type" to JsonPrimitive("cdp.command"), "requestId" to JsonPrimitive("open"), "command" to Wire.fields("method" to JsonPrimitive("Opensteer.openTab"),
        "parameters" to Wire.fields("operationAuthority" to token))))
      val handle = events.last().text("authorityHandle")
      val verified = writer.verifyAttach(gate.epoch, handle)
      return writer.commitAttach(gate.epoch, handle, verified.text("claimsDigest"), ReplayState.parse(verified.obj("replayState"), 4096)
        .claim(customClaims.text("nonce"), customClaims.time("expiresAt"), now, 4096).json())
    }
    fun admit(customClaims: JsonObject? = null, deadline: String = "2026-11-09T12:00:01.000Z") {
      val (pem, token) = customClaims?.let(::signed) ?: (tickets.getValue("publicKeyPem") to tickets.getValue("cases").jsonArray.first().jsonObject.getValue("token"))
      writer.online(socket, JsonObject(fences.obj("welcome") + mapOf("streamLeaseExpiresAt" to JsonPrimitive(deadline), "browserWireVersion" to JsonPrimitive(1), "browserAttachPublicKeys" to JsonArray(listOf(
        Wire.fields("keyId" to JsonPrimitive("fixture"), "publicKeyPem" to pem))))))
      writer.receive(relay("capability.grant", Wire.fields("requestId" to JsonPrimitive("grant"), "lease" to JsonObject(capability + ("expiresAt" to JsonPrimitive(deadline))))))
      writer.send(gate.epoch, relay("capability.accepted", Wire.fields("requestId" to JsonPrimitive("grant"), "capability" to capability)))
      writer.receive(relay("browser.attach", Wire.fields("channelId" to JsonPrimitive(channel), "capability" to capability, "requestId" to JsonPrimitive("attach"),
        "attachTicket" to token)))
      val handle = events.last().obj("message").text("attachHandle")
      val verified = writer.verifyAttach(gate.epoch, handle)
      val claims = verified.obj("claims")
      permit = writer.commitAttach(gate.epoch, handle, verified.text("claimsDigest"), ReplayState.parse(verified.obj("replayState"), 4096)
        .claim(claims.text("nonce"), claims.time("expiresAt"), fences.number("now"), 4096).json())
    }
    fun artifact(capture: Boolean = false) = PhoneBrowserArtifact("reference", gate.epoch, session, "tab", 1, "document", 2, 3, 100, 200, "image/png",
      PhoneBrowserGeometry(100.0, 200.0, 1.0, 0.0, 0.0, 0.0, 0.0, 200, 400, 2.0, 0), byteArrayOf(3, 4, 5), channel,
      if (capture) "capture" else null, if (capture) "attachment" else null, if (capture) null else "11111111-1111-4111-8111-111111111111", { page })
    fun drain() { val work = queue.toList(); queue.clear(); work.forEach(Runnable::run) }
    fun claims() = Wire.parse(Wire.decode(Wire.decode64(tickets.getValue("cases").jsonArray.first().jsonObject.text("token", max = 16384).split('.')[1])))
  }
  @Test fun joinRequiresAnAdmittedConnectionAndExactAllocationAndAgentAuthority() {
    val fixture = Fixture()
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAllocation(0, "invented", fixture.session, null) }
    fixture.admit()
    fixture.service.requireAllocation(0, fixture.permit, fixture.session, null)
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAllocation(0, fixture.permit, "wrong-session", null) }
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAllocation(0, fixture.permit, fixture.session, "wrong-profile") }
    assertThrows(BrowserFailure::class.java) { fixture.service.requireCdp(0, fixture.channel, "actor", "attachment") }
    fixture.agent()
    assertEquals("attachment", fixture.service.requireCdp(0, fixture.channel, "actor", "attachment").attachmentId)
    assertThrows(BrowserFailure::class.java) { fixture.service.requireCdp(0, fixture.channel, "other", "attachment") }
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAttachment(0, "attachment", "other", "tab") }
    assertThrows(BrowserFailure::class.java) { fixture.service.viewerActor(0, fixture.channel, "other") }
    fixture.client(Wire.fields("type" to JsonPrimitive("agent.detach"), "attachmentId" to JsonPrimitive("attachment")))
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAttachment(0, "attachment", fixture.session, "tab") }
    fixture.connected = false
    assertThrows(BrowserFailure::class.java) { fixture.service.requireViewer(0, fixture.channel, fixture.session) }
  }
  @Test fun framesReachOnlyTheNativeWriterWithTheOriginalCreditAndGeometry() {
    val fixture = Fixture(); fixture.admit()
    val artifact = fixture.artifact()
    fixture.service.deliver(artifact)
    fixture.drain()
    val (relay, bytes) = FrameCodec.decodeRelay(fixture.socket.binary.single())
    val (header, pixels) = FrameCodec.split(bytes)
    assertEquals(fixture.channel, relay.text("channelId"))
    assertFalse(header.containsKey("watchToken"))
    assertEquals(artifact.tabId, header.text("surfaceId"))
    assertEquals(artifact.geometryRevision, header.number("geometryRevision"))
    assertEquals(artifact.captureRevision, header.obj("capture").number("revision"))
    assertEquals(100L, header.number("viewportWidth"))
    assertEquals(200L, header.number("viewportHeight"))
    assertArrayEquals(artifact.bytes, pixels)
    assertFalse(fixture.events.any { it.toString().contains("reference") })
    assertEquals(1, fixture.tick)
  }
  @Test fun localProfileAllocationUsesTheExactSignedBindingAndInitializationFlag() {
    val fixture = Fixture()
    val binding = mapOf("version" to 1, "engine" to "android-webview", "deploymentId" to "dep_11111111-1111-4111-8111-111111111111",
      "runnerId" to "rnr_11111111-1111-4111-8111-111111111111", "profileId" to "bpr_11111111-1111-4111-8111-111111111111",
      "storageInstanceId" to "11111111-1111-4111-8111-111111111111", "bindingId" to "11111111-1111-4111-8111-111111111111")
    fixture.bindings["store"] = binding
    fixture.admit(JsonObject(fixture.claims() + ("identity" to nativeJson(mapOf("kind" to "profile-local", "binding" to binding, "initialized" to true, "readyUrl" to "https://fixture.invalid")))))
    fixture.service.requireAllocation(0, fixture.permit, null, null, binding, true)
    fixture.service.requireAllocation(0, fixture.permit, fixture.session, "store")
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAllocation(0, fixture.permit, null, null, binding, false) }
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAllocation(0, fixture.permit, fixture.session, null) }
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAllocation(0, fixture.permit, null, null, binding + ("runnerId" to "other"), true) }
  }
  @Test fun openingTicketsKeepChannelAuthorityAndCannotReplaceProfileBindings() {
    val fixture = Fixture()
    val binding = nativeJson(mapOf("version" to 1, "engine" to "android-webview", "deploymentId" to "dep_11111111-1111-4111-8111-111111111111",
      "runnerId" to "rnr_11111111-1111-4111-8111-111111111111", "profileId" to "bpr_11111111-1111-4111-8111-111111111111",
      "storageInstanceId" to "11111111-1111-4111-8111-111111111111", "bindingId" to "11111111-1111-4111-8111-111111111111")) as JsonObject
    val identity = Wire.fields("kind" to JsonPrimitive("profile-local"), "binding" to binding, "initialized" to JsonPrimitive(false), "readyUrl" to JsonPrimitive("https://fixture.invalid/initial"))
    fixture.admit(JsonObject(fixture.claims() + ("identity" to identity)), "2026-11-09T12:02:00.000Z")
    fixture.now += 21000
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAllocation(0, fixture.permit, fixture.session, "store") }
    val currentIdentity = JsonObject(identity + mapOf("initialized" to JsonPrimitive(true), "readyUrl" to JsonPrimitive("https://fixture.invalid/current")))
    val operation = JsonObject(fixture.claims() + mapOf("nonce" to JsonPrimitive("operation-nonce-1111111111111111"), "identity" to currentIdentity,
      "issuedAt" to JsonPrimitive("2026-11-09T12:00:21.000Z"), "expiresAt" to JsonPrimitive("2026-11-09T12:01:21.000Z"),
      "operationExpiresAt" to JsonPrimitive("2026-11-09T12:00:39.000Z"), "remainingBudgetMs" to JsonPrimitive(18000)))
    val permit = fixture.operation(operation)
    fixture.service.requireAllocation(0, permit, fixture.session, null, binding.mapValues { it.value.jsonPrimitive.let { value -> value.intOrNull ?: value.content } }, true)
    val fresh = fixture.operation(JsonObject(operation + mapOf("nonce" to JsonPrimitive("fresh-operation-nonce-1111111111111111"), "identity" to Wire.fields("kind" to JsonPrimitive("fresh")))))
    fixture.service.requireAllocation(0, fresh, fixture.session, null, binding.mapValues { it.value.jsonPrimitive.let { value -> value.intOrNull ?: value.content } })
    assertEquals(identity, fixture.writer.allocationClaims(0, fresh, fixture.session).obj("identity"))
    for ((index, changed) in listOf(
      operation + ("subject" to JsonPrimitive("another-subject")),
      operation + ("access" to JsonPrimitive("read")),
      operation + ("sessionId" to JsonPrimitive("bsn_22222222-2222-4222-8222-222222222222")),
      operation + ("identity" to JsonObject(currentIdentity + ("binding" to JsonObject(binding + ("profileId" to JsonPrimitive("bpr_22222222-2222-4222-8222-222222222222"))))))
    ).withIndex()) {
      assertThrows(Refused::class.java) { fixture.operation(JsonObject(changed + ("nonce" to JsonPrimitive("refused-operation-nonce-$index-1111111111111111")))) }
    }
    fixture.now += 19000
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAllocation(0, fresh, fixture.session, null, binding.mapValues { it.value.jsonPrimitive.content }) }
    fixture.agent()
    fixture.service.requireAllocation(0, "cdp:attachment", fixture.session, null, binding.mapValues { it.value.jsonPrimitive.let { value -> value.intOrNull ?: value.content } })
    fixture.writer.detachAgent(0, "attachment")
    assertThrows(BrowserFailure::class.java) { fixture.service.requireAllocation(0, "cdp:attachment", fixture.session, null, binding.mapValues { it.value.jsonPrimitive.content }) }
  }
  @Test fun readOnlyWatchersNeverBecomeControllersOrAgents() {
    val fixture = Fixture()
    fixture.admit(JsonObject(fixture.claims() + ("access" to JsonPrimitive("read"))))
    fixture.service.requireViewer(0, fixture.channel, fixture.session)
    assertThrows(BrowserFailure::class.java) { fixture.service.requireViewer(0, fixture.channel, fixture.session, true) }
    assertThrows(Refused::class.java) { fixture.agent() }
    assertThrows(BrowserFailure::class.java) { fixture.service.requireCdp(0, fixture.channel, "actor", "attachment") }
  }
  @Test fun queuedFramesAreDroppedOnPageLossAndOfflineKeepsOneEpoch() {
    for (offline in listOf(false, true)) {
      val fixture = Fixture(); fixture.admit()
      fixture.service.deliver(fixture.artifact())
      if (offline) {
        fixture.writer.offline("inactive")
        assertEquals(fixture.admission.epoch, fixture.gate.epoch)
        assertFalse(fixture.service.frameWritable(fixture.gate.epoch, fixture.channel))
      } else fixture.page = false
      fixture.drain()
      assertTrue(fixture.socket.binary.isEmpty())
      assertEquals(1, fixture.tick)
    }
  }
  @Test fun queuedPixelsAndCapturesLoseAuthorityOnFencingOrPageLoss() {
    for (loss in listOf("fence", "page", "detach")) {
      val fixture = Fixture(); fixture.admit(); fixture.agent(); fixture.captureRequest()
      val artifact = fixture.artifact(true)
      fixture.service.deliver(artifact)
      when (loss) {
        "fence" -> fixture.writer.fence()
        "page" -> fixture.page = false
        else -> fixture.client(Wire.fields("type" to JsonPrimitive("agent.detach"), "attachmentId" to JsonPrimitive("attachment")))
      }
      fixture.drain()
      assertFalse(fixture.socket.text.any { it.contains("cdp.result") })
      if (loss == "fence") assertThrows(BrowserFailure::class.java) { fixture.service.deliver(artifact) }
    }
  }
  @Test fun screenshotIdentityIsOneShotAndNeverGoesThroughAnEvent() {
    val fixture = Fixture(); fixture.admit(); fixture.agent(); fixture.captureRequest()
    val artifact = fixture.artifact(true)
    assertThrows(BrowserFailure::class.java) { fixture.service.deliver(artifact.copy(attachmentId = "wrong")) }
    fixture.service.deliver(artifact)
    fixture.service.deliver(artifact)
    fixture.drain()
    val responses = fixture.socket.text.map(Wire::parse).filter { it["type"] == JsonPrimitive("browser.server-message") }
    assertEquals(1, responses.size)
    val message = responses.single().obj("message")
    assertEquals("capture", message.text("requestId"))
    assertEquals("AwQF", message.obj("result").text("data"))
    assertFalse(fixture.events.any { it.toString().contains("AwQF") })
  }
}
