import CoreGraphics
import Foundation
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// `Stop` has to stop a batch that is already running, not only the one that
/// has not started; the Host's deadline stops work the same way; and neither
/// `Stop`, `session.close`, `session.open` nor `hello` may wait behind work on
/// an app that is not answering.
final class CancellationTests: XCTestCase {
  private static let sessionId = "cus_4a7c2f18-9b3e-4d61-8a02-5f6c1d9e0b74"
  private static let absentApp =
    #"{"access":"read-write","identity":{"bundleId":"com.opensteer.test.absent","displayName":"Absent","teamId":null}}"#

  @WorkActor
  private static func citedID(_ app: AppSessionState) -> String? { app.latest?.observationId }

  @WorkActor
  private static func observed() -> AppSessionState {
    let app = hostApp(
      identity: AppIdentity(bundleId: "com.apple.Notes", displayName: "Notes", teamId: nil),
      path: "/System/Applications/Notes.app"
    )
    app.latest = LatestObservation(
      observationId: "0123456789abcdef",
      processIdentifier: 1,
      windowID: 1,
      windowFrame: CGRect(x: 0, y: 0, width: 100, height: 100),
      coordinates: ObservationCoordinates(
        cropOrigin: .zero, scale: 1,
        geometry: Observation.Geometry(width: 1000, height: 1000)),
      elements: [],
      takenAt: Date()
    )
    return app
  }

  // Running-batch Stop/deadline coverage uses session.act with real input in
  // WindowGroupJourney/BatchCancellation.swift, including completed-prefix receipts.

