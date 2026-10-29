import Foundation
import Photos
import OpensteerAppleData

/// Metadata-only PhotoKit access. Actor work stays off the main actor; permission
/// requests and the limited-library picker belong exclusively to the owner UI.
actor IphonePhotosStore: IphonePhotosStorePort {
  func permission() -> IphonePermission {
    switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
    case .authorized: return .granted
    case .limited: return .limited
    case .denied: return .denied
    case .restricted: return .restricted
    case .notDetermined: return .notDetermined
    @unknown default: return .restricted
    }
  }
  private func check(_ budget: WorkBudget) throws {
    try Task.checkCancellation(); try budget.check()
    guard permission() == .granted || permission() == .limited else { throw HelperError(.permissionRequired, "Allow Photos access in iPhone Settings.") }
  }
  private func options(_ predicates: [NSPredicate], limit: Int) -> PHFetchOptions {
    let options = PHFetchOptions()
    options.includeHiddenAssets = false
    options.includeAssetSourceTypes = .typeUserLibrary
    options.fetchLimit = limit
    options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
    return options
  }
  private func base(_ filters: IphonePhotosFilters) -> [NSPredicate] {
    var predicates = [NSPredicate(format: "mediaType IN %@", [PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue])]
    if filters.favoritesOnly { predicates.append(NSPredicate(format: "favorite == YES")) }
    if let after = filters.createdAfter { predicates.append(NSPredicate(format: "creationDate > %@", after as NSDate)) }
    if let before = filters.createdBefore { predicates.append(NSPredicate(format: "creationDate < %@", before as NSDate)) }
    if !filters.mediaKinds.isEmpty {
      let kinds = filters.mediaKinds.map { kind -> NSPredicate in
        if kind == "video" { return NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue) }
        let live = PHAssetMediaSubtype.photoLive.rawValue
        return NSPredicate(format: kind == "live-photo" ? "mediaType == %d AND (mediaSubtypes & %d) != 0" : "mediaType == %d AND (mediaSubtypes & %d) == 0", PHAssetMediaType.image.rawValue, live)
      }
      predicates.append(NSCompoundPredicate(orPredicateWithSubpredicates: kinds))
    }
    return predicates
  }
  private func fetch(_ options: PHFetchOptions, album: PHAssetCollection?) -> PHFetchResult<PHAsset> {
    if let album { return PHAsset.fetchAssets(in: album, options: options) }
    return PHAsset.fetchAssets(with: options)
  }
  func assetGroup(filters: IphonePhotosFilters, date: Date?, inclusive: Bool, undated: Bool, budget: WorkBudget) throws -> [IphonePhotoAsset] {
    try check(budget)
    var album: PHAssetCollection?
    if let id = filters.albumId {
      album = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil).firstObject
      guard let album, album.assetCollectionType == .album, album.assetCollectionSubtype == .albumRegular else { return [] }
    }
    var predicates = base(filters)
    if undated { predicates.append(NSPredicate(format: "creationDate == nil")) }
    else {
      predicates.append(NSPredicate(format: "creationDate != nil"))
      if let date { predicates.append(NSPredicate(format: inclusive ? "creationDate <= %@" : "creationDate < %@", date as NSDate)) }
      let firstOptions = options(predicates, limit: 1)
      firstOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
      guard let newest = fetch(firstOptions, album: album).firstObject?.creationDate else { return [] }
      predicates.append(NSPredicate(format: "creationDate == %@", newest as NSDate))
    }
    let result = fetch(options(predicates, limit: 1001), album: album)
    var rows: [IphonePhotoAsset] = []
    for index in 0..<result.count {
      try check(budget)
      let asset = result.object(at: index)
      let kind = asset.mediaType == .video ? "video" : asset.mediaSubtypes.contains(.photoLive) ? "live-photo" : "image"
      rows.append(IphonePhotoAsset(id: asset.localIdentifier, createdAt: asset.creationDate, modifiedAt: asset.modificationDate, mediaKind: kind, width: asset.pixelWidth, height: asset.pixelHeight, durationSeconds: kind == "video" ? asset.duration : nil, favorite: asset.isFavorite))
    }
    return rows
  }
  func albums(afterTitle: String?, afterId: String?, limit: Int, budget: WorkBudget) throws -> [IphonePhotoAlbum] {
    try check(budget)
    let collections = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil)
    var page: [IphonePhotoAlbum] = []
    // Album titles can be nil/long and localIdentifier is not a portable sort
    // descriptor. Keep only a bounded top page while enumerating user albums.
    for index in 0..<collections.count {
      try check(budget)
      let collection = collections.object(at: index)
      let id = collection.localIdentifier
      let row = IphonePhotoAlbum(id: id, title: collection.localizedTitle ?? "", assetCount: 0)
      let title = row.title
      if let afterTitle, let afterId, title < afterTitle || (title == afterTitle && id <= afterId) { continue }
      page.append(row)
      page.sort { $0.title == $1.title ? $0.id < $1.id : $0.title < $1.title }
      if page.count > limit { page.removeLast() }
    }
    var output: [IphonePhotoAlbum] = []
    let filters = IphonePhotosFilters()
    for row in page {
      try check(budget)
      guard let collection = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [row.id], options: nil).firstObject else { continue }
      let count = PHAsset.fetchAssets(in: collection, options: options(base(filters), limit: 0)).count
      output.append(IphonePhotoAlbum(id: row.id, title: row.title, assetCount: count))
    }
    return output
  }
}
