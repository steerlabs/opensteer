import Foundation
import XCTest

@testable import ComputerUseCore

@MainActor
final class HelperReplacementTests: XCTestCase {
  func testNoCanonicalHelperNeedsNoTermination() {
    XCTAssertTrue(
      HelperReplacement.prepare(
        applications: [],
        currentProcessIdentifier: 9,
        identifies: canonicalIdentity,
        validates: { _ in false }
      )
    )
  }

  func testOnlyTheExactCanonicalHelperIsTerminated() {
    let canonical = FakeReplacementApplication(
      bundleURL: HelperPaths.application,
      executableURL: HelperPaths.executable,
      processIdentifier: 41,
      terminates: true
    )
    let otherCopy = FakeReplacementApplication(
      bundleURL: URL(fileURLWithPath: "/Applications/Opensteer Computer Use.app"),
      executableURL: URL(
        fileURLWithPath:
          "/Applications/Opensteer Computer Use.app/Contents/MacOS/Opensteer Computer Use"
      ),
      processIdentifier: 42,
      terminates: true
    )
    let currentProcess = FakeReplacementApplication(
      bundleURL: HelperPaths.application,
      executableURL: HelperPaths.executable,
      processIdentifier: 43,
      terminates: true
    )

    XCTAssertTrue(
      HelperReplacement.prepare(
        applications: [canonical, otherCopy, currentProcess],
        currentProcessIdentifier: 43,
        identifies: { url in
          if let identity = self.canonicalIdentity(url) { return identity }
          if url.lastPathComponent == "Opensteer Computer Use.app" {
            return ReplacementFileIdentity(device: 2, inode: 200)
          }
          if url.lastPathComponent == "Opensteer Computer Use" {
            return ReplacementFileIdentity(device: 2, inode: 201)
          }
          return nil
        },
        validates: { _ in true }
      )
    )
    XCTAssertEqual(canonical.terminationRequests, 1)
    XCTAssertEqual(otherCopy.terminationRequests, 0)
    XCTAssertEqual(currentProcess.terminationRequests, 0)
  }

  func testCanonicalHelperReportedThroughACaseAliasIsTerminated() {
    let aliasBundle = URL(
      fileURLWithPath:
        NSHomeDirectory()
        + "/Library/Application Support/opensteer/Computer Use/Opensteer Computer Use.app")
    let aliasExecutable = aliasBundle.appendingPathComponent(
      "Contents/MacOS/Opensteer Computer Use")
    let application = FakeReplacementApplication(
      bundleURL: aliasBundle,
      executableURL: aliasExecutable,
      processIdentifier: 44,
      terminates: true
    )
    let bundleIdentity = ReplacementFileIdentity(device: 1, inode: 100)
    let executableIdentity = ReplacementFileIdentity(device: 1, inode: 101)

    XCTAssertTrue(
      HelperReplacement.prepare(
        applications: [application],
        currentProcessIdentifier: 9,
        identifies: { url in
          switch url.lastPathComponent {
          case "Opensteer Computer Use.app": bundleIdentity
          case "Opensteer Computer Use": executableIdentity
          default: nil
          }
        },
        validates: { _ in true }
      )
    )
    XCTAssertEqual(application.terminationRequests, 1)
  }

  func testCaseVariantThatIsADifferentFilesystemItemIsNotTerminated() {
    let otherBundle = URL(
      fileURLWithPath:
        NSHomeDirectory()
        + "/Library/Application Support/opensteer/Computer Use/Opensteer Computer Use.app")
    let otherExecutable = otherBundle.appendingPathComponent(
      "Contents/MacOS/Opensteer Computer Use")
    let application = FakeReplacementApplication(
      bundleURL: otherBundle,
      executableURL: otherExecutable,
      processIdentifier: 45,
      terminates: true
    )
    let canonicalBundle = HelperPaths.application.standardizedFileURL.path
    let canonicalExecutable = HelperPaths.executable.standardizedFileURL.path

    XCTAssertTrue(
      HelperReplacement.prepare(
        applications: [application],
        currentProcessIdentifier: 9,
        identifies: { url in
          if url.path == canonicalBundle {
            return ReplacementFileIdentity(device: 1, inode: 100)
          }
          if url.path == canonicalExecutable {
            return ReplacementFileIdentity(device: 1, inode: 101)
          }
          if url.lastPathComponent == "Opensteer Computer Use.app" {
            return ReplacementFileIdentity(device: 2, inode: 100)
          }
          if url.lastPathComponent == "Opensteer Computer Use" {
            return ReplacementFileIdentity(device: 2, inode: 101)
          }
          return nil
        },
        validates: { _ in true }
      )
    )
    XCTAssertEqual(application.terminationRequests, 0)
  }