  /// A batch that was already cancelled before it started posts nothing at all.
  func testABatchIsRefusedOutrightWhenTheSessionIsAlreadyStopped() async {
    let app = await Self.observed()
    let cancellation = SessionCancellation()
    cancellation.cancel(.stoppedByUser)
    do {
      _ = try await ActionRunner.run(
        actions: [.key(keys: "Escape")],
        app: app,
        observationId: "0123456789abcdef",
        cancellation: cancellation,
        monitor: WindowMonitor(),
        overlay: nil, budget: .unlimited, accessibility: hostAccessibility(),
        stamp: { hostStamp($0) }, isHidden: { _ in false }, requireUnlocked: {}
      )
      XCTFail("A stopped session refuses the batch.")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, .stoppedByUser)
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  @WorkActor
  func testAnUnobservedAppCannotAct() async {
    let app = hostApp(
      identity: AppIdentity(bundleId: "com.example.missing", displayName: "Missing", teamId: nil),
      path: "/does/not/exist.app")
    do {
      _ = try await ActionRunner.run(
        actions: [.click(target: .index(0), button: .left, count: 1)], app: app,
        observationId: "made-up", cancellation: SessionCancellation(),
        monitor: WindowMonitor(), overlay: nil, budget: .unlimited,
        accessibility: hostAccessibility(),
        stamp: { hostStamp($0) }, isHidden: { _ in false }, requireUnlocked: {})
      XCTFail("An observation is required.")
    } catch let error as HelperError { XCTAssertEqual(error.code, .staleObservation) } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  @MainActor
  func testHelloOpenAndInspectionAnswerWhileTheLaneIsHeldAndWorkWaits() async throws {
    let first = try Self.pair(id: 1)
    let second = try Self.pair(id: 2)
    defer {
      first.close()
      second.close()
    }
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }

    let gate = AsyncTestGate()
    runtime.executor.enqueue { await gate.hold() }
    await gate.waitUntilHeld()
    defer { Task { await gate.open() } }

    // Greeting a connection does not wait for the lane.
    runtime.receive(connection: first.connection, frame: Self.hello(1))
    let frame1 = try await Self.readFrameAsync(first.client)
    XCTAssertEqual(try Self.responseID(frame1), 1)
    runtime.receive(connection: second.connection, frame: Self.hello(1))
    _ = try await Self.readFrameAsync(second.client)

    runtime.receive(
      connection: first.connection,
      frame: Data(#"{"id":2,"method":"permissions.get","params":{}}"#.utf8))
    let permissions = try await Self.readFrameAsync(first.client)
    XCTAssertEqual(try Self.responseID(permissions), 2)
    XCTAssertNotNil(try Self.permissionsResult(permissions))

    runtime.receive(
      connection: second.connection,
      frame: Data(
        #"{"id":3,"method":"session.open","params":{"sessionId":"\#(Self.sessionId)","threadTitle":null}}"#
          .utf8))
    let opened = try Self.object(try await Self.readFrameAsync(second.client))
    XCTAssertEqual(opened["id"] as? Int, 3)
    XCTAssertEqual(
      (opened["result"] as? [String: Any])?["sessionId"] as? String, Self.sessionId)

    runtime.receive(
      connection: second.connection,
      frame: Data(
        #"{"id":4,"method":"session.observe","params":{"window":"ref-A","sessionId":"\#(Self.sessionId)","app":\#(Self.absentApp)}}"#
          .utf8))
    XCTAssertFalse(
      Self.frameIsReady(second.client), "observe must remain behind the work lane")
    await gate.open()
    let observe = try await Self.readFrameAsync(second.client)
    XCTAssertEqual(try Self.responseID(observe), 4)
  }

  /// macOS holds a grant question while it asks the person about Messages.
  /// A status read waiting on that answer must hold up nothing else: the
  /// person's Stop, computer use and every other call keep answering.
  @MainActor
  func testAGrantReadMacOSIsHoldingHoldsUpNothingElse() async throws {
    let pair = try Self.pair(id: 13)
    defer { pair.close() }
    let reader = GatedGrants()
    let runtime = hostRuntime(
      helperVersion: "test",
      peerRequirement: .sameUser,
      dataPlane: DataPlane(contracts: [:], grants: [:], providers: [:], grantReader: reader)
    )
    defer { runtime.stop() }
    runtime.receive(connection: pair.connection, frame: Self.hello(1, protocolVersion: 10))
    _ = try await Self.readFrameAsync(pair.client)

    runtime.receive(
      connection: pair.connection,
      frame: Data(#"{"id":2,"method":"data.status","params":{}}"#.utf8))
    await reader.gate.waitUntilHeld()

    runtime.receive(
      connection: pair.connection,
      frame: Data(#"{"id":3,"method":"permissions.get","params":{}}"#.utf8))
    let permissions = try await Self.readFrameAsync(pair.client)
    XCTAssertEqual(try Self.responseID(permissions), 3)

    await reader.gate.open()
    let status = try await Self.readFrameAsync(pair.client)
    XCTAssertEqual(try Self.responseID(status), 2)
  }

  /// An app the helper serves never waits behind computer use's serial lane,
  /// nor behind another app: a contact search still running holds its own
  /// app only, while grants and a second app answer.
  @MainActor
  func testAppsTheHelperServesAnswerWhileTheLaneAndAnotherAppAreHeld() async throws {
    let pair = try Self.pair(id: 12)
    defer { pair.close() }
    let slow = GatedDataProvider(value: .object(["slow": .bool(true)]))
    let quick = GatedDataProvider(value: .object(["quick": .bool(true)]))
    await quick.gate.open()
    let contract = String(repeating: "c", count: 43)
    let read = DataOperationContract(contract: contract, effect: .read)
    let runtime = hostRuntime(
      helperVersion: "test",
      peerRequirement: .sameUser,
      dataPlane: DataPlane(
        contracts: ["slow-app": ["look": read], "quick-app": ["look": read]],
        grants: [
          "slow-app": DataAppGrants(read: .contacts, write: .contacts),
          "quick-app": DataAppGrants(read: .calendars, write: .calendars),
        ],
        providers: ["slow-app": slow, "quick-app": quick],
        grantReader: FakeGrants([
          .automation: .unknown, .calendars: .granted, .contacts: .granted,
          .fullDiskAccess: .denied, .reminders: .requestable,
        ])
      )
    )
    defer { runtime.stop() }

    let lane = AsyncTestGate()
    runtime.executor.enqueue { await lane.hold() }
    await lane.waitUntilHeld()
    defer { Task { await lane.open() } }

    runtime.receive(connection: pair.connection, frame: Self.hello(1, protocolVersion: 10))
    _ = try await Self.readFrameAsync(pair.client)

    func invoke(_ id: Int, _ app: String) -> Data {
      Data(
        #"{"id":\#(id),"method":"data.invoke","timeoutMs":5000,"params":{"access":"read","arguments":{},"contract":"\#(contract)","definitionId":"\#(app)","effect":"read","operation":"look"}}"#
          .utf8)
    }
    runtime.receive(connection: pair.connection, frame: invoke(2, "slow-app"))
    await slow.gate.waitUntilHeld()

    runtime.receive(
      connection: pair.connection,
      frame: Data(#"{"id":3,"method":"data.status","params":{}}"#.utf8))
    let status = try Self.object(try await Self.readFrameAsync(pair.client))
    XCTAssertEqual(status["id"] as? Int, 3)
    let grants = try XCTUnwrap(
      (status["result"] as? [String: Any])?["grants"] as? [String: String])
    XCTAssertEqual(
      grants,
      [
        "automation": "unknown", "calendars": "granted", "contacts": "granted",
        "full-disk-access": "denied", "reminders": "requestable",
      ])

    runtime.receive(connection: pair.connection, frame: invoke(4, "quick-app"))
    let answered = try Self.object(try await Self.readFrameAsync(pair.client))
    XCTAssertEqual(answered["id"] as? Int, 4)
    XCTAssertEqual(
      (answered["result"] as? [String: Any])?["value"] as? [String: Bool], ["quick": true])

    await slow.gate.open()
    let finished = try Self.object(try await Self.readFrameAsync(pair.client))
    XCTAssertEqual(finished["id"] as? Int, 2)
    XCTAssertEqual(
      (finished["result"] as? [String: Any])?["value"] as? [String: Bool], ["slow": true])
  }

  /// Work still waiting when its deadline passes is answered there and then,
  /// as not done, and is skipped when its turn comes: it never started, so it
  /// is never `outcome-unknown`.
  @MainActor
  func testQueuedWorkThatRunsOutOfTimeIsRefusedAsNotDone() async throws {
    let pair = try Self.pair(id: 3)
    defer { pair.close() }
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    runtime.receive(connection: pair.connection, frame: Self.hello(1))
    _ = try await Self.readFrameAsync(pair.client)

    let gate = AsyncTestGate()
    runtime.executor.enqueue { await gate.hold() }
    await gate.waitUntilHeld()
    defer { Task { await gate.open() } }

    runtime.receive(
      connection: pair.connection,
      frame: Data(
        #"{"id":9,"method":"session.observe","timeoutMs":150,"params":{"sessionId":"\#(Self.sessionId)","app":\#(Self.absentApp)}}"#
          .utf8))
    let refused = try Self.object(try await Self.readFrameAsync(pair.client))
    XCTAssertEqual(refused["id"] as? Int, 9)
    let error = try XCTUnwrap(refused["error"] as? [String: Any])
    XCTAssertEqual(error["code"] as? String, "failed")
    XCTAssertEqual(error["message"] as? String, QueuedWork.expired.message)
    XCTAssertTrue(QueuedWork.expired.message.contains("nothing was done"))

    await gate.open()
    // Wait until the lane has passed the expired request before checking that
    // it emitted no second response. A socket read timeout can leave a read
    // running on another thread when the machine is busy.
    let drained = AsyncTestGate()
    await drained.open()
    runtime.executor.enqueue { await drained.hold() }
    await drained.waitUntilHeld()
    XCTAssertFalse(Self.frameIsReady(pair.client))
  }

  /// A request that starts in time is not refused by the expiry that follows.
  func testWorkThatStartedIsNeverAlsoExpired() {
    let started = QueuedWork()
    XCTAssertTrue(startQueuedWork(started))
    XCTAssertFalse(started.expire())
    let expired = QueuedWork()
    XCTAssertTrue(expired.expire())
    XCTAssertFalse(startQueuedWork(expired))
  }

  /// The work executor is blocked the way an app that stops answering blocks
  /// an Accessibility call. `session.close`, the pill's `Stop` and a new
  /// connection's `hello` still answer at once, because none of them runs
  /// there.
  @MainActor
  func testCloseStopAndHelloAnswerWhileAnAppHoldsTheWorkExecutor() async throws {
    let pair = try Self.pair(id: 4)
    let other = try Self.pair(id: 5)
    defer {
      pair.close()
      other.close()
    }
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    runtime.receive(connection: pair.connection, frame: Self.hello(1))
    _ = try await Self.readFrameAsync(pair.client)
    for (id, session) in [(2, "first"), (3, "second")] {
      runtime.receive(
        connection: pair.connection,
        frame: Data(
          #"{"id":\#(id),"method":"session.open","params":{"sessionId":"\#(session)","threadTitle":null}}"#
            .utf8))
      _ = try await Self.readFrameAsync(pair.client)
    }

    let gate = AsyncTestGate()
    runtime.executor.enqueue { await gate.hold() }
    await gate.waitUntilHeld()
    defer { Task { await gate.open() } }

    runtime.receive(
      connection: pair.connection,
      frame: Data(#"{"id":4,"method":"session.close","params":{"sessionId":"first"}}"#.utf8))
    let frame2 = try await Self.readFrameAsync(pair.client)
    XCTAssertEqual(try Self.responseID(frame2), 4)
    runtime.stopFromOverlay()
    let stopped = try Self.object(try await Self.readFrameAsync(pair.client))
    XCTAssertEqual(stopped["event"] as? String, "session.stopped")
    runtime.receive(connection: other.connection, frame: Self.hello(1))
    let frame3 = try await Self.readFrameAsync(other.client)
    XCTAssertEqual(try Self.responseID(frame3), 1)
    XCTAssertTrue(runtime.registry.sessions.isEmpty)
    await gate.open()
  }

  @MainActor
  func testPillStopEmitsOneEventPerSessionAndRefusesFurtherCalls() async throws {
    let pair = try Self.pair(id: 9)
    defer { pair.close() }
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    await runtime.handle(connection: pair.connection, frame: Self.hello(1))
    _ = try await Self.readFrameAsync(pair.client)
    for id in ["first", "second"] {
      runtime.registry.insert(HelperSession(sessionId: id, connectionID: 9))
    }
    runtime.stopFromOverlay()
    var stopped = Set<String>()
    for _ in 0..<2 {
      let event = try Self.object(try await Self.readFrameAsync(pair.client))
      XCTAssertEqual(event["event"] as? String, "session.stopped")
      let params = try XCTUnwrap(event["params"] as? [String: Any])
      XCTAssertEqual(params["reason"] as? String, "user")
      stopped.insert(try XCTUnwrap(params["sessionId"] as? String))
    }
    XCTAssertEqual(stopped, ["first", "second"])
    await runtime.handle(
      connection: pair.connection,
      frame: Data(
        #"{"id":2,"method":"session.observe","params":{"window":"ref-A","sessionId":"first","includeScreenshot":false,"app":\#(Self.absentApp)}}"#
          .utf8))
    let response = try Self.object(try await Self.readFrameAsync(pair.client))
    let error = try XCTUnwrap(response["error"] as? [String: Any])
    XCTAssertEqual(error["code"] as? String, "stopped-by-user")
    // A stopped session cannot be opened again under the same id.
    await runtime.handle(
      connection: pair.connection,
      frame: Data(
        #"{"id":3,"method":"session.open","params":{"sessionId":"first","threadTitle":null}}"#
          .utf8))
    let reopened = try Self.object(try await Self.readFrameAsync(pair.client))
    XCTAssertEqual((reopened["error"] as? [String: Any])?["code"] as? String, "stopped-by-user")
  }

  /// An app that quits ends its single-app session with `app-quit`. A call
  /// that still names that session must not be told the person stopped it:
  /// the Host would then refuse this Run on this Mac for good.
  @MainActor
  func testAnAppQuitEndsTheSessionWithoutClaimingThePersonStoppedIt() async throws {
    let pair = try Self.pair(id: 11)
    defer { pair.close() }
    let runtime = hostRuntime(helperVersion: "test", peerRequirement: .sameUser)
    defer { runtime.stop() }
    await runtime.handle(connection: pair.connection, frame: Self.hello(1))
    _ = try await Self.readFrameAsync(pair.client)

    let session = HelperSession(sessionId: "quit", connectionID: 11)
    let state = hostApp(
      identity: AppIdentity(
        bundleId: "com.opensteer.test.never-running", displayName: "Gone", teamId: nil),
      path: "/Applications/Gone.app")
    session.add(state, access: .readWrite)
    session.processIdentifiers[state.key] = 424_242
    runtime.registry.insert(session)
    runtime.noticeQuitApps()

    let event = try Self.object(try await Self.readFrameAsync(pair.client))
    XCTAssertEqual(event["event"] as? String, "session.stopped")
    let params = try XCTUnwrap(event["params"] as? [String: Any])
    XCTAssertEqual(params["reason"] as? String, "app-quit")
    XCTAssertNil(runtime.registry.sessions["quit"])

    await runtime.handle(
      connection: pair.connection,
      frame: Data(
        #"{"id":2,"method":"session.observe","params":{"window":"ref-A","sessionId":"quit","includeScreenshot":false,"app":\#(Self.absentApp)}}"#
          .utf8))
    let response = try Self.object(try await Self.readFrameAsync(pair.client))
    let error = try XCTUnwrap(response["error"] as? [String: Any])
    XCTAssertEqual(error["code"] as? String, "no-session")
  }

  // MARK: - A socket pair standing in for the desktop

  private struct Pair {
    let connection: IPCConnection
    let client: Int32

    func close() {
      connection.close()
      Darwin.close(client)
    }
  }

  private static func pair(id: Int) throws -> Pair {
    var descriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
      throw HelperError(.failed, "No socket pair.")
    }
    // The lane remains held until each positive response arrives. This is a
    // deadlock bound, not a latency assertion; loaded Macs can take more than
    // a second to schedule the test client and the helper's main actor.
    var timeout = timeval(tv_sec: 10, tv_usec: 0)
    setsockopt(
      descriptors[1], SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    let connection = IPCConnection(
      id: id, fileDescriptor: descriptors[0], onFrame: { _, _ in }, onClose: { _ in })
    connection.resume()
    return Pair(connection: connection, client: descriptors[1])
  }

  private static func hello(_ id: Int, protocolVersion: Int = 10) -> Data {
    Data(
      #"{"id":\#(id),"method":"hello","params":{"clientVersion":"test","protocolVersion":\#(protocolVersion)}}"#
        .utf8)
  }

  nonisolated private static func readFrameAsync(_ descriptor: Int32) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global().async {
        do {
          continuation.resume(returning: try Self.readFrame(descriptor))
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private static func readFrame(_ descriptor: Int32) throws -> Data {
    let header = try read(descriptor, count: 4)
    let length = header.withUnsafeBytes { raw -> Int in
      let base = raw.bindMemory(to: UInt8.self)
      return (Int(base[0]) << 24) | (Int(base[1]) << 16) | (Int(base[2]) << 8) | Int(base[3])
    }
    return try read(descriptor, count: length)
  }

  private static func frameIsReady(_ descriptor: Int32) -> Bool {
    var descriptorToPoll = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
    return Darwin.poll(&descriptorToPoll, 1, 0) > 0
  }

  private static func read(_ descriptor: Int32, count: Int) throws -> Data {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: count)
    while data.count < count {
      let amount = buffer.withUnsafeMutableBytes { raw in
        Darwin.read(descriptor, raw.baseAddress, count - data.count)
      }
      guard amount > 0 else { throw HelperError(.failed, "The test client read nothing.") }
      data.append(contentsOf: buffer[0..<amount])
    }
    return data
  }

  nonisolated private static func object(_ data: Data) throws -> [String: Any] {
    try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  nonisolated private static func responseID(_ data: Data) throws -> Int {
    try XCTUnwrap(try object(data)["id"] as? Int)
  }

  nonisolated private static func permissionsResult(_ data: Data) throws -> [String: Any] {
    let result = try XCTUnwrap(try object(data)["result"] as? [String: Any])
    return try XCTUnwrap(result["permissions"] as? [String: Any])
  }
}

private actor AsyncTestGate {
  private var held = false
  private var opened = false
  private var heldWaiters: [CheckedContinuation<Void, Never>] = []
  private var openWaiters: [CheckedContinuation<Void, Never>] = []

  func hold() async {
    held = true
    let starting = heldWaiters
    heldWaiters.removeAll()
    for waiter in starting { waiter.resume() }
    guard !opened else { return }
    await withCheckedContinuation { openWaiters.append($0) }
  }

  func waitUntilHeld() async {
    guard !held else { return }
    await withCheckedContinuation { heldWaiters.append($0) }
  }

  func open() {
    opened = true
    let waiting = openWaiters
    openWaiters.removeAll()
    for waiter in waiting { waiter.resume() }
  }
}

/// An app whose calls wait until its gate opens.
private actor GatedDataProvider: DataProvider {
  let gate = AsyncTestGate()
  private let value: JSONValue

  init(value: JSONValue) {
    self.value = value
  }

  func invoke(
    operation: String, arguments: [String: JSONValue], budget: WorkBudget
  ) async throws -> JSONValue {
    await gate.hold()
    return value
  }
}

/// Grants whose read waits until the test lets it through, as macOS's answer
/// waits while it asks the person.
private final class GatedGrants: DataGrantReading, @unchecked Sendable {
  let gate = AsyncTestGate()

  func current() async -> DataGrants {
    await gate.hold()
    return DataGrants(
      automation: .unknown, calendars: .denied, contacts: .denied, fullDiskAccess: .denied,
      reminders: .denied)
  }

  func state(of grant: DataGrant) async -> DataGrantState { .denied }
  func request(_ grant: DataGrant) async -> DataGrants { await current() }
  func awaitingRestart(_ grant: DataGrant) async -> Bool { false }
}
