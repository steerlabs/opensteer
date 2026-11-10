import UIKit
import WebKit

@available(iOS 17, *)
@MainActor final class PhoneBrowserTab {
  let id: String
  var sessionId: String
  let storeHandle: String
  var generation = 0
  var allocationEpoch = -1
  var revision = 0
  var pageWaitChecks: [UUID: () -> Void] = [:]
  var clipboardPastes: [String: BrowserClipboardPaste] = [:]
  var captureRevision = 0
  let captureGate = EpochGate()
  var activitySequence = 0
  var agentOperations = Set<String>()
  var agentOwners: [String: String] = [:]
  var agentFrames: [String: WKFrameInfo] = [:]
  var webView: WKWebView?
  var url: URL?
  var documentId = ""
  var readiness = DocumentReadiness()
  var readyWaiters: [UUID: (Result<Void, Error>) -> Void] = [:]
  var loadWaiters: [UUID: (Result<Void, Error>) -> Void] = [:]
  var pendingCalls: [UUID: (Error) -> Void] = [:]
  var keyboardWaiters: [UUID: () -> Void] = [:]
  var callEpochs: [UUID: Int] = [:]
  var callOwners: [UUID: String] = [:]
  var readyEpochs: [UUID: Int] = [:]
  var geometryRevision = 0
  var presentationGeneration = 0
  var anchor: [String: Any]?
  var retainedScrollOffset: CGPoint?
  var frames: [String: WKFrameInfo] = [:]
  var pendingDialog: BrowserDialog?
  var externalPrompt: UIAlertController?
  var externalEpoch = -1
  var observers: [NSKeyValueObservation] = []
  var capture = CaptureDemandState()
  var latestPicture: UIImage?
  var frameDocuments: [String: String] = [:]
  var geometryFingerprint: NSDictionary?
  var visualViewport: [String: Double] = [:]
  var contextId: String?
  var contextEpoch = -1
  var captureEpoch = -1
  var inputEpoch = -1
  var secureInput = false
  var navigatingId = UUID().uuidString
  var navigations = NavigationLedger<ObjectIdentifier>()
  var failedURL: String?
  var inputBusy = false
  var markedByRemote = false
  var chooser: BrowserChooser?
  var stagedChooser = false
  var stagedSelection: BrowserStagedSelection?
  var chosenFiles: [[String: Any]]?
  var chosenSelectionId: UUID?
  var chosenWaiters: [UUID: ([[String: Any]]) -> Void] = [:]
  var popupOpener: String?

  init(id: String, sessionId: String, url: URL?, storeHandle: String = "") {
    self.id = id
    self.sessionId = sessionId
    self.url = url
    self.storeHandle = storeHandle
  }
}

@available(iOS 17, *)
@MainActor final class BrowserDialog {
  let id = UUID().uuidString
  let documentId: String
  let kind: String
  let message: String
  let defaultText: String?
  let epoch: Int
  private var completion: ((Bool, String?) -> Void)?

  init(documentId: String, kind: String, message: String, defaultText: String? = nil, epoch: Int,
    completion: @escaping (Bool, String?) -> Void) {
    self.documentId = documentId
    self.kind = kind
    self.message = message
    self.defaultText = defaultText
    self.epoch = epoch
    self.completion = completion
  }

  func answer(accept: Bool, text: String?) throws {
    guard let completion else { throw BrowserRefusal.staleDialog }
    self.completion = nil
    completion(accept, text)
  }
}

