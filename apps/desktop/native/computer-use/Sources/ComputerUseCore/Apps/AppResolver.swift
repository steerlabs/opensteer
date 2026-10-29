import AppKit
import Foundation

/// `app.resolve`: a bundle identifier, an absolute path, or a display name →
/// one app, or `app-not-found` with a sentence that lists the candidates.
public enum AppResolver {

  public static func resolve(
    query rawQuery: String,
    in records: [AppBundleRecord]
  ) throws -> AppBundleRecord {
    let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      throw HelperError(.appNotFound, "Name an app to use.")
    }

    if let match = records.first(where: {
      $0.identity.bundleId.caseInsensitiveCompare(query) == .orderedSame
    }) {
      return match
    }

    if query.hasPrefix("/") {
      let normalized = normalize(path: query)
      if let match = records.first(where: { normalize(path: $0.path) == normalized }) {
        return match
      }
      throw HelperError(
        .appNotFound,
        "Computer use can approve apps installed in Applications on this Mac."
      )
    }

    let exact = records.filter {
      $0.identity.displayName.caseInsensitiveCompare(query) == .orderedSame
    }
    if exact.count == 1, let match = exact.first { return match }
    if exact.count > 1 { throw ambiguous(query: query, candidates: exact) }

    let prefixed = records.filter {
      $0.identity.displayName.lowercased().hasPrefix(query.lowercased())
    }
    if prefixed.count == 1, let match = prefixed.first { return match }
    if prefixed.count > 1 { throw ambiguous(query: query, candidates: prefixed) }

    throw HelperError(.appNotFound, "No app on this Mac is called \(quoted(query)).")
  }

  static func ambiguous(query: String, candidates: [AppBundleRecord]) -> HelperError {
    let names = candidates.prefix(6).map { "\($0.identity.displayName) (\($0.identity.bundleId))" }
    let tail = candidates.count > 6 ? ", and \(candidates.count - 6) more" : ""
    return HelperError(
      .appNotFound,
      "More than one app matches \(quoted(query)): \(names.joined(separator: ", "))\(tail); "
        + "name one by its bundle identifier."
    )
  }

  /// A record for a bundle the index did not walk to, read straight from disk.
  public static func record(forBundleAtPath path: String) -> AppBundleRecord? {
    let url = URL(fileURLWithPath: path, isDirectory: true)
    guard url.pathExtension == "app",
      let bundle = Bundle(url: url),
      let bundleIdentifier = bundle.bundleIdentifier
    else { return nil }
    let info = bundle.infoDictionary ?? [:]
    let name =
      (info["CFBundleDisplayName"] as? String)
      ?? (info["CFBundleName"] as? String)
      ?? url.deletingPathExtension().lastPathComponent
    return AppBundleRecord(
      identity: AppIdentity(
        bundleId: bundleIdentifier,
        displayName: name,
        teamId: AppCatalog.teamIdentifier(forBundleAt: url)
      ),
      path: url.path
    )
  }

  @MainActor
  public static func isRunning(bundleIdentifier: String) -> Bool {
    !NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).isEmpty
  }

  @MainActor
  public static func resolved(_ record: AppBundleRecord) -> ResolvedApp {
    let verdict = AppPolicy.verdict(for: record.identity.bundleId)
    return ResolvedApp(
      allowed: verdict.allowed,
      identity: record.identity,
      path: record.path,
      reason: verdict.reason,
      risk: verdict.risk,
      running: isRunning(bundleIdentifier: record.identity.bundleId)
    )
  }

  private static func normalize(path: String) -> String {
    var value = path
    while value.count > 1, value.hasSuffix("/") { value.removeLast() }
    return value
  }

  private static func quoted(_ value: String) -> String {
    "\u{201C}\(value)\u{201D}"
  }
}
