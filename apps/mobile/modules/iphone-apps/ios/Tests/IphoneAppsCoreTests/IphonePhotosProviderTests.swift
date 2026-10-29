import Foundation
import XCTest
import OpensteerAppleData
@testable import IphoneAppsCore

// Failure-first fake OS cases: revoked/limited permission, ties/undated paging,
// forged/mismatched cursors, malformed arguments, oversized groups and deadlines.
final class IphonePhotosProviderTests: XCTestCase {
  func testDeniedAndRestrictedNeverFetch() async throws {
    for permission in [IphonePermission.denied, .restricted, .notDetermined] {
      let store = FakePhotos(permission: permission)
      do { _ = try await IphonePhotosProvider(store: store).invoke(operation: "list_assets", arguments: [:], budget: .unlimited); XCTFail("permission") }
      catch let error as HelperError { XCTAssertEqual(error.code, .permissionRequired) }
      let count = await store.fetchCount()
      XCTAssertEqual(count, 0)
    }
  }
  func testLimitedEmptyIsSelectedSuccess() async throws {
    let value = try await IphonePhotosProvider(store: FakePhotos(permission: .limited)).invoke(operation: "list_assets", arguments: [:], budget: .unlimited)
    XCTAssertEqual(value, .object(["scope": .string("selected"), "assets": .array([]), "nextCursor": .null]))
  }
  func testTiesUndatedAndDeletionDoNotRepeat() async throws {
    let store = FakePhotos(rows: [photo("c", nil), photo("b", 10), photo("a", 10)])
    let provider = IphonePhotosProvider(store: store)
    let first = try await provider.invoke(operation: "list_assets", arguments: ["limit": .number(1)], budget: .unlimited)
    let cursor = try XCTUnwrap(object(first)["nextCursor"])
    await store.remove("a")
    let second = try await provider.invoke(operation: "list_assets", arguments: ["limit": .number(100), "cursor": cursor], budget: .unlimited)
    guard case .array(let assets) = object(second)["assets"] else { return XCTFail("assets") }
    XCTAssertEqual(assets.map { object($0)["id"] }, [.string("b"), .string("c")])
    XCTAssertLessThan(try JSONEncoder().encode(second).count, 65536)
    do { _ = try await provider.invoke(operation: "list_assets", arguments: ["cursor": cursor, "favoritesOnly": .bool(true)], budget: .unlimited); XCTFail("query binding") } catch is IphoneArgumentsError {}
  }
  func testCursorBindsSubmillisecondDateFilters() async throws {
    let store = FakePhotos(rows: [photo("a", 1_800_000_000), photo("b", 1_800_000_000)])
    let provider = IphonePhotosProvider(store: store)
    let first = try await provider.invoke(operation: "list_assets", arguments: ["limit": .number(1),
      "createdAfter": .string("2026-01-01T00:00:00.0001Z")], budget: .unlimited)
    let cursor = try XCTUnwrap(object(first)["nextCursor"])
    do {
      _ = try await provider.invoke(operation: "list_assets", arguments: ["cursor": cursor,
        "createdAfter": .string("2026-01-01T00:00:00.0002Z")], budget: .unlimited)
      XCTFail("A different date filter must not accept the cursor")
    } catch is IphoneArgumentsError {}
  }
  func testStrictArgumentsAndMalformedCursor() async throws {
    let provider = IphonePhotosProvider(store: FakePhotos())
    let cases: [[String: JSONValue]] = [["limit": .number(0)], ["limit": .number(1.5)], ["cursor": .string("bad")], ["extra": .bool(true)], ["mediaKinds": .array([])], ["createdAfter": .string("2026-02-30T00:00:00Z")], ["createdAfter": .string("2026-01-02T00:00:00Z"), "createdBefore": .string("2026-01-01T00:00:00Z")]]
    for args in cases {
      do { _ = try await provider.invoke(operation: "list_assets", arguments: args, budget: .unlimited); XCTFail("invalid args") } catch is IphoneArgumentsError {}
    }
  }
  func testOversizedTieAndExpiredBudgetFail() async throws {
    let provider = IphonePhotosProvider(store: FakePhotos(rows: (0...1000).map { photo(String($0), 1) }))
    do { _ = try await provider.invoke(operation: "list_assets", arguments: [:], budget: .unlimited); XCTFail("tie cap") } catch let error as HelperError { XCTAssertEqual(error.code, .failed) }
    do { _ = try await provider.invoke(operation: "list_assets", arguments: [:], budget: WorkBudget(requestEnd: .distantPast)); XCTFail("deadline") } catch let error as HelperError { XCTAssertEqual(error.code, .failed) }
  }
  func testAlbumsPageAndRejectAssetFilters() async throws {
    let provider = IphonePhotosProvider(store: FakePhotos())
    let value = try await provider.invoke(operation: "list_albums", arguments: [:], budget: .unlimited)
    XCTAssertEqual(object(value)["albums"], .array([]))
    do { _ = try await provider.invoke(operation: "list_albums", arguments: ["albumId": .string("x")], budget: .unlimited); XCTFail("filter") } catch is IphoneArgumentsError {}
  }
  func testLongUnicodeAlbumTitlesRespectSchemaAndStillPage() async throws {
    let emoji = IphonePhotoAlbum(id: "emoji", title: String(repeating: "👩🏽‍💻", count: 256), assetCount: 1)
    XCTAssertEqual(emoji.title, String(repeating: "👩🏽‍💻", count: 36))
    XCTAssertLessThanOrEqual(emoji.title.utf16.count, 256)
    let raw = String(repeating: "相", count: 300)
    let title = String(repeating: "相", count: 256)
    let firstAlbum = IphonePhotoAlbum(id: "a", title: raw, assetCount: 1)
    XCTAssertEqual(firstAlbum.title, title)
    XCTAssertEqual(firstAlbum.title.unicodeScalars.count, 256)
    let provider = IphonePhotosProvider(store: FakePhotos(albums: [firstAlbum,
      IphonePhotoAlbum(id: "b", title: raw, assetCount: 2)]))
    let first = try await provider.invoke(operation: "list_albums", arguments: ["limit": .number(1)], budget: .unlimited)
    let cursor = try XCTUnwrap(object(first)["nextCursor"])
    let second = try await provider.invoke(operation: "list_albums", arguments: ["cursor": cursor], budget: .unlimited)
    guard case .array(let albums) = object(second)["albums"] else { return XCTFail("albums") }
    XCTAssertEqual(albums.map { object($0)["id"] }, [.string("b")])
    XCTAssertEqual(object(second)["nextCursor"], .null)
  }
}
private func object(_ value: JSONValue) -> [String: JSONValue] { if case .object(let object) = value { return object }; return [:] }
private func photo(_ id: String, _ seconds: Double?) -> IphonePhotoAsset {
  IphonePhotoAsset(id: id, createdAt: seconds.map(Date.init(timeIntervalSince1970:)), modifiedAt: nil, mediaKind: "image", width: 10, height: 20, durationSeconds: nil, favorite: false)
}
private actor FakePhotos: IphonePhotosStorePort {
  var state: IphonePermission
  var rows: [IphonePhotoAsset]
  var calls = 0
  var albumRows: [IphonePhotoAlbum]
  init(permission: IphonePermission = .granted, rows: [IphonePhotoAsset] = [], albums: [IphonePhotoAlbum] = []) { state = permission; self.rows = rows; albumRows = albums }
  func permission() -> IphonePermission { state }
  func fetchCount() -> Int { calls }
  func remove(_ id: String) { rows.removeAll { $0.id == id } }
  func assetGroup(filters: IphonePhotosFilters, date: Date?, inclusive: Bool, undated: Bool, budget: WorkBudget) throws -> [IphonePhotoAsset] {
    calls += 1
    if undated { return rows.filter { $0.createdAt == nil } }
    let eligible = rows.filter { row in guard let at = row.createdAt else { return false }; return date.map { inclusive ? at <= $0 : at < $0 } ?? true }
    guard let newest = eligible.compactMap(\.createdAt).max() else { return [] }
    return eligible.filter { $0.createdAt == newest }
  }
  func albums(afterTitle: String?, afterId: String?, limit: Int, budget: WorkBudget) -> [IphonePhotoAlbum] {
    Array(albumRows.filter { row in
      guard let afterTitle, let afterId else { return true }
      return row.title > afterTitle || (row.title == afterTitle && row.id > afterId)
    }.prefix(limit))
  }
}
