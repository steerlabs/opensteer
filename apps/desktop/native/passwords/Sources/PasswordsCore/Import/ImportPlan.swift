import Foundation

/// How each import candidate relates to the vault and to the rest of the file.
///
/// The key is the origin set plus the exact username bytes. Passwords are
/// compared as bytes. Conflicting rows all stay visible so the person can pick.
///
/// A plan lives while the person reviews the preview, so it keeps the saved
/// items' IDs only, never their passwords or two-factor seeds: `changes`
/// returns replacements that the commit applies to each item as it is then.
public struct ImportPlan: Sendable {
  public enum Classification: Sendable, Equatable {
    /// No saved item has this origin set and username.
    case new
    /// One saved item has this origin set and username but a different
    /// password or two-factor seed (or none).
    case update(itemID: String)
    /// Adds nothing: a saved item, or another row of this file, has the same
    /// password and the same two-factor seed (or this row has none).
    case duplicate(of: DuplicateSource)
    /// This file has the same origin set and username more than once with
    /// different passwords or different two-factor seeds, or several saved
    /// items match. `existingItemID` is the single saved item it would
    /// update, if any.
    case conflict(existingItemID: String?)
  }

  public enum DuplicateSource: Sendable, Equatable {
    case item(String)
    case sourceRow(Int)
  }

  public struct Entry: Sendable {
    public let candidate: ImportCandidate
    public let classification: Classification
    /// Entries with the same group share an origin set and username.
    public let group: Int
  }

  public enum PlanError: Error, Equatable, Sendable {
    /// More than one row of one conflict group was selected.
    case conflictingSelection(rows: [Int])
    case duplicateSourceRow(Int)
  }

  public let entries: [Entry]

  /// Refuses candidates that share a `sourceRow`: rows are selected by it,
  /// so a shared one would carry a second, unseen login with the first.
  public init(candidates: [ImportCandidate], existing: [Item]) throws {
    var rows = Set<Int>()
    for candidate in candidates where !rows.insert(candidate.sourceRow).inserted {
      throw PlanError.duplicateSourceRow(candidate.sourceRow)
    }
    var existingByKey: [Key: [Item]] = [:]
    for item in existing { existingByKey[Key(origins: item.origins, username: item.username), default: []].append(item) }

    var groupOrder: [Key] = []
    var groups: [Key: [Int]] = [:]
    for (index, candidate) in candidates.enumerated() {
      let key = Key(origins: candidate.origins, username: candidate.username)
      if groups[key] == nil { groupOrder.append(key) }
      groups[key, default: []].append(index)
    }

    var classified = [Classification](repeating: .new, count: candidates.count)
    var groupOf = [Int](repeating: 0, count: candidates.count)
    for (groupIndex, key) in groupOrder.enumerated() {
      let members = groups[key]!
      for member in members { groupOf[member] = groupIndex }
      let matches = existingByKey[key] ?? []
      var distinct: [Int] = []
      for member in members {
        if let identical = matches.first(where: { Self.isSame(candidates[member], as: $0) }) {
          classified[member] = .duplicate(of: .item(identical.id))
        } else if let representative = distinct.first(where: {
          candidates[$0].password.sameBytes(as: candidates[member].password) && candidates[$0].totp == candidates[member].totp
        }) {
          classified[member] = .duplicate(of: .sourceRow(candidates[representative].sourceRow))
        } else {
          distinct.append(member)
        }
      }
      if distinct.isEmpty { continue }
      let distinctPasswords = Set(distinct.map { Array(candidates[$0].password.utf8) })
      var seeds: [TOTPParameters] = []
      for member in distinct {
        if let seed = candidates[member].totp, !seeds.contains(seed) { seeds.append(seed) }
      }
      // Two seeds for one account cannot both be right, and keeping either
      // silently could lock the person out of the site's two-factor step.
      if distinctPasswords.count > 1 || seeds.count > 1 {
        let single = matches.count == 1 ? matches[0] : nil
        for member in distinct { classified[member] = .conflict(existingItemID: single?.id) }
        continue
      }
      let representative = distinct.first { candidates[$0].totp != nil } ?? distinct[0]
      for member in distinct where member != representative {
        classified[member] = .duplicate(of: .sourceRow(candidates[representative].sourceRow))
      }
      if let identical = matches.first(where: { Self.isSame(candidates[representative], as: $0) }) {
        classified[representative] = .duplicate(of: .item(identical.id))
      } else if matches.count == 1 {
        classified[representative] = .update(itemID: matches[0].id)
      } else if matches.isEmpty {
        classified[representative] = .new
      } else {
        classified[representative] = .conflict(existingItemID: nil)
      }
    }
    entries = candidates.indices.map { Entry(candidate: candidates[$0], classification: classified[$0], group: groupOf[$0]) }
  }

  /// The vault changes for the selected source rows: new rows are added,
  /// updates replace the saved password (and two-factor seed, when the row
  /// has one) of the item as it is at commit, duplicates are left out. A selected conflict row is added, or updates
  /// its single matching item; selecting two rows of one conflict is an error.
  public func changes(selecting rows: Set<Int>) throws -> VaultChanges {
    var changes = VaultChanges()
    var selectedByConflict: [Int: [Int]] = [:]
    for entry in entries where rows.contains(entry.candidate.sourceRow) {
      if case .conflict = entry.classification {
        selectedByConflict[entry.group, default: []].append(entry.candidate.sourceRow)
      }
    }
    if let clash = selectedByConflict.values.first(where: { $0.count > 1 }) {
      throw PlanError.conflictingSelection(rows: clash)
    }
    for entry in entries where rows.contains(entry.candidate.sourceRow) {
      switch entry.classification {
      case .new, .conflict(existingItemID: nil):
        changes.add.append(entry.candidate.draft)
      case .update(let id), .conflict(existingItemID: let id?):
        changes.replace.append(
          CredentialReplacement(itemID: id, password: entry.candidate.password, totp: entry.candidate.totp))
      case .duplicate:
        continue
      }
    }
    return changes
  }

  private static func isSame(_ candidate: ImportCandidate, as item: Item) -> Bool {
    item.password.map { candidate.password.sameBytes(as: $0) } == true && (candidate.totp == nil || candidate.totp == item.totp)
  }

  private struct Key: Hashable {
    let origins: [String]
    let username: [UInt8]

    init(origins: [String], username: String) {
      self.origins = origins.sorted()
      self.username = Array(username.utf8)
    }
  }
}
