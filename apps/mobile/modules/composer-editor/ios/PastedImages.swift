import UIKit
import UniformTypeIdentifiers

/// Images pasted or dropped into the editor, written to private temporary files.
enum PastedImages {
  /// Formats the Host reads as they are; anything else (HEIC from Photos, TIFF)
  /// is re-encoded as JPEG, as the photo picker's compatible mode does.
  private static let kept: [UTType] = [.png, .jpeg, .webP, .gif]

  private enum Outcome { case image([String: Any]), failed, tooLarge }

  static func providers(_ providers: [NSItemProvider]) -> [NSItemProvider] {
    providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
  }

  /// Delivers `{ images, failed, tooLarge }` on the main queue, or discards the files if `isLive` says no.
  static func load(
    _ providers: [NSItemProvider],
    maxBytes: Int,
    isLive: @escaping () -> Bool,
    deliver: @escaping ([String: Any]) -> Void
  ) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("pasted-images", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let group = DispatchGroup()
    var outcomes = [Outcome](repeating: .failed, count: providers.count)
    for (index, provider) in providers.enumerated() {
      group.enter()
      load(provider, into: directory, maxBytes: maxBytes) { outcome in
        DispatchQueue.main.async {
          outcomes[index] = outcome
          group.leave()
        }
      }
    }
    group.notify(queue: .main) {
      let delivered = outcomes.compactMap { outcome -> [String: Any]? in
        if case .image(let image) = outcome { return image }
        return nil
      }
      guard isLive() else {
        for image in delivered { discard(image) }
        return
      }
      deliver([
        "images": delivered,
        "failed": outcomes.filter { if case .failed = $0 { return true }; return false }.count,
        "tooLarge": outcomes.filter { if case .tooLarge = $0 { return true }; return false }.count,
      ])
    }
  }

  private static func load(
    _ provider: NSItemProvider, into directory: URL, maxBytes: Int, done: @escaping (Outcome) -> Void
  ) {
    let registered = provider.registeredTypeIdentifiers.compactMap(UTType.init)
    let name = provider.suggestedName.flatMap { $0.isEmpty ? nil : $0 } ?? "Pasted image"
    let finish = { (data: Data?, type: UTType) in
      guard let data else { return done(.failed) }
      guard data.count <= maxBytes else { return done(.tooLarge) }
      done(write(data, type: type, name: name, into: directory).map(Outcome.image) ?? .failed)
    }
    if let type = registered.first(where: { candidate in kept.contains { candidate.conforms(to: $0) } }) {
      provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
        finish(data, kept.first { type.conforms(to: $0) } ?? type)
      }
      return
    }
    guard provider.canLoadObject(ofClass: UIImage.self) else { return done(.failed) }
    provider.loadObject(ofClass: UIImage.self) { object, _ in
      finish((object as? UIImage)?.jpegData(compressionQuality: 0.9), .jpeg)
    }
  }

  private static func write(_ data: Data, type: UTType, name: String, into directory: URL) -> [String: Any]? {
    let ext = type.preferredFilenameExtension ?? "img"
    let url = directory.appendingPathComponent("\(UUID().uuidString).\(ext)")
    do {
      try data.write(to: url, options: [.atomic, .completeFileProtection])
    } catch {
      return nil
    }
    let base = (name as NSString).deletingPathExtension
    return [
      "uri": url.absoluteString,
      "mediaType": type.preferredMIMEType ?? "application/octet-stream",
      "name": "\(base.isEmpty ? "Pasted image" : base).\(ext)",
    ]
  }

  private static func discard(_ image: [String: Any]) {
    if let uri = image["uri"] as? String, let url = URL(string: uri) {
      try? FileManager.default.removeItem(at: url)
    }
  }
}
