import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

public final class PasteTargetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpensteerPasteTarget")
    View(PasteTargetView.self) {
      Events("onPasteImages")
    }
  }
}

/// Takes the images a Paste delivers to the text field it holds. A React Native
/// field declines Paste for a pasteboard that holds no text, and UIKit then asks
/// each view above the first responder; this view answers for images, so text
/// pastes stay with the field and nothing in React Native is replaced.
final class PasteTargetView: ExpoView {
  let onPasteImages = EventDispatcher()

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(UIResponderStandardEditActions.paste(_:)) {
      return UIPasteboard.general.hasImages
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    let providers = UIPasteboard.general.itemProviders
      .filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
    guard !providers.isEmpty else { return }
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("pasted-images", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let group = DispatchGroup()
    var images = [[String: Any]?](repeating: nil, count: providers.count)
    for (index, provider) in providers.enumerated() {
      group.enter()
      PastedImage.load(provider, into: directory) { image in
        DispatchQueue.main.async {
          images[index] = image
          group.leave()
        }
      }
    }
    group.notify(queue: .main) { [weak self] in
      let delivered = images.compactMap { $0 }
      guard let self, self.window != nil else {
        for image in delivered { PastedImage.discard(image) }
        return
      }
      self.onPasteImages(["images": delivered, "failed": images.count - delivered.count])
    }
  }
}

private enum PastedImage {
  /// Formats the Host reads as they are; anything else (HEIC from Photos, TIFF)
  /// is re-encoded as JPEG, as the photo picker's compatible mode does.
  static let kept: [UTType] = [.png, .jpeg, .webP, .gif]

  static func load(
    _ provider: NSItemProvider, into directory: URL, done: @escaping ([String: Any]?) -> Void
  ) {
    let registered = provider.registeredTypeIdentifiers.compactMap(UTType.init)
    let name = provider.suggestedName.flatMap { $0.isEmpty ? nil : $0 } ?? "Pasted image"
    if let type = registered.first(where: { candidate in kept.contains { candidate.conforms(to: $0) } }) {
      provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
        let kept = kept.first { type.conforms(to: $0) } ?? type
        done(data.flatMap { write($0, type: kept, name: name, into: directory) })
      }
      return
    }
    guard provider.canLoadObject(ofClass: UIImage.self) else { return done(nil) }
    provider.loadObject(ofClass: UIImage.self) { object, _ in
      let jpeg = (object as? UIImage)?.jpegData(compressionQuality: 0.9)
      done(jpeg.flatMap { write($0, type: .jpeg, name: name, into: directory) })
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

  static func discard(_ image: [String: Any]) {
    if let uri = image["uri"] as? String, let url = URL(string: uri) {
      try? FileManager.default.removeItem(at: url)
    }
  }
}
