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
    let cases = try XCTUnwrap(file["cases"] as? [[String: Any]])
    XCTAssertGreaterThanOrEqual(cases.count, 7)

    for entry in cases {
      let name = entry["name"] as? String ?? "?"
      var contexts = OwnerEditingContexts()
      var saved: [String: String] = [:]
      for step in try XCTUnwrap(entry["steps"] as? [[String: Any]]) {
        if let observe = step["observe"] as? [String: Any] {
          let before = contexts.current
          let field: OwnerEditingContexts.FieldIdentity?
          if let raw = observe["field"] as? [String: Any] {
            field = OwnerEditingContexts.FieldIdentity(
              id: try XCTUnwrap(raw["id"] as? String, name),
              kind: try XCTUnwrap(raw["kind"] as? String, name),
              sensitive: try XCTUnwrap(raw["sensitive"] as? Bool, name),
              editable: try XCTUnwrap(raw["editable"] as? Bool, name))
          } else {
            field = nil
          }
          let changed = contexts.observe(field: field, stateChanged: observe["changed"] as? Bool ?? false)
          if let expected = step["expectChanged"] as? Bool {
            XCTAssertEqual(changed, expected, name)
            XCTAssertEqual(contexts.current != before, expected, name)
          }
          if let key = step["save"] as? String { saved[key] = contexts.current }
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
          let expected = try XCTUnwrap(step["is"] as? Bool, name)
          XCTAssertEqual(
            contexts.admits(contextId, kind: kind, namedMatches: namedMatches, exactNamed: exactNamed),
            expected,
            "\(name): admits(\(key), \(kindName), namedMatches=\(namedMatches), exactNamed=\(exactNamed))")
        } else if step["mismatch"] != nil {
          let before = contexts.current
          contexts.mismatch()
          if let expected = step["expectChanged"] as? Bool {
            XCTAssertEqual(contexts.current != before, expected, name)
          }
          if let key = step["save"] as? String { saved[key] = contexts.current }
        } else if step["reset"] != nil {
          let before = contexts.current
          contexts.reset()
          if let expected = step["expectChanged"] as? Bool {
            XCTAssertEqual(contexts.current != before, expected, name)
          }
          if let key = step["save"] as? String { saved[key] = contexts.current }
        } else if let count = step["rotateSame"] as? Int {
          for _ in 0..<count { contexts.rotate(sameField: true) }
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

  func testCommandAndPasteRequireContextId() throws {
    let validId = "00000000-0000-4000-8000-000000000001"
    for bad in [
      #"{"kind":"command","command":"selectAll"}"#,
      #"{"kind":"command","command":"deleteBackward","contextId":"not-a-uuid"}"#,
      #"{"kind":"paste","text":"hello"}"#,
      #"{"kind":"paste","text":"hello","contextId":"not-a-uuid"}"#,
    ] {
      let event = try JSONDecoder().decode(MacOwnerInput.Event.self, from: Data(bad.utf8))
      XCTAssertThrowsError(try event.validate(), bad) { error in
        XCTAssertEqual((error as? MacOwnerInput.Refusal)?.reason, "unsupported", bad)
      }
    }
    for good in [
      #"{"kind":"command","command":"selectAll","contextId":"\#(validId)"}"#,
      #"{"kind":"paste","text":"hello","contextId":"\#(validId)"}"#,
    ] {
      let event = try JSONDecoder().decode(MacOwnerInput.Event.self, from: Data(good.utf8))
      XCTAssertNoThrow(try event.validate(), good)
    }
  }
}
