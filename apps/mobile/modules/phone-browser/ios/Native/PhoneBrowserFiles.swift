import UIKit
import WebKit
import UniformTypeIdentifiers
import ExpoModulesCore

@available(iOS 17, *)
@MainActor final class BrowserChooser {
  let id = UUID().uuidString
  let documentId: String
  let epoch: Int
  let multiple: Bool
  var completion: (([URL]?) -> Void)?
  var picker: UIDocumentPickerViewController?
  init(documentId: String, epoch: Int, multiple: Bool, completion: @escaping ([URL]?) -> Void) {
    self.documentId = documentId; self.epoch = epoch; self.multiple = multiple; self.completion = completion
  }
  func finish(_ urls: [URL]?) {
    let callback = completion; completion = nil
    picker?.dismiss(animated: false); picker = nil
    callback?(urls)
  }
}

@available(iOS 17, *)
@MainActor final class BrowserFiles: NSObject, WKDownloadDelegate, UIDocumentPickerDelegate {
  struct StageKey: Hashable { let session: String; let file: String }
  struct Staged {
    let id: String
    let session: String
    let name: String
    let url: URL
    var bytes = 0
    var expected: Int?
    var complete = false
  }
  @MainActor final class Download {
    let id = UUID().uuidString
    let tabId: String
    let sessionId: String
    let storeHandle: String
    let epoch: Int
    let native: WKDownload
    var name = "Download"
    var url: URL?
    var observation: NSKeyValueObservation?
    var complete = false
    init(tabId: String, sessionId: String, storeHandle: String, epoch: Int, native: WKDownload) {
      self.tabId = tabId; self.sessionId = sessionId; self.storeHandle = storeHandle; self.epoch = epoch; self.native = native
    }
  }
  private unowned let pool: PhoneBrowserPool
  private var staged: [StageKey: Staged] = [:]
  private var failed = Set<StageKey>()
  private var downloads: [String: Download] = [:]
  private var root: URL?
  init(pool: PhoneBrowserPool) { self.pool = pool }

  private func directory() throws -> URL {
    if let root { return root }
    var url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("PhoneBrowserFiles", isDirectory: true)
    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    root = url
    return url
  }

  private func destination(_ name: String) throws -> URL {
    let directory = try directory().appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent(name)
  }

