import Darwin
import Foundation

public enum StorageError: Error, Equatable, Sendable {
  case alreadyExists(String)
  case tooLarge(String)
  case notARegularFile(String)
  case posix(operation: String, path: String, code: Int32)
}

/// Durable file writes: a hidden temp file, `F_FULLFSYNC`, rename, then an
/// fsync of the directory so the rename itself survives power loss. Files are
/// 0600 and directories 0700; the broker's activity history uses it too.
public enum AtomicFile {
  static let tempPrefix = ".tmp-"

  public static func write(_ data: Data, to url: URL, exclusive: Bool) throws {
    let directory = url.deletingLastPathComponent()
    let temp = directory.appendingPathComponent(tempPrefix + UUID().uuidString)
    let fd = Darwin.open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw posixError("open", temp) }
    var renamed = false
    defer { if !renamed { unlink(temp.path) } }
    do {
      defer { close(fd) }
      try data.withUnsafeBytes { buffer in
        var offset = 0
        while offset < buffer.count {
          let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
          if written < 0 {
            if errno == EINTR { continue }
            throw posixError("write", temp)
          }
          offset += written
        }
      }
      try syncFile(fd, temp)
    }
    if exclusive {
      try renameExclusive(temp, to: url)
    } else if rename(temp.path, url.path) != 0 {
      throw posixError("rename", url)
    }
    renamed = true
    try syncDirectory(directory)
  }

  /// Reads a regular file without following symlinks. Returns nil when it does
  /// not exist.
  public static func read(_ url: URL, maxBytes: Int) throws -> Data? {
    guard let fd = try openRegular(url, O_RDONLY) else { return nil }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { throw posixError("stat", url) }
    guard info.st_size <= off_t(maxBytes) else { throw StorageError.tooLarge(url.lastPathComponent) }
    var data = Data(count: Int(info.st_size))
    let count = data.count
    try data.withUnsafeMutableBytes { buffer in
      var offset = 0
      while offset < count {
        let got = Darwin.read(fd, buffer.baseAddress! + offset, count - offset)
        if got < 0 {
          if errno == EINTR { continue }
          throw posixError("read", url)
        }
        if got == 0 { throw StorageError.posix(operation: "read", path: url.lastPathComponent, code: EIO) }
        offset += got
      }
    }
    return data
  }

  /// Opens an existing regular file, never following a symlink and never
  /// waiting: a named pipe put where a file should be would otherwise block
  /// `open` until something writes to it. Nil when it does not exist.
  public static func openRegular(_ url: URL, _ mode: Int32, create: Bool = false) throws -> Int32? {
    let fd = Darwin.open(url.path, mode | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (create ? O_CREAT : 0), 0o600)
    guard fd >= 0 else {
      if errno == ENOENT, !create { return nil }
      throw posixError("open", url)
    }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK) == 0
    else {
      close(fd)
      throw StorageError.notARegularFile(url.lastPathComponent)
    }
    return fd
  }

  public static func remove(_ url: URL) throws {
    guard unlink(url.path) == 0 || errno == ENOENT else { throw posixError("unlink", url) }
    try syncDirectory(url.deletingLastPathComponent())
  }

  /// Renames a file or directory, failing if the destination exists.
  static func renameExclusive(_ source: URL, to destination: URL) throws {
    guard renamex_np(source.path, destination.path, UInt32(RENAME_EXCL)) == 0 else {
      if errno == EEXIST { throw StorageError.alreadyExists(destination.lastPathComponent) }
      throw posixError("rename", destination)
    }
  }

  public static func makePrivateDirectory(_ url: URL) throws {
    guard mkdir(url.path, 0o700) == 0 else {
      if errno == EEXIST { throw StorageError.alreadyExists(url.lastPathComponent) }
      throw posixError("mkdir", url)
    }
  }

  public static func exists(_ url: URL) -> Bool {
    var info = stat()
    return lstat(url.path, &info) == 0
  }

  static func syncDirectory(_ url: URL) throws {
    let fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { throw posixError("open", url) }
    defer { close(fd) }
    guard fsync(fd) == 0 else { throw posixError("fsync", url) }
  }

  private static func syncFile(_ fd: Int32, _ url: URL) throws {
    // fsync alone leaves data in the drive's cache on macOS.
    if fcntl(fd, F_FULLFSYNC) == 0 { return }
    guard fsync(fd) == 0 else { throw posixError("fsync", url) }
  }

  private static func posixError(_ operation: String, _ url: URL) -> StorageError {
    .posix(operation: operation, path: url.lastPathComponent, code: errno)
  }
}
