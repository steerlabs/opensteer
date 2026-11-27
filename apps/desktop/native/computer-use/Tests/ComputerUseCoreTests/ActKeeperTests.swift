import XCTest

@testable import ComputerUseCore

/// What one agent act owes the person's front app (`ActKeeper`), decided without a Mac's
/// window server: the app the person had in front as the act began is the one put back.
@WorkActor
final class ActKeeperTests: XCTestCase {
  let person: pid_t = 4_242
  let target: pid_t = 777

  func keeper(
    front: Locked<pid_t?>, chosen: Bool = false, canPutBack: Bool = true,
    putBacks: Locked<[pid_t]>
  ) -> ActKeeper {
    let target = target
    return ActKeeper(
      target: target, front: { front.current }, chosen: { chosen },
      putBack: { original in
        putBacks.withLock { $0.append(original) }
        if canPutBack { front.withLock { $0 = original } }
        return front.current != target
      })
  }

  func testAnActThatLeavesTheTargetInFrontPutsThePersonsAppBack() async throws {
    let front = Locked<pid_t?>(person), putBacks = Locked<[pid_t]>([])
    let result = try await keeper(front: front, putBacks: putBacks).run { original in
      XCTAssertEqual(original, person)
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
      _ = try await keeper(front: front, canPutBack: false, putBacks: putBacks).run { _ in
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
    _ = try await keeper(front: front, chosen: true, putBacks: putBacks).run { _ in
      front.withLock { $0 = target }
    }
    XCTAssertEqual(putBacks.current, [])
    XCTAssertEqual(front.current, target)
  }

  func testAnActThatBeganWithTheTargetInFrontKeepsNothing() async throws {
    let front = Locked<pid_t?>(target), putBacks = Locked<[pid_t]>([])
    _ = try await keeper(front: front, putBacks: putBacks).run { original in
      XCTAssertNil(original)
    }
    XCTAssertEqual(putBacks.current, [])
  }

  func testAFailedActKeepsItsOwnErrorAndStillPutsThePersonsAppBack() async {
    let front = Locked<pid_t?>(person), putBacks = Locked<[pid_t]>([])
    let own = HelperError(.failed, "This element did not accept the text.")
    do {
      _ = try await keeper(front: front, canPutBack: false, putBacks: putBacks).run {
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
    _ = try await keeper(front: front, putBacks: putBacks).run { _ in
      front.withLock { $0 = 9_999 }
    }
    XCTAssertEqual(putBacks.current, [])
  }
}
