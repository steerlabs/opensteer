import Darwin
import XCTest
@testable import ComputerUseCore

final class MessagesFilesTests: XCTestCase {
  private struct Fixture {
    let database: URL
    let root: URL
    let scratch: URL
    let attachments: URL
    let staging: URL
    let files: MessagesFiles
    init() throws {
      database = try MessagesFixture.create()
      let canonical = try XCTUnwrap(realpath(database.deletingLastPathComponent().path, nil))
      root = URL(fileURLWithPath: String(cString: canonical))
      free(canonical)
      scratch = root.appendingPathComponent("scratch")
      attachments = root.appendingPathComponent("Attachments")
      staging = root.appendingPathComponent("staging")
      for url in [scratch, attachments] {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
      }
      files = MessagesFiles(databasePath: database.path, attachmentRoots: [attachments], stagingRoot: staging)
    }
    func point(_ path: String, name: String? = nil) throws {
      try MessagesFixture.write(database, "UPDATE attachment SET filename = ?, transfer_name = ? WHERE guid = 'att-1'", [.text(path), name.map(MessagesFixture.Value.text) ?? .null])
    }
    func clean() { try? FileManager.default.removeItem(at: root) }
  }

  func testOriginalBytesAndSafeTransferName() throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let original = Data((0...255).map(UInt8.init))
    let source = fixture.attachments.appendingPathComponent("photo.HEIC")
    try original.write(to: source)
    try fixture.point(source.path, name: "../../photo.HEIC")
    let result = try fixture.files.export("att-1", scratch: fixture.scratch.path)
    guard case .object(let value) = result, let file = value["file"]?.stringValue, let name = value["name"]?.stringValue else { return XCTFail() }
    XCTAssertTrue(MessagesFiles.validName(file))
    XCTAssertTrue(MessagesFiles.validName(name))
    XCTAssertEqual(value["sizeBytes"], .number(256))
    XCTAssertEqual(value["mediaType"], .string("image/heic"))
    XCTAssertEqual(try Data(contentsOf: fixture.scratch.appendingPathComponent(file)), original)
  }

  func testExportsAnAttachmentWhoseNameOnDiskIsLong() throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let source = fixture.attachments.appendingPathComponent(String(repeating: "a", count: 246) + ".HEIC")
    try Data("long".utf8).write(to: source)
    try fixture.point(source.path)
    let result = try fixture.files.export("att-1", scratch: fixture.scratch.path)
    guard case .object(let value) = result, let file = value["file"]?.stringValue else { return XCTFail() }
    XCTAssertEqual(try Data(contentsOf: fixture.scratch.appendingPathComponent(file)), Data("long".utf8))
  }

  func testFailedStagingLeavesNoCopies() throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    try Data("one".utf8).write(to: fixture.scratch.appendingPathComponent("one"))
    let expired = WorkBudget(requestEnd: Date().addingTimeInterval(-1))
    XCTAssertThrowsError(try fixture.files.stage(["one", "one"], scratch: fixture.scratch.path, budget: expired))
    let left = (try? FileManager.default.contentsOfDirectory(atPath: fixture.staging.path)) ?? []
    XCTAssertEqual(left, [])
  }

  func testAttachmentEscapesAndMissingFile() throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let secret = fixture.root.appendingPathComponent("secret")
    try Data("outside".utf8).write(to: secret)
    try FileManager.default.createSymbolicLink(at: fixture.attachments.appendingPathComponent("link"), withDestinationURL: secret)
    try FileManager.default.createSymbolicLink(at: fixture.attachments.appendingPathComponent("directory"), withDestinationURL: fixture.root)
    for path in [fixture.attachments.path + "/../secret", fixture.attachments.path + "/link", fixture.attachments.path + "/directory/secret", fixture.attachments.path + "/absent"] {
      try fixture.point(path)
      XCTAssertThrowsError(try fixture.files.export("att-1", scratch: fixture.scratch.path)) { error in
        XCTAssertFalse((error as? HelperError)?.message.contains(fixture.root.path) ?? true)
      }
    }
    try fixture.point(fixture.attachments.path + "/absent")
    XCTAssertThrowsError(try fixture.files.export("att-1", scratch: fixture.scratch.path)) { error in
      XCTAssertTrue((error as? HelperError)?.message.contains("not on this Mac") == true)
    }
  }

  func testScratchAndSendNamesAreConfined() throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    let source = fixture.scratch.appendingPathComponent("one")
    try Data("one".utf8).write(to: source)
    try FileManager.default.createSymbolicLink(at: fixture.scratch.appendingPathComponent("link"), withDestinationURL: source)
    for name in ["../one", "/one", ".", "..", "link", "missing"] {
      XCTAssertThrowsError(try fixture.files.stage([name], scratch: fixture.scratch.path))
    }
    let link = fixture.root.appendingPathComponent("scratch-link")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: fixture.scratch)
    XCTAssertThrowsError(try MessagesFiles.directory(link.path))
    XCTAssertThrowsError(try MessagesFiles.directory(link.appendingPathComponent("child").path))
    try FileManager.default.setAttributes([.posixPermissions: 0o750], ofItemAtPath: fixture.scratch.path)
    XCTAssertThrowsError(try MessagesFiles.directory(fixture.scratch.path))
  }

  func testStagingPreservesBytesAndPrunesOldCopies() throws {
    let fixture = try Fixture()
    defer { fixture.clean() }
    try Data("one".utf8).write(to: fixture.scratch.appendingPathComponent("one"))
    let staged = try fixture.files.stage(["one", "one"], scratch: fixture.scratch.path)
    XCTAssertEqual(staged.count, 2)
    XCTAssertNotEqual(staged[0], staged[1])
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: staged[0])), Data("one".utf8))
    // The recipient sees the person's own file name.
    XCTAssertEqual(staged.map { URL(fileURLWithPath: $0).lastPathComponent }, ["one", "one"])
    let old = URL(fileURLWithPath: staged[0]).deletingLastPathComponent().deletingLastPathComponent()
    try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-90_000)], ofItemAtPath: old.path)
    let new = try fixture.files.stage(["one"], scratch: fixture.scratch.path)
    XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: new[0]))
  }

  func testSendStagesAllFilesBeforeTextAndReportsPartialFailure() async throws {
    final class Log: @unchecked Sendable {
      let lock = NSLock()
      var requests: [OsascriptRequest] = []
      func add(_ request: OsascriptRequest) -> Int { lock.withLock { requests.append(request); return requests.count } }
      var all: [OsascriptRequest] { lock.withLock { requests } }
    }
    let fixture = try Fixture()
    defer { fixture.clean() }
    try Data("one".utf8).write(to: fixture.scratch.appendingPathComponent("one"))
    try Data("two".utf8).write(to: fixture.scratch.appendingPathComponent("two"))
    let log = Log()
    let provider = MessagesProvider(databasePath: fixture.database.path, attachmentRoots: [fixture.attachments], stagingRoot: fixture.staging, automation: { .granted }, runOsascript: { request, _ in
      let index = log.add(request)
      if index == 1 {
        let dirs = try FileManager.default.contentsOfDirectory(at: fixture.staging, includingPropertiesForKeys: nil)
        let files = try FileManager.default.contentsOfDirectory(at: XCTUnwrap(dirs.first), includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 2)
      }
      if index > 1 {
        XCTAssertEqual(try? Data(contentsOf: URL(fileURLWithPath: request.arguments[1])), Data((index == 2 ? "one" : "two").utf8))
      }
      return index == 3 ? OsascriptOutcome(exitCode: 1, stderr: "(-1728)") : OsascriptOutcome(exitCode: 0)
    })
    let args: [String: JSONValue] = ["to": .object(["address": .string("+15551234567"), "service": .string("sms")]), "text": .string("hello"), "files": .array([.string("one"), .string("two")])]
    do {
      _ = try await provider.invoke(operation: "send_message", arguments: args, scratchDirectory: fixture.scratch.path, budget: .unlimited)
      XCTFail("The third send must fail")
    } catch { XCTAssertEqual((error as? HelperError)?.code, .outcomeUnknown) }
    XCTAssertEqual(log.all.count, 3)
    guard log.all.count == 3 else { return }
    XCTAssertEqual(log.all[0].arguments, ["+15551234567", "hello"])
    XCTAssertTrue(log.all[1].script.joined().contains("send theFile to participant"))
    XCTAssertTrue(log.all[1].script.joined().contains("service type = SMS"))
    let before = log.all.count
    var invalid = args
    invalid["files"] = .array([.string("one"), .string("missing")])
    do {
      _ = try await provider.invoke(operation: "send_message", arguments: invalid, scratchDirectory: fixture.scratch.path, budget: .unlimited)
      XCTFail("Missing file must refuse before sending text")
    } catch { XCTAssertEqual((error as? HelperError)?.code, .failed) }
    XCTAssertEqual(log.all.count, before)
  }
}
