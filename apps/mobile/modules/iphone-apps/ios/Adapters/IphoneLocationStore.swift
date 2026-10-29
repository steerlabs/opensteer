import CoreLocation
import Foundation
import UIKit
import OpensteerAppleData

/// One foreground-only manager shared by permission UI and all agent reads.
@MainActor
final class IphoneLocationStore: NSObject, IphoneLocationPort, @preconcurrency CLLocationManagerDelegate {
  private let manager = CLLocationManager()
  private var permissionWaiters: [CheckedContinuation<IphonePermission, Never>] = []
  var onChange: (@MainActor @Sendable (IphoneLocationEvent) -> Void)?
  var foreground: Bool { UIApplication.shared.applicationState != .background }
  var precise: Bool { manager.accuracyAuthorization == .fullAccuracy }
  var cachedLocation: IphoneLocationFix? { manager.location.map(Self.fix) }
  var permission: IphonePermission {
    switch manager.authorizationStatus {
    case .authorizedAlways, .authorizedWhenInUse: return .granted
    case .notDetermined: return .notDetermined
    case .denied: return .denied
    case .restricted: return .restricted
    @unknown default: return .denied
    }
  }
  override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBest
    NotificationCenter.default.addObserver(self, selector: #selector(backgrounded),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
  }
  deinit { NotificationCenter.default.removeObserver(self) }

  /// Call only from the person's explicit permission action, never an invoke.
  func requestPermissionFromPersonTap() async -> IphonePermission {
    guard permission == .notDetermined, foreground else { return permission }
    return await withCheckedContinuation { continuation in
      permissionWaiters.append(continuation)
      if permissionWaiters.count == 1 { manager.requestWhenInUseAuthorization() }
    }
  }
  func startUpdating() {
    guard foreground, permission == .granted else { onChange?(.stateChanged); return }
    manager.startUpdatingLocation()
  }
  func stopUpdating() { manager.stopUpdatingLocation() }
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if permission != .notDetermined {
      let pending = permissionWaiters
      permissionWaiters.removeAll()
      for continuation in pending { continuation.resume(returning: permission) }
    }
    onChange?(.stateChanged)
  }
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    onChange?(.fixes(locations.map(Self.fix)))
  }
  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Core Location treats locationUnknown as transient while searching for a fix.
    if (error as? CLError)?.code == .locationUnknown { return }
    onChange?(.stateChanged)
    onChange?(.failed)
  }
  @objc private func backgrounded() {
    manager.stopUpdatingLocation()
    onChange?(.stateChanged)
  }
  private static func fix(_ location: CLLocation) -> IphoneLocationFix {
    IphoneLocationFix(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
      horizontalAccuracyMeters: location.horizontalAccuracy, capturedAt: location.timestamp)
  }
}

/// Creation stays on the main actor even when the Runner starts before JS.
@MainActor
enum IphoneLocationRuntime {
  static let store = IphoneLocationStore()
  static let provider = IphoneLocationProvider(store: store)
}

struct IphoneLocationAdapter: DataProvider {
  func invoke(operation: String, arguments: [String: JSONValue], budget: WorkBudget) async throws -> JSONValue {
    try await IphoneLocationRuntime.provider.invoke(operation: operation, arguments: arguments, budget: budget)
  }
}