  func testRealFilesystemAliasesUseKernelIdentity() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "opensteer-helper-identity-\(UUID().uuidString)", isDirectory: true)
    let original = directory.appendingPathComponent("helper")
    let alias = directory.appendingPathComponent("helper-link")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    XCTAssertTrue(FileManager.default.createFile(atPath: original.path, contents: Data()))
    try FileManager.default.linkItem(at: original, to: alias)

    XCTAssertEqual(
      HelperReplacement.fileIdentity(original), HelperReplacement.fileIdentity(alias))
    XCTAssertNotEqual(
      HelperReplacement.fileIdentity(original), HelperReplacement.fileIdentity(directory))
  }

  func testEveryCandidateIsValidatedBeforeAnyOneIsTerminated() {
    let first = canonicalApplication(processIdentifier: 51, terminates: true)
    let refused = canonicalApplication(processIdentifier: 52, terminates: true)

    XCTAssertFalse(
      HelperReplacement.prepare(
        applications: [first, refused],
        currentProcessIdentifier: 9,
        identifies: canonicalIdentity,
        validates: { $0.processIdentifier != 52 }
      )
    )
    XCTAssertEqual(first.terminationRequests, 0)
    XCTAssertEqual(refused.terminationRequests, 0)
  }

  func testACanonicalBundleWithAnUnexpectedExecutableFailsClosed() {
    let application = FakeReplacementApplication(
      bundleURL: HelperPaths.application,
      executableURL: nil,
      processIdentifier: 55,
      terminates: true
    )

    XCTAssertFalse(
      HelperReplacement.prepare(
        applications: [application],
        currentProcessIdentifier: 9,
        identifies: canonicalIdentity,
        validates: { _ in true }
      )
    )
    XCTAssertEqual(application.terminationRequests, 0)
  }

  func testAnActiveHelperWithUnreadablePathIdentityFailsClosed() {
    let application = FakeReplacementApplication(
      bundleURL: nil,
      executableURL: nil,
      processIdentifier: 56,
      terminates: true
    )

    XCTAssertFalse(
      HelperReplacement.prepare(
        applications: [application],
        currentProcessIdentifier: 9,
        identifies: canonicalIdentity,
        validates: { _ in true }
      )
    )
    XCTAssertEqual(application.terminationRequests, 0)
  }

  func testARefusedTerminationFailsClosed() {
    let application = canonicalApplication(processIdentifier: 61, terminates: false)

    XCTAssertFalse(
      HelperReplacement.prepare(
        applications: [application],
        currentProcessIdentifier: 9,
        identifies: canonicalIdentity,
        validates: { _ in true }
      )
    )
    XCTAssertEqual(application.terminationRequests, 1)
  }

  func testAHelperThatDoesNotExitBeforeTheDeadlineFailsClosed() {
    let application = canonicalApplication(
      processIdentifier: 71, terminates: true, marksTerminated: false)

    XCTAssertFalse(
      HelperReplacement.prepare(
        applications: [application],
        currentProcessIdentifier: 9,
        timeout: 0.01,
        pollInterval: 0.001,
        identifies: canonicalIdentity,
        validates: { _ in true }
      )
    )
    XCTAssertEqual(application.terminationRequests, 1)
  }

  private func canonicalApplication(
    processIdentifier: pid_t,
    terminates: Bool,
    marksTerminated: Bool = true
  ) -> FakeReplacementApplication {
    FakeReplacementApplication(
      bundleURL: HelperPaths.application,
      executableURL: HelperPaths.executable,
      processIdentifier: processIdentifier,
      terminates: terminates,
      marksTerminated: marksTerminated
    )
  }

  private func canonicalIdentity(_ url: URL) -> ReplacementFileIdentity? {
    if url.standardizedFileURL.path == HelperPaths.application.standardizedFileURL.path {
      return ReplacementFileIdentity(device: 1, inode: 100)
    }
    if url.standardizedFileURL.path == HelperPaths.executable.standardizedFileURL.path {
      return ReplacementFileIdentity(device: 1, inode: 101)
    }
    return nil
  }
}

@MainActor
private final class FakeReplacementApplication: ReplacementRunningApplication {
  let bundleURL: URL?
  let executableURL: URL?
  private(set) var isTerminated = false
  let processIdentifier: pid_t
  private let marksTerminated: Bool
  private let terminates: Bool
  private(set) var terminationRequests = 0

  init(
    bundleURL: URL?,
    executableURL: URL?,
    processIdentifier: pid_t,
    terminates: Bool,
    marksTerminated: Bool = true
  ) {
    self.bundleURL = bundleURL
    self.executableURL = executableURL
    self.processIdentifier = processIdentifier
    self.terminates = terminates
    self.marksTerminated = marksTerminated
  }

  func terminate() -> Bool {
    terminationRequests += 1
    if terminates && marksTerminated { isTerminated = true }
    return terminates
  }
}
