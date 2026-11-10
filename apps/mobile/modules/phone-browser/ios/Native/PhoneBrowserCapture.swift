import UIKit
import WebKit
import ImageIO
import UniformTypeIdentifiers

public struct PhoneBrowserFrame {
  public let epoch: Int
  public let sessionId: String
  public let generation: Int
  public let captureRevision: Int
  public let channelId: String?
  public let requestId: String?
  public let attachmentId: String?
  public let artifactId: String
  public let tabId: String
  public let documentId: String
  public let geometryRevision: Int
  public let geometry: [String: Any]
  public let channelIds: [String]
  public let token: String
  public let width: Int
  public let height: Int
  public let mimeType: String
  public let bytes: Data
}

@MainActor public protocol PhoneBrowserFrameSink: AnyObject {
  func receive(_ frame: PhoneBrowserFrame) -> Bool
}

@available(iOS 17, *)
@MainActor final class BrowserCapture {
  weak var sink: (any PhoneBrowserFrameSink)?
  private unowned let pool: PhoneBrowserPool
  private var timer: Timer?
  private var outstanding = false
  private var outstandingTab: String?
  private var captureGeneration = UUID()
  private var lastTab: String?
  let pictures = NSHashTable<PhoneBrowserPictureView>.weakObjects()
  private let encoder = DispatchQueue(label: "com.opensteer.phone-browser.encode", qos: .userInitiated)

  init(pool: PhoneBrowserPool) { self.pool = pool }

  func refresh() {
    let needed = pool.foreground && (pool.tabs.values.contains { pool.state.tabs[$0.id] == .live && !$0.capture.channels.isEmpty } ||
      pictures.allObjects.contains { $0.window != nil && !$0.tabId.isEmpty })
    if needed, timer == nil {
      timer = Timer.scheduledTimer(withTimeInterval: 0.125, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated { self?.tick() }
      }
    } else if !needed { stop() }
  }

  func stop() { timer?.invalidate(); timer = nil }
  func trimPictures() {
    for tab in pool.tabs.values where pool.state.tabs[tab.id] != .live { tab.latestPicture = nil }
  }

  private func tick() {
    guard !outstanding, pool.foreground else { return }
    let ordered = pool.tabs.values.sorted { $0.id < $1.id }
    let candidates = ordered.filter { $0.id != lastTab } + ordered.filter { $0.id == lastTab }
    for tab in candidates {
      let local = pictures.allObjects.filter { $0.window != nil && $0.tabId == tab.id && $0.bounds.width > 0 }
      guard pool.state.tabs[tab.id] == .live, let view = tab.webView, view.window != nil,
        tab.pendingDialog == nil, (try? tab.readiness.require(frame: "main")) != nil else { continue }
      let localWidth = local.map { $0.bounds.width * ($0.window?.screen.scale ?? 1) }.max() ?? 0
      let density = sink == nil ? nil : tab.capture.density
      guard density != nil || localWidth > 0 else { continue }
      guard tab.capture.begin(now: CACurrentMediaTime(), foreground: true, picture: localWidth > 0) else { continue }
      let width = max(localWidth, density.map { view.bounds.width * $0 } ?? 0)
      lastTab = tab.id
      Task { @MainActor in
        do { _ = try await self.take(tab, width: width, format: "jpeg", quality: 0.7, clip: nil, streamed: true) }
        catch { tab.capture.cancel() }
      }
      return
    }
    refresh()
  }

  func once(_ input: BrowserCaptureInput) async throws -> [String: Any] {
    try pool.gate.check(input.epoch)
    let tab = try pool.tab(input.tabId)
    guard tab.documentId == input.documentId else { throw BrowserRefusal.staleDocument }
    guard sink != nil else { throw BrowserRefusal.notActionable }
    guard ["jpeg", "png"].contains(input.format), input.quality.isFinite, (0...1).contains(input.quality),
      let view = tab.webView else { throw BrowserRefusal.invalidArgument }
    return try await take(tab, width: view.bounds.width * (view.window?.screen.scale ?? 1), format: input.format,
      quality: input.quality, clip: input.clip, streamed: false, epoch: input.epoch, route: input)
  }

