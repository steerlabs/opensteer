@testable import ComputerUseCore
import Foundation
import XCTest

/// Runs the shared editing-admission fixture (`packages/protocol/fixtures/editing-admission.json`)
/// against `OwnerEditingContexts` — the same fixture `packages/protocol/src/editing-admission.test.ts`
/// runs against TypeScript `EditingContexts`.
final class OwnerEditingContextsTests: XCTestCase {
  private static var fixtureURL: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // ComputerUseCoreTests
      .deletingLastPathComponent() // Tests
      .deletingLastPathComponent() // computer-use
      .deletingLastPathComponent() // native
      .deletingLastPathComponent() // desktop
      .deletingLastPathComponent() // apps
      .deletingLastPathComponent() // repo root
      .appendingPathComponent("packages/protocol/fixtures/editing-admission.json")
  }

  func testSharedFixtureCases() throws {
    let data = try Data(contentsOf: Self.fixtureURL)
    let file = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(file["kept"] as? Int, OwnerEditingContexts.kept)
    XCTAssertEqual(file["namedTextWaitSeconds"] as? Double, OwnerEditingContexts.namedTextWait)
    let fixtureRelativeCommands = try XCTUnwrap(file["caretRelativeCommands"] as? [String])
    XCTAssertEqual(OwnerEditingContexts.caretRelativeCommands, Set(fixtureRelativeCommands))
    let cases = try XCTUnwrap(file["cases"] as? [[String: Any]])
    XCTAssertGreaterThanOrEqual(cases.count, 7)

    func parseField(_ raw: Any?, _ name: String) throws -> OwnerEditingContexts.FieldIdentity? {
      guard let dict = raw as? [String: Any] else { return nil }
      return OwnerEditingContexts.FieldIdentity(
        id: try XCTUnwrap(dict["id"] as? String, name),
        kind: try XCTUnwrap(dict["kind"] as? String, name),
        sensitive: try XCTUnwrap(dict["sensitive"] as? Bool, name),
        editable: try XCTUnwrap(dict["editable"] as? Bool, name))
    }

    func parseState(_ raw: Any?, _ name: String) throws -> OwnerEditingContexts.ObservedState? {
      guard let dict = raw as? [String: Any] else { return nil }
      return OwnerEditingContexts.ObservedState(
        location: try XCTUnwrap((dict["location"] as? NSNumber)?.intValue, name),
        length: try XCTUnwrap((dict["length"] as? NSNumber)?.intValue, name),
        text: dict["text"] as? String)
    }

    for entry in cases {
      let name = entry["name"] as? String ?? "?"
      var contexts = OwnerEditingContexts()
      var saved: [String: String] = [:]
      for step in try XCTUnwrap(entry["steps"] as? [[String: Any]]) {
        if let observe = step["observe"] as? [String: Any] {
          let before = contexts.current
          let field = try parseField(observe["field"], name)
          let changed = contexts.observe(field: field, stateChanged: observe["changed"] as? Bool ?? false)
          if let expected = step["expectChanged"] as? Bool {
            XCTAssertEqual(changed, expected, name)
            XCTAssertEqual(contexts.current != before, expected, name)
          }
          if step["publish"] as? Bool ?? (step["save"] != nil) {
            contexts.markPublished()
          }
          if let key = step["save"] as? String { saved[key] = contexts.current }
        } else if let observeState = step["observeState"] as? [String: Any] {
          let before = contexts.current
          let field = try parseField(observeState["field"], name)
          let state = try parseState(observeState["state"], name)
          let forceChanged = observeState["forceChanged"] as? Bool ?? false
          let changed = contexts.observeState(field: field, state: state, forceChanged: forceChanged)
          if let expected = step["expectChanged"] as? Bool {
            XCTAssertEqual(changed, expected, name)
            XCTAssertEqual(contexts.current != before, expected, name)
          }
          if step["publish"] as? Bool ?? (step["save"] != nil) {
            contexts.markPublished()
          }
          if let key = step["save"] as? String { saved[key] = contexts.current }
        } else if let expectOwn = step["expectOwnEffect"] as? [String: Any] {
          let state = try XCTUnwrap(parseState(expectOwn, name), name)
          contexts.expectOwnEffect(state)
        } else if step["publish"] as? Bool == true {
          contexts.markPublished()
        } else if let admits = step["admits"] as? [String: Any] {
          let key = try XCTUnwrap(admits["context"] as? String, name)
          let contextId = try XCTUnwrap(saved[key], "\(name): unknown context \(key)")
          let kindName = try XCTUnwrap(admits["kind"] as? String, name)
          let kind: OwnerEditingContexts.AdmissionKind
          switch kindName {
          case "relative": kind = .relative
          case "named": kind = .named
          case "exact": kind = .exact
          default: XCTFail("\(name): unknown kind \(kindName)"); return
          }
          let namedMatches = admits["namedMatches"] as? Bool ?? true
          let exactNamed = admits["exactNamed"] as? Bool ?? false
          let collapsed = admits["collapsed"] as? Bool ?? true
          let expected = try XCTUnwrap(step["is"] as? Bool, name)
          XCTAssertEqual(
            contexts.admits(
              contextId,
              kind: kind,
              namedMatches: namedMatches,
              exactNamed: exactNamed,
              collapsed: collapsed),
            expected,
            "\(name): admits(\(key), \(kindName), namedMatches=\(namedMatches), exactNamed=\(exactNamed), collapsed=\(collapsed))")
        } else if let group = step["dependentGroup"] as? [String: Any] {
          let key = try XCTUnwrap(group["context"] as? String, name)
          let contextId = try XCTUnwrap(saved[key], "\(name): unknown context \(key)")
          var text = try XCTUnwrap(group["initial"] as? String, name)
          let ops = try XCTUnwrap(group["operations"] as? [[String: Any]], name)
          let independent = try XCTUnwrap(group["independent"] as? [String: Any], name)
          // P2: a dependent batch runs in order and stops at its first refusal; an independent
          // edit afterward still applies under the same field.
          func apply(_ op: [String: Any]) throws -> Bool {
            let kindName = try XCTUnwrap(op["kind"] as? String, name)
            let kind: OwnerEditingContexts.AdmissionKind =
              kindName == "named" ? .named : kindName == "exact" ? .exact : .relative
            let namedMatches = op["namedMatches"] as? Bool ?? true
            guard contexts.admits(contextId, kind: kind, namedMatches: namedMatches, collapsed: true) else {
              if kind == .named { contexts.mismatch() }
              return false
            }
            if let append = op["text"] as? String { text += append }
            return true
          }
          for op in ops {
            if !(try apply(op)) { break }
          }
          XCTAssertEqual(text, try XCTUnwrap(step["expectAfterGroup"] as? String, name), name)
          XCTAssertTrue(try apply(independent), name)
          XCTAssertEqual(text, try XCTUnwrap(step["expectAfterIndependent"] as? String, name), name)
        } else if step["mismatch"] != nil {
          let before = contexts.current
          contexts.mismatch()
          if let expected = step["expectChanged"] as? Bool {
            XCTAssertEqual(contexts.current != before, expected, name)
          }
          if step["publish"] as? Bool ?? (step["save"] != nil) {
            contexts.markPublished()
          }
          if let key = step["save"] as? String { saved[key] = contexts.current }
        } else if step["reset"] != nil {
          let before = contexts.current
          contexts.reset()
          if let expected = step["expectChanged"] as? Bool {
            XCTAssertEqual(contexts.current != before, expected, name)
          }
          if step["publish"] as? Bool ?? (step["save"] != nil) {
            contexts.markPublished()
          }
          if let key = step["save"] as? String { saved[key] = contexts.current }
        } else if let count = step["rotateSame"] as? Int {
          for _ in 0..<count {
            contexts.markPublished()
            contexts.rotate(sameField: true)
          }
        } else if let count = step["rotateUnpublished"] as? Int {
          for _ in 0..<count {
            contexts.rotate(sameField: true)
          }
        } else if let wait = step["wait"] as? [String: Any] {
          let sameField = try XCTUnwrap(wait["sameField"] as? Bool, name)
          let matches = try XCTUnwrap(wait["matches"] as? Bool, name)
          let waited = try XCTUnwrap((wait["waited"] as? NSNumber)?.doubleValue, name)
          let expected = try XCTUnwrap(step["is"] as? String, name)
          XCTAssertEqual(
            OwnerEditingContexts.namedTextWaitDecision(sameField: sameField, matches: matches, waited: waited).rawValue,
            expected,
            name)
        } else {
          XCTFail("\(name): unknown step \(step)")
        }
      }
    }
  }

  /// S9: exercises the real `MacOwnerInputWorker.waitForNamedText` async polling loop for a late
  /// render within 0.5 s, a timeout refusal that calls `mismatch`, and an immediate abort when
  /// focus leaves the field.
  func testNamedTextWaitLoopAppliesLateRenderAndAbortsOnFieldChangeOrTimeout() async throws {
    // 1) Late render: text is missing for the first 3 polls (~30 ms), then appears within 0.5 s.
    var probes = 0
    var mismatchCount = 0
    let matched: String = try await MacOwnerInputWorker.waitForNamedText(
      pollIntervalNanoseconds: 10_000_000,
      probe: {
        probes += 1
        return (sameField: true, match: probes >= 4 ? "teh" : nil)
      },
      onMismatch: { mismatchCount += 1 }
    )
    XCTAssertEqual(matched, "teh")
    XCTAssertEqual(probes, 4)
    XCTAssertEqual(mismatchCount, 0)

    // 2) Focus leaves the field while waiting: aborts immediately without calling onMismatch.
    var fieldProbes = 0
    var fieldMismatch = 0
    let fieldStarted = ProcessInfo.processInfo.systemUptime
    do {
      let _: String = try await MacOwnerInputWorker.waitForNamedText(
        pollIntervalNanoseconds: 10_000_000,
        probe: {
          fieldProbes += 1
          return (sameField: fieldProbes < 3, match: nil)
        },
        onMismatch: { fieldMismatch += 1 }
      )
      XCTFail("Expected stale refusal when focus left field")
    } catch let refusal as MacOwnerInput.Refusal {
      XCTAssertEqual(refusal.reason, "stale")
    }
    XCTAssertEqual(fieldMismatch, 0)
    XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - fieldStarted, 0.25)

    // 3) Text never appears: waits until the 0.5 s deadline, then calls onMismatch and refuses.
    var clock: TimeInterval = 100.0
    var timeoutMismatch = 0
    var timeoutProbes = 0
    do {
      let _: String = try await MacOwnerInputWorker.waitForNamedText(
        pollIntervalNanoseconds: 1_000_000,
        now: { clock },
        probe: {
          timeoutProbes += 1
          if timeoutProbes > 1 { clock += 0.1 }
          return (sameField: true, match: nil)
        },
        onMismatch: { timeoutMismatch += 1 }
      )
      XCTFail("Expected stale refusal after 0.5 s timeout")
    } catch let refusal as MacOwnerInput.Refusal {
      XCTAssertEqual(refusal.reason, "stale")
    }
    XCTAssertEqual(timeoutMismatch, 1)
    XCTAssertGreaterThanOrEqual(clock - 100.0, OwnerEditingContexts.namedTextWait)
  }

  func testCommandAndPasteRequireContextId() throws {
    let validId = "00000000-0000-4000-8000-000000000001"
    for bad in [
      #"{"kind":"command","command":"selectAll"}"#,
      #"{"kind":"command","command":"deleteBackward","contextId":"not-a-uuid"}"#,
      #"{"kind":"paste","text":"hello"}"#,
      #"{"kind":"paste","text":"hello","contextId":"not-a-uuid"}"#,
      #"{"kind":"copy"}"#,
      #"{"kind":"copy","contextId":"not-a-uuid"}"#,
    ] {
      let event = try JSONDecoder().decode(MacOwnerInput.Event.self, from: Data(bad.utf8))
      XCTAssertThrowsError(try event.validate(), bad) { error in
        XCTAssertEqual((error as? MacOwnerInput.Refusal)?.reason, "unsupported", bad)
      }
    }
    for good in [
      #"{"kind":"command","command":"selectAll","contextId":"\#(validId)"}"#,
      #"{"kind":"paste","text":"hello","contextId":"\#(validId)"}"#,
      #"{"kind":"copy","contextId":"\#(validId)"}"#,
    ] {
      let event = try JSONDecoder().decode(MacOwnerInput.Event.self, from: Data(good.utf8))
      XCTAssertNoThrow(try event.validate(), good)
    }
  }
}