@available(iOS 17, *)
@MainActor final class PhoneBrowserPool: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  static let shared = PhoneBrowserPool()
  nonisolated static let epochGate = EpochGate()
  nonisolated var gate: EpochGate { Self.epochGate }
  let world = WKContentWorld.world(name: "com.opensteer.phone-browser")
  var tabs: [String: PhoneBrowserTab] = [:]
  var state = TabPoolState()
  var emit: ((String, [String: Any]) -> Void)?
  var foreground = true
  let stores = BrowserStores()
  lazy var files = BrowserFiles(pool: self)
  lazy var capture = BrowserCapture(pool: self)
  var keyboardFrame = CGRect.zero
  var keyboardMoving = false
  var initialized = false
  let runtimeId = UUID().uuidString.lowercased()
  var nextGeneration = 0
  weak var admission: (any PhoneBrowserAdmission)?
  let hosts = NSMapTable<NSString, PhoneBrowserHostView>.strongToWeakObjects()
  private var coveredHolder: UIView?
  private var cover: UIView?
  private var lifecycle: [NSObjectProtocol] = []

  override init() {
    super.init()
    for name in [UIApplication.willResignActiveNotification, UIApplication.didReceiveMemoryWarningNotification,
      UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification,
      UIResponder.keyboardDidChangeFrameNotification, UIResponder.keyboardDidHideNotification] {
      lifecycle.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
        MainActor.assumeIsolated {
          guard let self else { return }
          if notification.name == UIApplication.willResignActiveNotification {
            self.setForeground(false)
          } else if notification.name == UIApplication.didReceiveMemoryWarningNotification {
            for id in self.state.memoryPressure() { self.releaseView(id) }
            self.capture.trimPictures()
            self.emit?("memoryPressure", ["level": "critical"])
          } else {
            self.keyboardMoving = notification.name == UIResponder.keyboardWillChangeFrameNotification || notification.name == UIResponder.keyboardWillHideNotification
            self.keyboardFrame = notification.name == UIResponder.keyboardWillHideNotification || notification.name == UIResponder.keyboardDidHideNotification ? .zero :
              (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect ?? .zero)
            for tab in self.tabs.values { _ = self.geometry(tab) }
            if !self.keyboardMoving {
              for tab in self.tabs.values {
                let waiters = tab.keyboardWaiters.values
                tab.keyboardWaiters.removeAll()
                for ready in waiters { ready() }
              }
            }
          }
        }
      })
    }
  }

  func tab(_ id: String, live: Bool = true) throws -> PhoneBrowserTab {
    guard let tab = tabs[id] else { throw BrowserRefusal.targetClosed }
    if live && state.tabs[id] != .live { throw BrowserRefusal.targetSuspended }
    return tab
  }

  func metadata(_ tab: PhoneBrowserTab) -> [String: Any] {
    ["tabId": tab.id, "sessionId": tab.sessionId, "documentId": tab.documentId.isEmpty ? NSNull() : tab.documentId as Any,
      "url": tab.webView?.url?.absoluteString ?? tab.url?.absoluteString ?? "about:blank",
      "title": tab.webView?.title ?? "", "canGoBack": tab.webView?.canGoBack ?? false,
      "canGoForward": tab.webView?.canGoForward ?? false, "loading": tab.webView?.isLoading ?? false,
      "state": state.tabs[tab.id]?.rawValue ?? "discarded", "geometryRevision": tab.geometryRevision,
      "failedURL": tab.failedURL as Any? ?? NSNull(), "frames": tab.frameDocuments.map { ["frameId": $0.key, "documentId": $0.value] }]
  }

  func changed(_ tab: PhoneBrowserTab) {
    tab.revision += 1
    emit?("tabChanged", ["tabId": tab.id, "metadata": metadata(tab)])
    for check in Array(tab.pageWaitChecks.values) { check() }
  }

  func window() throws -> UIWindow {
    guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
      .flatMap(\.windows).first(where: \.isKeyWindow) else { throw BrowserRefusal.notActionable }
    return window
  }

  func holder() throws -> UIView {
    if let coveredHolder, coveredHolder.window != nil { return coveredHolder }
    let window = try window()
    guard let parent = window.rootViewController?.view else { throw BrowserRefusal.notActionable }
    let holder = UIView(frame: parent.bounds)
    holder.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    holder.isUserInteractionEnabled = false
    parent.insertSubview(holder, at: 0)
    let cover = UIView(frame: holder.bounds)
    cover.backgroundColor = .black
    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    holder.addSubview(cover)
    self.cover = cover
    coveredHolder = holder
    return holder
  }

  func makeView(_ tab: PhoneBrowserTab, configuration supplied: WKWebViewConfiguration? = nil) throws -> WKWebView {
    let configuration = supplied ?? WKWebViewConfiguration()
    configuration.websiteDataStore = try stores.store(tab.storeHandle, session: tab.sessionId)
    configuration.userContentController = WKUserContentController()
    configuration.userContentController.add(self, contentWorld: world, name: "phoneBrowser")
    guard let resource = Bundle(for: PhoneBrowserModule.self).url(forResource: "PhoneBrowser", withExtension: "bundle"),
      let bundle = Bundle(url: resource), let url = bundle.url(forResource: "phone-browser-helper", withExtension: "js") else {
      throw BrowserRefusal.unsupportedOperation
    }
    configuration.userContentController.addUserScript(WKUserScript(source: PhoneBrowserAgentScript.source,
      injectionTime: .atDocumentStart, forMainFrameOnly: false, in: world))
    let script = try String(contentsOf: url, encoding: .utf8)
    configuration.userContentController.addUserScript(WKUserScript(source: script,
      injectionTime: .atDocumentStart, forMainFrameOnly: false, in: world))
    let view = BrowserWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 600), configuration: configuration)
    view.isInspectable = false
    let personInput = BrowserPersonGesture { [weak self, weak tab] point in
      if let self, let tab {
        if tab.stagedSelection != nil {
          self.cancelChooser(tab)
          let pending = tab.pendingCalls.values
          tab.pendingCalls.removeAll(); tab.callEpochs.removeAll()
          for cancel in pending { cancel(BrowserRefusal.notActionable) }
        }
        self.activity(tab, kind: "person", pointer: ["x": point.x, "y": point.y])
      }
    }
    view.addGestureRecognizer(personInput)
    view.geometryChanged = { [weak self, weak tab] in if let self, let tab { _ = self.geometry(tab) } }
    view.navigationDelegate = self
    view.uiDelegate = self
    view.scrollView.contentInsetAdjustmentBehavior = .never
    tab.webView = view
    tab.observers = [
      view.observe(\.title) { [weak self, weak tab] _, _ in
        MainActor.assumeIsolated { if let self, let tab { self.changed(tab) } }
      },
      view.observe(\.isLoading) { [weak self, weak tab] _, _ in
        MainActor.assumeIsolated { if let self, let tab { self.changed(tab) } }
      },
      view.observe(\.url) { [weak self, weak tab] _, _ in
        MainActor.assumeIsolated { if let self, let tab { self.changed(tab) } }
      },
      view.observe(\.canGoBack) { [weak self, weak tab] _, _ in
        MainActor.assumeIsolated { if let self, let tab { self.changed(tab) } }
      },
      view.observe(\.canGoForward) { [weak self, weak tab] _, _ in
        MainActor.assumeIsolated { if let self, let tab { self.changed(tab) } }
      },
      view.scrollView.observe(\.zoomScale) { [weak self, weak tab] _, _ in
        MainActor.assumeIsolated { if let self, let tab { _ = self.geometry(tab) } }
      },
      view.scrollView.observe(\.contentInset) { [weak self, weak tab] _, _ in
        MainActor.assumeIsolated { if let self, let tab { _ = self.geometry(tab) } }
      },
    ]
    return view
  }

  func create(_ input: BrowserCreateInput, authorization: (() throws -> Void)? = nil) async throws -> [String: Any] {
    let created: PhoneBrowserTab = try gate.perform(input.epoch) {
      try authorization?()
      guard foreground else { throw BrowserRefusal.notActionable }
      guard !input.sessionId.isEmpty, !input.tabId.isEmpty else { throw BrowserRefusal.invalidArgument }
      try validateSize(input.viewport.width, input.viewport.height)
      if let url = input.url { _ = try webURL(url) }
      try state.create(input.tabId)
      let tab = PhoneBrowserTab(id: input.tabId, sessionId: input.sessionId,
        url: input.url.flatMap(URL.init(string:)), storeHandle: input.storeHandle ?? "")
      tab.allocationEpoch = input.epoch
      nextGeneration += 1
      tab.generation = nextGeneration
      tabs[tab.id] = tab
      do {
        let view = try makeView(tab)
        view.frame.size = CGSize(width: input.viewport.width, height: input.viewport.height)
        loadBlank(view)
        changed(tab)
        return tab
      } catch {
        releaseView(tab.id)
        tabs.removeValue(forKey: tab.id)
        try? state.destroy(tab.id)
        throw error
      }
    }
    do {
      try await waitReady(created)
      try await waitLoadFinished(created, epoch: input.epoch)
      try gate.check(input.epoch)
      try authorization?()
      if let address = input.url {
        try gate.perform(input.epoch) {
          try authorization?()
          created.readiness.provisional()
          if let navigation = created.webView?.load(URLRequest(url: try webURL(address))) {
            let id = input.navigationId ?? UUID().uuidString
            created.navigations.submit(ObjectIdentifier(navigation), id: id)
            created.navigatingId = id
          }
        }
        try await waitReady(created)
        try gate.check(input.epoch)
        try authorization?()
      }
      if input.state == "retained" {
        try gate.perform(input.epoch) {
          for id in try state.suspend(created.id) { releaseView(id) }
          changed(created)
        }
      } else {
        let live = BrowserTabInput()
        live.epoch = input.epoch; live.tabId = created.id
        _ = try await resume(live)
      }
      try authorization?()
      return metadata(created)
    } catch {
      if tabs[created.id] === created { destroy(created.id) }
      throw error
    }
  }

  func waitReady(_ tab: PhoneBrowserTab, frame: String = "main", timeoutMs: Int = 10000, epoch: Int? = nil) async throws {
    if (try? tab.readiness.require(frame: frame)) != nil { return }
    if frame != "main" { throw BrowserRefusal.helperNotReady }
    guard tab.webView != nil else { throw BrowserRefusal.targetSuspended }
    guard tab.readyWaiters.count < 64 else { throw BrowserRefusal.notActionable }
    let id = UUID()
    tab.readyEpochs[id] = epoch ?? gate.current
    defer { tab.readyEpochs.removeValue(forKey: id) }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      tab.readyWaiters[id] = { continuation.resume(with: $0) }
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak tab] in
        tab?.readyWaiters.removeValue(forKey: id)?(.failure(BrowserRefusal.timeout))
      }
    }
  }

  func waitLoadFinished(_ tab: PhoneBrowserTab, timeoutMs: Int = 10000, epoch: Int) async throws {
    try gate.check(epoch)
    guard tab.webView?.isLoading == true else { return }
    let id = UUID()
    tab.readyEpochs[id] = epoch
    defer { tab.readyEpochs.removeValue(forKey: id) }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      tab.loadWaiters[id] = { continuation.resume(with: $0) }
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak tab] in
        tab?.loadWaiters.removeValue(forKey: id)?(.failure(BrowserRefusal.timeout))
      }
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let tab = tabs.values.first(where: { $0.webView === webView }) else { return }
    guard let navigation, tab.navigations.current(ObjectIdentifier(navigation)) != nil else { return }
    tab.navigations.finish(ObjectIdentifier(navigation))
    let waiters = tab.loadWaiters.values
    tab.loadWaiters.removeAll()
    for waiter in waiters { waiter(.success(())) }
    changed(tab)
  }

  func signalReady(_ tab: PhoneBrowserTab) {
    guard (try? tab.readiness.require(frame: "main")) != nil else { return }
    for frameId in tab.frames.keys where (try? tab.readiness.require(frame: frameId)) != nil {
      if frameId == "main" { tab.frameDocuments[frameId] = tab.documentId }
      else if tab.frameDocuments[frameId] == nil { tab.frameDocuments[frameId] = UUID().uuidString }
    }
    tab.frameDocuments["main"] = tab.documentId
    if let opener = tab.popupOpener {
      tab.popupOpener = nil
      emit?("popup", ["openerId": opener, "tabId": tab.id])
    }
    let waiters = tab.readyWaiters.values
    tab.readyWaiters.removeAll()
    for waiter in waiters { waiter(.success(())) }
  }

  func helper(_ tab: PhoneBrowserTab, function: String, arguments: [String: Any] = [:], frame: WKFrameInfo? = nil,
    epoch issued: Int? = nil, timeoutMs: Int = 10000, authorization: (() throws -> Void)? = nil,
    completionAuthorization: (() throws -> Void)? = nil,
    attachmentId: String? = nil) async throws -> Any {
    guard tab.pendingDialog == nil else { throw BrowserRefusal.dialogOpen }
    guard tab.pendingCalls.count < 32 else { throw BrowserRefusal.notActionable }
    guard let view = tab.webView else { throw BrowserRefusal.targetSuspended }
    let allowed = ["ping", "anchor", "restoreAnchor", "focus", "tap", "selection", "editing", "agent"]
    guard allowed.contains(function) else { throw BrowserRefusal.unsupportedOperation }
    let epoch = issued ?? gate.current
    let deadline = DispatchTime.now() + .milliseconds(timeoutMs)
    let documentId = tab.documentId
    let frameId = frame.flatMap { selected in tab.frames.first(where: { $0.value === selected })?.key } ?? "main"
    try await waitReady(tab, frame: frameId, timeoutMs: timeoutMs, epoch: epoch)
    let operation = (arguments["argument"] as? [String: Any])?["name"] as? String
    if keyboardMoving, function == "agent", ["act", "focus", "tap", "fileChoose"].contains(operation ?? "") {
      let request = UUID()
      defer {
        tab.keyboardWaiters.removeValue(forKey: request)
        tab.pendingCalls.removeValue(forKey: request)
        tab.callOwners.removeValue(forKey: request)
        tab.callEpochs.removeValue(forKey: request)
      }
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        tab.callEpochs[request] = epoch
        tab.callOwners[request] = attachmentId
        tab.pendingCalls[request] = { continuation.resume(throwing: $0) }
        tab.keyboardWaiters[request] = {
          guard tab.pendingCalls.removeValue(forKey: request) != nil else { return }
          continuation.resume()
        }
        DispatchQueue.main.asyncAfter(deadline: deadline) {
          tab.pendingCalls.removeValue(forKey: request)?(BrowserRefusal.timeout)
        }
      }
    }
    try gate.check(epoch)
    guard DispatchTime.now() < deadline else { throw BrowserRefusal.timeout }
    guard foreground, state.tabs[tab.id] == .live, tab.webView === view else { throw BrowserRefusal.targetSuspended }
    let token = try tab.readiness.require(frame: frameId, document: documentId)
    do {
      let result: Any = try await withCheckedThrowingContinuation { continuation in
        let request = UUID()
        tab.callEpochs[request] = epoch
        tab.callOwners[request] = attachmentId
        tab.pendingCalls[request] = { error in continuation.resume(throwing: error) }
        DispatchQueue.main.asyncAfter(deadline: deadline) { [weak tab] in
          tab?.callEpochs.removeValue(forKey: request)
          tab?.callOwners.removeValue(forKey: request)
          tab?.pendingCalls.removeValue(forKey: request)?(BrowserRefusal.timeout)
        }
        do {
          try gate.perform(epoch) {
            try authorization?()
            view.callAsyncJavaScript("if(typeof phoneBrowserHelper!=='object'||phoneBrowserHelper.token!==token)return {__phoneBrowserRefusal:'helper-not-ready'};return phoneBrowserHelper.\(function)(argument)",
              arguments: ["token": token, "argument": arguments["argument"] ?? NSNull()], in: frame, in: world) { result in
              tab.callEpochs.removeValue(forKey: request)
              tab.callOwners.removeValue(forKey: request)
              guard tab.pendingCalls.removeValue(forKey: request) != nil else { return }
              continuation.resume(with: result)
            }
          }
        } catch {
          tab.callEpochs.removeValue(forKey: request)
          tab.callOwners.removeValue(forKey: request)
          tab.pendingCalls.removeValue(forKey: request)?(error)
        }
      }
      try gate.check(epoch)
      if let completionAuthorization { try completionAuthorization() }
      else { try authorization?() }
      guard tab.documentId == documentId else { throw BrowserRefusal.staleDocument }
      guard state.tabs[tab.id] == .live, tab.webView === view else { throw BrowserRefusal.targetSuspended }
      if (result as? [String: Any])?["__phoneBrowserRefusal"] != nil { throw BrowserRefusal.helperNotReady }
      return result
    } catch let refusal as BrowserRefusal {
      throw refusal
    } catch {
      throw BrowserRefusal.notActionable
    }
  }

  func mount(_ input: BrowserMountInput) async throws -> [String: Any] {
    try gate.check(input.epoch)
    let tab = try tab(input.tabId, live: false)
    guard let host = hosts.object(forKey: input.hostId as NSString), host.window != nil else {
      throw BrowserRefusal.notActionable
    }
    guard input.presentationGeneration >= tab.presentationGeneration else { throw BrowserRefusal.notActionable }
    tab.presentationGeneration = input.presentationGeneration
    if state.tabs[tab.id] != .live {
      let reference = BrowserTabInput()
      reference.epoch = input.epoch; reference.tabId = input.tabId
      reference.sessionId = input.sessionId; reference.generation = input.generation
      _ = try await resume(reference, covered: !input.interactive)
    }
    guard input.presentationGeneration >= tab.presentationGeneration,
      host.window != nil,
      let view = tab.webView else { throw BrowserRefusal.notActionable }
    let anchor = view.bounds.size == host.bounds.size ? nil :
      try await helper(tab, function: "anchor", epoch: input.epoch) as? [String: Any]
    try gate.perform(input.epoch) {
      guard input.presentationGeneration >= tab.presentationGeneration else { throw BrowserRefusal.notActionable }
      if let current = state.visible, current != tab.id { throw BrowserRefusal.targetSuspended }
      try state.activate(tab.id, covered: !input.interactive)
      tab.presentationGeneration = input.presentationGeneration
      if let old = view.superview as? PhoneBrowserHostView { old.tabId = nil }
      try holder().insertSubview(view, at: 0)
      host.tabId = tab.id
      host.addSubview(view)
      view.frame = host.bounds
      view.isUserInteractionEnabled = input.interactive
      host.layoutIfNeeded()
    }
    if let anchor { _ = try await helper(tab, function: "restoreAnchor", arguments: ["argument": anchor], epoch: input.epoch) }
    try gate.check(input.epoch)
    return geometry(tab)
  }

  func parkView(_ tab: PhoneBrowserTab) throws {
    guard let view = tab.webView else { throw BrowserRefusal.targetSuspended }
    if let old = view.superview as? PhoneBrowserHostView { old.tabId = nil }
    try holder().insertSubview(view, at: 0)
    view.isUserInteractionEnabled = false
  }

  func suspend(_ input: BrowserTabInput) async throws -> [String: Any] {
    try gate.check(input.epoch)
    let tab = try tab(input.tabId)
    cancelDialog(tab)
    cancelChooser(tab)
    let anchor = try await helper(tab, function: "anchor", epoch: input.epoch) as? [String: Any]
    return try gate.perform(input.epoch) {
      tab.anchor = anchor
      tab.retainedScrollOffset = tab.webView?.scrollView.contentOffset
      tab.url = tab.webView?.url ?? tab.url
      cancelDialog(tab)
      cancelChooser(tab)
      tab.capture.clear()
      if let host = tab.webView?.superview as? PhoneBrowserHostView { host.tabId = nil }
      tab.webView?.removeFromSuperview()
      let released = try state.suspend(tab.id)
      for id in released { releaseView(id) }
      changed(tab)
      return ["url": tab.url?.absoluteString ?? "about:blank", "anchor": anchor ?? [:]]
    }
  }

  func resume(_ input: BrowserTabInput, covered: Bool = true) async throws -> [String: Any] {
    try input.anchor?.validate()
    var reloaded = false
    let tab: PhoneBrowserTab = try gate.perform(input.epoch) {
      guard foreground else { throw BrowserRefusal.notActionable }
      let tab = try tab(input.tabId, live: false)
      try state.activate(tab.id, covered: covered)
      reloaded = tab.webView == nil
      let view = try tab.webView ?? makeView(tab)
      try holder().insertSubview(view, at: 0)
      if reloaded {
        if let url = tab.url, ["http", "https"].contains(url.scheme) { view.load(URLRequest(url: url)) }
        else { loadBlank(view) }
      }
      changed(tab)
      return tab
    }
    try await waitReady(tab)
    try gate.check(input.epoch)
    if !reloaded, let offset = tab.retainedScrollOffset {
      try gate.perform(input.epoch) { tab.webView?.scrollView.setContentOffset(offset, animated: false) }
    } else if let anchor = input.anchor?.dictionary ?? tab.anchor {
      _ = try await helper(tab, function: "restoreAnchor", arguments: ["argument": anchor], epoch: input.epoch)
    }
    return metadata(tab)
  }

  func releaseView(_ id: String) {
    guard let tab = tabs[id] else { return }
    tab.captureGate.advance()
    cancelAgent(tab)
    tab.url = tab.webView?.url ?? tab.url
    cancelDialog(tab)
    cancelChooser(tab)
    cancelComposition(tab)
    tab.capture.clear()
    tab.contextId = nil
    let pending = tab.pendingCalls.values
    tab.pendingCalls.removeAll()
    for cancel in pending { cancel(BrowserRefusal.staleDocument) }
    tab.webView?.stopLoading()
    tab.observers.removeAll()
    tab.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "phoneBrowser", contentWorld: world)
    tab.webView?.navigationDelegate = nil
    tab.webView?.uiDelegate = nil
    tab.webView?.removeFromSuperview()
    tab.webView = nil
    tab.navigations = NavigationLedger()
    tab.frames.removeAll()
    tab.frameDocuments.removeAll()
    tab.readiness.invalidate()
    let waiters = tab.readyWaiters.values
    tab.readyWaiters.removeAll()
    for waiter in waiters { waiter(.failure(BrowserRefusal.targetSuspended)) }
    let loading = tab.loadWaiters.values
    tab.loadWaiters.removeAll()
    for waiter in loading { waiter(.failure(BrowserRefusal.targetSuspended)) }
    tab.documentId = ""
    emit?("documentChanged", ["tabId": tab.id, "documentId": NSNull(), "frames": []])
    changed(tab)
  }

  func geometry(_ tab: PhoneBrowserTab) -> [String: Any] {
    let size = tab.webView?.bounds.size ?? .zero
    let offset = tab.webView?.scrollView.contentOffset ?? .zero
    let inset = tab.webView?.scrollView.adjustedContentInset ?? .zero
    let keyboard = tab.webView.map { $0.convert(keyboardFrame, from: nil).intersection($0.bounds) } ?? .zero
    var result: [String: Any] = ["tabId": tab.id,
      "viewport": ["width": tab.visualViewport["width"] ?? size.width, "height": tab.visualViewport["height"] ?? size.height],
      "nativeViewport": ["width": Double(size.width), "height": Double(size.height)],
      "scale": tab.visualViewport["scale"] ?? tab.webView?.scrollView.zoomScale ?? 1,
      "offset": ["x": tab.visualViewport["x"] ?? 0, "y": tab.visualViewport["y"] ?? 0],
      "scroll": ["x": offset.x, "y": offset.y], "pixelRatio": tab.webView?.window?.screen.scale ?? 1,
      "inset": ["top": inset.top, "left": inset.left, "bottom": inset.bottom, "right": inset.right],
      "keyboard": ["x": keyboard.isNull ? 0 : keyboard.minX, "y": keyboard.isNull ? 0 : keyboard.minY,
        "width": keyboard.isNull ? 0 : keyboard.width, "height": keyboard.isNull ? 0 : keyboard.height]]
    let fingerprint = GeometryFingerprint.of(result)
    let changed = tab.geometryFingerprint != fingerprint
    if changed { tab.captureGate.advance(); tab.geometryRevision += 1; tab.revision += 1; tab.geometryFingerprint = fingerprint }
    result["revision"] = tab.geometryRevision
    if changed { emit?("geometry", result) }
    return result
  }

  func setForeground(_ active: Bool) {
    if foreground && !active {
      for tab in tabs.values where state.tabs[tab.id] == .live { preserveScroll(tab) }
    }
    foreground = active
    if !active {
      capture.stop()
      for tab in tabs.values {
        cancelAgent(tab); cancelDialog(tab); cancelChooser(tab); cancelComposition(tab); tab.capture.clear(); tab.contextId = nil
        let pending = tab.pendingCalls.values
        tab.pendingCalls.removeAll(); tab.callEpochs.removeAll()
        for cancel in pending { cancel(BrowserRefusal.notActionable) }
        let waiters = tab.readyWaiters.values
        tab.readyWaiters.removeAll(); tab.readyEpochs.removeAll()
        for waiter in waiters { waiter(.failure(BrowserRefusal.notActionable)) }
        let loading = tab.loadWaiters.values
        tab.loadWaiters.removeAll()
        for waiter in loading { waiter(.failure(BrowserRefusal.notActionable)) }
      }
    } else { capture.refresh() }
  }

  func preserveScroll(_ tab: PhoneBrowserTab) {
    guard let scroll = tab.webView?.scrollView else { return }
    tab.retainedScrollOffset = scroll.contentOffset
    let inset = scroll.adjustedContentInset
    let scale = max(scroll.zoomScale, 0.01)
    tab.anchor = ["x": (scroll.contentOffset.x + inset.left) / scale,
      "y": (scroll.contentOffset.y + inset.top) / scale]
  }

  func cancelDialog(_ tab: PhoneBrowserTab) {
    tab.externalPrompt?.dismiss(animated: false)
    tab.externalPrompt = nil
    guard let dialog = tab.pendingDialog else { return }
    tab.pendingDialog = nil
    try? dialog.answer(accept: false, text: nil)
    emit?("dialog", ["tabId": tab.id, "documentId": dialog.documentId, "dialog": NSNull(), "dialogId": dialog.id])
  }

  func dialog(_ view: WKWebView, kind: String, message: String, defaultText: String? = nil,
    completion: @escaping (Bool, String?) -> Void) {
    guard foreground, let tab = tabs.values.first(where: { $0.webView === view }) else {
      completion(false, nil)
      return
    }
    cancelDialog(tab)
    let dialog = BrowserDialog(documentId: tab.documentId, kind: kind, message: message,
      defaultText: defaultText, epoch: gate.current, completion: completion)
    tab.pendingDialog = dialog
    emit?("dialog", ["tabId": tab.id, "documentId": tab.documentId,
      "dialog": ["id": dialog.id, "kind": kind, "message": String(message.prefix(16384)), "defaultText": defaultText as Any? ?? NSNull()]])
    let pending = tab.pendingCalls.values
    tab.pendingCalls.removeAll(); tab.callEpochs.removeAll()
    for cancel in pending { cancel(BrowserRefusal.dialogOpen) }
  }

  func respondDialog(_ input: BrowserDialogInput) throws {
    try gate.perform(input.epoch) {
      let tab = try tab(input.tabId)
      guard tab.documentId == input.documentId, let dialog = tab.pendingDialog,
        dialog.id == input.dialogId, dialog.epoch == input.epoch else { throw BrowserRefusal.staleDialog }
      tab.pendingDialog = nil
      try dialog.answer(accept: input.accept, text: input.promptText)
      emit?("dialog", ["tabId": tab.id, "documentId": tab.documentId, "dialog": NSNull(), "dialogId": dialog.id])
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    dialog(webView, kind: "alert", message: message) { _, _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    dialog(webView, kind: "confirm", message: message) { accept, _ in completionHandler(accept) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    dialog(webView, kind: "prompt", message: prompt, defaultText: defaultText) { accept, text in
      completionHandler(accept ? text ?? defaultText ?? "" : nil)
    }
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    guard let tab = tabs.values.first(where: { $0.webView === webView }) else { return }
    guard let navigation, let navigationId = tab.navigations.current(ObjectIdentifier(navigation)) else { return }
    do { try stores.markInitialized(tab.storeHandle) }
    catch { try? state.discard(tab.id); releaseView(tab.id); return }
    cancelDialog(tab)
    tab.captureGate.advance()
    tab.documentId = UUID().uuidString
    tab.frameDocuments.removeAll()
    tab.readiness.commit(document: tab.documentId)
    tab.url = webView.url
    tab.failedURL = nil
    tab.visualViewport.removeAll()
    emit?("navigationCommitted", ["tabId": tab.id, "navigationId": navigationId,
      "documentId": tab.documentId, "url": webView.url?.absoluteString ?? "about:blank", "state": "committed"])
    changed(tab)
    signalReady(tab)
    emit?("documentChanged", ["tabId": tab.id, "documentId": tab.documentId,
      "frames": tab.frameDocuments.map { ["frameId": $0.key, "documentId": $0.value] }])
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    if let tab = tabs.values.first(where: { $0.webView === webView }) {
      guard let navigation, let id = tab.navigations.started(ObjectIdentifier(navigation), id: UUID().uuidString) else { return }
      tab.navigatingId = id
      cancelAgent(tab)
      cancelDialog(tab)
      cancelChooser(tab)
      cancelComposition(tab)
      let pending = tab.pendingCalls.values
      tab.pendingCalls.removeAll()
      tab.callEpochs.removeAll()
      for cancel in pending { cancel(BrowserRefusal.staleDocument) }
      tab.contextId = nil
      tab.frameDocuments.removeAll()
      tab.frames.removeAll()
      tab.readiness.provisional()
    }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    guard let tab = tabs.values.first(where: { $0.webView === webView }) else { return }
    try? state.discard(tab.id)
    releaseView(tab.id)
    emit?("rendererGone", ["tabIds": [tab.id], "reason": "web-content-process-terminated"])
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let tab = tabs.values.first(where: { $0.webView === message.webView }) else { return }
    guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
    if kind == "viewport", message.frameInfo.isMainFrame {
      guard (try? tab.readiness.require(frame: "main")) == body["token"] as? String,
        let viewport = body["viewport"] as? [String: Double], viewport.values.allSatisfy(\.isFinite) else { return }
      tab.visualViewport = viewport
      _ = geometry(tab)
      return
    }
    if kind == "editing", message.frameInfo.isMainFrame {
      guard (try? tab.readiness.require(frame: "main")) == body["token"] as? String else { return }
      tab.contextId = UUID().uuidString
      tab.contextEpoch = gate.current
      tab.secureInput = body["secure"] as? Bool ?? true
      emit?("editing", ["tabId": tab.id, "context": ["contextId": tab.contextId!, "documentId": tab.documentId,
        "editable": body["editable"] as? Bool ?? false, "secure": tab.secureInput, "field": body["field"] ?? NSNull()]])
      return
    }
    guard kind == "ready", let token = body["token"] as? String, token.count <= 256, tab.frames.count < 256 else { return }
    let frameId = message.frameInfo.isMainFrame ? "main" : UUID().uuidString
    tab.frames[frameId] = message.frameInfo
    tab.readiness.helper(frame: frameId, token: token)
    signalReady(tab)
    if let opener = tab.popupOpener, (try? tab.readiness.require(frame: "main")) != nil {
      tab.popupOpener = nil
      emit?("popup", ["openerId": opener, "tabId": tab.id])
    }
    if !tab.documentId.isEmpty { emit?("documentChanged", ["tabId": tab.id, "documentId": tab.documentId,
      "frames": tab.frameDocuments.map { ["frameId": $0.key, "documentId": $0.value] }]) }
  }

}
