import Foundation
import PasswordsCore

/// How a sign-in ended, as the history shows it.
public enum ActivityOutcome: String, CaseIterable, Sendable {
  case used
  case signedIn = "signed-in"
  case declined
  case cancelled
  case expired
  case failed
  /// The site refused the saved password.
  case wrongPassword = "wrong-password"
  /// The result never came back (the desktop went away after a release, or
  /// a released login's sign-in ended without a word).
  case outcomeUnknown = "outcome-unknown"
}

/// One line of "Recent sign-ins". It holds what the person needs to
/// recognise a sign-in and nothing that would help anyone use one: never a
/// password, a full username, a code or the agent's reason.
public struct ActivityEntry: Equatable, Sendable {
  public let brand: String?
  public let lastFour: String?
  public var credential: String? { brand == nil ? nil : "card" }
  public let at: Date
  /// The site's registrable domain, e.g. `github.com`.
  public let site: String
  /// `t•••@example.com`, or nil when no account was used.
  public let account: String?
  public let deployment: String
  public let thread: String
  /// A grant released the login: nobody was asked.
  public let automatic: Bool
  public let outcome: ActivityOutcome

  public init(
    at: Date, site: String, account: String?, deployment: String, thread: String, automatic: Bool,
    outcome: ActivityOutcome, brand: String? = nil, lastFour: String? = nil
  ) {
    // Whole milliseconds, so an entry reads back exactly as it was written.
    self.at = Date(timeIntervalSince1970: (at.timeIntervalSince1970 * 1_000).rounded(.down) / 1_000)
    self.brand = brand
    self.lastFour = lastFour
    self.site = site
    self.account = account
    self.deployment = deployment
    self.thread = thread
    self.automatic = automatic
    self.outcome = outcome
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = [
      "account": account.map(JSONValue.string) ?? .null,
      "at": .string(ActivityLog.timestamp(at)),
      "automatic": .bool(automatic),
      "deployment": .string(deployment),
      "outcome": .string(outcome.rawValue),
      "site": .string(site),
      "thread": .string(thread),
    ]
    if let brand, let lastFour {
      fields["credential"] = .string("card")
      fields["brand"] = .string(brand)
      fields["lastFour"] = .string(lastFour)
    }
    return .object(fields)
  }

  init?(line: Data) {
    guard let value = try? CanonicalJSON.parseCanonical(line) else { return nil }
    let cardKeys: Set<String>
    if case .object(let fields) = value, fields["credential"] == .string("card") {
      guard case .string(let brand)? = fields["brand"], (1...64).contains(brand.utf8.count),
        case .string(let last)? = fields["lastFour"], last.utf8.count == 4,
        last.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
      cardKeys = ["credential", "brand", "lastFour"]
    } else { cardKeys = [] }
    guard
      let object = try? StrictObject(
        value, keys: Set(["account", "at", "automatic", "deployment", "outcome", "site", "thread"]).union(cardKeys),
        context: "activity"),
      let at = (try? object.string("at")).flatMap(WireRules.isoDate),
      let site = try? object.string("site"),
      let deployment = try? object.string("deployment"),
      let thread = try? object.string("thread"),
      case .bool(let automatic)? = object.fields["automatic"],
      let outcome = (try? object.string("outcome")).flatMap(ActivityOutcome.init(rawValue:))
    else { return nil }
    // Read on its own: `try?` would flatten a null account into a failure.
    let account: String?
    switch object.fields["account"] {
    case .null?: account = nil
    case .string(let value)?: account = value
    default: return nil
    }
    self.init(
      at: at, site: site, account: account, deployment: deployment, thread: thread,
      automatic: automatic, outcome: outcome, brand: try? object.string("brand"), lastFour: try? object.string("lastFour"))
  }
}

/// `<root>/activity.jsonl`: the newest 500 entries, one canonical JSON object
/// per line, 0600, rewritten atomically on every entry. All file work runs on
/// one serial queue.
public final class ActivityLog: @unchecked Sendable {
  public static let defaultCapacity = 500
  /// 500 entries of capped fields are well under this; more is not ours.
  static let maxFileBytes = 4 << 20

  private let url: URL
  private let capacity: Int
  private let queue = DispatchQueue(label: "com.opensteer.passwords.activity")

  public init(url: URL, capacity: Int = ActivityLog.defaultCapacity) {
    self.url = url
    self.capacity = capacity
  }

  public func append(_ entry: ActivityEntry) {
    queue.async { [self] in
      var entries = readNow()
      entries.append(entry)
      if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
      do {
        var data = Data()
        for item in entries {
          data.append(Wire.encode(item.json))
          data.append(0x0A)
        }
        try AtomicFile.write(data, to: url, exclusive: false)
      } catch {
        Log.activity.error("The sign-in history could not be written.")
      }
    }
  }

  /// Oldest first.
  public func entries() async -> [ActivityEntry] {
    await withCheckedContinuation { continuation in
      queue.async { [self] in continuation.resume(returning: readNow()) }
    }
  }

  /// Waits for every write queued so far.
  public func flush() async {
    await withCheckedContinuation { continuation in
      queue.async { continuation.resume() }
    }
  }

  private func readNow() -> [ActivityEntry] {
    let data: Data?
    do {
      data = try AtomicFile.read(url, maxBytes: Self.maxFileBytes)
    } catch {
      Log.activity.error("The sign-in history could not be read; it starts again.")
      return []
    }
    guard let data else { return [] }
    var entries: [ActivityEntry] = []
    var dropped = 0
    for line in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
      if let entry = ActivityEntry(line: Data(line)) { entries.append(entry) } else { dropped += 1 }
    }
    if dropped > 0 { Log.activity.error("Dropped \(dropped, privacy: .public) unreadable history lines.") }
    return Array(entries.suffix(capacity))
  }

  static func timestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(identifier: "UTC")
    return formatter.string(from: date)
  }
}
