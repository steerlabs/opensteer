import Darwin
import Foundation

struct MessagesFiles {
  let databasePath: String
  let attachmentRoots: [URL]
  let stagingRoot: URL

  static let invalid = HelperError(.failed, "The task's private file area is unavailable. Start a task with file access and try again.")
  private static var ioFailure: HelperError {
    errno == EPERM
      ? HelperError(.permissionRequired, DataPlane.permissionSentence(.fullDiskAccess))
      : HelperError(.failed, "Messages files could not be copied. Check file access and try again.")
  }

  final class Descriptor {
    let value: Int32
    init(_ value: Int32) throws {
      guard value >= 0 else {
        if errno == EPERM { throw HelperError(.permissionRequired, DataPlane.permissionSentence(.fullDiskAccess)) }
        throw MessagesFiles.ioFailure
      }
      self.value = value
    }
    deinit { close(value) }
  }

  private static func components(_ path: String) throws -> [String] {
    guard path.hasPrefix("/"), !path.utf8.contains(0) else { throw invalid }
    let parts = path.split(separator: "/").map(String.init)
    guard !parts.contains(".."), !parts.contains(".") else { throw invalid }
    return parts
  }

  static func directory(_ path: String) throws -> Descriptor {
    let root = try openDirectory(path)
    var info = stat()
    guard fstat(root.value, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw invalid }
    return root
  }

  private static func openDirectory(_ path: String, create: Bool = false) throws -> Descriptor {
    var current = try Descriptor(Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC))
    for part in try components(path) {
      if create && mkdirat(current.value, part, 0o700) != 0 && errno != EEXIST { throw ioFailure }
      current = try Descriptor(openat(current.value, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
    }
    return current
  }

  static func validName(_ name: String) -> Bool {
    !name.isEmpty && name != "." && name != ".." && !name.contains("/") && !name.contains("\\")
      && !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
      && name.utf8.count <= 240
  }

  private static func safeName(_ name: String) -> String {
    let cleaned = String(String.UnicodeScalarView(name.unicodeScalars.map {
      CharacterSet.controlCharacters.contains($0) || $0 == "/" || $0 == "\\" ? UnicodeScalar(95)! : $0
    }).prefix(100))
    return validName(cleaned) && cleaned.utf8.count <= 180 ? cleaned : "attachment"
  }

  private static func regular(_ name: String, in directory: Descriptor) throws -> Descriptor {
    guard validName(name) else { throw invalid }
    let file = try Descriptor(openat(directory.value, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
    var info = stat()
    guard fstat(file.value, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { throw invalid }
    return file
  }

  private static func copy(_ source: Descriptor, name: String, to directory: Descriptor, budget: WorkBudget) throws -> Int64 {
    let target = try Descriptor(openat(directory.value, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600))
    var success = false
    defer { if !success { unlinkat(directory.value, name, 0) } }
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    var total: Int64 = 0
    while true {
      try budget.check()
      let count = Darwin.read(source.value, &buffer, buffer.count)
      if count == 0 { break }
      if count < 0 { if errno == EINTR { continue }; throw ioFailure }
      try buffer.withUnsafeBytes { bytes in
        var offset = 0
        while offset < count {
          let written = Darwin.write(target.value, bytes.baseAddress!.advanced(by: offset), count - offset)
          if written < 0 { if errno == EINTR { continue }; throw ioFailure }
          guard written > 0 else { throw ioFailure }
          offset += written
        }
      }
      total += Int64(count)
      guard total <= 2 * 1024 * 1024 * 1024 else { throw ioFailure }
    }
    success = true
    return total
  }

  func export(_ id: String, scratch: String?, budget: WorkBudget = .unlimited) throws -> JSONValue {
    guard let scratch else { throw Self.invalid }
    let directory = try Self.directory(scratch)
    let database = try MessagesDatabase.open(databasePath)
    guard let row = try database.rows("SELECT filename, mime_type, transfer_name FROM attachment WHERE guid = ?", [.text(id)]).first,
      let filename = row.text(0) else { throw missing }
    let path = (filename as NSString).expandingTildeInPath
    let parts = try Self.components(path)
    guard let root = try attachmentRoots.first(where: { parts.starts(with: try Self.components($0.path)) }) else {
      throw HelperError(.failed, "That attachment is outside the Messages attachment area.")
    }
    let suffix = Array(parts.dropFirst(try Self.components(root.path).count))
    guard let leaf = suffix.last else { throw missing }
    let source: Descriptor
    do {
      var parent = try Self.openDirectory(root.path)
      for part in suffix.dropLast() {
        parent = try Descriptor(openat(parent.value, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
      }
      source = try Self.regular(leaf, in: parent)
    } catch let error as HelperError {
      if error.code == .permissionRequired { throw error }
      throw missing
    }
    let name = Self.safeName(DataText.present(row.text(2)) ?? leaf)
    let file = UUID().uuidString + "-" + name
    let size = try Self.copy(source, name: file, to: directory, budget: budget)
    return .object(["file": .string(file), "name": .string(name), "mediaType": .string(DataText.present(row.text(1)) ?? "application/octet-stream"), "sizeBytes": .number(Double(size))])
  }

  func stage(_ names: [String], scratch: String?, budget: WorkBudget = .unlimited) throws -> [String] {
    guard !names.isEmpty else { return [] }
    guard let scratch else { throw Self.invalid }
    let directory = try Self.directory(scratch)
    let sources = try names.map { try Self.regular($0, in: directory) }
    let root = try Self.openDirectory(stagingRoot.path, create: true)
    var info = stat()
    guard fstat(root.value, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw Self.invalid }
    try Self.prune(root)
    let unique = UUID().uuidString
    guard mkdirat(root.value, unique, 0o700) == 0 else { throw Self.ioFailure }
    let destination = try Descriptor(openat(root.value, unique, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
    return try sources.enumerated().map { index, source in
      let name = "\(index)-\(names[index])"
      _ = try Self.copy(source, name: name, to: destination, budget: budget)
      return stagingRoot.appendingPathComponent(unique).appendingPathComponent(name).path
    }
  }

  private static func prune(_ root: Descriptor) throws {
    guard let stream = fdopendir(dup(root.value)) else { throw ioFailure }
    defer { closedir(stream) }
    while let entry = readdir(stream) {
      let name = withUnsafePointer(to: &entry.pointee.d_name) {
        $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
      }
      guard UUID(uuidString: name) != nil else { continue }
      var info = stat()
      guard fstatat(root.value, name, &info, AT_SYMLINK_NOFOLLOW) == 0,
        info.st_mode & S_IFMT == S_IFDIR, Date().timeIntervalSince1970 - Double(info.st_mtimespec.tv_sec) > 86_400 else { continue }
      let child = try Descriptor(openat(root.value, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
      guard let files = fdopendir(dup(child.value)) else { throw ioFailure }
      while let file = readdir(files) {
        let leaf = withUnsafePointer(to: &file.pointee.d_name) {
          $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
        }
        if leaf != "." && leaf != ".." { unlinkat(child.value, leaf, 0) }
      }
      closedir(files)
      unlinkat(root.value, name, AT_REMOVEDIR)
    }
  }

  private var missing: HelperError { HelperError(.failed, "That attachment is not on this Mac. Download it in Messages and try again.") }
}
