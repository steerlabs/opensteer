import os

/// The helper's loggers.
///
/// Nothing here ever logs a window title, an element label, tree text, typed
/// text or a screenshot: the whole point of the helper is that what it sees
/// inside a person's app stays between the app and the Run that was granted it.
/// Counts, codes and bundle identifiers are what a log line may carry.
public enum Log {
  public static let subsystem = "com.opensteer.computer-use"

  public static let lifecycle = Logger(subsystem: subsystem, category: "lifecycle")
  public static let ipc = Logger(subsystem: subsystem, category: "ipc")
  public static let peer = Logger(subsystem: subsystem, category: "peer")
  public static let permissions = Logger(subsystem: subsystem, category: "permissions")
  public static let apps = Logger(subsystem: subsystem, category: "apps")
  public static let session = Logger(subsystem: subsystem, category: "session")
  public static let observe = Logger(subsystem: subsystem, category: "observe")
  public static let act = Logger(subsystem: subsystem, category: "act")
  public static let focus = Logger(subsystem: subsystem, category: "focus")
  public static let overlay = Logger(subsystem: subsystem, category: "overlay")
}
