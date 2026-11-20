import Foundation
import ApplicationServices

/// Helper-boot identity only. Entries own neither capture nor input authority.
@WorkActor
final class WindowIdentityRegistry<Value> {
  private var entries: [String: Value] = [:]
  private var retired: Set<String> = []

  func retain(_ value: Value, same: (Value, Value) -> Bool) -> String {
    if let existing = entries.first(where: { !retired.contains($0.key) && same($0.value, value) }) {
      return existing.key
    }
    let id = "win_" + UUID().uuidString.lowercased()
    entries[id] = value
    return id
  }

  func resolve(_ id: String) throws -> Value {
    if retired.contains(id) { throw SessionWindows.closed }
    guard let value = entries[id] else {
      throw OwnerViewWindow.Failure(reason: "window-identity-lost")
    }
    return value
  }

  func resolve(_ id: String, inScope: (Value) -> Bool) throws -> Value {
    guard let value = entries[id], !retired.contains(id), inScope(value) else {
      throw SessionWindows.closed
    }
    return value
  }

  func retire(_ id: String) {
    guard entries.removeValue(forKey: id) != nil else { return }
    retired.insert(id)
  }
}

@WorkActor
enum WindowIdentities {
  final class Identity {
    let liveness: WindowLiveness
    var app: AppIdentity?
    var observer: AppAXObserver?
    deinit { observer?.stop() }
    init(_ liveness: WindowLiveness) { self.liveness = liveness }
  }
  static let registry = WindowIdentityRegistry<Identity>()

  static func retain(_ liveness: WindowLiveness, app: AppIdentity? = nil) throws -> String {
    _ = try liveness.read()
    let candidate = Identity(liveness)
    let id = registry.retain(candidate) { left, right in
      !left.liveness.isClosed && left.liveness.process == right.liveness.process
        && CFEqual(left.liveness.element, right.liveness.element)
    }
    let identity = try registry.resolve(id)
    if let app { identity.app = app }
    if identity.observer == nil {
      let lifetime = identity.liveness
      let observer = AppAXObserver(processIdentifier: liveness.process.processIdentifier) {
        _, kind in
        if case .destroyed(let element) = kind,
          CFEqual(element, lifetime.element) {
          lifetime.close()
        }
      }
      if observer.start() {
        observer.watchWindow(liveness.element)
        identity.observer = observer
      }
    }
    return id
  }

  static func app(_ id: String) throws -> AppIdentity {
    guard let app = try registry.resolve(id).app else {
      throw OwnerViewWindow.Failure(reason: "window-identity-lost")
    }
    return app
  }

  static func resolve(_ id: String, process: ProcessStamp? = nil) throws -> WindowLiveness {
    let identity =
      if let process { try registry.resolve(id) { $0.liveness.process == process } }
      else { try registry.resolve(id) }
    do { _ = try identity.liveness.read() }
    catch let error as HelperError where error == SessionWindows.closed {
      registry.retire(id)
      throw error
    }
    return identity.liveness
  }
}
