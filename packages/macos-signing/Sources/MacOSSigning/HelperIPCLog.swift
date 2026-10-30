import os

struct HelperIPCLog: Sendable {
  let ipc: Logger
  let peer: Logger

  init(subsystem: String) {
    ipc = Logger(subsystem: subsystem, category: "ipc")
    peer = Logger(subsystem: subsystem, category: "peer")
  }
}
