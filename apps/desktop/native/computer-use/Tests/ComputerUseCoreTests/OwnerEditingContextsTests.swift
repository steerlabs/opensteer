@testable import ComputerUseCore
import XCTest

/// CY13: the page's rule for a Mac app's field, and publishing a context only once the field
/// shows the person's edit (an Electron app applies a key in its renderer, after its receipt).
final class OwnerEditingContextsTests: XCTestCase {
  func testAnInsertionUnderAnEarlierContextOfTheSameFieldIsTheirs() {
    var contexts = OwnerEditingContexts()
    let beforeKey = contexts.current
    contexts.rotate(sameField: true)
    XCTAssertTrue(contexts.admits(beforeKey, insertion: true), "a commit typed just after a key goes in at the caret")
    XCTAssertFalse(contexts.admits(beforeKey, insertion: false), "a replacement names text and needs the current context")
    XCTAssertTrue(contexts.admits(contexts.current, insertion: false))
  }

  func testAnotherFieldLeavesNoEarlierContext() {
    var contexts = OwnerEditingContexts()
    let first = contexts.current
    contexts.rotate(sameField: true)
    contexts.rotate(sameField: false)
    XCTAssertFalse(contexts.admits(first, insertion: true), "what was typed for one field never lands in another")
  }

  func testOnlyTheRecentContextsAreKept() {
    var contexts = OwnerEditingContexts()
    let oldest = contexts.current
    for _ in 0...OwnerEditingContexts.kept { contexts.rotate(sameField: true) }
    XCTAssertFalse(contexts.admits(oldest, insertion: true))
  }

  func testAContextWaitsForTheFieldToShowTheEdit() {
    let before = OwnerEditingContexts.FieldState(value: "", selectionLocation: 0, selectionLength: 0)
    let applied = OwnerEditingContexts.FieldState(value: "q", selectionLocation: 1, selectionLength: 0)
    XCTAssertFalse(OwnerEditingContexts.effectShown(before: before, now: before, waited: 0.05), "the key's receipt came first")
    XCTAssertTrue(OwnerEditingContexts.effectShown(before: before, now: applied, waited: 0.05))
    XCTAssertTrue(OwnerEditingContexts.effectShown(before: before, now: before, waited: OwnerEditingContexts.effectWait), "an app that shows nothing does not hold the context back for ever")
  }
}
