import ApplicationServices
import XCTest
@testable import ComputerUseCore

final class FocusRestorationTests: XCTestCase {
  func testSiblingEnforcerStopDeactivatesTheRemainingBeliefDespiteARound() {
    let (kind, deactivated, activated) = (FocusEvents.appKitDefined, FocusEvents.deactivated, FocusEvents.activated)
    let roundDropsAll: (UInt32, Int64) -> Bool = { _, _ in true }
    func notice(helper: Bool, _ subtype: Int64, window: CGWindowID = 0,
                suppress: ((UInt32, Int64) -> Bool)? = roundDropsAll) -> FocusEnforcer.Notice {
      FocusEnforcer.notice(fromHelper: helper, kind, subtype, window: window, suppress: suppress)
    }
    // B's `undoActivation` reaches the app, so A must prepare it again and
    // stop a delivery the app no longer takes.
    XCTAssertEqual(notice(helper: true, deactivated), .pass(believesActive: false, endsDelivery: true))
    // A round's own key switch, seen late by its tap, ends neither belief nor delivery.
    XCTAssertEqual(notice(helper: true, deactivated, window: 38), .pass(believesActive: nil, endsDelivery: false))
    XCTAssertEqual(notice(helper: true, activated, window: 37), .pass(believesActive: true, endsDelivery: false))
    XCTAssertEqual(notice(helper: false, deactivated), .drop)
    XCTAssertEqual(notice(helper: false, deactivated, window: 38, suppress: nil),
      .pass(believesActive: false, endsDelivery: true))
    XCTAssertEqual(notice(helper: true, FocusEvents.resignedKey, suppress: nil),
      .pass(believesActive: nil, endsDelivery: false))
  }


  private struct Choice {
    var relinquished = false
    var front: pid_t? = 101
    var window: AXUIElement? = AXUIElementCreateApplication(101)
  }

  @MainActor
  private func queuedRaise(_ change: (inout Choice) -> Void, permitted: Bool) async {
    let choice = Locked(Choice())
    let original = choice.current.window!
    let queued = DispatchSemaphore(value: 0)
    let raises = Locked(0)
    // The main actor stays occupied until the worker has passed the old check.
    let pending = Task.detached { () throws -> AXError in
      guard !choice.current.relinquished else { throw FocusEnforcer.personSwitched }
      queued.signal()
      return try await MainActor.run {
        try FocusEnforcer.raiseOriginalWindow(original, originalPID: 101,
          relinquished: { choice.current.relinquished },
          frontPID: { choice.current.front }, focusedWindow: { _ in choice.current.window },
          raise: { window in
            XCTAssertTrue(CFEqual(window, original))
            raises.withLock { $0 += 1 }
            return .cannotComplete
          })
      }
    }
    XCTAssertEqual(queued.wait(timeout: .now() + 1), .success)
    choice.withLock(change)
    switch await pending.result {
    case .success(let status):
      XCTAssertTrue(permitted, "A queued raise overrode the person's later choice")
      XCTAssertEqual(status, .cannotComplete, "Preserve the native AX result")
    case .failure(let error):
      XCTAssertFalse(permitted)
      XCTAssertEqual(error as? HelperError, FocusEnforcer.personSwitched)
    }
    XCTAssertEqual(raises.current, permitted ? 1 : 0)
  }

  @MainActor func testQueuedRaiseDoesNotUndoAPersonClick() async {
    await queuedRaise({ $0.relinquished = true }, permitted: false)
  }
  @MainActor func testQueuedRaiseDoesNotOverrideAnotherOriginalAppWindow() async {
    await queuedRaise({ $0.window = AXUIElementCreateApplication(102) }, permitted: false)
  }
  @MainActor func testQueuedRaiseDoesNotFollowAChangedFrontApp() async {
    await queuedRaise({ $0.front = 103 }, permitted: false)
  }
  @MainActor func testQueuedRaiseRefusesUnreadableFocusedWindowIdentity() async {
    await queuedRaise({ $0.window = nil }, permitted: false)
  }
  @MainActor func testQueuedRaisePreservesTheUnchangedChoiceAndNativeStatus() async {
    await queuedRaise({ _ in }, permitted: true)
  }
}
