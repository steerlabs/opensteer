import ApplicationServices
import Darwin
import XCTest
@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class OwnerInputAttachmentTests: XCTestCase {
  private func readResponse(_ descriptor: Int32) throws -> [String: Any] {
    var timeout = timeval(tv_sec: 1, tv_usec: 0)
    XCTAssertEqual(setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)), 0)
    var header = [UInt8](repeating: 0, count: 4)
    XCTAssertEqual(recv(descriptor, &header, 4, MSG_WAITALL), 4)
    let size = header.reduce(0) { ($0 << 8) | Int($1) }
    var body = [UInt8](repeating: 0, count: size)
    XCTAssertEqual(recv(descriptor, &body, size, MSG_WAITALL), size)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body)) as? [String: Any])
  }

  @MainActor
  func testLegacyDesktopOfferKeepsComputerUseWithoutOwnerInput() async throws {
    for offer in [nil, 1, 2] as [Int?] {
      let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
      defer { runtime.stop() }
      var pair: [Int32] = [0, 0]
      XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
      let connection = IPCConnection(id: 42, fileDescriptor: pair[0], onFrame: { _, _ in }, onClose: { _ in })
      defer { connection.close(); Darwin.close(pair[1]) }
      var params: [String: Any] = ["protocolVersion": 10, "ownerViewVersion": 3]
      if let offer { params["ownerInputVersion"] = offer }
      let frame = try JSONSerialization.data(withJSONObject: ["id": 0, "method": "hello", "params": params])
      await runtime.handle(connection: connection, frame: frame)
      let hello = try readResponse(pair[1])
      XCTAssertEqual((hello["result"] as? [String: Any])?["ownerInputVersion"] as? Int, offer == 2 ? 2 : nil)
      XCTAssertTrue(connection.isGreeted)
      XCTAssertFalse(connection.closedFlag)
      XCTAssertEqual(connection.negotiatedOwnerViewVersion, 3)
      XCTAssertEqual(connection.negotiatedOwnerInputVersion, offer == 2 ? 2 : nil)
      // Baseline computer-use requests remain readable on the same connection.
      await runtime.handle(connection: connection, frame: Data(#"{"id":1,"method":"permissions.get","params":{}}"#.utf8))
      let permissions = try readResponse(pair[1])
      XCTAssertNotNil((permissions["result"] as? [String: Any])?["permissions"])
      XCTAssertFalse(connection.closedFlag)
    }
  }

  @MainActor
  func testResetInvalidatesBatchesDuringFirstVerificationAndDrainsBeforeNextAttachment() async throws {
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    var pair: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
    let connection = IPCConnection(id: 77, fileDescriptor: pair[0], onFrame: { _, _ in }, onClose: { _ in })
    connection.markGreeted(protocolVersion: 10, ownerInputVersion: 2)
    defer { connection.close(); Darwin.close(pair[1]) }
    let binding = await Task { @WorkActor in
      MacVideoBinding(OwnerViewWindow.Binding(target: CaptureTarget(observationId: "fixture",
        app: AppIdentity(bundleId: "fixture", displayName: "Fixture", teamId: nil),
        process: ProcessStamp.of(getpid())!, windowID: 1), element: AXUIElementCreateApplication(getpid())))
    }.value
    let producer = MacWindowVideoProducer(id: "stream", binding: binding, operations: SerialTaskChain(),
      authority: { true }, onState: { _ in })
    defer { producer.stop() }
    let source = MacVideoSource(kind: "owner-view", sessionId: nil, appKey: nil, viewId: "view", generation: 1)
    let entered = expectation(description: "first batch verifying app")
    let verification = Locked<CheckedContinuation<String, Never>?>(nil)
    let attachment = try XCTUnwrap(runtime.installOwnerAttachment(streamID: "stream", source: source,
      connection: connection, binding: binding, producer: producer, path: "/Fixture.app", verification: {
        await withCheckedContinuation { continuation in
          verification.withLock { $0 = continuation }
          entered.fulfill()
        }
      }))
    func batch(_ sequence: Int) async throws -> MacOwnerInput.Result {
      let params = MacOwnerInput.InputParams(streamId: "stream", source: source, geometry: 1,
        sequence: sequence, events: [])
      let reservation = try attachment.admission.admit(sequence: sequence, bytes: 10)
      return await withCheckedContinuation { reply in
        if attachment.mailbox.append(.init(params: params, reservation: reservation,
          deadline: ProcessInfo.processInfo.systemUptime + 5, reply: reply)) {
          attachment.queue.enqueue { await attachment.worker.drain(attachment) }
        }
      }
    }
    let first = Task { try await batch(0) }
    await fulfillment(of: [entered], timeout: 1)
    attachment.mutations.setHeld(true, attachment: attachment.id)
    let second = Task { try await batch(1) }
    while attachment.admission.pendingBatches < 2 { await Task.yield() }
    let reset = Task { @MainActor in
      await runtime.handle(connection: connection, frame: Data(#"{"id":1,"method":"display.input-reset","params":{"streamId":"stream","source":{"kind":"owner-view","viewId":"view","generation":1}}}"#.utf8))
    }
    while attachment.active.current { await Task.yield() }
    XCTAssertEqual(attachment.admission.pendingBatches, 0)
    XCTAssertNil(runtime.installOwnerAttachment(streamID: "stream", source: source,
      connection: connection, binding: binding, producer: producer, path: "/Fixture.app"),
      "A new attachment must wait for physical cleanup")
    verification.current?.resume(returning: "/Fixture.app")
    await reset.value
    let a = try await first.value, b = try await second.value
    XCTAssertEqual(a.outcome, "refused"); XCTAssertEqual(a.reason, "unavailable")
    XCTAssertEqual(b.outcome, "refused"); XCTAssertEqual(b.reason, "unavailable")
    _ = try readResponse(pair[1])
    XCTAssertNil(runtime.ownerAttachments[attachment.id])
    try await attachment.mutations.beginAgent()
    attachment.mutations.endAgent()
    let next = try XCTUnwrap(runtime.installOwnerAttachment(streamID: "stream", source: source,
      connection: connection, binding: binding, producer: producer, path: "/Fixture.app"))
    XCTAssertFalse(next === attachment)
    runtime.connectionClosed(connection)
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in next.queue.enqueue { done.resume() } }
  }

  @MainActor
  func testInterleavedVerificationKeepsOneAttachmentAndDisconnectDrainsCleanup() async throws {
    let runtime = HelperRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    var pair: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
    let connection = IPCConnection(id: 77, fileDescriptor: pair[0], onFrame: { _, _ in }, onClose: { _ in })
    defer { connection.close(); Darwin.close(pair[1]) }
    let id = "first.app:first.app:l1"
    func candidate(_ app: String) async -> (MacOwnerInput.ResetParams, MacWindowVideoProducer) {
      let binding = await Task { @WorkActor in
        let target = CaptureTarget(observationId: app,
          app: AppIdentity(bundleId: app, displayName: app, teamId: nil),
          process: ProcessStamp.of(getpid())!, windowID: 1)
        return MacVideoBinding(OwnerViewWindow.Binding(target: target,
          element: AXUIElementCreateApplication(getpid())))
      }.value
      return (MacOwnerInput.ResetParams(streamId: app,
        source: MacVideoSource(kind: "owner-view", sessionId: nil, appKey: nil, viewId: app, generation: 1)),
        MacWindowVideoProducer(id: app, binding: binding, operations: SerialTaskChain(),
          authority: { true }, onState: { _ in }))
    }
    let a = await candidate("first.app"), b = await candidate("first.app")
    defer { a.1.stop(); b.1.stop() }
    var firstVerified: CheckedContinuation<Void, Never>?
    var secondVerified: CheckedContinuation<Void, Never>?
    let first = Task { @MainActor in
      XCTAssertNil(runtime.ownerAttachments[id])
      await withCheckedContinuation { firstVerified = $0 }
      return runtime.installOwnerAttachment(streamID: a.0.streamId, source: a.0.source, connection: connection,
        binding: a.1.binding, producer: a.1, path: "/First.app")
    }
    let second = Task { @MainActor in
      XCTAssertNil(runtime.ownerAttachments[id])
      await withCheckedContinuation { secondVerified = $0 }
      return runtime.installOwnerAttachment(streamID: b.0.streamId, source: b.0.source, connection: connection,
        binding: b.1.binding, producer: b.1, path: "/Second.app")
    }
    while firstVerified == nil || secondVerified == nil { await Task.yield() }
    firstVerified!.resume()
    let firstResult = await first.value
    let held = try XCTUnwrap(firstResult)
    secondVerified!.resume()
    let duplicate = await second.value
    XCTAssertNil(duplicate, "The second verification must refuse the already-live stream/source attachment")
    XCTAssertTrue(runtime.ownerAttachments[id] === held, "Disconnect and expiry must still reach the first attachment")
    runtime.connectionClosed(connection)
    for lease in [held, duplicate].compactMap({ $0 }) {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        lease.queue.enqueue { continuation.resume() }
      }
    }
    XCTAssertFalse(held.active.current)
    XCTAssertNil(runtime.ownerAttachments[id])
    do {
      try await held.mutations.beginAgent()
      held.mutations.endAgent()
    } catch { XCTFail("Disconnect stranded the app mutation lane: \(error)") }
  }
}