  func stage(_ input: BrowserStageInput) throws -> [String: Any]? {
    guard #available(iOS 18.4, *) else { throw BrowserRefusal.unsupportedOperation }
    return try pool.gate.perform(input.epoch) {
      guard !input.sessionId.isEmpty, !input.fileId.isEmpty, input.data.utf8.count <= 350000,
        let data = Data(base64Encoded: input.data), data.count <= 256 * 1024, input.offset >= 0, input.offset <= 512 * 1024 * 1024,
        !input.name.isEmpty, input.name.utf8.count <= 255, input.name == (input.name as NSString).lastPathComponent,
        input.name != ".", input.name != "..", !input.name.contains("\0"), !input.name.contains("\\"),
        input.size == nil || (input.size! >= 0 && input.size! <= 512 * 1024 * 1024) else { throw BrowserRefusal.invalidArgument }
      let key = StageKey(session: input.sessionId, file: input.fileId)
      guard !failed.contains(key) else { throw BrowserRefusal.outcomeUnknown }
      let total = staged.values.filter { $0.session == input.sessionId }.reduce(0) { $0 + $1.bytes }
      guard total + data.count <= 512 * 1024 * 1024 else { throw BrowserRefusal.tooLarge }
      if let expected = input.size, input.offset + data.count > expected { throw BrowserRefusal.invalidArgument }
      if input.last, let expected = input.size, input.offset + data.count != expected { throw BrowserRefusal.invalidArgument }
      var file: Staged
      if let existing = staged[key] {
        guard existing.name == input.name, !existing.complete, existing.expected == input.size else { throw BrowserRefusal.invalidArgument }
        file = existing
      } else {
        guard input.offset == 0, staged.count < 1024 else { throw BrowserRefusal.invalidArgument }
        let url = try destination(input.name)
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw BrowserRefusal.notActionable }
        file = Staged(id: UUID().uuidString, session: input.sessionId, name: input.name, url: url, expected: input.size)
      }
      guard input.offset == file.bytes, total + data.count <= 512 * 1024 * 1024,
        file.expected == nil || file.bytes + data.count <= file.expected! else { throw BrowserRefusal.tooLarge }
      if input.last, let expected = file.expected, file.bytes + data.count != expected { throw BrowserRefusal.invalidArgument }
      do {
        let handle = try FileHandle(forWritingTo: file.url)
        defer { try? handle.close() }
        try handle.seekToEnd(); try handle.write(contentsOf: data)
        file.bytes += data.count
        if input.last { try handle.synchronize(); file.complete = true }
      } catch {
        failed.insert(key)
        staged.removeValue(forKey: key)
        try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent())
        throw BrowserRefusal.outcomeUnknown
      }
      staged[key] = file
      return input.last ? ["fileId": file.id, "name": file.name, "size": file.bytes] : nil
    }
  }

  func selected(_ ids: [String], session: String) throws -> [Staged] {
    guard ids.count <= 128, Set(ids).count == ids.count else { throw BrowserRefusal.invalidArgument }
    return try ids.map { id in
      guard let file = staged.values.first(where: { $0.id == id && $0.session == session && $0.complete }) else {
        throw BrowserRefusal.invalidArgument
      }
      return file
    }
  }

  func portStage(_ input: BrowserStageInput) throws -> [String: Any] {
    input.last = input.size.map { input.offset + (Data(base64Encoded: input.data)?.count ?? 0) == $0 } ?? true
    _ = try stage(input)
    guard let file = staged[StageKey(session: input.sessionId, file: input.fileId)] else { throw BrowserRefusal.outcomeUnknown }
    return ["fileId": file.id, "complete": file.complete]
  }

  func cancel(_ id: String, session: String) throws {
    guard let download = downloads[id], download.sessionId == session else { throw BrowserRefusal.invalidArgument }
    cancel(id)
  }

  func finishSession(_ session: String) {
    for (key, file) in staged where file.session == session { try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent()); staged.removeValue(forKey: key) }
    failed = failed.filter { $0.session != session }
  }
  func clearAll() {
    for download in downloads.values { download.native.cancel { _ in }; download.observation = nil }
    downloads.removeAll(); staged.removeAll(); failed.removeAll()
    if let root { try? FileManager.default.removeItem(at: root) }
    root = nil
  }

  func invalidate(before epoch: Int) {
    for item in Array(downloads.values) where item.epoch < epoch && !item.complete { cancel(item.id) }
  }
  func eraseStores(_ handles: Set<String>) {
    for item in Array(downloads.values) where handles.contains(item.storeHandle) { cancel(item.id) }
  }

  func add(_ native: WKDownload, tab: PhoneBrowserTab) {
    let download = Download(tabId: tab.id, sessionId: tab.sessionId, storeHandle: tab.storeHandle, epoch: pool.gate.current, native: native)
    downloads[download.id] = download
    native.delegate = self
    download.observation = native.progress.observe(\.completedUnitCount) { [weak self, weak download] _, _ in
      MainActor.assumeIsolated {
        guard let self, let download else { return }
        if download.native.progress.completedUnitCount > 512 * 1024 * 1024 { self.cancel(download.id) }
        else { self.event(download, state: "downloading") }
      }
    }
    event(download, state: "downloading")
  }

  func event(_ download: Download, state: String, error: String? = nil) {
    var body: [String: Any] = ["tabId": download.tabId, "downloadId": download.id, "state": state,
      "name": download.name, "received": download.native.progress.completedUnitCount]
    if download.native.progress.totalUnitCount > 0 { body["total"] = download.native.progress.totalUnitCount }
    if let error { body["error"] = error }
    pool.emit?("download", body)
  }

  func cancel(_ id: String) {
    guard let download = downloads.removeValue(forKey: id) else { return }
    download.observation = nil
    download.native.cancel { _ in }
    if let url = download.url { try? FileManager.default.removeItem(at: url) }
    event(download, state: "canceled")
  }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
    completionHandler: @escaping (URL?) -> Void) {
    guard let item = downloads.values.first(where: { $0.native === download }), item.epoch == pool.gate.current,
      pool.foreground, response.expectedContentLength <= 512 * 1024 * 1024 else { completionHandler(nil); return }
    do {
      let name = String((suggestedFilename as NSString).lastPathComponent.prefix(255))
      item.name = name.isEmpty ? "Download" : name
      item.url = try destination(item.name)
      completionHandler(item.url)
    } catch { completionHandler(nil) }
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let item = downloads.values.first(where: { $0.native === download }) else { return }
    item.observation = nil; item.complete = true
    event(item, state: "complete")
  }
  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    guard let item = downloads.values.first(where: { $0.native === download }) else { return }
    item.observation = nil
    if let url = item.url { try? FileManager.default.removeItem(at: url) }
    event(item, state: "failed", error: "download-failed")
    downloads.removeValue(forKey: item.id)
  }

  func share(_ id: String, from view: UIView) {
    guard pool.foreground, let item = downloads[id], item.complete, let url = item.url,
      let presenter = pool.presenter(), presenter.presentedViewController == nil else { return }
    let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    share.popoverPresentationController?.sourceView = view
    share.popoverPresentationController?.sourceRect = view.bounds
    presenter.present(share, animated: true)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    for tab in pool.tabs.values where tab.chooser?.picker === controller { pool.cancelChooser(tab) }
  }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let tab = pool.tabs.values.first(where: { $0.chooser?.picker === controller }), let chooser = tab.chooser,
      chooser.epoch == pool.gate.current, tab.documentId == chooser.documentId, pool.foreground else {
      documentPickerWasCancelled(controller); return
    }
    do {
      let selected: [URL] = try urls.prefix(128).map { url in
        let scope = url.startAccessingSecurityScopedResource()
        defer { if scope { url.stopAccessingSecurityScopedResource() } }
        guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 512 * 1024 * 1024 else { throw BrowserRefusal.tooLarge }
        let destination = try destination(url.lastPathComponent)
        try FileManager.default.copyItem(at: url, to: destination)
        let file = Staged(id: UUID().uuidString, session: tab.sessionId, name: url.lastPathComponent,
          url: destination, bytes: (try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0, complete: true)
        staged[StageKey(session: tab.sessionId, file: file.id)] = file
        return destination
      }
      tab.chooser = nil; chooser.finish(selected)
    } catch { pool.cancelChooser(tab) }
  }
}

