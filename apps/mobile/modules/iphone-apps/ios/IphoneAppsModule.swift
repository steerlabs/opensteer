import ExpoModulesCore
import Foundation
import UIKit

private struct PrepareInput: Record {
  @Field var deploymentId: String = ""
}
private struct IssuanceInput: Record {
  @Field var pairing: PairingInput = PairingInput()
  @Field var devicesV1: Bool = false
}
private struct CompleteLeaveInput: Record {
  @Field var runnerId: String = ""
}
private struct SessionBindingInput: Record {
  @Field var deploymentId: String = ""
  @Field var sessionId: String = ""
}
private struct PairingInput: Record {
  @Field var deploymentId: String = ""
  @Field var deploymentName: String = ""
  @Field var hostInstanceId: String = ""
  @Field var hostUrl: String = ""
  var dictionary: [String: String] {
    ["deploymentId": deploymentId, "deploymentName": deploymentName,
      "hostInstanceId": hostInstanceId, "hostUrl": hostUrl]
  }
}
private struct EnrollInput: Record {
  @Field var pairing: PairingInput = PairingInput()
  @Field var enrollmentId: String = ""
  @Field var enrollmentToken: String = ""
  @Field var expiresAt: String = ""
  @Field var name: String = ""
}
private struct ApprovalExpectedInput: Record {
  @Field var definitionId: String = ""
  @Field var access: String = ""
}
private struct ApprovalAnswerInput: Record {
  @Field var setupRequestId: String = ""
  @Field var decision: String = ""
  @Field var expected: ApprovalExpectedInput = ApprovalExpectedInput()
}

