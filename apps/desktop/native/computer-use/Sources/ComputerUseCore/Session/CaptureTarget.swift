import ApplicationServices
import CoreGraphics
import Foundation

/// Comparing retained AX identities is local CF equality, with no IPC. Keeping
/// the token alive prevents a reused WindowServer number sharing an old video.
struct AXWindowToken: @unchecked Sendable, Equatable {
  let element: AXUIElement
  static func == (left: Self, right: Self) -> Bool { CFEqual(left.element, right.element) }
}

/// Immutable evidence published when the explicit current window changes.
/// Viewer reads never touch the action snapshot or choose a new app/window.
struct CaptureTarget: Sendable, Equatable {
  let observationId: String
  let app: AppIdentity
  let process: ProcessStamp
  let windowID: CGWindowID
  var windowToken: AXWindowToken? = nil

  func matchesWindow(_ other: CaptureTarget) -> Bool {
    process == other.process && windowID == other.windowID && windowToken == other.windowToken
      && AppCatalog.sameIdentity(app, other.app)
  }
}

/// Session targets cross the work and capture lanes through one short lock.
/// No image bytes are kept here.
final class CaptureTargetStore: @unchecked Sendable {
  private struct SessionTargets {
    var byApp: [String: CaptureTarget] = [:]
  }

  private let targets = Locked<[String: SessionTargets]>([:])

  func publish(_ target: CaptureTarget, for sessionId: String) {
    targets.withLock {
      $0[sessionId, default: SessionTargets()].byApp[target.app.bundleId.lowercased()] = target
    }
  }

  func current(for sessionId: String, appKey: String) -> CaptureTarget? {
    targets.withLock { $0[sessionId]?.byApp[appKey] }
  }

  func contains(_ target: CaptureTarget) -> Bool {
    targets.withLock {
      $0.values.contains { $0.byApp.values.contains { $0.matchesWindow(target) } }
    }
  }

  func remove(_ sessionId: String, appKey: String) {
    targets.withLock {
      $0[sessionId]?.byApp[appKey] = nil
    }
  }

  func remove(_ sessionId: String) {
    targets.withLock { $0[sessionId] = nil }
  }
}
