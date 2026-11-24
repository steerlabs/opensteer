#if canImport(UIKit)
import UIKit
import XCTest

/// CU3: what UIKit's own UITextView does, recorded from the real view (no subclass of ours), for
/// every effect the TypeScript port models of it (tests/remote-input-port.ts, NativeField): the
/// text, selection and marked text each call leaves, and every range UIKit names to its delegate
/// on the way. Cases/uikit-recordings.json is this recording; the port is held to it
/// (uikit-recordings.test.ts), and the typing test generates only what it shows. The file is
/// compared here, so a UIKit that behaves otherwise fails; TEST_RUNNER_OPENSTEER_WRITE_UIKIT=1
/// writes it again.
@MainActor final class UIKitRecordingTests: XCTestCase {
  private final class Recorder: NSObject, UITextViewDelegate {
    var named: [[String: Any]] = []
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
      named.append(["start": range.location, "end": NSMaxRange(range), "text": text])
      return true
    }
  }
  private func state(_ view: UITextView) -> [String: Any] {
    var state: [String: Any] = ["text": view.text ?? "", "selection": ["start": view.selectedRange.location, "end": NSMaxRange(view.selectedRange)]]
    if let marked = view.markedTextRange {
      state["marked"] = ["start": view.offset(from: view.beginningOfDocument, to: marked.start), "end": view.offset(from: view.beginningOfDocument, to: marked.end)]
    }
    return state
  }
  /// Each case: a start (text, selection, optional marked text set by setMarkedText), then calls.
  private struct Case {
    let name: String
    let text: String
    let selection: (Int, Int)
    var marked: String? = nil
    let calls: [[Any]]
  }
  private let cases: [Case] = [
    Case(name: "insertText at a caret", text: "ab", selection: (1, 1), calls: [["insertText", "x"]]),
    Case(name: "insertText over a selection", text: "abc", selection: (1, 2), calls: [["insertText", "x"]]),
    Case(name: "insertText over marked text", text: "ab", selection: (1, 1), marked: "日本", calls: [["insertText", "x"]]),
    Case(name: "setMarkedText at a caret", text: "ab", selection: (1, 1), calls: [["setMarkedText", "に", 1]]),
    Case(name: "setMarkedText over a selection", text: "abc", selection: (1, 2), calls: [["setMarkedText", "に", 1]]),
    Case(name: "setMarkedText over marked text, shorter", text: "ab", selection: (1, 1), marked: "日本", calls: [["setMarkedText", "日", 1]]),
    Case(name: "setMarkedText empty cancels", text: "ab", selection: (1, 1), marked: "日本", calls: [["setMarkedText", "", 0]]),
    Case(name: "unmarkText", text: "ab", selection: (1, 1), marked: "日本", calls: [["unmarkText"]]),
    Case(name: "deleteBackward at a caret", text: "abc", selection: (2, 2), calls: [["deleteBackward"]]),
    Case(name: "deleteBackward at the start", text: "abc", selection: (0, 0), calls: [["deleteBackward"]]),
    Case(name: "deleteBackward over a selection", text: "abcd", selection: (1, 3), calls: [["deleteBackward"]]),
    Case(name: "deleteBackward after a decomposed é", text: "ae\u{301}", selection: (3, 3), calls: [["deleteBackward"]]),
    Case(name: "deleteBackward after a precomposed é", text: "a\u{e9}", selection: (2, 2), calls: [["deleteBackward"]]),
    Case(name: "deleteBackward after an emoji sequence", text: "a👩‍💻", selection: (6, 6), calls: [["deleteBackward"]]),
    Case(name: "deleteBackward after a Hebrew letter", text: "aא", selection: (2, 2), calls: [["deleteBackward"]]),
    Case(name: "deleteBackward inside marked text", text: "ab", selection: (1, 1), marked: "日本", calls: [["deleteBackward"]]),
    Case(name: "replace before the caret", text: "abcd", selection: (4, 4), calls: [["replace", 0, 2, "the"]]),
    Case(name: "replace after the caret", text: "abcd", selection: (0, 0), calls: [["replace", 2, 4, "the"]]),
    Case(name: "replace around the caret", text: "abcd", selection: (2, 2), calls: [["replace", 1, 3, "the"]]),
    Case(name: "replace at the caret, empty range", text: "abcd", selection: (2, 2), calls: [["replace", 2, 2, "the"]]),
    Case(name: "replace ending at the caret", text: "abcd", selection: (2, 2), calls: [["replace", 0, 2, "é"]]),
    Case(name: "replace starting at the caret", text: "abcd", selection: (2, 2), calls: [["replace", 2, 4, "ab"]]),
    Case(name: "replace covering a selection", text: "abcd", selection: (1, 3), calls: [["replace", 0, 4, "the"]]),
    Case(name: "replace inside a selection", text: "abcd", selection: (0, 4), calls: [["replace", 1, 3, "x"]]),
    Case(name: "replace over part of a selection", text: "abcd", selection: (1, 3), calls: [["replace", 2, 4, "xy"]]),
    Case(name: "replace with nothing", text: "abcd", selection: (4, 4), calls: [["replace", 1, 3, ""]]),
    Case(name: "select a range", text: "abcd", selection: (4, 4), calls: [["select", 1, 3]]),
    Case(name: "select inside an emoji", text: "a👩‍💻b", selection: (0, 0), calls: [["select", 2, 2]]),
  ]

  func testUIKitsOwnTextViewAsRecorded() throws {
    var recorded: [[String: Any]] = []
    for test in cases {
      let view = UITextView()
      let recorder = Recorder()
      view.delegate = recorder
      view.text = test.text
      view.selectedRange = NSRange(location: test.selection.0, length: test.selection.1 - test.selection.0)
      if let marked = test.marked { view.setMarkedText(marked, selectedRange: NSRange(location: (marked as NSString).length, length: 0)) }
      let start = state(view)
      recorder.named = []
      var steps: [[String: Any]] = []
      for call in test.calls {
        switch call[0] as? String {
        case "insertText": view.insertText(call[1] as? String ?? "")
        case "setMarkedText": view.setMarkedText(call[1] as? String, selectedRange: NSRange(location: call[2] as? Int ?? 0, length: 0))
        case "unmarkText": view.unmarkText()
        case "deleteBackward": view.deleteBackward()
        case "replace":
          let a = view.position(from: view.beginningOfDocument, offset: call[1] as? Int ?? 0)!
          let b = view.position(from: view.beginningOfDocument, offset: call[2] as? Int ?? 0)!
          view.replace(view.textRange(from: a, to: b)!, withText: call[3] as? String ?? "")
        case "select":
          let location = call[1] as? Int ?? 0
          view.selectedRange = NSRange(location: location, length: (call[2] as? Int ?? location) - location)
        default: XCTFail("unknown call \(call)")
        }
        var step = state(view)
        step["call"] = call
        step["named"] = recorder.named
        recorder.named = []
        steps.append(step)
      }
      recorded.append(["name": test.name, "start": start, "steps": steps])
    }
    let data = try JSONSerialization.data(withJSONObject: ["about": "UIKit's own UITextView on Mac Catalyst, recorded by UIKitRecordingTests.swift: each case's start, then each call's text, selection, marked text and the ranges UIKit named to its delegate.", "cases": recorded], options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
    let written = String(decoding: data, as: UTF8.self) + "\n"
    let url = try XCTUnwrap(Bundle.module.url(forResource: "Cases", withExtension: nil)).appendingPathComponent("uikit-recordings.json")
    if ProcessInfo.processInfo.environment["OPENSTEER_WRITE_UIKIT"] == "1" {
      // The bundle's copy is not the source: write where the test was compiled from.
      let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Cases/uikit-recordings.json")
      try written.write(to: source, atomically: true, encoding: .utf8)
      return
    }
    let committed = try String(contentsOf: url, encoding: .utf8)
    XCTAssertEqual(written, committed, "UIKit no longer does what Cases/uikit-recordings.json recorded")
  }
}
#endif
