import ExpoModulesCore
import WebKit

final class BrowserPersonGesture: UIGestureRecognizer {
  private let began: (CGPoint) -> Void
  init(began: @escaping (CGPoint) -> Void) {
    self.began = began
    super.init(target: nil, action: nil)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
  }
  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    if let touch = touches.first { began(touch.location(in: view)) }
    state = .failed
  }
}

final class BrowserWebView: WKWebView {
  var geometryChanged: (() -> Void)?
  override func layoutSubviews() { super.layoutSubviews(); geometryChanged?() }
}

final class PhoneBrowserHostView: ExpoView {
  let onReady = EventDispatcher()
  let onPageScroll = EventDispatcher()
  private var announced = false
  private var laidOut = CGSize.zero
  /// The page's own controls float over these edges: the page lays out clear of them and keeps its size.
  var barInsets: UIEdgeInsets? { didSet { if barInsets != oldValue { present() } } }
  /// Pull to refresh, and edge swipes through the page's history.
  var pageGestures = false { didSet { if pageGestures != oldValue { present() } } }
  var pageScroll = false { didSet { if pageScroll != oldValue { present() } } }
  private weak var page: WKWebView?
  private var watching: [NSKeyValueObservation] = []
  private var lastScroll: [String: AnyHashable]?
  private var refreshing = false
  private lazy var refresh: UIRefreshControl = {
    let control = UIRefreshControl()
    control.addTarget(self, action: #selector(pulled), for: .valueChanged)
    return control
  }()
  var hostId = "" {
    didSet {
      if #available(iOS 17, *) {
        if !oldValue.isEmpty { PhoneBrowserPool.shared.hosts.removeObject(forKey: oldValue as NSString) }
        PhoneBrowserPool.shared.hosts.setObject(self, forKey: hostId as NSString)
      }
    }
  }
  /// Set by the pool exactly while one of its pages is presented here. WebKit may move the page
  /// into its own container for a back swipe; that is not the page leaving.
  var tabId: String? { didSet { attach() } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    if newWindow == nil { announced = false }
    if newWindow == nil, window != nil, let tabId, #available(iOS 17, *),
      PhoneBrowserPool.shared.tabs[tabId]?.webView?.superview === self {
      let pool = PhoneBrowserPool.shared
      if let tab = pool.tabs[tabId], let view = tab.webView {
        do {
          try pool.parkView(tab)
        } catch {
          pool.cancelDialog(tab)
          pool.cancelChooser(tab)
          view.removeFromSuperview()
          for released in (try? pool.state.suspend(tabId)) ?? [] { pool.releaseView(released) }
          pool.changed(tab)
        }
      }
    }
    super.willMove(toWindow: newWindow)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // The page follows its place turning or growing, not the keyboard lifting the place for a moment.
    let before = laidOut
    laidOut = bounds.size
    if let web = page, web.superview === self, before != .zero, before != bounds.size,
      bounds.width != before.width || bounds.height > before.height {
      web.frame = bounds
    }
    if !announced, window != nil, bounds.width > 0, bounds.height > 0 {
      announced = true
      onReady(["hostId": hostId])
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    setNeedsLayout()
  }

  private func attach() {
    var next: WKWebView?
    if #available(iOS 17, *), let tabId { next = PhoneBrowserPool.shared.tabs[tabId]?.webView }
    if let web = page, web !== next { release(web) }
    if let next, #available(iOS 17, *) {
      for case let other as PhoneBrowserHostView in PhoneBrowserPool.shared.hosts.objectEnumerator()?.allObjects ?? []
      where other !== self && other.page === next { other.page = nil }
    }
    page = next
    present()
  }

  private func present() {
    guard let web = page else { return }
    release(web)
    let insets = barInsets ?? .zero
    if #available(iOS 26, *) { web.obscuredContentInsets = insets }
    else {
      web.scrollView.contentInset = insets
      web.scrollView.verticalScrollIndicatorInsets = insets
    }
    web.allowsBackForwardNavigationGestures = pageGestures
    if pageGestures {
      web.scrollView.refreshControl = refresh
      watching.append(web.observe(\.isLoading) { [weak self] web, _ in
        MainActor.assumeIsolated { self?.loaded(web) }
      })
    }
    if pageScroll {
      watching.append(web.scrollView.observe(\.contentOffset) { [weak self] scroll, _ in
        MainActor.assumeIsolated { self?.scrolled(scroll) }
      })
    }
  }

  private func release(_ web: WKWebView) {
    watching.removeAll()
    lastScroll = nil
    if #available(iOS 26, *) { web.obscuredContentInsets = .zero }
    else {
      web.scrollView.contentInset = .zero
      web.scrollView.verticalScrollIndicatorInsets = .zero
    }
    web.allowsBackForwardNavigationGestures = false
    if web.scrollView.refreshControl === refresh {
      refresh.endRefreshing()
      web.scrollView.refreshControl = nil
    }
    refreshing = false
  }

  private func scrolled(_ scroll: UIScrollView) {
    let inset = scroll.adjustedContentInset
    let y = Double(scroll.contentOffset.y + inset.top)
    let end = Double(max(0, scroll.contentSize.height + inset.top + inset.bottom - scroll.bounds.height))
    let person = scroll.isTracking || scroll.isDecelerating
    let sample: [String: AnyHashable] = ["y": y.rounded(), "end": end.rounded(), "person": person]
    if sample == lastScroll { return }
    lastScroll = sample
    onPageScroll(["y": y, "end": end, "person": person])
  }

  /// A pull reloads through the pool's own navigation, as Reload does, so fences and watchers see a navigation.
  @objc private func pulled() {
    guard #available(iOS 17, *), let tabId, let web = page,
      let tab = PhoneBrowserPool.shared.tabs[tabId], tab.webView === web else {
      refresh.endRefreshing()
      return
    }
    let input = BrowserNavigationInput()
    input.epoch = PhoneBrowserPool.shared.gate.current
    input.tabId = tabId
    input.kind = "reload"
    do {
      _ = try PhoneBrowserPool.shared.navigate(input)
      refreshing = true
    } catch { refresh.endRefreshing() }
  }

  private func loaded(_ web: WKWebView) {
    if refreshing, !web.isLoading {
      refreshing = false
      refresh.endRefreshing()
    }
  }
}

final class PhoneBrowserPictureView: ExpoView {
  private let picture = UIImageView()
  var tabId = "" {
    didSet {
      if #available(iOS 17, *) {
        picture.image = PhoneBrowserPool.shared.tabs[tabId]?.latestPicture
        PhoneBrowserPool.shared.capture.refresh()
      }
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    picture.contentMode = .scaleAspectFill
    picture.clipsToBounds = true
    addSubview(picture)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    picture.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if #available(iOS 17, *) {
      PhoneBrowserPool.shared.capture.pictures.add(self)
      PhoneBrowserPool.shared.capture.refresh()
    }
  }

  func draw(_ image: UIImage) {
    UIView.performWithoutAnimation { picture.image = image }
  }
}
