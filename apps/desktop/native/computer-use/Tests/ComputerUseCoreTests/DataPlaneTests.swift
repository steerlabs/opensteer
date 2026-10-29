import XCTest

@testable import ComputerUseCore
@testable import ComputerUseTestSupport

/// Every way one `data.invoke` can be refused before or after it reaches an
/// app, written before the data plane: the helper checks what the Host
/// resolved on the call itself rather than trusting every hop before it.
final class DataPlaneTests: XCTestCase {
  private let readContract = String(repeating: "r", count: 43)
  private let writeContract = String(repeating: "w", count: 43)

  /// Reads need Full Disk Access and changes need Automation, as Messages'
  /// do, so each operation is held to its own grant.
  private func plane(
    grant: DataGrantState = .granted,
    reads: DataGrantState? = nil,
    writes: DataGrantState? = nil,
    restarting: Set<DataGrant> = [],
    reader: FakeGrants? = nil,
    provider: FakeDataProvider = FakeDataProvider()
  ) -> DataPlane {
    DataPlane(
      contracts: [
        "fake-app": [
          "read_thing": DataOperationContract(contract: readContract, effect: .read),
          "write_thing": DataOperationContract(contract: writeContract, effect: .write),
        ]
      ],
      grants: ["fake-app": DataAppGrants(read: .fullDiskAccess, write: .automation)],
      providers: ["fake-app": provider],
      grantReader: reader
        ?? FakeGrants(
          [
            .automation: writes ?? grant, .calendars: .denied, .contacts: .denied,
            .fullDiskAccess: reads ?? grant, .reminders: .denied,
          ],
          restarting: restarting)
    )
  }

  private func invocation(
    definitionId: String = "fake-app",
    operation: String = "read_thing",
    contract: String? = nil,
    effect: DataEffect = .read,
    access: DataAccess = .read
  ) -> Wire.DataInvokeParams {
    Wire.DataInvokeParams(
      access: access,
      arguments: [:],
      contract: contract ?? (effect == .read ? readContract : writeContract),
      definitionId: definitionId,
      effect: effect,
      operation: operation
    )
  }

  private func refusal(
    _ plane: DataPlane, _ params: Wire.DataInvokeParams
  ) async -> HelperError? {
    do {
      _ = try await plane.invoke(params, budget: .unlimited)
      return nil
    } catch let error as HelperError {
      return error
    } catch {
      XCTFail("Only helper errors may leave the data plane, not \(error)")
      return nil
    }
  }

  func testAnAppThisHelperDoesNotServeIsUnsupported() async {
    let error = await refusal(plane(), invocation(definitionId: "other-app"))
    XCTAssertEqual(error?.code, .unsupported)
  }

  func testAnOperationTheAppDoesNotHaveIsUnsupported() async {
    let error = await refusal(plane(), invocation(operation: "delete_everything"))
    XCTAssertEqual(error?.code, .unsupported)
  }

  func testAContractFromAnotherVersionIsRefusedBeforeTheApp() async {
    let provider = FakeDataProvider()
    let error = await refusal(
      plane(provider: provider), invocation(contract: String(repeating: "x", count: 43)))
    XCTAssertEqual(error?.code, .unsupported)
    XCTAssertEqual(error?.message, "This operation comes from a different Opensteer version.")
    XCTAssertEqual(provider.calls, 0)
  }

  func testAnEffectThatDisagreesWithTheContractIsRefused() async {
    let provider = FakeDataProvider()
    let error = await refusal(
      plane(provider: provider),
      invocation(operation: "read_thing", contract: readContract, effect: .write,
        access: .readWrite))
    XCTAssertEqual(error?.code, .unsupported)
    XCTAssertEqual(provider.calls, 0)
  }

  func testAWriteUnderReadAccessNeverReachesTheApp() async {
    let provider = FakeDataProvider()
    let error = await refusal(
      plane(provider: provider), invocation(operation: "write_thing", effect: .write))
    XCTAssertEqual(error?.code, .failed)
    XCTAssertEqual(error?.message, "This app is read only.")
    XCTAssertEqual(provider.calls, 0)
  }

  func testAMissingGrantIsPermissionRequiredAndNeverPrompts() async {
    for state in [DataGrantState.requestable, .denied] {
      let provider = FakeDataProvider()
      let error = await refusal(plane(grant: state, provider: provider), invocation())
      XCTAssertEqual(error?.code, .permissionRequired)
      XCTAssertEqual(provider.calls, 0)
    }
  }

