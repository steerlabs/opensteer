import Foundation

/// Connection-bound passive authority. It never enters SessionRegistry or owns an action snapshot.
@MainActor
final class OwnerViewRegistry {
  final class View {
    let id: String
    let generation: Int
    let connectionID: Int
    let app: AppIdentity
    let requestedWindowID: UInt32?
    let captureTargetId = UUID().uuidString
    let videoLease: MacVideoLease
    var expiresAt: TimeInterval
    var closed = false
    var target: CaptureTarget?
    var window: OwnerViewWindow.Binding?
    var unavailableReason = "window-unreadable"
    var prepared = false
    var windowSummary: Wire.ViewStateResult.OwnerWindowSummary?
    let cancellation = SessionCancellation()

    init(id: String, generation: Int, expiresAt: TimeInterval, app: AppIdentity, connectionID: Int, requestedWindowID: UInt32?)
    {
      self.id = id
      self.generation = generation
      self.expiresAt = expiresAt
      self.videoLease = MacVideoLease(expiresAt: expiresAt)
      self.app = app
      self.requestedWindowID = requestedWindowID
      self.connectionID = connectionID
    }
  }

  private var views: [String: View] = [:]

  func open(
    id: String, generation: Int, leaseDurationMs: Int, app: AppIdentity, connectionID: Int,
    windowID: UInt32? = nil,
    now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) throws -> View {
    prune(now: now)
    guard generation > 0, leaseDurationMs > 0, leaseDurationMs <= 600_000 else {
      throw HelperError(.noSession, "That owner view has expired.")
    }
    if let old = views[id] {
      guard old.connectionID == connectionID, generation >= old.generation else {
        throw HelperError(
          .noSession, "That owner view belongs to another connection or generation.")
      }
      if generation == old.generation {
        guard !old.closed, AppCatalog.sameIdentity(old.app, app), old.requestedWindowID == windowID else {
          throw HelperError(.noSession, "That owner view has ended or changed identity.")
        }
        return old
      }
      old.videoLease.close()
      old.closed = true
      old.cancellation.cancel(.closed)
    }
    guard views[id] != nil || views.count < 64 else {
      throw HelperError(.busy, "This Mac already has as many owner views as it can keep.")
    }
    let view = View(
      id: id, generation: generation, expiresAt: now + Double(leaseDurationMs) / 1_000, app: app,
      connectionID: connectionID, requestedWindowID: windowID)
    views[id] = view
    return view
  }

  func require(
    _ id: String, generation: Int, connectionID: Int,
    now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) throws -> View {
    guard let view = views[id], !view.closed, view.generation == generation,
      view.connectionID == connectionID, view.expiresAt > now
    else {
      throw HelperError(.noSession, "That owner view has ended.")
    }
    return view
  }

  func renew(
    _ id: String, generation: Int, leaseDurationMs: Int, connectionID: Int,
    now: TimeInterval = ProcessInfo.processInfo.systemUptime
  )
    throws -> View
  {
    let view = try require(id, generation: generation, connectionID: connectionID, now: now)
    guard leaseDurationMs > 0, leaseDurationMs <= 600_000 else {
      throw HelperError(.noSession, "That owner renewal has expired.")
    }
    view.expiresAt = max(view.expiresAt, now + Double(leaseDurationMs) / 1_000)
    view.videoLease.renew(view.expiresAt)
    return view
  }

  func close(_ id: String, generation: Int, connectionID: Int) throws {
    guard let view = views[id], view.generation == generation, view.connectionID == connectionID
    else {
      throw HelperError(.noSession, "That owner view has ended.")
    }
    view.videoLease.close()
    view.closed = true
    view.cancellation.cancel(.closed)
    view.target = nil
    view.window = nil
  }

  func contains(_ target: CaptureTarget) -> Bool {
    let now = ProcessInfo.processInfo.systemUptime
    return views.values.contains {
      !$0.closed && $0.expiresAt > now && $0.target?.matchesWindow(target) == true
    }
  }

  func remove(connectionID: Int) {
    for view in views.values where view.connectionID == connectionID {
      view.videoLease.close()
      view.closed = true
      view.cancellation.cancel(.closed)
    }
    views = views.filter { $0.value.connectionID != connectionID }
  }

  func prune(now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
    for view in views.values where view.expiresAt <= now {
      view.videoLease.close()
      view.closed = true
      view.cancellation.cancel(.closed)
      view.target = nil
      view.window = nil
    }
    views = views.filter { $0.value.expiresAt > now }
  }
}
