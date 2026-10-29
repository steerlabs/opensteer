import ApplicationServices
import OpensteerAppleData
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// A saved login value, or text for a secure field, reaches only the element
/// the act names. Ways it leaked or could leak, each checked below:
///  A. The target is a secure field whose AXSelectedText is not settable, and
///     focusing it did not move the app's focus off Username: the value went
///     through Username's AXSelectedText and showed in later observations.
///  B. As A, and the secure field's value cannot be set either, as with
///     AppKit's: keys are its only route. Focusing it leaves Username focused,
///     where keys would land, so nothing is typed and only the field's own
///     focus is written. A field that cannot even take focus gets nothing.
///  C. A saved value with no target: whatever has focus would receive it.
///  D. Control: a target that takes AXSelectedText receives the value itself.
///  E. A target that cannot take AX focus was clicked instead, and whatever
///     the app then reported as focused received the value.
///  F. The observation shows a secure field but a live read fails (AXUnknown):
///     treating it as plain restored the fallback into Username.
///  G. Text with a Tab needs keys, which land wherever focus moves next.
///  H. Text with no target while the app's focused field is secure went as
///     keys; a Tab in it carried the rest into another field.
///  I. A Stop during the focus write must still keep the text from going in.
///  J. Text with no target while the focused field's role cannot be read: it
///     may be secure, so the plain path must not take it.
///  K. Text with no target while focus moves from Username to the secure field
///     between reads: the field classified as plain must be the one that
///     receives it, never a later, unclassified one.
///  L. As B, but the field then holds the app's focus: the value goes on to
///     the keyboard for that field instead of being refused.
///  M. A plain target that takes only focus may not be a text field at all, so
///     it never takes the keyboard route: refused with nothing written.
@WorkActor
final class SavedTextDeliveryTests: XCTestCase {
  struct Write: Equatable {
    let other: Bool
    let attribute: String
  }
  struct UnicodePost: Equatable {
    let text: String
    let pid: pid_t
    let windowID: CGWindowID
  }
  static let secure = ElementAttributes(role: "AXTextField", subrole: "AXSecureTextField")
  static let plain = ElementAttributes(role: "AXTextField")

  func deliver(
    target: ActionTarget? = .index(0), observed: ElementAttributes = secure,
    live: ElementAttributes? = nil, settable: Set<String>, saved: LoginField? = .password,
    text: String = "synthetic-secret", focusIsTarget: Bool = false, stopOnFocus: Bool = false,
    focusMoves: Bool = false, keyboard: Bool = false,
    moveBeforeChunk: Bool = false, moveAfterChunk: Bool = false,
    posts: Locked<[UnicodePost]> = Locked([]),
    trace: Locked<[String]> = Locked([])
  ) async -> (result: Result<String, Error>, writes: [Write]) {
    let field = AXUIElementCreateApplication(getpid())
    let username = AXUIElementCreateApplication(1)
    let moved = Locked(false)
    let focus = FocusSlot(make: { pid in
      FakeFocusGuard(
        pid: pid,
        onGuard: {
          trace.withLock { $0.append("guard") }
          if moveBeforeChunk { moved.withLock { $0 = true } }
        })
    })
    let app = hostApp(
      identity: AppIdentity(bundleId: "fixture", displayName: "Fixture", teamId: nil),
      path: "/tmp/Fixture.app", focus: focus)
    defer { app.focus.stop() }
    let frame = CGRect(x: 0, y: 0, width: 200, height: 200)
    app.latest = LatestObservation(
      observationId: "snapshot", processIdentifier: getpid(), windowID: 1, windowFrame: frame,
      coordinates: ObservationCoordinates(
        cropOrigin: .zero, scale: 1, geometry: Observation.Geometry(width: 200, height: 200)),
      elements: [
        ObservedElement(
          node: AXElementNode(field), attributes: observed,
          frame: CGRect(x: 20, y: 20, width: 80, height: 30), depth: 0)
      ], takenAt: Date())
    let writes = Locked<[Write]>([])
    var calls = hostAccessibility()
    calls.isSettable = { element, attribute in
      CFEqual(element, field) ? settable.contains(attribute) : attribute == kAXSelectedTextAttribute
    }
    // Focusing the target "succeeds" and the app keeps Username focused.
    let focusReads = Locked(0)
    calls.focusedElement = { _ in
      trace.withLock { $0.append("focus verification") }
      if moved.current { return username }
      let read = focusReads.withLock { reads in
        reads += 1
        return reads
      }
      if focusMoves { return read == 1 ? username : field }
      return focusIsTarget ? field : username
    }
    calls.window = { _ in 1 }
    calls.attributes = { element in CFEqual(element, field) ? live ?? observed : Self.plain }
    let cancellation = SessionCancellation()
    calls.setAttribute = { element, attribute, _ in
      trace.withLock { $0.append(attribute) }
      writes.withLock { $0.append(Write(other: !CFEqual(element, field), attribute: attribute)) }
      if stopOnFocus, attribute == kAXFocusedAttribute { cancellation.cancel(.stoppedByUser) }
      return .success
    }
    var context = hostContext(
      app: app, cancellation: cancellation, monitor: WindowMonitor(), overlay: nil,
      budget: .unlimited, accessibility: calls)
    if keyboard {
      context.input = hostInput(
        checked: { trace.withLock { $0.append("per-chunk check") } },
        unicode: { chunk, destination, _ in
          XCTAssertEqual(destination.processIdentifier, getpid())
          XCTAssertEqual(destination.windowID, 1)
          posts.withLock {
            $0.append(UnicodePost(
              text: chunk, pid: destination.processIdentifier, windowID: destination.windowID))
          }
          trace.withLock { $0.append("post " + chunk) }
          if moveAfterChunk { moved.withLock { $0 = true } }
        })
    }
    context.requireUnlocked = {}
    context.elementCheck = { _, _ in trace.withLock { $0.append("validation") } }
    let binding = ActionRunner.Binding(
      processIdentifier: getpid(), stamp: hostStamp(getpid()), windowID: 1,
      windowFrame: frame, onScreen: false)
    do {
      let receipt = try await ActionRunner.type(
        text: text, target: target, binding: binding, context, savedField: saved, savedCheck: {})
      return (.success(receipt), writes.current)
    } catch {
      return (.failure(error), writes.current)
    }
  }

