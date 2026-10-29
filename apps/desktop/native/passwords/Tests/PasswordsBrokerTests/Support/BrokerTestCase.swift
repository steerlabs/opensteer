import PasswordsCore
import XCTest
@testable import PasswordsBrokerKit

/// Each test gets its own broker on its own socket; its frames are one
/// scenario of the run's artifact.
@MainActor
class BrokerTestCase: XCTestCase {
  var harness: BrokerHarness!

  override func setUp() async throws {
    Artifact.begin(name)
    harness = try BrokerHarness()
    try await harness.start()
  }

  /// Replaces the harness, for a test that needs another kind.
  func restart(_ make: () throws -> BrokerHarness) async throws {
    await harness.stop()
    harness = try make()
    try await harness.start()
  }

  override func tearDown() async throws {
    await harness?.stop()
    harness = nil
    Artifact.write()
  }

  var broker: Broker { harness.broker }
  var presence: ScriptedPresence { harness.presence }

  /// A greeted desktop's request, answered: the decision.
  func request(
    _ desktop: TestClient, _ id: String, site: String = "https://example.com", session: String = Fixtures.session,
    workspace: (String, String) = Fixtures.workspace
  ) async throws -> JSONValue {
    let reply = try await desktop.call("signin.request", Fixtures.request(id, site: site, session: session, workspace: workspace))
    return try XCTUnwrap(reply.result, "signin.request answered \(reply)")
  }

  /// `XCTAssertEqual` without an autoclosure, so `try await` can be an argument.
  func same<T: Equatable>(
    _ actual: T, _ expected: T, _ message: String = "", file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertEqual(actual, expected, message, file: file, line: line)
  }

  /// `XCTUnwrap` without an autoclosure, so `try await` can be its argument.
  func unwrap<T>(_ value: T?, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) throws -> T {
    try XCTUnwrap(value, message, file: file, line: line)
  }

  /// `XCTAssertTrue` without an autoclosure.
  func holds(_ condition: Bool, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(condition, message, file: file, line: line)
  }

  func present<T>(_ value: T?, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertNotNil(value, message, file: file, line: line)
  }
}
