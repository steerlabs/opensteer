import ExpoModulesCore
import UIKit

/// iOS's own context menu around a React Native view, as Messages' bubbles have:
/// held, the view lifts over the dimmed screen with its menu beside it, drawn and
/// timed by the system on the main thread. A plain container, not a SwiftUI host:
/// hosted bubbles size a layout pass late, so the rows under them overlap.
public final class ContextMenuModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpensteerContextMenu")
    View(ContextMenuView.self) {
      Events("onAction")
      Prop("actions") { (view: ContextMenuView, actions: [ContextMenuAction]) in
        view.actions = actions
      }
      Prop("previewRadius") { (view: ContextMenuView, radius: Double) in
        view.previewRadius = CGFloat(radius)
      }
      Prop("previewBottomEndRadius") { (view: ContextMenuView, radius: Double?) in
        view.previewBottomEndRadius = radius.map { CGFloat($0) }
      }
    }
  }
}

struct ContextMenuAction: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  /// An SF Symbol's name.
  @Field var systemImage: String = ""
  /// Actions sharing a group stand together between the menu's dividers.
  @Field var group: Int = 0
}

final class ContextMenuView: ExpoView, UIContextMenuInteractionDelegate {
  let onAction = EventDispatcher()
  var actions: [ContextMenuAction] = []
  var previewRadius: CGFloat = 0
  var previewBottomEndRadius: CGFloat?

  private var chosen: String?
  private var dismissing = false
  private var lifted = false
  private weak var scrollView: UIScrollView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    addInteraction(UIContextMenuInteraction(delegate: self))
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(listPanned(_:)))
    scrollView = nil
    guard window != nil else { return }
    var ancestor = superview
    while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
    scrollView = ancestor as? UIScrollView
    scrollView?.panGestureRecognizer.addTarget(self, action: #selector(listPanned(_:)))
  }

  /// A press that moves on into a scroll was a scroll, so the view lets go and the
  /// list moves, rather than the pressed view hanging over a list sliding under it.
  @objc private func listPanned(_ pan: UIPanGestureRecognizer) {
    guard pan.state == .began, !lifted else { return }
    for gesture in gestureRecognizers ?? [] where gesture.isEnabled {
      gesture.isEnabled = false
      gesture.isEnabled = true
    }
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard !actions.isEmpty else { return nil }
    chosen = nil
    dismissing = false
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      self?.menu()
    }
  }

  private func menu() -> UIMenu {
    let groups = Dictionary(grouping: actions, by: \.group).sorted { $0.key < $1.key }
    return UIMenu(children: groups.map { _, members in
      UIMenu(options: .displayInline, children: members.map { action in
        UIAction(title: action.title, image: UIImage(systemName: action.systemImage)) {
          [weak self] _ in
          self?.chosen = action.id
          if self?.dismissing == true { self?.fire() }
        }
      })
    })
  }

  /// Lifted, the list holds still: the finger that held the view no longer scrolls it.
  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willDisplayMenuFor configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionAnimating?
  ) {
    lifted = true
    guard let scrollView else { return }
    scrollView.panGestureRecognizer.isEnabled = false
    scrollView.panGestureRecognizer.isEnabled = true
    scrollView.setContentOffset(scrollView.contentOffset, animated: false)
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForHighlightingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? {
    preview()
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    previewForDismissingMenuWithConfiguration configuration: UIContextMenuConfiguration
  ) -> UITargetedPreview? {
    preview()
  }

  /// An action fires once the menu has gone, so a sheet it opens can come up.
  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willEndFor configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionAnimating?
  ) {
    lifted = false
    let done: () -> Void = { [weak self] in
      self?.dismissing = true
      self?.fire()
    }
    if let animator {
      animator.addCompletion(done)
    } else {
      done()
    }
  }

  private func fire() {
    guard let id = chosen else { return }
    chosen = nil
    onAction(["id": id])
  }

  /// The view cut to its bubble, which leaves out its tail, as the system's lift has no room for it.
  private func preview() -> UITargetedPreview? {
    guard window != nil else { return nil }
    let parameters = UIPreviewParameters()
    parameters.backgroundColor = .clear
    parameters.visiblePath = previewPath()
    return UITargetedPreview(view: self, parameters: parameters)
  }

  private func previewPath() -> UIBezierPath {
    let radius = previewRadius
    guard let end = previewBottomEndRadius, end != radius else {
      return UIBezierPath(roundedRect: bounds, cornerRadius: radius)
    }
    let rightToLeft = effectiveUserInterfaceLayoutDirection == .rightToLeft
    let bottomLeft = rightToLeft ? end : radius
    let bottomRight = rightToLeft ? radius : end
    let box = bounds
    let path = UIBezierPath()
    path.move(to: CGPoint(x: box.minX + radius, y: box.minY))
    path.addArc(
      withCenter: CGPoint(x: box.maxX - radius, y: box.minY + radius), radius: radius,
      startAngle: -.pi / 2, endAngle: 0, clockwise: true)
    path.addArc(
      withCenter: CGPoint(x: box.maxX - bottomRight, y: box.maxY - bottomRight), radius: bottomRight,
      startAngle: 0, endAngle: .pi / 2, clockwise: true)
    path.addArc(
      withCenter: CGPoint(x: box.minX + bottomLeft, y: box.maxY - bottomLeft), radius: bottomLeft,
      startAngle: .pi / 2, endAngle: .pi, clockwise: true)
    path.addArc(
      withCenter: CGPoint(x: box.minX + radius, y: box.minY + radius), radius: radius,
      startAngle: .pi, endAngle: 3 * .pi / 2, clockwise: true)
    path.close()
    return path
  }
}
