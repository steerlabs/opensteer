import XCTest
@testable import RemoteTextInputCore

/// RemoteInputEdits' arithmetic from Cases/remote-input-edits.json, the file the TypeScript port's
/// tests (tests/edits-cases.test.ts) run too: change one and both must pass.
final class RemoteInputEditsCasesTests: XCTestCase {
  func testEveryCaseInTheSharedFile() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "remote-input-edits", withExtension: "json", subdirectory: "Cases"))
    let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let cases = try XCTUnwrap(file["cases"] as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty)
    for entry in cases {
      let name = entry["name"] as? String ?? "?"
      var edits = RemoteInputEdits()
      var places: [String: RemoteInputEdits.Place] = [:]
      func pair(_ value: Any?) -> [Int] { (value as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue } ?? [] }
      func range(_ value: Any?) -> NSRange { let v = pair(value); return NSRange(location: v[0], length: v[1]) }
      for step in try XCTUnwrap(entry["steps"] as? [[String: Any]]) {
        if let place = step["place"] as? String {
          let at = pair(step["at"])
          places[place] = edits.place(at[0], at[1])
        } else if step["record"] != nil {
          let edit = pair(step["record"])
          edits.record(start: edit[0], removed: edit[1], inserted: edit[2])
        } else if step["settle"] != nil {
          edits.settle()
        } else if let chosen = step["choose"] as? String {
          edits.choose(try XCTUnwrap(places[chosen], name))
        } else if let place = step["current"] as? String {
          let current = edits.current(try XCTUnwrap(places[place], name), length: (step["length"] as! NSNumber).intValue)
          XCTAssertEqual([current.start, current.end], pair(step["is"]), name)
        } else if let place = step["deletion"] as? String {
          let deleted = edits.deletion(try XCTUnwrap(places[place], name), in: step["text"] as! String)
          XCTAssertEqual([deleted.location, deleted.length], pair(step["is"]), name)
        } else if let place = step["backspace"] as? String {
          let deleted = edits.backspace(try XCTUnwrap(places[place], name), in: step["text"] as! String)
          XCTAssertEqual([deleted.location, deleted.length], pair(step["is"]), name)
        } else if let place = step["chosenAfter"] as? String {
          let chosen = edits.chosen(after: try XCTUnwrap(places[place], name))
          let expected = (step["is"] as? String).flatMap { places[$0] }
          XCTAssertEqual(chosen, expected, name)
        } else if let asked = step["isBackspace"] as? [String: Any] {
          XCTAssertEqual(RemoteInputEdits.isBackspace(named: range(asked["named"]), selection: range(asked["selection"]), in: asked["text"] as! String), step["is"] as? Bool, name)
        } else if let asked = step["deletesSelection"] as? [String: Any] {
          XCTAssertEqual(RemoteInputEdits.deletesSelection(named: range(asked["named"]), selection: range(asked["selection"])), step["is"] as? Bool, name)
        } else if let asked = step["composedCount"] as? [String: Any] {
          XCTAssertEqual(RemoteInputEdits.composedCount(in: asked["text"] as! String, range: range(asked["range"])), (step["is"] as! NSNumber).intValue, name)
        } else if let asked = step["deletedStart"] as? [String: Any] {
          let marked = asked["marked"] == nil ? nil : range(asked["marked"])
          XCTAssertEqual(RemoteInputEdits.deletedStart(selection: range(asked["selection"]), marked: marked, removed: (asked["removed"] as! NSNumber).intValue), (step["is"] as! NSNumber).intValue, name)
        } else {
          XCTFail("\(name): unknown step \(step)")
        }
      }
    }
  }
}
