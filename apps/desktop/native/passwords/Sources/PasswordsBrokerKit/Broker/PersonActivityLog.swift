import Foundation
import PasswordsCore

public struct PersonActivityEntry: Equatable, Sendable {
  public enum Kind: String, Sendable { case password, code }
  public let at: Date
  public let site: String
  public let account: String
  public let kind: Kind
  public let presence: Wire.FillPresence

  public init(at: Date, site: String, account: String, kind: Kind, presence: Wire.FillPresence) {
    self.at = Date(timeIntervalSince1970: (at.timeIntervalSince1970 * 1_000).rounded(.down) / 1_000)
    self.site = site
    self.account = account
    self.kind = kind
    self.presence = presence
  }

  var json: JSONValue {
    .object([
      "at": .string(ActivityLog.timestamp(at)), "site": .string(site),
      "account": .string(account), "kind": .string(kind.rawValue),
      "where": .string(presence == .here ? "this Mac" : "another device"),
    ])
  }

  init?(line: Data) {
    guard let value = try? CanonicalJSON.parseCanonical(line),
      let object = try? StrictObject(
        value, keys: ["at", "site", "account", "kind", "where"], context: "person activity"),
      let at = (try? object.string("at")).flatMap(WireRules.isoDate),
      let site = try? object.string("site"), WireRules.length(site, within: 1...300),
      let account = try? object.string("account"), (1...200).contains(account.count),
      let kind = (try? object.string("kind")).flatMap(Kind.init(rawValue:)),
      let location = try? object.string("where"), ["this Mac", "another device"].contains(location)
    else { return nil }
    self.init(
      at: at, site: site, account: account, kind: kind,
      presence: location == "this Mac" ? .here : .elsewhere)
  }
}

/// Separate from agent history so an older broker cannot rewrite person entries away.
public final class PersonActivityLog: @unchecked Sendable {
  private let url: URL
  private let capacity: Int
  private let queue = DispatchQueue(label: "com.opensteer.passwords.person-activity")

  public init(url: URL, capacity: Int = ActivityLog.defaultCapacity) {
    self.url = url
    self.capacity = capacity
  }

  public func append(_ entry: PersonActivityEntry) {
    queue.async { [self] in
      let entries = Array((readNow() + [entry]).suffix(capacity))
      var data = Data()
      for entry in entries {
        data.append(Wire.encode(entry.json))
        data.append(0x0A)
      }
      do { try AtomicFile.write(data, to: url, exclusive: false) } catch {
        Log.activity.error("The person fill history could not be written.")
      }
    }
  }

  public func entries() async -> [PersonActivityEntry] {
    await withCheckedContinuation { continuation in
      queue.async { [self] in continuation.resume(returning: readNow()) }
    }
  }

  public func flush() async { _ = await entries() }

  private func readNow() -> [PersonActivityEntry] {
    do {
      guard let data = try AtomicFile.read(url, maxBytes: ActivityLog.maxFileBytes) else {
        return []
      }
      return Array(
        data.split(separator: 0x0A).compactMap { PersonActivityEntry(line: Data($0)) }.suffix(
          capacity))
    } catch {
      Log.activity.error("The person fill history could not be read.")
      return []
    }
  }
}

public enum RecentSignIn: Equatable, Sendable {
  case agent(ActivityEntry)
  case person(PersonActivityEntry)
  public var at: Date {
    switch self {
    case .agent(let entry): return entry.at
    case .person(let entry): return entry.at
    }
  }

  static func merge(_ agents: [ActivityEntry], _ people: [PersonActivityEntry]) -> [RecentSignIn] {
    (agents.map(RecentSignIn.agent) + people.map(RecentSignIn.person)).sorted { $0.at > $1.at }
  }
}
