import ApplicationServices
import CoreGraphics
import Foundation

public enum PermissionState: String, Codable, Sendable {
  case granted
  case denied
}

public enum PermissionPane: String, Decodable, Sendable {
  case screenRecording = "screen-recording"
  case accessibility
}

/// `{accessibility, screenRecording}` — the shape `permissions.get`,
/// `permissions.request` and `hello` all return.
public struct PermissionsState: Codable, Sendable, Equatable {
  public let accessibility: PermissionState
  public let screenRecording: PermissionState

  public var bothGranted: Bool {
    accessibility == .granted && screenRecording == .granted
  }
}

/// The two macOS grants, in the words the product uses for them:
/// `macOS Accessibility` and `macOS Screen Recording`.
public enum Permissions {
  /// Never prompts. `permissions.get` and `hello` both go through here, so a
  /// status read can never put a system dialog in front of the person.
  public static func current() -> PermissionsState {
    PermissionsState(
      accessibility: AXIsProcessTrusted() ? .granted : .denied,
      screenRecording: CGPreflightScreenCaptureAccess() ? .granted : .denied
    )
  }

  /// Protocol 3 clients name no pane and expect their one setup call to ask for
  /// both grants. Keep that wire behavior for an older Stable desktop that
  /// shares this helper with Beta. Protocol 4 requests exactly one named grant.
  public static func requestActions(
    pane: PermissionPane?, permissions: PermissionsState
  ) -> [PermissionPane] {
    if let pane {
      switch pane {
      case .screenRecording where permissions.screenRecording == .denied: return [pane]
      case .accessibility where permissions.accessibility == .denied: return [pane]
      default: return []
      }
    }
    var actions: [PermissionPane] = []
    if permissions.accessibility == .denied { actions.append(.accessibility) }
    if permissions.screenRecording == .denied { actions.append(.screenRecording) }
    return actions
  }

  /// Protocol 4 asks for one named grant. Protocol 3 keeps its established
  /// behavior because an older desktop asks once, then only polls for both.
  @discardableResult
  public static func request(pane: PermissionPane?) -> PermissionsState {
    let before = current()
    for action in requestActions(pane: pane, permissions: before) {
      switch action {
      case .accessibility:
        // The literal is what `kAXTrustedCheckOptionPrompt` holds; the symbol
        // itself imports as a mutable global, which nothing here may read.
        let options = ["AXTrustedCheckOptionPrompt" as CFString: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
      case .screenRecording:
        _ = CGRequestScreenCaptureAccess()
      }
    }
    return current()
  }
}
