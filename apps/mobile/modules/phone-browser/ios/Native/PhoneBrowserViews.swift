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
  private var announced = false
  var hostId = "" {
    didSet {
      if #available(iOS 17, *) {
        if !oldValue.isEmpty { PhoneBrowserPool.shared.hosts.removeObject(forKey: oldValue as NSString) }
        PhoneBrowserPool.shared.hosts.setObject(self, forKey: hostId as NSString)
      }
    }
  }
  var tabId: String?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    if newWindow == nil { announced = false }
    if newWindow == nil, window != nil, let tabId, #available(iOS 17, *),
      PhoneBrowserPool.shared.tabs[tabId]?.webView?.superview === self {
      let pool = PhoneBrowserPool.shared
      if (try? pool.coverTab(tabId)) == nil {
        if let tab = pool.tabs[tabId] {
          pool.cancelDialog(tab)
          pool.cancelChooser(tab)
          tab.webView?.removeFromSuperview()
          for released in (try? pool.state.suspend(tabId)) ?? [] { pool.releaseView(released) }
          pool.changed(tab)
        }
      }
    }
    super.willMove(toWindow: newWindow)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if !announced, window != nil, bounds.width > 0, bounds.height > 0 {
      announced = true
      onReady(["hostId": hostId])
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    setNeedsLayout()
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
