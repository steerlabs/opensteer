#if canImport(UIKit)
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import RemoteTextInputCore

/// CU2: is the port the view? Regime A's sequences, recorded from the TypeScript port
/// (Cases/typing-sequences.json, written by typing-order.interaction.test.tsx), are replayed on
/// the real view with the same answers; after every step the native text, selection and marked
/// text, and the events it delivered, must equal the port's.
@MainActor final class RemoteTextInputReplayTests: XCTestCase {
  private func json(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value),
      let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) else { return "\(value)" }
    return String(decoding: data, as: UTF8.self)
  }

  func testThePortsRegimeASequencesOnTheRealView() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "typing-sequences", withExtension: "json", subdirectory: "Cases"))
    let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let contextId = try XCTUnwrap(file["contextId"] as? String)
    let sequences = try XCTUnwrap(file["sequences"] as? [[String: Any]])
    var differences: [String] = []
    var compared = 0
    for sequence in sequences {
      let name = sequence["name"] as? String ?? "?"
      let view = RemoteInputTextView()
      var packets: [[String: Any]] = []
      view.deliver = { packets.append($0) }
      var pasting = ""
      view.pasteboardItems = { [[UTType.utf8PlainText.identifier: pasting]] }
      view.configure(["contextId": contextId, "field": ["kind": "text", "multiline": false, "sensitive": false]], focused: false)
      var delivered = 0
      for (index, step) in (sequence["steps"] as? [[String: Any]] ?? []).enumerated() {
        let call = step["call"] as? [Any] ?? []
        let what = call.first as? String ?? ""
        let text = view.text ?? ""
        switch what {
        case "insertText": view.insertText(call[1] as? String ?? "")
        case "type": _ = view.textView(view, shouldChangeTextIn: view.selectedRange, replacementText: call[1] as? String ?? "")
        case "backspace":
          let caret = view.selectedRange
          let named = caret.length > 0 ? caret : (text as NSString).rangeOfComposedCharacterSequence(at: caret.location - 1)
          _ = view.textView(view, shouldChangeTextIn: named, replacementText: "")
        case "deleteBackward": view.deleteBackward()
        case "moveSelection":
          let start = call[1] as? Int ?? 0, end = call[2] as? Int ?? start
          view.selectedRange = NSRange(location: start, length: end - start)
        case "replaceRange":
          let start = call[1] as? Int ?? 0, end = call[2] as? Int ?? 0
          let a = view.position(from: view.beginningOfDocument, offset: start)!, b = view.position(from: view.beginningOfDocument, offset: end)!
          view.replace(view.textRange(from: a, to: b)!, withText: call[3] as? String ?? "")
        case "deleteMark": _ = view.textView(view, shouldChangeTextIn: NSRange(location: call[1] as? Int ?? 0, length: 1), replacementText: "")
        case "paste":
          pasting = call[1] as? String ?? ""
          view.paste(nil)
        case "setMarkedText":
          let marked = call[1] as? String ?? ""
          view.setMarkedText(marked, selectedRange: NSRange(location: (marked as NSString).length, length: 0))
        case "unmarkText": view.unmarkText()
        default: break
        }
        for answer in step["answers"] as? [[String: Any]] ?? [] { view.respond(answer) }
        compared += 1
        let expected = step["packets"] as? [Any] ?? []
        let sent = Array(packets[delivered...])
        delivered = packets.count
        let selection = step["selection"] as? [String: Int] ?? [:]
        let marked = step["marked"] as? [String: Int]
        var native: [String: Any] = ["text": view.text ?? "", "selection": ["start": view.selectedRange.location, "end": view.selectedRange.location + view.selectedRange.length]]
        if let range = view.markedTextRange {
          native["marked"] = ["start": view.offset(from: view.beginningOfDocument, to: range.start), "end": view.offset(from: view.beginningOfDocument, to: range.end)]
        }
        var port: [String: Any] = ["text": step["text"] as? String ?? "", "selection": selection]
        if let marked { port["marked"] = marked }
        if json(sent) != json(expected) || json(native) != json(port) {
          differences.append("\(name) step \(index) \(json(call)): view \(json(native)) sent \(json(sent)); port \(json(port)) sent \(json(expected))")
          break
        }
      }
    }
    print("replayed \(sequences.count) sequences, \(compared) steps compared, \(differences.count) differing")
    XCTAssertEqual(differences.count, 0, differences.prefix(5).joined(separator: "\n"))
    if !differences.isEmpty, let path = ProcessInfo.processInfo.environment["OPENSTEER_REPLAY_REPORT"] {
      try? differences.joined(separator: "\n").write(toFile: path, atomically: true, encoding: .utf8)
    }
  }
}
#endif