  func testEachOperationIsHeldToTheGrantItsEffectNeeds() async {
    let readsOnly = plane(reads: .granted, writes: .requestable)
    let read = await refusal(readsOnly, invocation())
    XCTAssertNil(read)
    let write = invocation(operation: "write_thing", effect: .write, access: .readWrite)
    let refused = await refusal(readsOnly, write)
    XCTAssertEqual(refused?.code, .permissionRequired)
    XCTAssertEqual(
      refused?.message,
      "Sending in Messages needs macOS Automation permission for Opensteer Computer Use.")
    let writesOnly = plane(reads: .denied, writes: .granted)
    let written = await refusal(writesOnly, write)
    XCTAssertNil(written)
    let unread = await refusal(writesOnly, invocation())
    XCTAssertEqual(
      unread?.message, "Reading Messages needs macOS Full Disk Access for Opensteer Computer Use.")
  }

  /// A read asks macOS about its own grant and nothing else: every other grant
  /// is a question macOS may be holding for the person, and a read must not
  /// wait behind it.
  func testAReadAsksMacOSOnlyAboutItsOwnGrant() async {
    let reader = FakeGrants([.fullDiskAccess: .granted, .automation: .requestable])
    let read = await refusal(plane(reader: reader), invocation())
    XCTAssertNil(read)
    XCTAssertEqual(reader.askedAbout, [.fullDiskAccess])
  }

  /// The person switched the grant on after this helper started. macOS gives
  /// it to the next launch, which the helper is about to be, so a read now is
  /// one to retry in a moment rather than a grant to go and find.
  func testAGrantGivenAfterLaunchIsARetryNotAPermissionError() async {
    let provider = FakeDataProvider()
    let error = await refusal(
      plane(reads: .denied, restarting: [.fullDiskAccess], provider: provider), invocation())
    XCTAssertEqual(error?.code, .failed)
    XCTAssertEqual(
      error?.message, "Opensteer Computer Use is restarting to finish setup. Try again in a moment.")
    XCTAssertEqual(provider.calls, 0)
  }

  /// The read that finds the grant given after launch is what starts the
  /// restart, so it is a retry too, not a grant to go and find.
  func testTheReadThatFindsAGrantGivenAfterLaunchIsItselfARetry() async {
    let provider = FakeDataProvider()
    let reader = FakeGrants(
      [
        .automation: .granted, .calendars: .denied, .contacts: .denied,
        .fullDiskAccess: .denied, .reminders: .denied,
      ],
      discovering: [.fullDiskAccess])
    let error = await refusal(plane(reader: reader, provider: provider), invocation())
    XCTAssertEqual(error?.code, .failed)
    XCTAssertEqual(
      error?.message, "Opensteer Computer Use is restarting to finish setup. Try again in a moment.")
    XCTAssertEqual(provider.calls, 0)
  }

  /// A grant macOS will not report yet is the app's to settle before it acts.
  func testAGrantMacOSCannotReportYetReachesTheAppToSettle() async {
    let provider = FakeDataProvider()
    let write = invocation(operation: "write_thing", effect: .write, access: .readWrite)
    let refused = await refusal(plane(writes: .unknown, provider: provider), write)
    XCTAssertNil(refused)
    XCTAssertEqual(provider.calls, 1)
  }

  func testAnUnexpectedReadFailureIsAPlainFailure() async {
    let provider = FakeDataProvider(failure: FakeFailure())
    let error = await refusal(plane(provider: provider), invocation())
    XCTAssertEqual(error?.code, .failed)
  }

  func testAnUnexpectedWriteFailureMayHaveHappened() async {
    let provider = FakeDataProvider(failure: FakeFailure())
    let error = await refusal(
      plane(provider: provider),
      invocation(operation: "write_thing", effect: .write, access: .readWrite))
    XCTAssertEqual(error?.code, .outcomeUnknown)
  }

  func testTheAppsOwnRefusalPassesThroughUnchanged() async {
    let said = HelperError(.failed, "No reminder list has that id.")
    let provider = FakeDataProvider(failure: said)
    let error = await refusal(plane(provider: provider), invocation())
    XCTAssertEqual(error, said)
  }

  func testAnAnswerComesBackAsTheAppWroteIt() async throws {
    let provider = FakeDataProvider(value: .object(["things": .array([.string("one")])]))
    let value = try await plane(provider: provider).invoke(invocation(), budget: .unlimited)
    XCTAssertEqual(value, .object(["things": .array([.string("one")])]))
    XCTAssertEqual(provider.calls, 1)
    XCTAssertEqual(provider.lastOperation, "read_thing")
  }
}

private struct FakeFailure: Error {}

private final class FakeDataProvider: DataProvider, @unchecked Sendable {
  private let lock = NSLock()
  private let failure: (any Error)?
  private let value: JSONValue
  private var callCount = 0
  private var operation: String?

  init(failure: (any Error)? = nil, value: JSONValue = .object([:])) {
    self.failure = failure
    self.value = value
  }

  var calls: Int { lock.withLock { callCount } }
  var lastOperation: String? { lock.withLock { operation } }

  func invoke(
    operation: String, arguments: [String: JSONValue], budget: WorkBudget
  ) async throws -> JSONValue {
    lock.withLock {
      callCount += 1
      self.operation = operation
    }
    if let failure { throw failure }
    return value
  }
}
