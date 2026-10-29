import AppKit
import ApplicationServices
import QuartzCore
import XCTest

@testable import ComputerUseCore

// These constructors have no live fallback. AX handles are identity tokens only.
func hostStamp(_ pid: pid_t) -> ProcessStamp? {
  ProcessStamp(processIdentifier: pid, startSeconds: 10, startMicroseconds: 20)
}

final class FakeFocusGuard: FocusGuard, @unchecked Sendable {
  let pid: pid_t
  let preparations = Locked<[(prepare: Bool, keys: Bool)]>([])
  let stops = Locked(0)
  var onGuard: @Sendable () throws -> Void
  var onStop: @Sendable () -> Void
  init(
    pid: pid_t, onGuard: @escaping @Sendable () throws -> Void = {},
    onStop: @escaping @Sendable () -> Void = {}
  ) {
    self.pid = pid
    self.onGuard = onGuard
    self.onStop = onStop
  }
  func stop() {
    stops.withLock { $0 += 1 }
    onStop()
  }
  @WorkActor func guarded<Result>(
    window: AXUIElement?, prepare: Bool, keys: Bool,
    finalCheck: @escaping @Sendable () throws -> Void,
    deliveryCheck: @escaping @Sendable () throws -> Void,
    check: () throws -> Void, prepared: (Bool) -> Void,
    deliver: (@escaping @Sendable () throws -> Void) async throws -> Result
  ) async throws -> Result {
    preparations.withLock { $0.append((prepare, keys)) }
    try finalCheck()
    try check()
    try onGuard()
    prepared(false)
    return try await deliver { try deliveryCheck() }
  }
}

func hostApp(
  identity: AppIdentity, path: String,
  focus: FocusSlot = FocusSlot(make: { FakeFocusGuard(pid: $0) }),
  menuShortcuts: MenuShortcutIndex = MenuShortcutIndex(build: { _ in .init() })
) -> AppSessionState {
  AppSessionState(identity: identity, path: path, focus: focus, menuShortcuts: menuShortcuts)
}

func hostAccessibility() -> AccessibilityCalls {
  AccessibilityCalls(
    menuLookup: { _, _, _ in .none }, menuPath: { _ in [] },
    isSettable: { _, _ in false }, focusedElement: { _ in nil }, window: { _ in nil },
    attributes: { _ in ElementAttributes(role: "AXUnknown") },
    press: { _ in
      XCTFail("Unexpected AX press")
      return .failure
    },
    setAttribute: { _, _, _ in
      XCTFail("Unexpected AX write")
      return .failure
    },
    offersPress: { _ in false })
}

func hostInput(
  checked: @escaping @MainActor @Sendable () -> Void = {},
  unicode: @escaping @MainActor @Sendable (String, EventTarget, UInt64?) throws -> Void = {
    _, _, _ in
    XCTFail("Unexpected unicode post")
  }
) -> InputCalls {
  InputCalls(
    mouse: { _, _, _, _, _, gate in
      try gate()
      XCTFail("Unexpected mouse post")
    },
    scroll: { _, _, _, gate in
      try gate()
      XCTFail("Unexpected scroll post")
    },
    press: { _, _, _, _, _, gate in
      try gate()
      XCTFail("Unexpected key post")
    },
    unicode: { text, target, pacing, gate in
      try gate()
      checked()
      try unicode(text, target, pacing)
    })
}

@WorkActor func hostContext(
  app: AppSessionState, cancellation: SessionCancellation,
  monitor: WindowMonitor, overlay: OverlayController?, budget: WorkBudget,
  accessibility: AccessibilityCalls = hostAccessibility(), feedback: (any ActionFeedback)? = nil,
  requireUnlocked: @escaping @Sendable () throws -> Void = {},
  input: InputCalls = hostInput()
) -> ActionRunner.Context {
  ActionRunner.Context(
    app: app, cancellation: cancellation, monitor: monitor, overlay: overlay,
    budget: budget, accessibility: accessibility, feedback: feedback,
    requireUnlocked: requireUnlocked,
    stamp: { hostStamp($0) }, isHidden: { _ in false },
    keyOwner: { _, id in (id, AXUIElementCreateApplication(999_999)) }, input: input,
    elementCheck: { _, _ in })
}

@MainActor final class ManualFrameDriver: FrameDriving {
  private var step: (@MainActor (CFTimeInterval) -> Bool)?
  var isRunning: Bool { step != nil }
  func run(_ step: @escaping @MainActor (CFTimeInterval) -> Bool) { self.step = step }
  func stop() { step = nil }
  func advance(_ time: CFTimeInterval) { if step?(time) == false { stop() } }
}

@MainActor func hostRuntime(
  helperVersion: String, peerRequirement: PeerRequirementMode,
  catalog: AppCatalog = AppCatalog(roots: [], bundles: []),
  dataPlane: DataPlane = DataPlane(
    contracts: [:], grants: [:], providers: [:], grantReader: FakeGrants([:]))
) -> HelperRuntime {
  HelperRuntime(
    helperVersion: helperVersion, peerRequirement: peerRequirement, catalog: catalog,
    dataPlane: dataPlane,
    imessage: IMessageChannel(
      databasePath: "/nonexistent/cu-host-test.db",
      clock: DataClock(timeZone: TimeZone(identifier: "UTC")!),
      account: { nil },
      outbox: MessagesOutbox(run: { _ in
        XCTFail("Unexpected osascript")
        return OsascriptOutcome(exitCode: 1)
      }),
      sendRecords: URL(fileURLWithPath: "/nonexistent/cu-host-test-records.json")),
    permissions: { PermissionsState(accessibility: .granted, screenRecording: .granted) },
    appRunning: { _, _ in false })
}

func startQueuedWork(_ work: QueuedWork) -> Bool { work.start() }
func startIPCServer(_ server: IPCServer) throws { try server.start() }