  private func take(_ tab: PhoneBrowserTab, width: Double, format: String, quality: Double,
    clip: BrowserClip?, streamed: Bool, epoch: Int? = nil, route: BrowserCaptureInput? = nil) async throws -> [String: Any] {
    guard !outstanding, let view = tab.webView, view.window != nil, pool.foreground else { throw BrowserRefusal.notActionable }
    let issued = epoch ?? pool.gate.current
    try pool.gate.check(issued)
    outstanding = true
    outstandingTab = tab.id
    let generation = UUID()
    captureGeneration = generation
    var snapshotPending = false
    defer { if !snapshotPending, captureGeneration == generation { outstanding = false; outstandingTab = nil } }
    let document = tab.documentId
    let geometry = tab.geometryRevision
    let configuration = WKSnapshotConfiguration()
    guard width.isFinite, width >= 1, width <= 4096 else { throw BrowserRefusal.tooLarge }
    let targetWidth = width.rounded(.up)
    configuration.snapshotWidth = NSNumber(value: targetWidth / (view.window?.screen.scale ?? 1))
    if let clip {
      let rect = CGRect(x: clip.x, y: clip.y, width: clip.width, height: clip.height)
      guard [clip.x, clip.y, clip.width, clip.height].allSatisfy(\.isFinite), clip.width > 0, clip.height > 0,
        view.bounds.contains(rect) else { throw BrowserRefusal.invalidArgument }
      configuration.rect = rect
    }
    let snapshotSize = clip.map { CGSize(width: $0.width, height: $0.height) } ?? view.bounds.size
    let targetHeight = (snapshotSize.height * targetWidth / snapshotSize.width).rounded(.up)
    guard targetHeight.isFinite, targetHeight >= 1, targetHeight <= 8192,
      targetWidth * targetHeight <= 4 * 1024 * 1024 else { throw BrowserRefusal.tooLarge }
    let image: UIImage = try await withCheckedThrowingContinuation { continuation in
      var finished = false
      snapshotPending = true
      view.takeSnapshot(with: configuration) { image, _ in
        snapshotPending = false
        guard !finished else {
          if self.captureGeneration == generation { self.outstanding = false; self.outstandingTab = nil }
          return
        }
        finished = true
        if let image { continuation.resume(returning: image) }
        else { continuation.resume(throwing: BrowserRefusal.notActionable) }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
        guard !finished else { return }; finished = true
        continuation.resume(throwing: BrowserRefusal.timeout)
      }
    }
    guard let source = image.cgImage else { throw BrowserRefusal.notActionable }
    let encoded: (Data, CGImage) = try await withCheckedThrowingContinuation { continuation in
      encoder.async {
        let height = max(1, Int(Double(source.height) * targetWidth / Double(source.width)))
        guard height <= 8192, Int(targetWidth) * height <= 4 * 1024 * 1024,
          let context = CGContext(data: nil, width: Int(targetWidth), height: height,
          bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
          continuation.resume(throwing: BrowserRefusal.tooLarge); return
        }
        context.draw(source, in: CGRect(x: 0, y: 0, width: Int(targetWidth), height: height))
        guard let resized = context.makeImage() else { continuation.resume(throwing: BrowserRefusal.notActionable); return }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, (format == "png" ? UTType.png.identifier : UTType.jpeg.identifier) as CFString, 1, nil) else {
          continuation.resume(throwing: BrowserRefusal.notActionable); return
        }
        CGImageDestinationAddImage(destination, resized, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination), data.length <= 8 * 1024 * 1024 else {
          continuation.resume(throwing: BrowserRefusal.tooLarge); return
        }
        continuation.resume(returning: (data as Data, resized))
      }
    }
    return try pool.gate.perform(issued) {
      guard pool.foreground, pool.tabs[tab.id] === tab, pool.state.tabs[tab.id] == .live,
        tab.documentId == document, tab.geometryRevision == geometry else { throw BrowserRefusal.staleDocument }
      let picture = UIImage(cgImage: encoded.1)
      tab.latestPicture = picture
      for local in pictures.allObjects where local.tabId == tab.id { local.draw(picture) }
      let token = UUID().uuidString
      let channels = streamed ? tab.capture.recipients : []
      let artifact = UUID().uuidString
      if !channels.isEmpty || !streamed {
        let nextRevision = tab.captureRevision + 1
        let frame = PhoneBrowserFrame(epoch: issued, sessionId: tab.sessionId, generation: tab.generation,
          captureRevision: nextRevision, channelId: route?.channelId, requestId: route?.requestId,
          attachmentId: route?.attachmentId, artifactId: artifact, tabId: tab.id, documentId: document,
          geometryRevision: geometry, geometry: pool.geometry(tab), channelIds: channels, token: token, width: encoded.1.width,
          height: encoded.1.height, mimeType: format == "png" ? "image/png" : "image/jpeg", bytes: encoded.0)
        guard sink?.receive(frame) == true else { throw BrowserRefusal.notActionable }
        tab.captureRevision = nextRevision
        if streamed { tab.capture.complete(token: token) }
      } else { tab.capture.cancel() }
      trimCache(except: tab.id)
      if !channels.isEmpty || !streamed { pool.changed(tab) }
      return ["artifactId": artifact, "token": token, "width": encoded.1.width, "height": encoded.1.height,
        "mimeType": format == "png" ? "image/png" : "image/jpeg", "documentId": document, "geometryRevision": geometry]
    }
  }

  private func trimCache(except tabId: String) {
    var bytes = pool.tabs.values.reduce(0) { $0 + ($1.latestPicture?.cgImage.map { $0.bytesPerRow * $0.height } ?? 0) }
    for tab in pool.tabs.values.sorted(by: { $0.id < $1.id }) where tab.id != tabId && bytes > 16 * 1024 * 1024 {
      if let image = tab.latestPicture?.cgImage { bytes -= image.bytesPerRow * image.height; tab.latestPicture = nil }
    }
  }
}

@available(iOS 17, *)
@MainActor public enum PhoneBrowserNative {
  public static func setFrameSink(_ sink: (any PhoneBrowserFrameSink)?, epoch: Int) throws {
    let pool = PhoneBrowserPool.shared
    try pool.gate.perform(epoch) { pool.capture.sink = sink; pool.capture.refresh() }
  }
}
