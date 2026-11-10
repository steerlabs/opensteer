import UIKit
import WebKit

@available(iOS 17, *)
@MainActor extension PhoneBrowserPool {
  func initialize(_ input: BrowserInitializeInput) async throws -> [String: Any] {
    try gate.perform(input.epoch) {
      guard tabs.isEmpty || (stores.deploymentId == input.deploymentId && stores.runnerId == input.runnerId) else {
        throw BrowserRefusal.notActionable
      }
      try stores.initialize(deploymentId: input.deploymentId, runnerId: input.runnerId)
    }
    await stores.recoverErasures()
    try gate.check(input.epoch)
    initialized = true
    var capabilities: [String: Any] = ["basicInput": 1, "rasterDemand": 1]
    if #available(iOS 18.4, *) { capabilities["fileStaging"] = true }
    return ["available": true, "epoch": gate.current, "storageInstanceId": stores.storageInstanceId,
      "capabilities": capabilities, "profiles": stores.inventory(input.deploymentId)]
  }

  func webURL(_ address: String) throws -> URL {
    guard address.utf8.count <= 16384, let url = URL(string: address),
      ["http", "https"].contains(url.scheme?.lowercased()), url.host != nil, url.user == nil, url.password == nil else {
      throw BrowserRefusal.invalidArgument
    }
    return url
  }

  func validateSize(_ width: Double, _ height: Double) throws {
    guard width.isFinite, height.isFinite, width >= 1, height >= 1, width <= 4096, height <= 8192 else {
      throw BrowserRefusal.invalidArgument
    }
  }

  @discardableResult func loadBlank(_ view: WKWebView) -> WKNavigation? {
    view.loadHTMLString("<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'></head><body></body></html>", baseURL: nil)
  }

  func destroy(_ id: String) {
    guard let tab = tabs[id] else { return }
    releaseView(id)
    try? state.destroy(id)
    var closed = metadata(tab)
    closed["state"] = "closed"
    emit?("tabChanged", ["tabId": id, "metadata": closed])
    tabs.removeValue(forKey: id)
    if !tabs.values.contains(where: { $0.sessionId == tab.sessionId }) {
      stores.endGuest(tab.sessionId)
      files.finishSession(tab.sessionId)
    }
    capture.refresh()
  }

  func eraseProfile(_ input: BrowserProfileInput) async throws -> [String: Any] {
    let binding = try gate.perform(input.epoch) {
      guard let binding = try input.binding?.value(), let deletion = input.deletionId.flatMap(UUID.init(uuidString:)),
        binding.deploymentId == stores.deploymentId, binding.runnerId == stores.runnerId else { throw BrowserRefusal.bindingMismatch }
      let handles = Set(stores.handles(binding))
      try stores.tombstone(binding, deletionId: deletion)
      files.eraseStores(handles)
      for tab in Array(tabs.values) where handles.contains(tab.storeHandle) { destroy(tab.id) }
      return binding
    }
    let result = try await stores.erase(binding)
    try gate.check(input.epoch)
    return ["state": result]
  }

  func eraseDeployment(_ input: BrowserDeploymentInput) async throws -> [[String: Any]] {
    let bindings = try gate.perform(input.epoch) {
      guard input.deploymentId == stores.deploymentId else { throw BrowserRefusal.bindingMismatch }
      let bindings = stores.bindings(input.deploymentId)
      for binding in bindings { try stores.tombstone(binding, deletionId: UUID()) }
      for tab in Array(tabs.values) { destroy(tab.id) }
      files.clearAll()
      stores.releaseHeld()
      return bindings
    }
    var result: [[String: Any]] = []
    for binding in bindings { result.append(["binding": stores.bindingDictionary(binding), "state": try await stores.erase(binding)]) }
    try gate.check(input.epoch)
    return result
  }

  func invalidateWork(before epoch: Int) {
    files.invalidate(before: epoch)
    for tab in tabs.values {
      cancelAgent(tab)
      if let dialog = tab.pendingDialog, dialog.epoch < epoch { cancelDialog(tab) }
      if tab.externalEpoch < epoch { tab.externalPrompt?.dismiss(animated: false); tab.externalPrompt = nil }
      if let chooser = tab.chooser, chooser.epoch < epoch { cancelChooser(tab) }
      if tab.inputEpoch < epoch { cancelComposition(tab) }
      if tab.contextEpoch < epoch { tab.contextId = nil }
      if tab.captureEpoch < epoch { tab.capture.clear() }
      for id in Array(tab.pendingCalls.keys) where (tab.callEpochs[id] ?? -1) < epoch {
        tab.callEpochs.removeValue(forKey: id)
        tab.pendingCalls.removeValue(forKey: id)?(BrowserRefusal.staleEpoch)
      }
      for id in Array(tab.readyWaiters.keys) where (tab.readyEpochs[id] ?? -1) < epoch {
        tab.readyWaiters.removeValue(forKey: id)?(.failure(BrowserRefusal.staleEpoch))
      }
      for id in Array(tab.loadWaiters.keys) where (tab.readyEpochs[id] ?? -1) < epoch {
        tab.loadWaiters.removeValue(forKey: id)?(.failure(BrowserRefusal.staleEpoch))
      }
    }
    capture.refresh()
  }

  func unmount(_ input: BrowserUnmountInput) throws {
    try gate.perform(input.epoch) {
      let tab = try tab(input.tabId)
      guard tab.presentationGeneration == input.presentationGeneration else { throw BrowserRefusal.notActionable }
      try coverTab(tab.id)
      _ = geometry(tab)
    }
  }

