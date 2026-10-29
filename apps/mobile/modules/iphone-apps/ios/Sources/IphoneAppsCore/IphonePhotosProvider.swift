import CryptoKit
import Foundation
import OpensteerAppleData

public struct IphonePhotoAsset: Sendable {
  public let id: String
  public let createdAt: Date?
  public let modifiedAt: Date?
  public let mediaKind: String
  public let width: Int
  public let height: Int
  public let durationSeconds: Double?
  public let favorite: Bool
  public init(id: String, createdAt: Date?, modifiedAt: Date?, mediaKind: String, width: Int, height: Int, durationSeconds: Double?, favorite: Bool) {
    self.id = id; self.createdAt = createdAt; self.modifiedAt = modifiedAt; self.mediaKind = mediaKind
    self.width = width; self.height = height; self.durationSeconds = durationSeconds; self.favorite = favorite
  }
}
public struct IphonePhotoAlbum: Sendable {
  public let id: String
  public let title: String
  public let assetCount: Int
  public init(id: String, title: String, assetCount: Int) {
    self.id = id
    // The Host validator counts UTF-16 units. Keep whole characters within
    // that bound, including multi-scalar emoji, before sorting and paging.
    var length = 0
    self.title = String(title.prefix { character in
      length += String(character).utf16.count
      return length <= 256
    })
    self.assetCount = assetCount
  }
}
public struct IphonePhotosFilters: Sendable {
  public let albumId: String?
  public let mediaKinds: [String]
  public let createdAfter: Date?
  public let createdBefore: Date?
  public let favoritesOnly: Bool
  public init(albumId: String? = nil, mediaKinds: [String] = [], createdAfter: Date? = nil, createdBefore: Date? = nil, favoritesOnly: Bool = false) {
    self.albumId = albumId; self.mediaKinds = mediaKinds; self.createdAfter = createdAfter; self.createdBefore = createdBefore; self.favoritesOnly = favoritesOnly
  }
}
public protocol IphonePhotosStorePort: Sendable {
  func permission() async -> IphonePermission
  /// Returns one complete timestamp group, or undated group. At most 1001 rows.
  func assetGroup(filters: IphonePhotosFilters, date: Date?, inclusive: Bool, undated: Bool, budget: WorkBudget) async throws -> [IphonePhotoAsset]
  func albums(afterTitle: String?, afterId: String?, limit: Int, budget: WorkBudget) async throws -> [IphonePhotoAlbum]
}
public struct IphonePhotosProvider: DataProvider {
  private let store: any IphonePhotosStorePort
  public init(store: any IphonePhotosStorePort) { self.store = store }
  private struct Cursor: Codable { let v: Int; let q: String; let at: String?; let id: String }
  private static func check(_ budget: WorkBudget) throws { try Task.checkCancellation(); try budget.check() }
  private func scope() async throws -> String {
    switch await store.permission() {
    case .granted: return "all"
    case .limited: return "selected"
    default: throw HelperError(.permissionRequired, "Allow Photos access in iPhone Settings.")
    }
  }
  public func invoke(operation: String, arguments: [String: JSONValue], budget: WorkBudget) async throws -> JSONValue {
    try Self.check(budget)
    guard operation == "list_assets" || operation == "list_albums" else { throw HelperError(.unsupported, "This Photos operation is not supported.") }
    let assets = operation == "list_assets"
    let allowed: Set<String> = assets ? ["limit", "cursor", "albumId", "mediaKinds", "createdAfter", "createdBefore", "favoritesOnly"] : ["limit", "cursor"]
    guard Set(arguments.keys).isSubset(of: allowed) else { throw invalid() }
    var limit = 50
    if let value = arguments["limit"] { guard case .number(let n) = value, n >= 1, n <= 100, n.rounded() == n else { throw invalid() }; limit = Int(n) }
    func string(_ key: String, max: Int) throws -> String? {
      guard let value = arguments[key] else { return nil }
      guard case .string(let s) = value, !s.isEmpty, s.count <= max else { throw invalid() }; return s
    }
    let album = try string("albumId", max: 256)
    let afterText = try string("createdAfter", max: 40), beforeText = try string("createdBefore", max: 40)
    let after = try afterText.map(Self.parseDate), before = try beforeText.map(Self.parseDate)
    if let after, let before, after >= before { throw invalid() }
    var kinds: [String] = []
    if let value = arguments["mediaKinds"] {
      guard case .array(let values) = value, (1...3).contains(values.count) else { throw invalid() }
      for value in values { guard case .string(let kind) = value, ["image", "video", "live-photo"].contains(kind), !kinds.contains(kind) else { throw invalid() }; kinds.append(kind) }
    }
    var favorite = false
    if let value = arguments["favoritesOnly"] { guard case .bool(let flag) = value else { throw invalid() }; favorite = flag }
    let filters = IphonePhotosFilters(albumId: album, mediaKinds: kinds.sorted(), createdAfter: after, createdBefore: before, favoritesOnly: favorite)
    let canonical: [String: Any] = ["operation": operation, "order": assets ? "date-desc-id-asc-undated-last" : "title-id-asc", "album": album ?? "", "kinds": kinds.sorted(), "after": afterText ?? "", "before": beforeText ?? "", "favorite": favorite]
    let bytes = try JSONSerialization.data(withJSONObject: canonical, options: [.sortedKeys])
    let query = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    var cursor: Cursor?
    if let text = try string("cursor", max: 2048) {
      guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { throw invalid() }
      let base = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
      guard let data = Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4)),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], Set(object.keys).isSubset(of: ["v", "q", "at", "id"]),
        let value = try? JSONDecoder().decode(Cursor.self, from: data), value.v == 1, value.q == query, !value.id.isEmpty, value.id.count <= 256 else { throw invalid() }
      if assets, let at = value.at { guard let seconds = Double(at), seconds.isFinite else { throw invalid() } }
      if !assets && value.at == nil { throw invalid() }
      cursor = value
    }
    let initialScope = try await scope()
    var rows: [JSONValue] = []
    var next: Cursor?
    if assets {
      var anchor = cursor?.at.flatMap(Double.init).map(Date.init(timeIntervalSince1970:))
      var lastAsset: IphonePhotoAsset?
      var undated = cursor != nil && cursor?.at == nil
      var inclusive = cursor != nil
      var skipId = cursor?.id
      while rows.count <= limit {
        try Self.check(budget)
        let group = try await store.assetGroup(filters: filters, date: anchor, inclusive: inclusive, undated: undated, budget: budget)
        guard group.count <= 1000 else { throw HelperError(.failed, "Too many photos have the same date to page safely.") }
        if group.isEmpty { if undated { break }; undated = true; inclusive = false; skipId = nil; continue }
        for row in group.sorted(by: { $0.id < $1.id }) {
          try Self.check(budget)
          if let skipId, row.createdAt == anchor, row.id <= skipId { continue }
          if rows.count == limit { next = Cursor(v: 1, q: query, at: lastAsset?.createdAt.map { String($0.timeIntervalSince1970) }, id: lastAsset?.id ?? ""); break }
          lastAsset = row
          rows.append(.object(["id": .string(row.id), "createdAt": row.createdAt.map { .string(Self.date($0)) } ?? .null, "modifiedAt": row.modifiedAt.map { .string(Self.date($0)) } ?? .null, "mediaKind": .string(row.mediaKind), "width": .number(Double(row.width)), "height": .number(Double(row.height)), "durationSeconds": row.durationSeconds.map(JSONValue.number) ?? .null, "favorite": .bool(row.favorite)]))
        }
        if next != nil || undated { break }
        anchor = group.first?.createdAt; inclusive = false; skipId = nil
      }
    } else {
      let albums = try await store.albums(afterTitle: cursor?.at, afterId: cursor?.id, limit: limit + 1, budget: budget)
      for row in albums.prefix(limit) { try Self.check(budget); rows.append(.object(["id": .string(row.id), "title": .string(row.title), "assetCount": .number(Double(row.assetCount))])) }
      if albums.count > limit, let last = albums.prefix(limit).last { next = Cursor(v: 1, q: query, at: last.title, id: last.id) }
    }
    try Self.check(budget)
    guard try await scope() == initialScope else { throw HelperError(.permissionRequired, "Photos access changed; try again.") }
    let nextText: JSONValue
    if let next { let data = try JSONEncoder().encode(next); let text = data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""); guard text.count <= 2048 else { throw HelperError(.failed, "This photo identifier is too long to page safely.") }; nextText = .string(text) } else { nextText = .null }
    return .object(["scope": .string(initialScope), assets ? "assets" : "albums": .array(rows), "nextCursor": nextText])
  }
  private func invalid() -> IphoneArgumentsError { IphoneArgumentsError("These Photos arguments or cursor are invalid.") }
  private static func date(_ value: Date) -> String { let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter.string(from: value) }
  private static func parseDate(_ text: String) throws -> Date {
    let pattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$"#
    guard text.range(of: pattern, options: .regularExpression) != nil else { throw IphoneArgumentsError("Use an ISO date and time with a timezone.") }
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let value = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    guard let value else { throw IphoneArgumentsError("Use a valid ISO date and time.") }
    // ISO8601DateFormatter normalizes invalid calendar days; validate that day independently.
    let day = String(text.prefix(10)); let dateFormatter = DateFormatter(); dateFormatter.locale = Locale(identifier: "en_US_POSIX"); dateFormatter.dateFormat = "yyyy-MM-dd"; dateFormatter.isLenient = false
    guard let parsed = dateFormatter.date(from: day), dateFormatter.string(from: parsed) == day else { throw IphoneArgumentsError("Use a valid calendar date.") }
    return value
  }
}