@available(iOS 17, *)
@MainActor extension PhoneBrowserPool {
  func cancelChooser(_ tab: PhoneBrowserTab) { let chooser = tab.chooser; tab.chooser = nil; tab.stagedChooser = false; chooser?.finish(nil) }

  @available(iOS 18.4, *)
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    guard foreground, let tab = tabs.values.first(where: { $0.webView === webView }) else { completionHandler(nil); return }
    let staged = tab.stagedChooser
    cancelChooser(tab)
    let chooser = BrowserChooser(documentId: tab.documentId, epoch: gate.current, multiple: parameters.allowsMultipleSelection,
      completion: completionHandler)
    tab.chooser = chooser
    emit?("upload", ["tabId": tab.id, "documentId": tab.documentId, "chooserId": chooser.id, "accept": [], "multiple": chooser.multiple])
    if !staged {
      guard state.visible == tab.id, let presenter = presenter() else { cancelChooser(tab); return }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
      picker.allowsMultipleSelection = chooser.multiple; picker.delegate = files; chooser.picker = picker
      presenter.present(picker, animated: true)
    }
  }

  func respondUpload(_ input: BrowserUploadInput) throws -> [[String: Any]] {
    guard #available(iOS 18.4, *) else { throw BrowserRefusal.unsupportedOperation }
    return try gate.perform(input.epoch) {
      let tab = try tab(input.tabId)
      guard let chooser = tab.chooser, chooser.id == input.chooserId, chooser.documentId == input.documentId,
        tab.documentId == input.documentId, chooser.epoch == input.epoch, chooser.picker == nil else { throw BrowserRefusal.staleChooser }
      let selected = try files.selected(input.stagedFileIds, session: tab.sessionId)
      guard chooser.multiple || selected.count <= 1 else { throw BrowserRefusal.invalidArgument }
      tab.chooser = nil; chooser.finish(selected.isEmpty ? nil : selected.map(\.url))
      return selected.map { ["fileId": $0.id, "name": $0.name, "size": $0.bytes] }
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .download)
  }
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    if let tab = tabs.values.first(where: { $0.webView === webView }) { files.add(download, tab: tab) }
  }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    if let tab = tabs.values.first(where: { $0.webView === webView }) { files.add(download, tab: tab) }
  }
}

final class PhoneBrowserDownloadView: ExpoView {
  var downloadId = ""
  private let button = UIButton(type: .system)
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    button.setImage(UIImage(systemName: "square.and.arrow.up"), for: .normal)
    button.accessibilityLabel = "Share download"
    button.addTarget(self, action: #selector(share), for: .touchUpInside)
    addSubview(button)
  }
  override func layoutSubviews() { super.layoutSubviews(); button.frame = bounds }
  @objc private func share() {
    if #available(iOS 17, *) { PhoneBrowserPool.shared.files.share(downloadId, from: self) }
  }
}