  func resize(_ input: BrowserResizeInput) async throws -> [String: Any] {
    try gate.check(input.epoch)
    try validateSize(input.width, input.height)
    try input.anchor?.validate()
    let tab = try tab(input.tabId)
    let anchor: [String: Any]?
    if let provided = input.anchor { anchor = provided.dictionary }
    else { anchor = try await helper(tab, function: "anchor", epoch: input.epoch) as? [String: Any] }
    try gate.perform(input.epoch) { tab.webView?.frame.size = CGSize(width: input.width, height: input.height) }
    if let anchor { _ = try await helper(tab, function: "restoreAnchor", arguments: ["argument": anchor], epoch: input.epoch) }
    try gate.check(input.epoch)
    return geometry(tab)
  }

  func navigate(_ input: BrowserNavigationInput) throws -> [String: Any] {
    try gate.perform(input.epoch) {
      let tab = try tab(input.tabId)
      guard foreground, let view = tab.webView else { throw BrowserRefusal.notActionable }
      cancelDialog(tab)
      cancelChooser(tab)
      let id = input.navigationId ?? UUID().uuidString
      var submitted: WKNavigation?
      switch input.kind {
      case "go":
        guard let address = input.url else { throw BrowserRefusal.invalidArgument }
        if address == "about:blank" {
          tab.readiness.provisional()
          submitted = loadBlank(view)
          break
        }
        let url = try webURL(address)
        tab.readiness.provisional()
        submitted = view.load(URLRequest(url: url))
      case "back": guard view.canGoBack else { throw BrowserRefusal.notActionable }; tab.readiness.provisional(); submitted = view.goBack()
      case "forward": guard view.canGoForward else { throw BrowserRefusal.notActionable }; tab.readiness.provisional(); submitted = view.goForward()
      case "reload": tab.readiness.provisional(); submitted = input.ignoreCache ? view.reloadFromOrigin() : view.reload()
      case "stop": view.stopLoading()
      default: throw BrowserRefusal.invalidArgument
      }
      if let submitted { tab.navigations.submit(ObjectIdentifier(submitted), id: id); tab.navigatingId = id }
      return ["submitted": true, "navigationId": id]
    }
  }

  func navigationFailed(_ view: WKWebView, navigation: WKNavigation?, error: Error) {
    guard let tab = tabs.values.first(where: { $0.webView === view }) else { return }
    guard let navigation else { return }
    let key = ObjectIdentifier(navigation)
    guard let id = tab.navigations.current(key) else { tab.navigations.finish(key); return }
    tab.navigations.finish(key)
    tab.readiness.failed()
    tab.failedURL = (error as NSError).userInfo[NSURLErrorFailingURLStringErrorKey] as? String ?? tab.url?.absoluteString
    let waiters = tab.readyWaiters.values
    tab.readyWaiters.removeAll()
    for waiter in waiters { waiter(.failure(BrowserRefusal.notActionable)) }
    let loading = tab.loadWaiters.values
    tab.loadWaiters.removeAll()
    for waiter in loading { waiter(.failure(BrowserRefusal.notActionable)) }
    emit?("navigationCommitted", ["tabId": tab.id, "navigationId": id,
      "documentId": tab.documentId.isEmpty ? NSNull() : tab.documentId as Any,
      "url": tab.failedURL ?? "about:blank", "state": "failed", "error": "navigation-failed"])
    changed(tab)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationFailed(webView, navigation: navigation, error: error) }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationFailed(webView, navigation: navigation, error: error) }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { decisionHandler(.cancel); return }
    let scheme = url.scheme?.lowercased() ?? ""
    if ["http", "https"].contains(scheme) {
      guard url.user == nil, url.password == nil else { decisionHandler(.cancel); return }
      decisionHandler(action.shouldPerformDownload ? .download : .allow)
    } else if scheme == "about" || scheme == "blob" { decisionHandler(.allow) }
    else {
      decisionHandler(.cancel)
      guard foreground, action.navigationType == .linkActivated,
        let tab = tabs.values.first(where: { $0.webView === webView }), state.visible == tab.id,
        ["mailto", "tel", "sms"].contains(scheme) else { return }
      cancelDialog(tab)
      let epoch = gate.current
      let document = tab.documentId
      let alert = UIAlertController(title: "Open another app?", message: nil, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
      alert.addAction(UIAlertAction(title: "Open", style: .default) { [weak self, weak tab] _ in
        guard let self, let tab else { return }
        try? self.gate.perform(epoch) {
          guard self.foreground, tab.documentId == document, self.state.visible == tab.id else { return }
          UIApplication.shared.open(url)
        }
        tab.externalPrompt = nil
      })
      tab.externalPrompt = alert
      tab.externalEpoch = epoch
      presenter()?.present(alert, animated: true)
    }
  }

  func presenter() -> UIViewController? {
    var result = try? window().rootViewController
    while let presented = result?.presentedViewController { result = presented }
    return result
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    guard foreground, action.targetFrame == nil, let opener = tabs.values.first(where: { $0.webView === webView }),
      state.covered == nil else { return nil }
    let id = UUID().uuidString
    let tab = PhoneBrowserTab(id: id, sessionId: opener.sessionId, url: action.request.url, storeHandle: opener.storeHandle)
    nextGeneration += 1
    tab.generation = nextGeneration
    do {
      try state.create(id)
      try state.activate(id, covered: true)
      tabs[id] = tab
      tab.popupOpener = opener.id
      let view = try makeView(tab, configuration: configuration)
      try holder().insertSubview(view, at: 0)
      return view
    } catch { destroy(id); return nil }
  }

  func webViewDidClose(_ webView: WKWebView) {
    if let tab = tabs.values.first(where: { $0.webView === webView }) { destroy(tab.id) }
  }
}
