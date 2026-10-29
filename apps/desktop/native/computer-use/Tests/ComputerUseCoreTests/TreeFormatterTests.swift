import CoreGraphics
import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

final class TreeFormatterTests: XCTestCase {
  /// The key window sits at (100, 50) on screen, so every frame in the tree is
  /// 100 and 50 smaller than the screen frame the element reported.
  private let windowFrame = CGRect(x: 100, y: 50, width: 800, height: 600)

  private func render(_ root: FakeElementNode, limit: Int = ElementTreeWalker.elementLimit)
    -> TreeFormatter.Rendered
  {
    TreeFormatter.render(
      ElementTreeWalker.walk(root: root, windowFrame: windowFrame, limit: limit),
      coordinates: ObservationCoordinates(
        cropOrigin: .zero, scale: 1,
        geometry: Observation.Geometry(width: 800, height: 600))
    )
  }

  func testOneLinePerElementInTheDocumentedShape() {
    let root = FakeElementNode.node(
      "AXWindow",
      title: "Notes",
      frame: windowFrame,
      children: [
        FakeElementNode.node(
          "AXButton",
          title: "Save",
          frame: CGRect(x: 512, y: 138, width: 96, height: 28)
        )
      ]
    )
    let rendered = render(root)
    XCTAssertEqual(
      rendered.text,
      """
      [0] window "Notes" (0,0 800×600)
        [1] button "Save" (412,88 96×28)
      """
    )
    XCTAssertEqual(rendered.elementCount, 2)
    XCTAssertFalse(rendered.truncated)
  }

