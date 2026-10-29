import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class MessagesSenderLiveTests: XCTestCase {

  // MARK: - The real osascript, which sends no Apple event here

  func testArgumentsFollowTheSeparatorSoABodyStartingWithADashIsNoOption() async {
    let ending = await MessagesSender.runOsascript(
      OsascriptRequest(
        script: ["on run argv", "if item 1 of argv is not \"-e\" then error number -1", "end run"],
        arguments: ["-e", "x"], timeout: 10))
    XCTAssertEqual(ending.exitCode, 0, ending.stderr)
    XCTAssertTrue(ending.started)
  }

  func testAScriptThatOutlivesItsDeadlineIsKilledAndItsSendUnknown() async {
    let started = Date()
    let ending = await MessagesSender.runOsascript(
      OsascriptRequest(script: ["delay 20"], arguments: [], timeout: 0.3))
    XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    XCTAssertTrue(ending.stopped)
    XCTAssertEqual(messagesSendOutcome(ending)?.code, .outcomeUnknown)
  }

  func testABinaryThatCannotRunNeverStarted() async {
    let ending = await MessagesSender.runOsascript(
      OsascriptRequest(script: [], arguments: [], timeout: 1),
      binary: "/nonexistent/osascript")
    XCTAssertFalse(ending.started)
    XCTAssertEqual(messagesSendOutcome(ending)?.code, .failed)
  }
}