  func refused(_ result: Result<String, Error>, _ case: String) {
    guard case .failure(let error) = result else { return XCTFail("Delivered: " + `case`) }
    XCTAssertEqual((error as? HelperError)?.code, .unsupported, `case`)
  }

  func testASecureTargetThatKeepsNoFocusGetsTheValueAndUsernameGetsNothing() async {
    let (result, writes) = await deliver(settable: [kAXFocusedAttribute, kAXValueAttribute])
    XCTAssertEqual(try? result.get(), "Typed saved password")
    XCTAssertEqual(writes, [Write(other: false, attribute: kAXValueAttribute)])
  }

  func testASecureTargetThatTakesNeitherRefusesWhileUsernameKeepsTheFocus() async {
    let (result, writes) = await deliver(settable: [kAXFocusedAttribute])
    refused(result, "B")
    XCTAssertEqual(writes, [Write(other: false, attribute: kAXFocusedAttribute)])
    let (unfocusable, none) = await deliver(settable: [])
    refused(unfocusable, "B, no focus")
    XCTAssertEqual(none, [])
  }

  func testAPlainTargetThatTakesOnlyFocusIsRefusedWithNothingWritten() async {
    let (result, writes) = await deliver(
      observed: Self.plain, settable: [kAXFocusedAttribute], saved: .username, focusIsTarget: true)
    refused(result, "M")
    XCTAssertEqual(writes, [])
  }

  func testASecureTargetThatHoldsTheFocusGoesOnToTheKeyboard() async {
    let trace = Locked<[String]>([])
    let posts = Locked<[UnicodePost]>([])
    let (result, writes) = await deliver(
      settable: [kAXFocusedAttribute], focusIsTarget: true,
      keyboard: true, posts: posts, trace: trace)
    XCTAssertEqual(posts.current, [UnicodePost(text: "synthetic-secret", pid: getpid(), windowID: 1)])
    XCTAssertEqual(try? result.get(), "Typed saved password")
    XCTAssertEqual(
      trace.current,
      [
        "validation", kAXFocusedAttribute, "validation", "focus verification",
        "guard", "focus verification", "focus verification", "validation", "per-chunk check",
        "post synthetic-secret",
      ])
    XCTAssertEqual(writes, [Write(other: false, attribute: kAXFocusedAttribute)])
  }

  func testASavedValueWithoutATargetIsRefusedWithNothingWritten() async {
    let (result, writes) = await deliver(target: nil, settable: [kAXSelectedTextAttribute])
    refused(result, "C")
    XCTAssertEqual(writes, [])
  }

  func testATargetThatTakesSelectedTextReceivesTheValueItself() async {
    let (result, writes) = await deliver(
      observed: Self.plain, settable: [kAXFocusedAttribute, kAXSelectedTextAttribute],
      saved: .username)
    XCTAssertEqual(try? result.get(), "Typed saved username")
    XCTAssertEqual(
      writes,
      [
        Write(other: false, attribute: kAXFocusedAttribute),
        Write(other: false, attribute: kAXSelectedTextAttribute),
      ])
  }

