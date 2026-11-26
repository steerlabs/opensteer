import CoreFoundation
import Foundation
import XCTest

@testable import ComputerUseCore

/// A tap stopped before the tap thread ran the block that adds it must never be enabled after
/// its port is invalidated. The helper crashed exactly so in the trial guest (EXC_BAD_ACCESS in
/// SLEventTapEnable on com.opensteer.computer-use.focus-taps, report
/// Opensteer Computer Use-2026-11-26-070023.ips): the focus guard creates and stops its taps for
/// every owner input drain, and a stop could invalidate the port while the add was still queued.
final class EventTapOrderTests: XCTestCase {
  private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(String, Bool)] = []
    func note(_ name: String) {
      lock.lock()
      entries.append((name, Thread.current.name == "com.opensteer.computer-use.focus-taps"))
      lock.unlock()
    }
    var names: [String] {
      lock.lock()
      defer { lock.unlock() }
      return entries.map(\.0)
    }
    var allOnTapThread: Bool {
      lock.lock()
      defer { lock.unlock() }
      return entries.allSatisfy(\.1)
    }
  }

  private func port() -> (CFMachPort, CFRunLoopSource) {
    let port = CFMachPortCreate(nil, { _, _, _, _ in }, nil, nil)!
    return (port, CFMachPortCreateRunLoopSource(nil, port, 0)!)
  }

  func testAStopQueuedBehindItsAddDisablesAndInvalidatesOnlyAfterTheAddOnTheTapThread() {
    for _ in 0..<50 {
      let recorder = Recorder()
      let ops = EventTap.PortOps(
        enable: { _, enable in recorder.note(enable ? "enable" : "disable") },
        invalidate: { _ in recorder.note("invalidate") })
      // The tap thread is busy (another tap's callback, a slow run-loop turn): the add waits.
      let busy = DispatchSemaphore(value: 0)
      let drained = DispatchSemaphore(value: 0)
      EventTapThread.shared.perform { busy.wait() }
      let (port, source) = port()
      let tap = EventTap(port: port, source: source, ops: ops) { _, event in event }
      tap.stop()
      tap.stop()
      busy.signal()
      EventTapThread.shared.perform { drained.signal() }
      XCTAssertEqual(drained.wait(timeout: .now() + 5), .success)
      XCTAssertEqual(recorder.names, ["enable", "disable", "invalidate"],
        "Nothing may touch a tap's port after it is invalidated")
      XCTAssertTrue(recorder.allOnTapThread, "Only the tap thread touches a tap's port")
    }
  }

  func testAStoppedTapPassesEventsThroughUntilItsPortIsGone() {
    let (port, source) = port()
    var calls = 0
    let busy = DispatchSemaphore(value: 0)
    EventTapThread.shared.perform { busy.wait() }
    let tap = EventTap(port: port, source: source, ops: EventTap.PortOps(
      enable: { _, _ in }, invalidate: { _ in })) { _, _ in calls += 1; return nil }
    tap.stop()
    busy.signal()
    let drained = DispatchSemaphore(value: 0)
    EventTapThread.shared.perform { drained.signal() }
    XCTAssertEqual(drained.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(calls, 0)
  }
}
