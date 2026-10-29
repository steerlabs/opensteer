import ApplicationServices
import Darwin
import XCTest
@testable import ComputerUseCore

final class OwnerControlAcquisitionTests: XCTestCase {
  @MainActor
  func testInterleavedCatalogVerificationsCannotReplaceAHeldControlAndDisconnectReleasesIt() async throws {
    let runtime = HelperRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    var pair: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
    let connection = IPCConnection(id: 77, fileDescriptor: pair[0], onFrame: { _, _ in }, onClose: { _ in })
    defer { connection.close(); Darwin.close(pair[1]) }
    let id = "dcl_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    func candidate(_ app: String) async -> (MacOwnerInput.ControlParams, MacWindowVideoProducer) {
      let binding = await Task { @WorkActor in
        let target = CaptureTarget(observationId: app,
          app: AppIdentity(bundleId: app, displayName: app, teamId: nil),
          process: ProcessStamp.of(getpid())!, windowID: 1)
        return MacVideoBinding(OwnerViewWindow.Binding(target: target,
          element: AXUIElementCreateApplication(getpid())))
      }.value
      return (MacOwnerInput.ControlParams(streamId: app,
        source: MacVideoSource(kind: "owner-view", sessionId: nil, appKey: nil, viewId: app, generation: 1),
        controlId: id, action: "acquire", access: "read-write"),
        MacWindowVideoProducer(id: app, binding: binding, operations: SerialTaskChain(),
          authority: { true }, onState: { _ in }))
    }
    let a = await candidate("first.app"), b = await candidate("second.app")
    defer { a.1.stop(); b.1.stop() }
    var firstVerified: CheckedContinuation<Void, Never>?
    var secondVerified: CheckedContinuation<Void, Never>?
    let first = Task { @MainActor in
      XCTAssertNil(runtime.ownerControls[id])
      await withCheckedContinuation { firstVerified = $0 }
      return runtime.installOwnerControl(a.0, connection: connection,
        binding: a.1.binding, producer: a.1, path: "/First.app")
    }
    let second = Task { @MainActor in
      XCTAssertNil(runtime.ownerControls[id])
      await withCheckedContinuation { secondVerified = $0 }
      return runtime.installOwnerControl(b.0, connection: connection,
        binding: b.1.binding, producer: b.1, path: "/Second.app")
    }
    while firstVerified == nil || secondVerified == nil { await Task.yield() }
    firstVerified!.resume()
    let firstResult = await first.value
    let held = try XCTUnwrap(firstResult)
    try held.fence.hold(id, epoch: held.epoch)
    secondVerified!.resume()
    let duplicate = await second.value
    XCTAssertNil(duplicate, "The second verification must refuse the already-live control ID")
    XCTAssertTrue(runtime.ownerControls[id] === held, "Disconnect and expiry must still reach the first lease")
    runtime.connectionClosed(connection)
    for lease in [held, duplicate].compactMap({ $0 }) {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        lease.queue.enqueue { continuation.resume() }
      }
    }
    XCTAssertFalse(held.active.current)
    XCTAssertNil(runtime.ownerControls[id])
    do {
      let agent = try held.fence.beginAgent()
      held.fence.endAgent(agent)
    } catch { XCTFail("Disconnect stranded the original app fence: \(error)") }
    // Also leave the expected-red implementation's unreachable lease clean.
    if held.active.current { _ = held.fence.release(id); held.fence.finishRelease(id) }
  }
}
