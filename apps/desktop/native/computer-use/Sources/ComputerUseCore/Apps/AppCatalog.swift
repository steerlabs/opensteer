import AppKit
import Foundation
import Security

/// What the helper knows about one app bundle on disk.
public struct AppBundleRecord: Sendable {
  public let identity: AppIdentity
  public let path: String
}

/// The installed-app index behind `apps.installed` and `app.resolve`.
///
/// Enumeration includes one level of vendor folders under Applications; it is not a filesystem
/// search, and the helper never reports what is inside anyone's home beyond
/// `~/Applications`.
public actor AppCatalog {
  private static let cacheLifetime: TimeInterval = 60

  private var cached: [AppBundleRecord] = []
  private var cachedAt: Date?

  private let roots: [URL]
  private let bundles: [URL]

  public init() {
    roots = Self.searchRoots
    bundles = Self.individualBundles
  }

  init(roots: [URL], bundles: [URL] = []) {
    self.roots = roots
    self.bundles = bundles
  }

  public func records() async -> [AppBundleRecord] {
    if let cachedAt, Date().timeIntervalSince(cachedAt) < Self.cacheLifetime {
      return cached
    }
    let scanned = Self.scan(roots: roots, bundles: bundles)
    cached = scanned
    cachedAt = Date()
    return scanned
  }

  func installed(_ params: Wire.InstalledAppsParams) async -> Wire.InstalledAppsResult {
    let matching = Self.matching(await records(), query: params.query)
    let page = Array(matching.dropFirst(params.offset).prefix(params.limit))
    let icons = params.icons ? await AppIcons.pngBase64(forPaths: page.map(\.path)) : [:]
    var apps: [InstalledApp] = []
    for record in page {
      apps.append(
        InstalledApp(
          identity: record.identity,
          running: await AppResolver.isRunning(bundleIdentifier: record.identity.bundleId),
          iconPng: icons[record.path] ?? nil))
    }
    return Wire.InstalledAppsResult(apps: apps, total: matching.count)
  }

  nonisolated static func matching(_ records: [AppBundleRecord], query: String) -> [AppBundleRecord]
  {
    records.filter {
      query.isEmpty
        || $0.identity.displayName.range(of: query, options: .caseInsensitive) != nil
        || $0.identity.bundleId.range(of: query, options: .caseInsensitive) != nil
    }
  }

  public func resolve(query: String) async throws -> AppBundleRecord {
    do { return try AppResolver.resolve(query: query, in: await records()) } catch let error
      as HelperError where error.code == .appNotFound
    {
      invalidate()
      return try AppResolver.resolve(query: query, in: await records())
    }
  }

  /// Drop the cache so the next read sees an app that was just installed.
  public func invalidate() {
    cachedAt = nil
  }

  // MARK: - Scanning

  private static var searchRoots: [URL] {
    let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    return [
      URL(fileURLWithPath: "/Applications", isDirectory: true),
      URL(fileURLWithPath: "/System/Applications", isDirectory: true),
      URL(fileURLWithPath: "/System/Applications/Utilities", isDirectory: true),
      home.appendingPathComponent("Applications", isDirectory: true),
    ]
  }

  /// Apps a person uses every day that macOS keeps outside every Applications
  /// folder. Finder lives with the system's own agents, which are not listed.
  static let individualBundles = [
    URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app", isDirectory: true)
  ]

  static func scan(roots: [URL], bundles: [URL]) -> [AppBundleRecord] {
    var byBundleIdentifier: [String: AppBundleRecord] = [:]
    var order: [String] = []
    let listed = roots.map { root in
      bundleURLs(in: root, descendOneLevel: root.path != "/System/Applications/Utilities")
    }
    for url in listed.joined() + bundles {
      guard let record = read(bundleAt: url) else { continue }
      let key = record.identity.bundleId.lowercased()
      if byBundleIdentifier[key] == nil {
        byBundleIdentifier[key] = record
        order.append(key)
      }
    }
    return order.compactMap { byBundleIdentifier[$0] }
      .sorted { left, right in
        left.identity.displayName.localizedCaseInsensitiveCompare(right.identity.displayName)
          == .orderedAscending
      }
  }

  /// Dot files are skipped by name, not by the hidden flag: macOS installs
  /// Safari in /Applications as a symlink flagged hidden, and Finder still
  /// shows it there.
  static func bundleURLs(in root: URL, descendOneLevel: Bool) -> [URL] {
    let contents =
      (try? FileManager.default.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: [.isDirectoryKey, .isPackageKey],
        options: [.skipsPackageDescendants]
      )) ?? []
    var found: [URL] = []
    for url in contents where !url.lastPathComponent.hasPrefix(".") {
      if url.pathExtension == "app" {
        found.append(url)
        continue
      }
      guard descendOneLevel,
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey]),
        values.isDirectory == true, values.isPackage != true,
        Bundle(url: url)?.bundleIdentifier == nil
      else { continue }
      found.append(contentsOf: bundleURLs(in: url, descendOneLevel: false))
    }
    return found
  }

  private static func read(bundleAt url: URL) -> AppBundleRecord? {
    guard let bundle = Bundle(url: url),
      let bundleIdentifier = bundle.bundleIdentifier,
      !bundleIdentifier.isEmpty
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
        teamId: teamIdentifier(forBundleAt: url)
      ),
      path: url.path
    )
  }

  /// The signing team, or `nil` for an unsigned app — which is a legitimate
  /// answer, not an error: `ComputerAppIdentity` carries `null` for one.
  static func teamIdentifier(forBundleAt url: URL) -> String? {
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess,
      let staticCode
    else { return nil }
    return signingIdentity(of: staticCode)?.teamId
  }

  /// The code identifier and signing team of one piece of code. The bundle on
  /// disk and the running process are both read here, with the flag that makes
  /// Security include the team at all: without it every team is `nil`, and no
  /// running third-party app would ever match its approval.
  nonisolated static func signingIdentity(of staticCode: SecStaticCode)
    -> (identifier: String, teamId: String?)?
  {
    var information: CFDictionary?
    guard
      SecCodeCopySigningInformation(
        staticCode,
        SecCSFlags(rawValue: kSecCSSigningInformation),
        &information
      ) == errSecSuccess,
      let values = information as? [String: Any],
      let identifier = values[kSecCodeInfoIdentifier as String] as? String
    else { return nil }
    return (identifier, values[kSecCodeInfoTeamIdentifier as String] as? String)
  }

  /// Approval binds the complete identity that was shown to the owner. Bundle
  /// identifiers are compared case-insensitively because they are app keys;
  /// the displayed name and signing team must be the approved values.
  public nonisolated static func sameIdentity(_ left: AppIdentity, _ right: AppIdentity) -> Bool {
    left.bundleId.caseInsensitiveCompare(right.bundleId) == .orderedSame
      && left.displayName == right.displayName
      && left.teamId == right.teamId
  }

  /// Re-read the selected bundle rather than trusting the minute-long picker
  /// cache when authority is about to be established.
  public nonisolated static func freshRecord(_ record: AppBundleRecord) -> AppBundleRecord? {
    AppResolver.record(forBundleAtPath: record.path)
  }

  /// The installed bundle behind an identity the Host carried, read fresh from
  /// disk, or the refusal that says why it is not the approved app. This is
  /// the first-use check of an app in a session (§1 invariant 3).
  public func verifiedRecord(for approved: AppIdentity) async throws -> AppBundleRecord {
    let indexed = try await resolve(query: approved.bundleId)
    guard let record = Self.freshRecord(indexed) else {
      throw HelperError(.appNotFound, "The approved app is no longer installed on this Mac.")
    }
    guard Self.sameIdentity(record.identity, approved) else {
      throw HelperError(
        .appNotAllowed,
        "This app no longer matches what the owner approved. Remove it and approve it again."
      )
    }
    return record
  }

  /// Bind a PID back to the approved bundle on disk and to the code actually
  /// executing in that process. The path prevents a second installation with
  /// the same identifier from being selected; the live SecCode identity catches
  /// replacement or re-signing after approval.
  public nonisolated static func runningApplication(
    _ application: NSRunningApplication,
    matches identity: AppIdentity,
    bundlePath: String
  ) -> Bool {
    guard let runningBundle = application.bundleURL else { return false }
    let expectedPath = URL(fileURLWithPath: bundlePath).resolvingSymlinksInPath()
      .standardizedFileURL.path
    let actualPath = runningBundle.resolvingSymlinksInPath().standardizedFileURL.path
    guard expectedPath == actualPath,
      let record = AppResolver.record(forBundleAtPath: actualPath),
      sameIdentity(record.identity, identity)
    else { return false }

    let attributes =
      [kSecGuestAttributePid as String: NSNumber(value: application.processIdentifier)]
      as CFDictionary
    var guest: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
      let guest
    else { return false }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(guest, [], &staticCode) == errSecSuccess,
      let staticCode,
      let live = signingIdentity(of: staticCode),
      live.identifier.caseInsensitiveCompare(identity.bundleId) == .orderedSame
    else { return false }
    return live.teamId == identity.teamId
  }
}

