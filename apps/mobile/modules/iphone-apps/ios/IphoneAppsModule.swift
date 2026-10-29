import ExpoModulesCore
import Foundation
import UIKit

private struct PrepareInput: Record {
  @Field var deploymentId: String = ""
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
    Events("onChange")
    OnCreate { [weak self] in
      if #available(iOS 17, *) {
        IphoneExecutorRuntime.shared.setObserver { [weak self] snapshot in
          self?.sendEvent("onChange", snapshot)
        }
      }
    }
    OnDestroy {
      if #available(iOS 17, *) { IphoneExecutorRuntime.shared.setObserver(nil) }
    }
    Function("getSnapshot") { () -> [String: Any?] in
      guard #available(iOS 17, *) else { return Self.unsupported("ios-version") }
      return IphoneExecutorRuntime.shared.snapshot()
    }
    Function("disconnect") { () -> [String: String?] in
      guard #available(iOS 17, *) else { return ["deploymentId": nil, "runnerId": nil] }
      return IphoneExecutorRuntime.shared.disconnect()
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
    AsyncFunction("answerApproval") { (input: ApprovalAnswerInput) async throws -> [String: Any] in
      guard #available(iOS 17, *) else { throw Self.refusal("unsupported") }
      guard input.decision == "allow" || input.decision == "deny" else { throw Self.refusal("unsupported") }
      return await IphoneExecutorRuntime.shared.answerApproval(requestId: input.setupRequestId,
        decision: input.decision, definitionId: input.expected.definitionId,
        access: input.expected.access)
    }
  }

  private static func refusal(_ code: String) -> Exception {
    Exception(name: "IphoneAppsError", description: "This iPhone cannot do that now.", code: code)
  }
  private static func map(_ error: Error) -> Exception {
    if let error = error as? IdentityStoreError {
      switch error {
      case .enrolledElsewhere: return refusal("enrolled-elsewhere")
      case .notPrepared, .missingIdentity, .invalidIdentity: return refusal("not-prepared")
      case .wrongDeployment: return refusal("wrong-deployment")
      }
    }
    if error is HostTargetError { return refusal("invalid-target") }
    return refusal("busy")
  }
  private static func unsupported(_ reason: String) -> [String: Any?] {
    ["revision": 0, "supported": false, "unsupportedReason": reason,
      "deviceName": UIDevice.current.name, "enrollment": nil, "connection": "none",
      "retryAt": nil, "issue": nil, "issueMessage": nil, "approvalKey": nil,
      "permissions": Dictionary(uniqueKeysWithValues: InvokeRules.apps.map { ($0, "not-determined") }),
      "locationAccuracy": nil,
      "approvals": [[String: Any]](), "working": 0]
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
      ] {
        observations.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
          switch action {
          case 0: IphoneExecutorRuntime.shared.becameActive()
          case 1: IphoneExecutorRuntime.shared.enteredBackground()
          case 2: break // didBecomeActive replaces the transport generation.
          default: IphoneExecutorRuntime.shared.terminate()
          }
        })
      }
    }
    return true
  }
  deinit { for observer in observations { NotificationCenter.default.removeObserver(observer) } }
}