  func testATargetThatCannotTakeFocusIsNeverClickedAndOnlyItReceives() async {
    let (result, writes) = await deliver(
      observed: Self.plain, settable: [kAXSelectedTextAttribute], saved: .username)
    XCTAssertEqual(try? result.get(), "Typed saved username")
    XCTAssertEqual(writes, [Write(other: false, attribute: kAXSelectedTextAttribute)])
  }

  func testAnObservedSecureFieldWhoseLiveReadFailsStaysExact() async {
    let (result, writes) = await deliver(
      live: ElementAttributes(role: "AXUnknown"), settable: [kAXValueAttribute], saved: nil)
    guard case .success = result else { return XCTFail("Refused a settable secure field") }
    XCTAssertEqual(writes, [Write(other: false, attribute: kAXValueAttribute)])
  }

  func testTextThatNeedsKeysIsRefusedForASecureField() async {
    let (result, writes) = await deliver(
      settable: [kAXFocusedAttribute, kAXSelectedTextAttribute, kAXValueAttribute], saved: nil,
      text: "first\tsecond")
    refused(result, "G")
    XCTAssertEqual(writes, [])
  }

  func testUntargetedTextIntoAFocusedSecureFieldGoesOnlyIntoItsValue() async {
    let (result, writes) = await deliver(
      target: nil, settable: [kAXValueAttribute], saved: nil, focusIsTarget: true)
    guard case .success = result else { return XCTFail("Refused a settable secure field") }
    XCTAssertEqual(writes, [Write(other: false, attribute: kAXValueAttribute)])
    let (tabbed, tabWrites) = await deliver(
      target: nil, settable: [kAXValueAttribute], saved: nil, text: "a\tb", focusIsTarget: true)
    refused(tabbed, "H")
    XCTAssertEqual(tabWrites, [])
  }

  func testAStopDuringTheFocusWriteKeepsTheTextOut() async {
    let (result, writes) = await deliver(
      observed: Self.plain, settable: [kAXFocusedAttribute, kAXSelectedTextAttribute],
      saved: .username, stopOnFocus: true)
    guard case .failure(let error) = result else { return XCTFail("Typed after Stop") }
    XCTAssertEqual(error as? HelperError, SessionCancelReason.stoppedByUser.error)
    XCTAssertEqual(writes, [Write(other: false, attribute: kAXFocusedAttribute)])
  }

  func testUntargetedTextIsRefusedWhenTheFocusedFieldCannotBeRead() async {
    let (result, writes) = await deliver(
      target: nil, live: ElementAttributes(role: "AXUnknown"), settable: [kAXSelectedTextAttribute],
      saved: nil, focusIsTarget: true)
    guard case .failure(let error) = result else {
      return XCTFail("Typed into an unreadable field")
    }
    XCTAssertEqual((error as? HelperError)?.code, .staleObservation)
    XCTAssertEqual(writes, [])
  }

  func testUntargetedTextGoesOnlyIntoTheFocusedFieldItClassified() async {
    let (result, writes) = await deliver(
      target: nil, settable: [kAXSelectedTextAttribute], saved: nil, text: "plain",
      focusMoves: true)
    guard case .success = result else { return XCTFail("Refused a plain focused field") }
    XCTAssertEqual(writes, [Write(other: true, attribute: kAXSelectedTextAttribute)])
  }
  func testFocusMovesBeforeFirstChunkRefusesWithoutPosting() async {
    let trace = Locked<[String]>([])
    let (result, _) = await deliver(
      settable: [kAXFocusedAttribute], focusIsTarget: true,
      keyboard: true, moveBeforeChunk: true, trace: trace)
    guard case .failure(let error) = result else { return XCTFail("Delivered after focus moved") }
    XCTAssertEqual(error as? HelperError, ActionRunner.unreceived)
    XCTAssertFalse(trace.current.contains { $0.hasPrefix("post ") })
  }

  func testFocusMovesAfterFirstChunkReportsUnknownWithoutAnotherPost() async {
    let trace = Locked<[String]>([])
    let text = String(repeating: "x", count: 1000)
    let (result, _) = await deliver(
      settable: [kAXFocusedAttribute], text: text, focusIsTarget: true,
      keyboard: true, moveAfterChunk: true, trace: trace)
    guard case .failure(let error) = result else { return XCTFail("Delivered after focus moved") }
    XCTAssertEqual(error as? HelperError, ActionRunner.focusLost)
    XCTAssertEqual(
      ActionRunner.failureAfter(ActionRunner.focusLost, performed: [], delivered: true).code,
      .outcomeUnknown)
    XCTAssertEqual(
      trace.current.filter { $0.hasPrefix("post ") }, ["post " + TextChunker.chunks(text)[0]])
  }

}
