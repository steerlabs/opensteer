import AppKit
import ApplicationServices
import CoreMedia
@preconcurrency import ScreenCaptureKit

private final class SharingProbeOutput: NSObject, SCStreamOutput {
  let count = Locked(0)
  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer,
              of type: SCStreamOutputType) {
    if type == .screen { count.withLock { $0 += 1 } }
  }
}

@WorkActor enum SharingEvidence {
  static func run(pid: pid_t, root: CGWindowID, out: URL) async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let window = try content.windows.first { $0.windowID == root }.unwrap("sharing probe root")
    let config = SCStreamConfiguration()
    config.width = max(2, Int(window.frame.width) / 2 * 2)
    config.height = max(2, Int(window.frame.height) / 2 * 2)
    config.showsCursor = false
    config.queueDepth = 3
    let output = SharingProbeOutput()
    let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window),
      configuration: config, delegate: nil)
    try stream.addStreamOutput(output, type: .screen,
      sampleHandlerQueue: DispatchQueue(label: "sharing-composition-evidence"))
    try await stream.startCapture()
    do {
      try await Task.sleep(nanoseconds: 500_000_000)
      try await save(pid: pid, root: root, stage: "sharing-chrome", out: out)
      try await Contracts.command(out, "small-child")
      try await save(pid: pid, root: root, stage: "real-small-child", out: out)
      try await Contracts.command(out, "owner-close-child")
      try require(output.count.current > 0, "Independent sharing probe received no screen samples")
      try await stream.stopCapture()
    } catch {
      try? await stream.stopCapture()
      throw error
    }
  }

  private static func save(pid: pid_t, root: CGWindowID, stage: String, out: URL) async throws {
    let app = AXUIElementCreateApplication(pid)
    let windows = AXValueReader.copyElements(app, kAXWindowsAttribute).map { element -> [String: Any] in
      ["id": KeyWindow.windowID(of: element) ?? 0,
        "role": AXValueReader.copyString(element, kAXRoleAttribute) ?? "",
        "subrole": AXValueReader.copyString(element, kAXSubroleAttribute) ?? "",
        "identifier": AXValueReader.copyString(element, kAXIdentifierAttribute) ?? "",
        "frame": AXValueReader.copyFrame(element).map(NSStringFromRect) ?? ""]
    }
    let stack = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    let owned = stack.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let shareable = content.windows.filter { $0.owningApplication?.processID == pid }.map {
      ["id": $0.windowID, "frame": NSStringFromRect($0.frame), "onScreen": $0.isOnScreen,
        "layer": $0.windowLayer, "title": $0.title ?? ""] as [String: Any]
    }
    let nativeRows = (try? String(contentsOf: out.appendingPathComponent("native-window-inventory.jsonl"), encoding: .utf8))?
      .split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? []
    let chromeIDs = Set(nativeRows.filter { $0["class"] as? String == "NSLocalWindowSharingWindow" }
      .compactMap { ($0["id"] as? NSNumber)?.uint32Value })
    let rootElement = AXValueReader.copyElements(app, kAXWindowsAttribute).first { KeyWindow.windowID(of: $0) == root }
    var rootButtons: [String: AXUIElement] = [:]
    if let rootElement {
      for name in [kAXCloseButtonAttribute, kAXMinimizeButtonAttribute, kAXZoomButtonAttribute, kAXFullScreenButtonAttribute] {
        rootButtons[name] = AXValueReader.copyElement(rootElement, name)
      }
    }
    func metadata(_ element: AXUIElement, depth: Int = 0) -> [String: Any] {
      var names: CFArray?
      _ = AXUIElementCopyAttributeNames(element, &names)
      var actions: CFArray?
      _ = AXUIElementCopyActionNames(element, &actions)
      var parameterized: CFArray?
      _ = AXUIElementCopyParameterizedAttributeNames(element, &parameterized)
      var result: [String: Any] = ["actions": actions as? [String] ?? [],
        "parameterized": parameterized as? [String] ?? [], "attributes": names as? [String] ?? [],
        "id": KeyWindow.windowID(of: element) ?? 0,
        "rootControls": rootButtons.filter { CFEqual($0.value, element) }.map(\.key)]
      for name in names as? [String] ?? [] where name != kAXValueAttribute && name != kAXSelectedTextAttribute {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success,
          let value else { continue }
        if let text = value as? String { result[name] = text }
        else if let number = value as? NSNumber { result[name] = number }
        else if CFGetTypeID(value) == AXUIElementGetTypeID() {
          let node = unsafeBitCast(value, to: AXUIElement.self)
          result[name] = ["id": KeyWindow.windowID(of: node) ?? 0,
            "role": AXValueReader.copyString(node, kAXRoleAttribute) ?? ""]
        }
        var settable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success {
          result[name + "Settable"] = settable.boolValue
        }
      }
      if depth < 5 { result["children"] = AXElementNode.children(of: element).prefix(32).map { metadata($0, depth: depth + 1) } }
      return result
    }
    let chrome = AXValueReader.copyElements(app, kAXWindowsAttribute).filter {
      KeyWindow.windowID(of: $0).map(chromeIDs.contains) == true
    }.map { metadata($0) }
    try JSONSerialization.data(withJSONObject: ["stage": stage, "rootPID": pid,
      "AXWindows": windows, "windowServer": owned, "shareable": shareable, "sharingChromeAX": chrome,
        "rootControls": rootButtons.mapValues { metadata($0) }],
      options: [.prettyPrinted, .sortedKeys])
      .write(to: out.appendingPathComponent(stage + "-composition.json"))
  }
}
