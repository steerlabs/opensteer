import Darwin
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// The desktop quitting asks the helper to go too (`helper.exit`). The helper
/// ends that connection exactly as if it had dropped, and exits once nothing
/// else on this Mac uses it: another Opensteer app sharing the helper keeps it.
final class HelperExitTests: XCTestCase {
  private struct Peer {
    let connection: IPCConnection
    let remote: Int32
  }

  /// One desktop's socket; `process` stands for the app on the other end.
  private func peer(_ id: Int, process: pid_t = 1_000) -> Peer {
    var pair: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair), 0)
    let connection = IPCConnection(
      id: id, fileDescriptor: pair[0], onFrame: { _, _ in }, onClose: { _ in },
      peerProcessIdentifier: process)
    connection.markGreeted(protocolVersion: 11)
    return Peer(connection: connection, remote: pair[1])
  }

  private func close(_ peer: Peer) {
    peer.connection.close()
    Darwin.close(peer.remote)
  }

  /// Every frame waiting on the desktop's end, without blocking for more.
  private func frames(_ descriptor: Int32) throws -> [[String: Any]] {
    var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
    XCTAssertEqual(
      setsockopt(
        descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)), 0)
    var read: [[String: Any]] = []
    while true {
      var header = [UInt8](repeating: 0, count: 4)
      guard recv(descriptor, &header, 4, MSG_WAITALL) == 4 else { return read }
      let size = header.reduce(0) { ($0 << 8) | Int($1) }
      var body = [UInt8](repeating: 0, count: size)
      XCTAssertEqual(recv(descriptor, &body, size, MSG_WAITALL), size)
      read.append(try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body)) as? [String: Any]))
    }
  }

  private static let exitFrame = Data(#"{"id":7,"method":"helper.exit","params":{}}"#.utf8)

  /// Lets the answer go out and the serial lane drain, which is when an exit runs.
  @MainActor
  private func settle(_ runtime: HelperRuntime) async {
    for _ in 0..<3 {
      await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        runtime.executor.enqueue { done.resume() }
      }
      await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        DispatchQueue.main.async { done.resume() }
      }
    }
  }

  @MainActor
  func testAskedToExitWithNoSessionAnswersThenExits() async throws {
    var exits = 0
    let runtime = hostRuntime(
      helperVersion: "test", peerRequirement: .sameUser, terminate: { exits += 1 })
    defer { runtime.stop() }
    let desktop = peer(1)
    defer { close(desktop) }

    await runtime.handle(connection: desktop.connection, frame: Self.exitFrame)
    await settle(runtime)

    let answers = try frames(desktop.remote)
    XCTAssertEqual(answers.count, 1)
    XCTAssertEqual(answers.first?["id"] as? Int, 7)
    XCTAssertEqual((answers.first?["result"] as? [String: Any])?["exiting"] as? Bool, true)
    XCTAssertEqual(exits, 1)
  }

  /// The session ends as it would had the connection dropped: cancelled as
  /// `closed`, never as the person's Stop, and with no `session.stopped`
  /// event, so nothing records it differently.
  @MainActor
  func testAskedToExitClosesItsSessionsAsADroppedConnectionDoesThenExits() async throws {
    var exits = 0
    let asked = hostRuntime(
      helperVersion: "test", peerRequirement: .sameUser, terminate: { exits += 1 })
    defer { asked.stop() }
    let dropped = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { dropped.stop() }
    let quitting = peer(1)
    defer { close(quitting) }
    let lost = peer(1)
    defer { close(lost) }
    let askedSession = HelperSession(sessionId: "task", connectionID: 1)
    asked.registry.insert(askedSession)
    let droppedSession = HelperSession(sessionId: "task", connectionID: 1)
    dropped.registry.insert(droppedSession)

    await asked.handle(connection: quitting.connection, frame: Self.exitFrame)
    dropped.connectionClosed(lost.connection)
    await settle(asked)
    await settle(dropped)

    XCTAssertTrue(asked.registry.sessions.isEmpty)
    XCTAssertTrue(dropped.registry.sessions.isEmpty)
    XCTAssertEqual(askedSession.cancellation.reason, .closed)
    XCTAssertEqual(askedSession.cancellation.reason, droppedSession.cancellation.reason)
    // Only the answer: no session event either way.
    let answers = try frames(quitting.remote)
    XCTAssertEqual(answers.map { $0["id"] as? Int }, [7])
    XCTAssertNil(answers.first?["event"])
    XCTAssertTrue(try frames(lost.remote).isEmpty)
    XCTAssertEqual(exits, 1)
  }

  /// One installed helper serves Stable and Beta. The app that quit loses its
  /// sessions; the other keeps the helper and its own.
  @MainActor
  func testAnotherAppStillConnectedKeepsTheHelper() async throws {
    var exits = 0
    let runtime = hostRuntime(
      helperVersion: "test", peerRequirement: .sameUser, terminate: { exits += 1 })
    defer { runtime.stop() }
    let quitting = peer(1)
    defer { close(quitting) }
    let other = peer(2, process: 2_000)
    defer { close(other) }
    await runtime.handle(
      connection: other.connection,
      frame: Data(#"{"id":1,"method":"permissions.get","params":{}}"#.utf8))
    let mine = HelperSession(sessionId: "mine", connectionID: 1)
    let theirs = HelperSession(sessionId: "theirs", connectionID: 2)
    runtime.registry.insert(mine)
    runtime.registry.insert(theirs)

    await runtime.handle(connection: quitting.connection, frame: Self.exitFrame)
    await settle(runtime)

    let answers = try frames(quitting.remote)
    XCTAssertEqual((answers.first?["result"] as? [String: Any])?["exiting"] as? Bool, false)
    XCTAssertEqual(mine.cancellation.reason, .closed)
    XCTAssertNil(theirs.cancellation.reason)
    XCTAssertTrue(runtime.registry.sessions["theirs"] === theirs)
    XCTAssertEqual(exits, 0)
  }

  /// A watched window has a video socket of its own from the same app. The
  /// app that is quitting is not another app: its every socket ends with it.
  @MainActor
  func testQuittingWhileAWindowIsWatchedStillExits() async throws {
    var exits = 0
    let runtime = hostRuntime(
      helperVersion: "test", peerRequirement: .sameUser, terminate: { exits += 1 })
    defer { runtime.stop() }
    let control = peer(1)
    defer { close(control) }
    let video = peer(2)
    defer { close(video) }
    await runtime.handle(
      connection: video.connection,
      frame: Data(#"{"id":1,"method":"permissions.get","params":{}}"#.utf8))
    _ = try frames(video.remote)

    await runtime.handle(connection: control.connection, frame: Self.exitFrame)
    await settle(runtime)

    let answers = try frames(control.remote)
    XCTAssertEqual((answers.first?["result"] as? [String: Any])?["exiting"] as? Bool, true)
    XCTAssertTrue(video.connection.closedFlag)
    XCTAssertEqual(exits, 1)
  }

  /// Work already on the serial lane finishes before the process goes.
  @MainActor
  func testWorkUnderWayFinishesBeforeTheHelperExits() async throws {
    var exits = 0
    let runtime = hostRuntime(
      helperVersion: "test", peerRequirement: .sameUser, terminate: { exits += 1 })
    defer { runtime.stop() }
    let quitting = peer(1)
    defer { close(quitting) }

    let release = Locked<CheckedContinuation<Void, Never>?>(nil)
    let entered = expectation(description: "earlier work running")
    runtime.executor.enqueue {
      await withCheckedContinuation { continuation in
        release.withLock { $0 = continuation }
        entered.fulfill()
      }
    }
    await fulfillment(of: [entered], timeout: 2)
    await runtime.handle(connection: quitting.connection, frame: Self.exitFrame)
    for _ in 0..<3 {
      await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        DispatchQueue.main.async { done.resume() }
      }
    }
    XCTAssertEqual(exits, 0, "The exit waits for the work before it.")
    release.withLock { $0?.resume() }
    await settle(runtime)
    XCTAssertEqual(exits, 1)
  }

  @MainActor
  func testADesktopConnectingBeforeTheExitRunsKeepsTheHelper() async throws {
    var exits = 0
    let runtime = hostRuntime(
      helperVersion: "test", peerRequirement: .sameUser, terminate: { exits += 1 })
    defer { runtime.stop() }
    let held = Locked<CheckedContinuation<Void, Never>?>(nil)
    let busy = expectation(description: "second work running")
    runtime.executor.enqueue {
      await withCheckedContinuation { continuation in
        held.withLock { $0 = continuation }
        busy.fulfill()
      }
    }
    await fulfillment(of: [busy], timeout: 2)
    let again = peer(3)
    defer { close(again) }
    await runtime.handle(connection: again.connection, frame: Self.exitFrame)
    let returning = peer(4, process: 2_000)
    defer { close(returning) }
    await runtime.handle(
      connection: returning.connection,
      frame: Data(#"{"id":1,"method":"permissions.get","params":{}}"#.utf8))
    held.withLock { $0?.resume() }
    await settle(runtime)
    XCTAssertEqual(exits, 0, "A desktop that came back keeps the helper.")
  }

  /// A call answered outside the serial lane, such as reading the data grants,
  /// still finishes before the process goes.
  @MainActor
  func testAnOutOfBandCallUnderWayFinishesBeforeTheHelperExits() async throws {
    var exits = 0
    let grants = HeldGrants()
    let runtime = hostRuntime(
      helperVersion: "test", peerRequirement: .sameUser,
      dataPlane: DataPlane(contracts: [:], grants: [:], providers: [:], grantReader: grants),
      terminate: { exits += 1 })
    defer { runtime.stop() }
    let quitting = peer(1)
    defer { close(quitting) }
    let reading = Task { @MainActor in
      await runtime.handle(
        connection: quitting.connection,
        frame: Data(#"{"id":2,"method":"data.status","params":{}}"#.utf8))
    }
    await grants.entered()
    await runtime.handle(connection: quitting.connection, frame: Self.exitFrame)
    await settle(runtime)
    XCTAssertEqual(exits, 0, "The exit waits for the call under way.")
    grants.release()
    await reading.value
    await settle(runtime)
    XCTAssertEqual(exits, 1)
  }

  /// A quit is not a lost connection: the pill says the work ended.
  @MainActor
  func testAQuitEndsSessionsAsEndedNotAsALostConnection() async throws {
    let runtime = hostRuntime(
      helperVersion: "test", peerRequirement: .sameUser, terminate: {})
    defer { runtime.stop() }
    let quitting = peer(1)
    defer { close(quitting) }
    runtime.registry.insert(HelperSession(sessionId: "task", connectionID: 1))
    await runtime.handle(connection: quitting.connection, frame: Self.exitFrame)
    XCTAssertEqual(runtime.lastOverlayEnding, .ended)

    let dropped = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { dropped.stop() }
    let lost = peer(1)
    defer { close(lost) }
    dropped.registry.insert(HelperSession(sessionId: "task", connectionID: 1))
    dropped.connectionClosed(lost.connection)
    XCTAssertEqual(dropped.lastOverlayEnding, .connectionLost)
  }

  /// Answered at once, never behind a batch, so a quitting app is not kept.
  func testExitIsAnsweredOutsideTheSerialLane() {
    XCTAssertTrue(HelperRuntime.outOfBandMethods.contains("helper.exit"))
  }
}

/// Grants whose first read waits until the test lets it answer.
private final class HeldGrants: DataGrantReading, @unchecked Sendable {
  private let held = Locked<CheckedContinuation<Void, Never>?>(nil)
  private let arrived = Locked<CheckedContinuation<Void, Never>?>(nil)
  private let hasArrived = Locked(false)

  func entered() async {
    if hasArrived.current { return }
    await withCheckedContinuation { continuation in
      arrived.withLock { $0 = continuation }
      if hasArrived.current { arrived.withLock { $0?.resume(); $0 = nil } }
    }
  }

  func release() { held.withLock { $0?.resume(); $0 = nil } }

  func current() async -> DataGrants {
    await withCheckedContinuation { continuation in
      held.withLock { $0 = continuation }
      hasArrived.withLock { $0 = true }
      arrived.withLock { $0?.resume(); $0 = nil }
    }
    return DataGrants(
      automation: .denied, calendars: .denied, contacts: .denied, fullDiskAccess: .denied,
      reminders: .denied)
  }

  func state(of grant: DataGrant) async -> DataGrantState { .denied }
  func request(_ grant: DataGrant) async -> DataGrants { await current() }
  func awaitingRestart(_ grant: DataGrant) async -> Bool { false }
}
