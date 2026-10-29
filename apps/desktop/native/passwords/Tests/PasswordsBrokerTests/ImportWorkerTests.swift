import Foundation
import PasswordsCore
import XCTest
@testable import PasswordsBrokerKit

let coreFixtures = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent().deletingLastPathComponent()
  .appendingPathComponent("PasswordsCoreTests/Fixtures")

/// The worker SwiftPM built beside this test bundle.
var builtWorker: URL {
  Bundle(for: ImportWorkerTests.self).bundleURL.deletingLastPathComponent().appendingPathComponent("PasswordsImportWorker")
}

/// Section 14: the real worker binary, stdin to stdout, through the runner.
final class ImportWorkerTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("pwi-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    XCTAssertTrue(FileManager.default.isExecutableFile(atPath: builtWorker.path), "swift build makes the worker")
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private func run(_ url: URL, runner: ImportRunner = ImportRunner(worker: builtWorker)) async throws
    -> Result<ImportResult, ImportFailure>
  {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    return await runner.run(input: handle)
  }

  private func write(_ data: Data, _ name: String = "export.csv") throws -> URL {
    let url = directory.appendingPathComponent(name)
    try data.write(to: url)
    return url
  }

  func testEveryFixtureThroughTheWorker() async throws {
    let names = try FileManager.default.contentsOfDirectory(atPath: coreFixtures.path)
      .filter { ($0.hasSuffix(".csv") || $0.hasSuffix(".json")) && !$0.contains("fixtures") }.sorted()
    XCTAssertGreaterThanOrEqual(names.count, 10)
    for name in names {
      let url = coreFixtures.appendingPathComponent(name)
      let data = try Data(contentsOf: url)
      let outcome = try await run(url)
      switch Result(catching: { try PasswordImporter.parse(data) }) {
      case .success(let expected):
        guard case .success(let result) = outcome else { return XCTFail("\(name): \(outcome)") }
        XCTAssertEqual(try ImportWire.encode(result), try ImportWire.encode(expected), name)
      case .failure(let error):
        XCTAssertEqual(failure(outcome), .refused(try XCTUnwrap(error as? ImportError)), name)
      }
    }
  }

  func testInputOverSixteenMiBIsRefused() async throws {
    let header = Data("url,username,password\n".utf8)
    let atLimit = header + Data(repeating: UInt8(ascii: "a"), count: ImportLimits.maxInputBytes - header.count)
    let over = try await run(try write(atLimit + Data("a".utf8)))
    XCTAssertEqual(failure(over), .refused(.tooLarge))
    let at = try await run(try write(atLimit, "at-limit.csv"))
    XCTAssertNotEqual(failure(at), .refused(.tooLarge), "16 MiB itself is read")
  }

  func testGarbageInputIsAStructuredError() async throws {
    let empty = try await run(try write(Data(), "empty.csv"))
    XCTAssertEqual(failure(empty), .refused(.emptyFile))
    var noise = Data((0..<4_096).map { UInt8(truncatingIfNeeded: $0 &* 7919) })
    noise[0] = 0xFF
    let binary = try await run(try write(noise, "noise.csv"))
    XCTAssertEqual(failure(binary), .refused(.notUTF8))
    let json = try await run(try write(Data(#"{"not":"bitwarden"}"#.utf8), "other.json"))
    XCTAssertEqual(failure(json), .refused(.unrecognizedJSON))
  }
}

/// W6–W9: the runner's limits, with stand-in workers.
final class ImportRunnerTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("pwr-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private func worker(_ script: String) throws -> URL {
    let url = directory.appendingPathComponent("worker-\(UUID().uuidString)")
    try Data("#!/bin/sh\n\(script)\n".utf8).write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    return url
  }

  private func input(_ data: Data = Data("url,username,password\n".utf8)) throws -> FileHandle {
    let url = directory.appendingPathComponent("input-\(UUID().uuidString)")
    try data.write(to: url)
    return try FileHandle(forReadingFrom: url)
  }

  func testHangingWorkerIsKilled() async throws {
    let runner = ImportRunner(worker: try worker("exec /bin/sleep 30"), timeout: 0.5)
    let started = Date()
    let outcome = await runner.run(input: try input())
    XCTAssertEqual(failure(outcome), .unreadable)
    XCTAssertLessThan(Date().timeIntervalSince(started), 5)
  }

  func testFloodingWorkerIsKilled() async throws {
    let runner = ImportRunner(worker: try worker("exec /usr/bin/yes"), timeout: 20, outputLimit: 1 << 20)
    let started = Date()
    let outcome = await runner.run(input: try input())
    XCTAssertEqual(failure(outcome), .unreadable)
    XCTAssertLessThan(Date().timeIntervalSince(started), 10)
  }

  func testCrashOrGarbageIsUnreadable() async throws {
    let valid = String(decoding: try ImportWire.encode(ImportError.emptyFile), as: UTF8.self)
    for script in [
      "kill -SEGV $$", "echo garbage", "printf '%s' '\(valid)'; exit 1", "printf '%s ' '\(valid)'", "exit 0",
    ] {
      let outcome = await ImportRunner(worker: try worker(script)).run(input: try input())
      XCTAssertEqual(failure(outcome), .unreadable, script)
    }
    let missing = await ImportRunner(worker: directory.appendingPathComponent("nothing")).run(input: try input())
    XCTAssertEqual(failure(missing), .unreadable)
  }

  /// The worker's standard input is the export itself: a worker that echoes
  /// its input answers with what the file holds.
  func testTheExportIsTheWorkersInput() async throws {
    let echo = ImportRunner(worker: try worker("exec /bin/cat"))
    let answer = try ImportWire.encode(ImportError.bitwardenEncrypted)
    let refused = await echo.run(input: try input(answer))
    XCTAssertEqual(failure(refused), .refused(.bitwardenEncrypted))
    let result = try PasswordImporter.parse(Data("url,username,password\nhttps://example.com,a,synthetic\n".utf8))
    let parsed = await echo.run(input: try input(try ImportWire.encode(result)))
    guard case .success(let read) = parsed else { return XCTFail("\(parsed)") }
    XCTAssertEqual(read.candidates.map(\.password), ["synthetic"])
  }
}

/// W4 and W5: the worker's answer, encoded and read strictly.
final class ImportWireTests: XCTestCase {
  func testRoundTripKeepsBytes() throws {
    let csv = "url,username,password,totp\nhttps://example.com, spaced ,\" pass word \",\nhttps://example.org,nfd,pa\u{0308}ss,JBSWY3DPEHPK3PXP\nhttp://plain.example,a,b,\n"
    let result = try PasswordImporter.parse(Data(csv.utf8))
    let decoded = try ImportWire.decode(try ImportWire.encode(result))
    guard case .success(let read) = decoded else { return XCTFail() }
    XCTAssertEqual(read.candidates.count, 2)
    for (copy, original) in zip(read.candidates, result.candidates) {
      XCTAssertTrue(copy.password.utf8.elementsEqual(original.password.utf8))
      XCTAssertTrue(copy.username.utf8.elementsEqual(original.username.utf8))
      XCTAssertEqual(copy.totp, original.totp)
      XCTAssertEqual(copy.sourceRow, original.sourceRow)
    }
    XCTAssertEqual(read.skipped, result.skipped)
    XCTAssertEqual(read.format, result.format)
    for error in [ImportError.malformedCSV(row: 12), .duplicateHeader("url"), .notUTF8, .tooLarge] {
      guard case .failure(let read) = try ImportWire.decode(try ImportWire.encode(error)) else {
        XCTFail("\(error)")
        continue
      }
      XCTAssertEqual(read, error)
    }
  }

  func testStrictDecoding() throws {
    let result = try PasswordImporter.parse(Data("url,username,password\nhttps://example.com,a,synthetic\n".utf8))
    let good = String(decoding: try ImportWire.encode(result), as: UTF8.self)
    XCTAssertNoThrow(try ImportWire.decode(Data(good.utf8)))
    let variants = [
      good + "\n",
      " " + good,
      good.replacingOccurrences(of: #""v":1"#, with: #""v":2"#),
      good.replacingOccurrences(of: #""format":"generic""#, with: #""extra":1,"format":"generic""#),
      good.replacingOccurrences(of: "https://example.com", with: "http://example.com"),
      good.replacingOccurrences(of: #""sourceRow":2"#, with: #""sourceRow":0"#),
      good.replacingOccurrences(of: #""format":"generic""#, with: #""format":"keepass""#),
      good.replacingOccurrences(of: #""ignoredURLs":[],"#, with: ""),
      // Two candidates with one row number.
      good.replacingOccurrences(of: #""candidates":[{"#, with: #""candidates":[{"label":null,"loginURL":"https://other.example.com/","origins":["https://other.example.com"],"password":"x","sourceRow":2,"totp":null,"username":"b"},{"#),
      #"{"error":{"code":"notUTF8","name":"x","row":null},"v":1}"#,
      #"{"error":{"code":"malformedCSV","name":null,"row":null},"v":1}"#,
      #"{"error":{"code":"somethingElse","name":null,"row":null},"v":1}"#,
      #"{"error":{"code":"notUTF8","name":null,"row":null},"result":{},"v":1}"#,
      "",
    ]
    for variant in variants {
      XCTAssertThrowsError(try ImportWire.decode(Data(variant.utf8)), variant)
    }
  }

  func testAnswersAreBounded() {
    XCTAssertEqual(ImportWire.maxOutputBytes, 64 << 20)
    XCTAssertThrowsError(try ImportWire.decode(Data(count: ImportWire.maxOutputBytes + 1)))
  }
}

/// The failure of an outcome, or nil when it parsed.
func failure(_ outcome: Result<ImportResult, ImportFailure>) -> ImportFailure? {
  if case .failure(let failure) = outcome { return failure }
  return nil
}