public final class IphoneAppsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("IphoneApps")
    Events("onChange", "onBrowserEvent", "onBrowserErasure")
    OnCreate { [weak self] in
      if #available(iOS 17, *) {
        IphoneExecutorRuntime.shared.setObserver { [weak self] snapshot in
          self?.sendEvent("onChange", snapshot)
        }
        IphoneBrowserTransport.shared.setObserver({ [weak self] event in self?.sendEvent("onBrowserEvent", event) },
          erasure: { [weak self] event in self?.sendEvent("onBrowserErasure", event) })
      }
    }
    OnDestroy {
      if #available(iOS 17, *) { IphoneExecutorRuntime.shared.setObserver(nil) }
      if #available(iOS 17, *) { IphoneBrowserTransport.shared.setObserver(nil, erasure: nil) }
    }
    Function("getSnapshot") { () -> [String: Any?] in
      guard #available(iOS 17, *) else { return Self.unsupported("ios-version") }
      return IphoneExecutorRuntime.shared.snapshot()
    }
    Function("disconnect") { () -> [String: String?] in
      guard #available(iOS 17, *) else { return ["deploymentId": nil, "runnerId": nil] }
      return IphoneExecutorRuntime.shared.disconnect()
    }
    Function("leave") { () throws -> [String: String?] in
      guard #available(iOS 17, *) else { return ["deploymentId": nil, "runnerId": nil] }
      do { return try IphoneExecutorRuntime.shared.leave() } catch { throw Self.map(error) }
    }
    AsyncFunction("beginIssuance") { (input: IssuanceInput) throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { try IphoneExecutorRuntime.shared.beginIssuance(pairing: input.pairing.dictionary, devicesV1: input.devicesV1) }
      catch { throw Self.map(error) }
    }
    AsyncFunction("clearRemoved") { () throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { try IphoneExecutorRuntime.shared.clearRemoved() } catch { throw Self.map(error) }
    }
    AsyncFunction("completeLeave") { (input: CompleteLeaveInput) throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { try IphoneExecutorRuntime.shared.completeLeave(runnerId: input.runnerId) }
      catch { throw Self.map(error) }
    }
    AsyncFunction("signSessionBinding") { (input: SessionBindingInput) throws -> [String: String] in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { return try IphoneExecutorRuntime.shared.signSessionBinding(deploymentId: input.deploymentId, sessionId: input.sessionId) }
      catch { throw Self.map(error) }
    }
    AsyncFunction("prepare") { (input: PrepareInput) throws -> [String: String] in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { return try IphoneExecutorRuntime.shared.prepare(deploymentId: input.deploymentId) }
      catch { throw Self.map(error) }
    }
    AsyncFunction("enroll") { (input: EnrollInput) throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do {
        try IphoneExecutorRuntime.shared.enroll(pairing: input.pairing.dictionary,
          enrollmentId: input.enrollmentId, token: input.enrollmentToken,
          expiresAt: input.expiresAt, name: input.name)
      } catch { throw Self.map(error) }
    }
    AsyncFunction("discardPendingEnrollment") { () throws -> [String: String] in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { return try IphoneExecutorRuntime.shared.discardPendingEnrollment() }
      catch { throw Self.map(error) }
    }
    AsyncFunction("retarget") { (pairing: PairingInput) throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { try IphoneExecutorRuntime.shared.retarget(pairing.dictionary) }
      catch { throw Self.map(error) }
    }
    AsyncFunction("requestPermission") { (app: String) async throws -> String in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { return try await IphoneExecutorRuntime.shared.requestPermission(app) }
      catch { throw Self.map(error) }
    }
    AsyncFunction("chooseContacts") { () async throws -> String in
      guard #available(iOS 18, *) else { throw Self.refusal("unsupported") }
      do { return try await IphoneExecutorRuntime.shared.chooseContacts() }
      catch { throw Self.map(error) }
    }
    AsyncFunction("choosePhotos") { () async throws -> String in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      return try await IphoneExecutorRuntime.shared.choosePhotos()
    }

    Function("fenceBrowser") { (_ reason: String) throws -> Int in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      return IphoneBrowserTransport.shared.fence(reason: "manager-fenced")
    }
    AsyncFunction("configureBrowser") { (input: [String: Any]) throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do {
        try IphoneExecutorRuntime.shared.configureBrowser(epoch: Self.epoch(input),
          deploymentId: WireField.string(input, "deploymentId"), runnerId: WireField.string(input, "runnerId"),
          descriptor: WireField.object(input, "descriptor"))
      } catch { throw Self.refusal("busy") }
    }
    AsyncFunction("setBrowserForeground") { (input: [String: Any]) throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      guard PhoneBrowserValidation.boolean(input["active"]), let active = input["active"] as? Bool else { throw Self.refusal("busy") }
      do { try IphoneExecutorRuntime.shared.setBrowserForeground(epoch: Self.epoch(input), active: active) }
      catch { throw Self.refusal("busy") }
    }
    AsyncFunction("verifyAttach") { (input: [String: Any]) throws -> [String: Any] in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { return try IphoneBrowserTransport.shared.connection.verifyAttach(epoch: Self.epoch(input), attachHandle: WireField.string(input, "attachHandle")) }
      catch { throw Self.refusal("forbidden") }
    }
    AsyncFunction("commitAttach") { (input: [String: Any]) throws -> String in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do { return try IphoneBrowserTransport.shared.connection.commitAttach(epoch: Self.epoch(input), attachHandle: WireField.string(input, "attachHandle"),
        claimsDigest: WireField.string(input, "claimsDigest"), replayTransition: WireField.object(input, "replayTransition")) }
      catch { throw Self.refusal("forbidden") }
    }
    AsyncFunction("sendRelay") { (input: [String: Any]) async throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      let epoch = try Self.epoch(input)
      let message = try WireField.object(input, "message")
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        IphoneBrowserTransport.shared.connection.sendRelay(epoch: epoch, message: message) { error in
          if error != nil { continuation.resume(throwing: Self.refusal("forbidden")) }
          else { continuation.resume() }
        }
      }
    }
    AsyncFunction("closeChannel") { (input: [String: Any]) throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      do {
        _ = try WireField.int(input, "code", range: 1000...4999)
        try IphoneBrowserTransport.shared.connection.closeChannel(epoch: Self.epoch(input), channelId: WireField.string(input, "channelId"))
      }
      catch { throw Self.refusal("forbidden") }
    }
    AsyncFunction("retryBrowserErasure") { () -> Void in
      if #available(iOS 17, *) { IphoneExecutorRuntime.shared.retryBrowserErasure() }
    }
    AsyncFunction("attachAgent") { (input: [String: Any]) throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported-operation") }
      do {
        guard input["backend"] as? String == "actions" else { throw PhoneBrowserFailure.forbidden }
        try IphoneBrowserTransport.shared.connection.checkAgent(epoch: Self.epoch(input),
          channelId: WireField.string(input, "channelId"), sessionId: WireField.string(input, "sessionId"),
          attachmentId: WireField.string(input, "attachmentId"), actorToken: WireField.string(input, "actorToken"))
      } catch { throw Self.refusal("forbidden") }
    }
    AsyncFunction("detachAgent") { (input: [String: Any]) throws -> Void in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported-operation") }
      do { try IphoneBrowserTransport.shared.connection.detachAgent(epoch: Self.epoch(input), attachmentId: WireField.string(input, "attachmentId")) }
      catch { throw Self.refusal("forbidden") }
    }

  }

  private static func refusal(_ code: String) -> Exception {
    Exception(name: "IphoneAppsError", description: "This iPhone cannot do that now.", code: code)
  }
  private static func epoch(_ input: [String: Any]) throws -> Int {
    try WireField.int(input, "epoch", range: 0...9_007_199_254_740_991)
  }
  private static func map(_ error: Error) -> Exception {
    if let error = error as? IdentityStoreError {
      switch error {
      case .enrolledElsewhere: return refusal("enrolled-elsewhere")
      case .notPrepared, .missingIdentity, .invalidIdentity: return refusal("not-prepared")
      case .wrongDeployment: return refusal("wrong-deployment")
      case .erasurePending: return refusal("busy")
      }
    }
    if error is HostTargetError { return refusal("invalid-target") }
    return refusal("busy")
  }
  private static func unsupported(_ reason: String) -> [String: Any?] {
    ["revision": 0, "supported": false, "unsupportedReason": reason,
      "deviceName": UIDevice.current.name, "enrollment": nil, "connection": "none",
      "retryAt": nil, "issue": nil, "issueMessage": nil,
      "permissions": Dictionary(uniqueKeysWithValues: InvokeRules.apps.map { ($0, "not-determined") }),
      "locationAccuracy": nil,
      "working": 0]
  }
}

public final class IphoneAppsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private var observations: [NSObjectProtocol] = []
  public func application(_ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    if #available(iOS 17, *) {
      _ = IphoneExecutorRuntime.shared
      for (name, action) in [
        (UIApplication.didBecomeActiveNotification, 0),
        (UIApplication.didEnterBackgroundNotification, 1),
        (UIApplication.willEnterForegroundNotification, 2),
        (UIApplication.willTerminateNotification, 3),
        (UIApplication.willResignActiveNotification, 4),
      ] {
        observations.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
          switch action {
          case 0: IphoneExecutorRuntime.shared.becameActive()
          case 1: IphoneExecutorRuntime.shared.enteredBackground()
          case 2: break // didBecomeActive replaces the transport generation.
          case 4: IphoneExecutorRuntime.shared.browserBecameInactive()
          default: IphoneExecutorRuntime.shared.terminate()
          }
        })
      }
    }
    return true
  }
  deinit { for observer in observations { NotificationCenter.default.removeObserver(observer) } }
}
