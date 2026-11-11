import Foundation
import PasswordsCore

/// One line of a person log: no password, no full username.
public protocol PersonLogEntry: Equatable, Sendable {
  var at: Date { get }
  var json: JSONValue { get }
  init?(line: Data)
}

public struct PersonActivityEntry: PersonLogEntry {
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

  public var json: JSONValue {
    .object([
      "at": .string(ActivityLog.timestamp(at)), "site": .string(site),
      "account": .string(account), "kind": .string(kind.rawValue),
      "where": .string(presence == .here ? "this Mac" : "another device"),
    ])
  }

  public init?(line: Data) {
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

/// A login the person saved from a page. Its own file: an older broker
/// rewrites the fill log and would drop a kind it does not know.
public struct PersonSaveEntry: PersonLogEntry {
  public let at: Date
  public let site: String
  public let account: String

  public init(at: Date, site: String, account: String) {
    self.at = Date(timeIntervalSince1970: (at.timeIntervalSince1970 * 1_000).rounded(.down) / 1_000)
    self.site = site
    self.account = account
  }

  public var json: JSONValue {
    .object(["at": .string(ActivityLog.timestamp(at)), "site": .string(site), "account": .string(account)])
  }

  public init?(line: Data) {
    guard let value = try? CanonicalJSON.parseCanonical(line),
      let object = try? StrictObject(value, keys: ["at", "site", "account"], context: "person save"),
      let at = (try? object.string("at")).flatMap(WireRules.isoDate),
      let site = try? object.string("site"), WireRules.length(site, within: 1...300),
      let account = try? object.string("account"), (1...200).contains(account.count)
    else { return nil }
    self.init(at: at, site: site, account: account)
  }
}

public typealias PersonActivityLog = PersonLog<PersonActivityEntry>
public typealias PersonSaveLog = PersonLog<PersonSaveEntry>

/// Separate from agent history so an older broker cannot rewrite person entries away.
public final class PersonLog<Entry: PersonLogEntry>: @unchecked Sendable {
  private let url: URL
  private let capacity: Int
  private let queue = DispatchQueue(label: "com.opensteer.passwords.person-activity")

  public init(url: URL, capacity: Int = ActivityLog.defaultCapacity) {
    self.url = url
    self.capacity = capacity
  }

  public func append(_ entry: Entry) {
    queue.async { [self] in
      let entries = Array((readNow() + [entry]).suffix(capacity))
      var data = Data()
      for entry in entries {
        data.append(Wire.encode(entry.json))
        data.append(0x0A)
      }
      do { try AtomicFile.write(data, to: url, exclusive: false) } catch {
        Log.activity.error("The person history could not be written.")
      }
    }
  }

  public func entries() async -> [Entry] {
    await withCheckedContinuation { continuation in
      queue.async { [self] in continuation.resume(returning: readNow()) }
    }
  }

  public func flush() async { _ = await entries() }

  private func readNow() -> [Entry] {
    do {
      guard let data = try AtomicFile.read(url, maxBytes: ActivityLog.maxFileBytes) else {
        return []
      }
      return Array(
        data.split(separator: 0x0A).compactMap { Entry(line: Data($0)) }.suffix(
          capacity))
    } catch {
      Log.activity.error("The person history could not be read.")
      return []
    }
  }
}

public enum RecentSignIn: Equatable, Sendable {
  case agent(ActivityEntry)
  case person(PersonActivityEntry)
  case saved(PersonSaveEntry)
  public var at: Date {
    switch self {
    case .agent(let entry): return entry.at
    case .person(let entry): return entry.at
    case .saved(let entry): return entry.at
    }
  }

  static func merge(
    _ agents: [ActivityEntry], _ people: [PersonActivityEntry], _ saves: [PersonSaveEntry] = []
  ) -> [RecentSignIn] {
    (agents.map(RecentSignIn.agent) + people.map(RecentSignIn.person) + saves.map(RecentSignIn.saved))
      .sorted { $0.at > $1.at }
  }
}
