import XCTest

@testable import ComputerUseCore

@WorkActor
final class ActionSettleTests: XCTestCase {
  private let inbox = ActionSettle.Fingerprint(title: "Inbox", childCount: 12)
  private let opensteer = ActionSettle.Fingerprint(title: "Opensteer", childCount: 12)

  func testWaitsForTheWindowToChangeFromBeforeTheInputAndHold() async {
    var time = Date(timeIntervalSince1970: 0)
    var readings = [inbox, inbox, opensteer, opensteer]
    let polls = await ActionSettle.settle(
      fingerprint: { _ in readings.removeFirst() }, before: inbox, budget: .unlimited,
      cancellation: SessionCancellation(), now: { time }, sleep: { time += $0 })
    XCTAssertEqual(polls, 4)
    XCTAssertEqual(time.timeIntervalSince1970, 0.4, accuracy: 0.001)
  }

  func testAWindowThatAlreadyChangedSettlesAfterTwoPolls() async {
    var time = Date(timeIntervalSince1970: 0)
    let polls = await ActionSettle.settle(
      fingerprint: { _ in self.opensteer }, before: inbox, budget: .unlimited,
      cancellation: SessionCancellation(), now: { time }, sleep: { time += $0 })
    XCTAssertEqual(polls, 2)
    XCTAssertEqual(time.timeIntervalSince1970, 0.2, accuracy: 0.001)
  }

  func testAnUnchangedOrUnreadableWindowWaitsTheWholeSecond() async {
    for unreadable in [false, true] {
      var time = Date(timeIntervalSince1970: 0)
      _ = await ActionSettle.settle(
        fingerprint: { deadline in
          XCTAssertLessThan(time, deadline)
          return unreadable ? nil : self.inbox
        }, before: inbox, budget: .unlimited, cancellation: SessionCancellation(),
        now: { time }, sleep: { time += $0 })
      XCTAssertEqual(time.timeIntervalSince1970, 1, accuracy: 0.001)
    }
  }

  func testStopEndsTheSettleBeforeAnotherRead() async {
    let cancellation = SessionCancellation()
    var time = Date(timeIntervalSince1970: 0)
    let polls = await ActionSettle.settle(
      fingerprint: { _ in
        XCTFail("Stop must precede the read")
        return nil
      },
      before: inbox, budget: .unlimited, cancellation: cancellation, now: { time },
      sleep: {
        time += $0
        cancellation.cancel(.stoppedByUser)
      })
    XCTAssertEqual(polls, 0)
    XCTAssertEqual(time.timeIntervalSince1970, 0.1, accuracy: 0.001)
  }

  func testSettleLeavesTheClosingObservationItsTimeWithinEitherBudget() async {
    for request in [true, false] {
      var time = Date(timeIntervalSince1970: 0)
      let end = time.addingTimeInterval(ActionSettle.observationReserve + 0.15)
      let deadline = end.addingTimeInterval(-ActionSettle.observationReserve)
      let budget = request ? WorkBudget(requestEnd: end) : WorkBudget(batchEnd: end)
      _ = await ActionSettle.settle(
        fingerprint: { passedDeadline in
          XCTAssertEqual(passedDeadline, deadline)
          XCTAssertLessThan(time, deadline)
          return self.inbox
        }, before: inbox, budget: budget, cancellation: SessionCancellation(), now: { time },
        sleep: { interval in
          XCTAssertLessThanOrEqual(interval, deadline.timeIntervalSince(time) + 0.000_001)
          time += interval
        })
      XCTAssertEqual(time.timeIntervalSince1970, deadline.timeIntervalSince1970, accuracy: 0.001)
    }
  }

  func testNoPollStartsWhenTheBudgetOrCancellationAlreadyEnded() async {
    let time = Date()
    for stopped in [true, false] {
      let cancellation = SessionCancellation()
      if stopped { cancellation.cancel(.stoppedByUser) }
      let polls = await ActionSettle.settle(
        fingerprint: { _ in
          XCTFail("No read")
          return nil
        },
        before: inbox,
        budget: WorkBudget(requestEnd: stopped ? time.addingTimeInterval(10) : time),
        cancellation: cancellation, now: { time },
        sleep: { _ in XCTFail("No sleep") })
      XCTAssertEqual(polls, 0)
    }
  }

  func testEveryNonemptyInputBatchCanSettle() {
    let click = ActionRequest.click(target: .point(.zero), button: .left, count: 1)
    XCTAssertTrue(ActionSettle.mayApply(to: [click]))
    XCTAssertTrue(ActionSettle.mayApply(to: [.key(keys: "Escape"), click]))
    XCTAssertFalse(ActionSettle.mayApply(to: []))
    XCTAssertTrue(ActionSettle.mayApply(to: [.key(keys: "Escape")]))
    XCTAssertTrue(ActionSettle.mayApply(to: [click, .key(keys: "Escape")]))
  }

  func testPreActionReadDoesNotConsumeTheClosingObservationReserve() {
    let now = Date(timeIntervalSince1970: 0)
    XCTAssertEqual(
      ActionSettle.preActionDeadline(budget: .unlimited, now: now),
      now.addingTimeInterval(ActionSettle.timeout))
    let end = now.addingTimeInterval(ActionSettle.observationReserve + 0.2)
    XCTAssertEqual(
      ActionSettle.preActionDeadline(budget: WorkBudget(requestEnd: end), now: now),
      now.addingTimeInterval(0.2))
  }
}