  func testTheValueIsUsedWhenThereIsNoTitle() {
    let root = FakeElementNode.node(
      "AXTextField",
      value: "hello",
      frame: CGRect(x: 100, y: 50, width: 200, height: 24)
    )
    XCTAssertEqual(render(root).text, #"[0] textfield "hello" (0,0 200×24)"#)
  }

  func testDisabledAndFocusedAreSuffixes() {
    let root = FakeElementNode.node(
      "AXWindow",
      title: "W",
      frame: windowFrame,
      children: [
        FakeElementNode.node(
          "AXButton",
          title: "Off",
          frame: CGRect(x: 100, y: 50, width: 10, height: 10),
          enabled: false
        ),
        FakeElementNode.node(
          "AXTextField",
          title: "In",
          frame: CGRect(x: 100, y: 70, width: 10, height: 10),
          focused: true
        ),
      ]
    )
    let lines = render(root).text.components(separatedBy: "\n")
    XCTAssertEqual(lines[1], #"  [1] button "Off" (0,0 10×10) (disabled)"#)
    XCTAssertEqual(lines[2], #"  [2] textfield "In" (0,20 10×10) (focused)"#)
  }

  func testGroupsAndUnknownsAreSkippedAsLinesButStillDescendedInto() {
    let root = FakeElementNode.node(
      "AXWindow",
      title: "W",
      frame: windowFrame,
      children: [
        FakeElementNode.node(
          "AXGroup",
          frame: windowFrame,
          children: [
            FakeElementNode.node(
              "AXUnknown",
              frame: windowFrame,
              children: [
                FakeElementNode.node(
                  "AXButton",
                  title: "Deep",
                  frame: CGRect(x: 100, y: 50, width: 20, height: 20)
                )
              ]
            )
          ]
        )
      ]
    )
    // Two wrappers, no extra indentation, and the button is still there.
    XCTAssertEqual(
      render(root).text,
      """
      [0] window "W" (0,0 800×600)
        [1] button "Deep" (0,0 20×20)
      """
    )
  }

  func testZeroSizedElementsAreSkippedButTheirChildrenAreNot() {
    let root = FakeElementNode.node(
      "AXWindow",
      title: "W",
      frame: windowFrame,
      children: [
        FakeElementNode.node(
          "AXButton",
          title: "Invisible",
          frame: CGRect(x: 100, y: 50, width: 0, height: 0),
          children: [
            FakeElementNode.node(
              "AXButton",
              title: "Real",
              frame: CGRect(x: 110, y: 60, width: 20, height: 20)
            )
          ]
        )
      ]
    )
    let text = render(root).text
    XCTAssertFalse(text.contains("Invisible"))
    XCTAssertTrue(text.contains(#"[1] button "Real" (10,10 20×20)"#))
  }

  func testElementsOutsideTheWindowAreLeftOutWithTheirSubtree() {
    let root = FakeElementNode.node(
      "AXWindow",
      title: "W",
      frame: windowFrame,
      children: [
        FakeElementNode.node(
          "AXButton",
          title: "Offscreen",
          frame: CGRect(x: 2_000, y: 2_000, width: 50, height: 50),
          children: [
            FakeElementNode.node(
              "AXButton",
              title: "AlsoOffscreen",
              frame: CGRect(x: 2_000, y: 2_000, width: 10, height: 10)
            )
          ]
        )
      ]
    )
    XCTAssertEqual(render(root).text, #"[0] window "W" (0,0 800×600)"#)
  }

  func testTheValueIsCutAtTwoHundredCharacters() {
    let long = String(repeating: "a", count: 500)
    let root = FakeElementNode.node(
      "AXTextArea",
      value: long,
      frame: CGRect(x: 100, y: 50, width: 100, height: 100)
    )
    let line = render(root).text
    XCTAssertTrue(line.contains(String(repeating: "a", count: 200) + "…"))
    XCTAssertFalse(line.contains(String(repeating: "a", count: 201)))
  }

  func testNewlinesAndQuotesInALabelStayOnOneLine() {
    let root = FakeElementNode.node(
      "AXStaticText",
      value: "one\ntwo \"three\"",
      frame: CGRect(x: 100, y: 50, width: 100, height: 20)
    )
    let text = render(root).text
    XCTAssertEqual(text.components(separatedBy: "\n").count, 1)
    XCTAssertTrue(text.contains(#"one two \"three\""#))
  }

  func testTheCapIsStatedOnItsOwnLine() {
    let children = (0..<20).map { index in
      FakeElementNode.node(
        "AXButton",
        title: "b\(index)",
        frame: CGRect(x: 100, y: 50 + index, width: 10, height: 10)
      )
    }
    let root = FakeElementNode.node("AXWindow", title: "W", frame: windowFrame, children: children)
    let rendered = render(root, limit: 5)
    XCTAssertTrue(rendered.truncated)
    XCTAssertEqual(rendered.elementCount, 5)
    XCTAssertEqual(
      rendered.text.components(separatedBy: "\n").last,
      "… 16 more elements not shown; act on what you see or scroll."
    )
  }

  func testTheTreeStaysUnderItsByteCap() {
    let children = (0..<2_000).map { index in
      FakeElementNode.node(
        "AXStaticText",
        value: String(repeating: "x", count: 200),
        frame: CGRect(x: 100, y: 50 + (index % 500), width: 10, height: 10)
      )
    }
    let root = FakeElementNode.node("AXWindow", title: "W", frame: windowFrame, children: children)
    let rendered = render(root)
    XCTAssertLessThanOrEqual(rendered.text.utf8.count, TreeFormatter.maxBytes)
    XCTAssertGreaterThan(rendered.text.utf8.count, TreeFormatter.maxBytes - 300)
    XCTAssertTrue(rendered.truncated)
    // The closing line counts every element left out, by the cap and by the
    // byte budget together, and the count of shown lines is what indexes.
    let shown = rendered.text.components(separatedBy: "\n").dropLast()
    XCTAssertEqual(shown.count, rendered.elementCount)
    XCTAssertEqual(
      rendered.text.components(separatedBy: "\n").last,
      "… \(2_001 - rendered.elementCount) more elements not shown; act on what you see or scroll."
    )
  }

  /// Multi-byte labels are counted in UTF-8 bytes, the unit of the budget.
  func testTheBudgetIsUTF8Bytes() {
    let children = (0..<600).map { index in
      FakeElementNode.node(
        "AXButton", title: String(repeating: "界", count: 60),
        frame: CGRect(x: 100, y: 50 + (index % 500), width: 10, height: 10))
    }
    let root = FakeElementNode.node("AXWindow", title: "W", frame: windowFrame, children: children)
    let rendered = render(root)
    XCTAssertLessThanOrEqual(rendered.text.utf8.count, TreeFormatter.maxBytes)
    XCTAssertTrue(rendered.truncated)
  }

  /// A line has to earn its bytes: unlabeled layout, empty text and text that
  /// only repeats its parent are left out and their children hoisted, while
  /// controls stay even unlabeled.
  func testLayoutAndRepeatsAreLeftOutAndControlsStay() {
    let root = FakeElementNode.node(
      "AXWindow", title: "W", frame: windowFrame,
      children: [
        FakeElementNode.node(
          "AXScrollArea", frame: windowFrame,
          children: [
            FakeElementNode.node(
              "AXRow", frame: CGRect(x: 100, y: 50, width: 400, height: 20),
              children: [
                FakeElementNode.node(
                  "AXCell", frame: CGRect(x: 100, y: 50, width: 400, height: 20),
                  children: [
                    FakeElementNode.node(
                      "AXStaticText", value: "Groceries",
                      frame: CGRect(x: 104, y: 52, width: 100, height: 16))
                  ])
              ]),
            FakeElementNode.node("AXImage", frame: CGRect(x: 100, y: 80, width: 16, height: 16)),
            FakeElementNode.node(
              "AXStaticText", frame: CGRect(x: 100, y: 100, width: 16, height: 16)),
            FakeElementNode.node(
              "AXButton", title: "Save", frame: CGRect(x: 100, y: 120, width: 60, height: 20),
              children: [
                FakeElementNode.node(
                  "AXStaticText", value: "Save",
                  frame: CGRect(x: 104, y: 122, width: 40, height: 16))
              ]),
            FakeElementNode.node(
              "AXButton", frame: CGRect(x: 170, y: 120, width: 20, height: 20)),
            FakeElementNode.node(
              "AXGroup", title: "Sidebar", frame: CGRect(x: 100, y: 150, width: 100, height: 100)),
          ])
      ])
    XCTAssertEqual(
      render(root).text,
      """
      [0] window "W" (0,0 800×600)
        [1] statictext "Groceries" (4,2 100×16)
        [2] button "Save" (0,70 60×20)
        [3] button (70,70 20×20)
        [4] group "Sidebar" (0,100 100×100)
      """)
  }

  /// What the screenshot shows first comes first: roots are walked in order,
  /// an element hidden behind a window in front of its own is left out, and a
  /// root already walked is not walked again inside its parent.
  func testRootsAreWalkedInOrderAndHiddenElementsAreLeftOut() {
    let sheet = FakeElementNode.node(
      "AXSheet", frame: CGRect(x: 200, y: 50, width: 300, height: 200),
      children: [
        FakeElementNode.node(
          "AXButton", title: "Cancel", frame: CGRect(x: 210, y: 200, width: 60, height: 20))
      ])
    let window = FakeElementNode.node(
      "AXWindow", title: "Doc", frame: windowFrame,
      children: [
        sheet,
        FakeElementNode.node(
          "AXButton", title: "Behind", frame: CGRect(x: 220, y: 60, width: 60, height: 20)),
        FakeElementNode.node(
          "AXButton", title: "Beside", frame: CGRect(x: 600, y: 60, width: 60, height: 20)),
      ])
    let walk = ElementTreeWalker.walk(
      roots: [
        WalkRoot(sheet),
        WalkRoot(window, occluders: [CGRect(x: 200, y: 50, width: 300, height: 200)]),
      ],
      bounds: windowFrame, origin: windowFrame.origin)
    let rendered = TreeFormatter.render(
      walk,
      coordinates: ObservationCoordinates(
        cropOrigin: .zero, scale: 1, geometry: Observation.Geometry(width: 800, height: 600)))
    XCTAssertEqual(
      rendered.text,
      """
      [0] sheet (100,0 300×200)
        [1] button "Cancel" (110,150 60×20)
      [2] window "Doc" (0,0 800×600)
        [3] button "Beside" (500,10 60×20)
      """)
  }

  /// Menu items outside the key window are kept when the screenshot shows
  /// them: the bound is the picture, not the window.
  func testElementsInsideThePictureButOutsideTheWindowAreKept() {
    let window = FakeElementNode.node("AXWindow", title: "W", frame: windowFrame)
    let menu = FakeElementNode.node(
      "AXMenu", frame: CGRect(x: 850, y: 100, width: 150, height: 40),
      children: [
        FakeElementNode.node(
          "AXMenuItem", title: "Paste", frame: CGRect(x: 850, y: 104, width: 150, height: 20))
      ])
    let walk = ElementTreeWalker.walk(
      roots: [WalkRoot(menu), WalkRoot(window)],
      bounds: CGRect(x: 100, y: 50, width: 900, height: 600), origin: windowFrame.origin)
    XCTAssertEqual(walk.elements.map(\.attributes.title), [nil, "Paste", "W"])
    XCTAssertEqual(walk.elements[1].frame, CGRect(x: 750, y: 54, width: 150, height: 20))
  }

  func testIndicesAreReassignedEveryTime() {
    // Every observation is a full snapshot, so the first element is always [0].
    let root = FakeElementNode.node(
      "AXWindow",
      title: "W",
      frame: windowFrame,
      children: [
        FakeElementNode.node(
          "AXButton", title: "A", frame: CGRect(x: 100, y: 50, width: 9, height: 9))
      ]
    )
    XCTAssertTrue(render(root).text.hasPrefix("[0] "))
    root.children.insert(
      FakeElementNode.node(
        "AXButton", title: "New", frame: CGRect(x: 100, y: 70, width: 9, height: 9)),
      at: 0
    )
    let lines = render(root).text.components(separatedBy: "\n")
    XCTAssertTrue(lines[1].contains(#"[1] button "New""#))
    XCTAssertTrue(lines[2].contains(#"[2] button "A""#))
  }
  /// An app that stops answering part way through costs up to two seconds per
  /// read, on the actor that also handles `Stop`. The walk ends at its time
  /// budget and says the tree is incomplete.
  func testASlowAppEndsTheWalkAtItsTimeBudget() {
    var clock = Date(timeIntervalSince1970: 0)
    final class SlowNode: ElementNode {
      let attributes: ElementAttributes
      let children: [SlowNode]
      let advance: () -> Void
      init(
        _ attributes: ElementAttributes, children: [SlowNode] = [], advance: @escaping () -> Void
      ) {
        self.attributes = attributes
        self.children = children
        self.advance = advance
      }
      func readAttributes() -> ElementAttributes {
        advance()
        return attributes
      }
      func readChildren() -> [any ElementNode] { children }
    }
    let advance = { clock.addTimeInterval(2) }
    let children = (0..<50).map { index in
      SlowNode(
        ElementAttributes(
          role: "AXButton", title: "b\(index)",
          frame: CGRect(x: 100, y: 50 + index, width: 10, height: 10)),
        advance: advance)
    }
    let root = SlowNode(
      ElementAttributes(role: "AXWindow", title: "W", frame: windowFrame), children: children,
      advance: advance)
    let walk = ElementTreeWalker.walk(
      root: root, windowFrame: windowFrame, budget: 3, now: { clock })
    XCTAssertTrue(walk.incomplete)
    XCTAssertEqual(walk.elements.count, 2)
    XCTAssertLessThanOrEqual(clock.timeIntervalSince1970, 6)
    let rendered = TreeFormatter.render(
      walk,
      coordinates: ObservationCoordinates(
        cropOrigin: .zero, scale: 1, geometry: Observation.Geometry(width: 800, height: 600)))
    XCTAssertTrue(rendered.truncated)
    XCTAssertEqual(
      rendered.text.components(separatedBy: "\n").last,
      "… this app answered too slowly, so the rest of it is not shown; "
        + "act on what you see or observe again.")
  }

  /// A context menu is a child of the application, not of the window. It is
  /// walked before the window, since an open menu is what the app is showing
  /// first, with window-relative frames like everything else.
  func testAnOpenContextMenuFollowsTheWindowInTheTree() {
    let root = FakeElementNode.node(
      "AXWindow", title: "Notes", frame: windowFrame,
      children: [
        FakeElementNode.node(
          "AXButton", title: "Save", frame: CGRect(x: 512, y: 138, width: 96, height: 28))
      ])
    let menu = FakeElementNode.node(
      "AXMenu", frame: CGRect(x: 300, y: 200, width: 180, height: 60),
      children: [
        FakeElementNode.node(
          "AXMenuItem", title: "Copy", frame: CGRect(x: 300, y: 205, width: 180, height: 22))
      ])
    let walk = ElementTreeWalker.walk(root: root, menus: [menu], windowFrame: windowFrame)
    let rendered = TreeFormatter.render(
      walk,
      coordinates: ObservationCoordinates(
        cropOrigin: .zero, scale: 1, geometry: Observation.Geometry(width: 800, height: 600)))
    XCTAssertEqual(
      rendered.text,
      """
      [0] menu (200,150 180×60)
        [1] menuitem "Copy" (200,155 180×22)
      [2] window "Notes" (0,0 800×600)
        [3] button "Save" (412,88 96×28)
      """)
    XCTAssertFalse(walk.incomplete)
  }

  /// Every read — the children as well as the attributes — waits at most for
  /// what is left of the budget, and none starts once it is spent or the work
  /// was stopped.
  func testEveryReadIsBoundedByWhatIsLeftOfTheBudget() {
    final class TimedNode: ElementNode {
      let attributes: ElementAttributes
      let children: [TimedNode]
      var waits: [TimeInterval] = []
      init(_ attributes: ElementAttributes, children: [TimedNode] = []) {
        self.attributes = attributes
        self.children = children
      }
      func limitWait(to seconds: TimeInterval) { waits.append(seconds) }
      func readAttributes() -> ElementAttributes { attributes }
      func readChildren() -> [any ElementNode] { children }
    }
    var clock = Date(timeIntervalSince1970: 0)
    let child = TimedNode(
      ElementAttributes(
        role: "AXButton", title: "b", frame: CGRect(x: 100, y: 50, width: 10, height: 10)))
    let root = TimedNode(
      ElementAttributes(role: "AXWindow", title: "W", frame: windowFrame), children: [child])
    _ = ElementTreeWalker.walk(
      roots: [WalkRoot(root)], bounds: windowFrame, origin: windowFrame.origin, budget: 3,
      now: {
        defer { clock.addTimeInterval(0.5) }
        return clock
      })
    // Attributes and children of the root, then of the child: four reads,
    // each told the time that was left when it started.
    XCTAssertEqual(root.waits, [2.5, 2.0])
    XCTAssertEqual(child.waits, [1.5, 1.0])

    var stopped = false
    let walk = ElementTreeWalker.walk(
      roots: [WalkRoot(root)], bounds: windowFrame, origin: windowFrame.origin,
      isCancelled: {
        defer { stopped = true }
        return stopped
      })
    XCTAssertTrue(walk.incomplete)
    XCTAssertEqual(walk.elements.count, 1)
  }
}