/// Icons are rendered on the main actor because `NSWorkspace` and `NSImage`
/// belong there; the scan that feeds this does not.
enum AppIcons {
  @MainActor
  static func pngBase64(forPaths paths: [String]) -> [String: String?] {
    var result: [String: String?] = [:]
    for path in paths {
      result[path] = pngBase64(forPath: path)
    }
    return result
  }

  @MainActor
  static func pngBase64(forPath path: String) -> String? {
    guard
      let representation = bitmap(NSWorkspace.shared.icon(forFile: path), pixels: 64),
      let data = representation.representation(using: .png, properties: [:])
    else { return nil }
    return data.base64EncodedString()
  }

  /// `icon` drawn into a square bitmap `pixels` wide, at one point per pixel.
  @MainActor
  static func bitmap(_ icon: NSImage, pixels: Int) -> NSBitmapImageRep? {
    guard
      pixels > 0,
      let representation = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
      )
    else { return nil }
    let size = NSSize(width: pixels, height: pixels)
    representation.size = size
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    guard let context = NSGraphicsContext(bitmapImageRep: representation) else { return nil }
    NSGraphicsContext.current = context
    icon.draw(
      in: NSRect(origin: .zero, size: size),
      from: .zero,
      operation: .sourceOver,
      fraction: 1
    )
    context.flushGraphics()
    return representation
  }
}
