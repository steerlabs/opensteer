import os

/// The broker's loggers.
///
/// A log line may carry counts, codes, methods and connection numbers. It
/// never carries a password, a username, a site, a TOTP code, a reason the
/// agent wrote or anything read from an export: logs are readable by other
/// processes of this user and are kept by the system.
public enum Log {
  public static let subsystem = "com.opensteer.passwords"

  public static let lifecycle = Logger(subsystem: subsystem, category: "lifecycle")
  public static let ipc = Logger(subsystem: subsystem, category: "ipc")
  public static let peer = Logger(subsystem: subsystem, category: "peer")
  public static let broker = Logger(subsystem: subsystem, category: "broker")
  public static let vault = Logger(subsystem: subsystem, category: "vault")
  public static let importer = Logger(subsystem: subsystem, category: "import")
  public static let activity = Logger(subsystem: subsystem, category: "activity")
}
