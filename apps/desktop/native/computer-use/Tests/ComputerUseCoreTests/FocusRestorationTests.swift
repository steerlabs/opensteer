import ApplicationServices
import XCTest
@testable import ComputerUseCore

final class FocusRestorationTests: XCTestCase {
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
