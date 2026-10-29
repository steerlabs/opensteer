import Darwin
import Foundation
import PasswordsCore

/// `Opensteer Passwords Import`, embedded at
/// `Opensteer Passwords.app/Contents/Helpers/`.
///
/// It parses one password export the person chose and does nothing else. It
/// runs in the App Sandbox with no other entitlement (no network, no files):
/// its standard input is the export the broker opened, and its standard
/// output is one `ImportWire` answer. It holds no keys, so a file crafted to
/// exploit the parser reaches nothing but the passwords already in that file.

// A broker that stopped listening is an answer nobody reads; exiting with an
// error is the same outcome as the signal, without a crash report.
signal(SIGPIPE, SIG_IGN)

let input = readStandardInput(limit: ImportLimits.maxInputBytes + 1)
let answer: Data
do {
  guard let input else { exit(EX_IOERR) }
  if input.count > ImportLimits.maxInputBytes {
    answer = try ImportWire.encode(ImportError.tooLarge)
  } else {
    do {
      answer = try ImportWire.encode(try PasswordImporter.parse(input))
    } catch let error as ImportError {
      answer = try ImportWire.encode(error)
    }
  }
} catch {
  exit(EX_SOFTWARE)
}
exit(writeStandardOutput(answer) ? EXIT_SUCCESS : EX_IOERR)

/// Up to `limit` bytes, so an export one byte over the import limit is
/// recognised without reading the rest. Nil when the read fails.
func readStandardInput(limit: Int) -> Data? {
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
  while data.count < limit {
    let wanted = min(buffer.count, limit - data.count)
    let count = buffer.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, wanted) }
    if count == 0 { break }
    if count < 0 {
      if errno == EINTR { continue }
      return nil
    }
    data.append(contentsOf: buffer[0..<count])
  }
  return data
}

func writeStandardOutput(_ data: Data) -> Bool {
  data.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let written = Darwin.write(STDOUT_FILENO, raw.baseAddress! + offset, raw.count - offset)
      if written < 0 {
        if errno == EINTR { continue }
        return false
      }
      offset += written
    }
    return true
  }
}
