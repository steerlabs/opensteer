import XCTest

@testable import ComputerUseCore

/// The focus policy exercised with a fake foreground app.
@WorkActor
final class ActKeeperTests: XCTestCase {
  let person: pid_t = 4_242
  let target: pid_t = 777

  func run<Result>(
    front: Locked<pid_t?>, putBacks: Locked<[pid_t]>, canPutBack: Bool = true,
    _ body: (ActKeeper) async throws -> Result
  ) async throws -> Result {
    let act = ActKeeper(target: target, front: { front.current },
      cancellation: SessionCancellation(), deliveryProgress: Locked(true))
    return try await act.run(putBack: { act in
      guard let original = act.originalToRestore() else { return true }
      putBacks.withLock { $0.append(original) }
      if canPutBack { front.withLock { $0 = original } }
      return canPutBack
    }) { try await body(act) }
  }

  func testAnActThatLeavesTheTargetInFrontPutsThePersonsAppBack() async throws {
    let front = Locked<pid_t?>(person), putBacks = Locked<[pid_t]>([])
    let result = try await run(front: front, putBacks: putBacks) { act in
      XCTAssertTrue(act.permitsRestoring(person))
      front.withLock { $0 = target }
      return "typed"
    }
    XCTAssertEqual(result, "typed")
    XCTAssertEqual(putBacks.current, [person])
    XCTAssertEqual(front.current, person)
  }

  func testAnActWhoseTargetStaysInFrontIsNotCompleted() async {
    let front = Locked<pid_t?>(person), putBacks = Locked<[pid_t]>([])
    do {
      _ = try await run(front: front, putBacks: putBacks, canPutBack: false) { _ in
        front.withLock { $0 = target }
        return "typed"
      }
      XCTFail("An act that left the app in front read completed.")
    } catch let error as HelperError {
      XCTAssertEqual(error.code, .outcomeUnknown)
      XCTAssertEqual(error.message, FocusEnforcer.leftInFront.message)
    } catch {
      XCTFail("\(error)")
    }
  }

  func testThePersonsOwnChoiceOfTheTargetStands() async throws {
    let front = Locked<pid_t?>(person), putBacks = Locked<[pid_t]>([])
    _ = try await run(front: front, putBacks: putBacks) { act in
      act.noteClick(windowOwner: target, addressedTo: target)
      front.withLock { $0 = target }
    }
    XCTAssertEqual(putBacks.current, [])
    XCTAssertEqual(front.current, target)
  }

  func testAnActThatBeganWithTheTargetInFrontKeepsNothing() async throws {
    let front = Locked<pid_t?>(target), putBacks = Locked<[pid_t]>([])
    _ = try await run(front: front, putBacks: putBacks) { act in
      XCTAssertNil(act.originalToRestore())
    }
    XCTAssertEqual(putBacks.current, [])
  }

  func testAFailedActKeepsItsOwnErrorAndStillPutsThePersonsAppBack() async {
    let front = Locked<pid_t?>(person), putBacks = Locked<[pid_t]>([])
    let own = HelperError(.failed, "This element did not accept the text.")
    do {
      _ = try await run(front: front, putBacks: putBacks, canPutBack: false) {
        _ -> String in
        front.withLock { $0 = target }
        throw own
      }
      XCTFail("A failed act read completed.")
    } catch let error as HelperError {
      XCTAssertEqual(error.message, own.message)
    } catch {
      XCTFail("\(error)")
    }
    XCTAssertEqual(putBacks.current, [person])
  }

  func testAnActTheTargetLeftForAnotherAppOfThePersonsNeedsNothing() async throws {
    let front = Locked<pid_t?>(person), putBacks = Locked<[pid_t]>([])
    _ = try await run(front: front, putBacks: putBacks) { _ in
      front.withLock { $0 = 9_999 }
    }
    XCTAssertEqual(putBacks.current, [])
  }

  func testRecoveryRequiresTheTargetToStayBehindTheLatestOwner() async throws {
    let front = Locked<pid_t?>(person)
    let act = ActKeeper(target: target, front: { front.current },
      cancellation: SessionCancellation(), deliveryProgress: Locked(false))
    front.withLock { $0 = target }
    do {
      try await act.recover { act in
        front.withLock { $0 = 9_999 }
        act.observeFront()
        front.withLock { $0 = target }
        return true
      }
      XCTFail("The target came forward again before recovery returned.")
    } catch let error as HelperError {
      XCTAssertEqual(error, FocusEnforcer.notRestored)
      XCTAssertTrue(act.permitsRestoring(9_999))
    }
  }
}
