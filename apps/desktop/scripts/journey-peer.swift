import Darwin
import Foundation

let operation = CommandLine.arguments[1]
if operation == "peer" {
  var pid: pid_t = 0
  var size = socklen_t(MemoryLayout<pid_t>.size)
  guard getsockopt(3, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0 else { exit(1) }
  print(pid)
} else if operation == "inspect", let pid = pid_t(CommandLine.arguments[2]) {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { exit(1) }
  var bytes = [CChar](repeating: 0, count: Int(4 * MAXPATHLEN))
  guard proc_pidpath(pid, &bytes, UInt32(bytes.count)) > 0 else { exit(1) }
  let value: [String: Any] = [
    "pid": pid, "pgid": getpgid(pid), "executable": String(cString: bytes),
    "startSeconds": info.pbi_start_tvsec, "startMicroseconds": info.pbi_start_tvusec,
  ]
  print(String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
} else { exit(2) }
