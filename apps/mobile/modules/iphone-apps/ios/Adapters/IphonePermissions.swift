import Contacts
import ContactsUI
import EventKit
import Foundation
import Photos
import PhotosUI
import SwiftUI
import UIKit

@available(iOS 17, *)
final class IphonePermissions {
  private var events = EKEventStore()
  @MainActor
  func current(_ app: String) -> IphonePermission {
    switch app {
    case "apple-calendar":
      return Self.event(EKEventStore.authorizationStatus(for: .event))
    case "apple-reminders":
      return Self.event(EKEventStore.authorizationStatus(for: .reminder))
    case "apple-contacts":
      let status = CNContactStore.authorizationStatus(for: .contacts)
      if #available(iOS 18, *), status == .limited { return .limited }
      switch status {
      case .authorized: return .granted
      case .notDetermined: return .notDetermined
      case .denied: return .denied
      case .restricted: return .restricted
      @unknown default: return .denied
      }
    case "iphone-location": return IphoneLocationRuntime.store.permission
    case "iphone-photos":
      switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
      case .authorized: return .granted
      case .limited: return .limited
      case .notDetermined: return .notDetermined
      case .denied: return .denied
      case .restricted: return .restricted
      @unknown default: return .denied
      }
    default: return .restricted
    }
  }
  @MainActor var locationAccuracy: String? {
    guard current("iphone-location") == .granted else { return nil }
    return IphoneLocationRuntime.store.precise ? "precise" : "approximate"
  }
  @MainActor
  func all() -> [String: IphonePermission] {
    Dictionary(uniqueKeysWithValues: InvokeRules.apps.map { ($0, current($0)) })
  }
  @MainActor
  func request(_ app: String) async -> IphonePermission {
    switch app {
    case "apple-calendar": _ = try? await events.requestFullAccessToEvents()
    case "apple-reminders": _ = try? await events.requestFullAccessToReminders()
    case "apple-contacts": _ = try? await CNContactStore().requestAccess(for: .contacts)
    case "iphone-location": _ = await IphoneLocationRuntime.store.requestPermissionFromPersonTap()
    case "iphone-photos": _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    default: return .restricted
    }
    // EventKit caches its initial authorization. A fresh store observes the grant.
    events = EKEventStore()
    return current(app)
  }
  @MainActor
  func chooseContacts() async -> IphonePermission {
    guard #available(iOS 18, *), current("apple-contacts") == .limited,
      let top = Self.topController() else { return current("apple-contacts") }
    await withCheckedContinuation { continuation in
      let holder = UIHostingController(rootView: LimitedContactsPicker {
        top.dismiss(animated: true) { continuation.resume() }
      })
      holder.modalPresentationStyle = .overFullScreen
      holder.view.backgroundColor = .clear
      top.present(holder, animated: false)
    }
    return current("apple-contacts")
  }
  @MainActor
  func choosePhotos() async -> IphonePermission {
    guard current("iphone-photos") == .limited, let top = Self.topController() else {
      return current("iphone-photos")
    }
    _ = await PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top)
    return current("iphone-photos")
  }
  private static func event(_ status: EKAuthorizationStatus) -> IphonePermission {
    switch status {
    case .fullAccess: return .granted
    case .writeOnly: return .writeOnly
    case .notDetermined: return .notDetermined
    case .denied: return .denied
    case .restricted: return .restricted
    @unknown default: return .denied
    }
  }
  @MainActor private static func topController() -> UIViewController? {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
      let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else { return nil }
    var top = root
    while let shown = top.presentedViewController { top = shown }
    return top
  }
}

@available(iOS 18, *)
private struct LimitedContactsPicker: View {
  @State private var presented = false
  let onDone: () -> Void
  var body: some View {
    Color.clear
      .onAppear { presented = true }
      .contactAccessPicker(isPresented: $presented) { _ in onDone() }
  }
}
