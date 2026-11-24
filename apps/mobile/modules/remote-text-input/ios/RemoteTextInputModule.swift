import ExpoModulesCore

public final class RemoteTextInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RemoteTextInput")
    View(RemoteTextInputView.self) {
      Events("onProxyEvent")
      Prop("context") { (view: RemoteTextInputView, value: [String: Any]?) in view.context = value; view.configure() }
      Prop("softKeyboard") { (view: RemoteTextInputView, value: Bool) in view.softKeyboard = value; view.configure() }
      Prop("keyboardMayReplaceText") { (view: RemoteTextInputView, value: Bool?) in view.keyboardMayReplaceText = value ?? true; view.configure() }
      Prop("focused") { (view: RemoteTextInputView, value: Bool) in view.editingFocused = value; view.configure() }
    }
    // JavaScript reads this to call the input's functions by its tag. A function whose argument
    // is a view makes Expo resolve it on the JavaScript thread by waiting for the main thread,
    // which deadlocks while React holds the main thread waiting for JavaScript. These take the
    // tag and run on the main queue, in order; keep their FIFO work synchronous.
    Constant("viewTagFunctions") { 1 }
    AsyncFunction("finishCompositionForView") { (tag: Int) in
      guard let view = self.input(tag) else { throw ViewNotMountedException() }
      MainActor.assumeIsolated { view.input.unmarkText() }
    }.runOnQueue(.main)
    AsyncFunction("respondForView") { (tag: Int, instruction: [String: Any]) in
      guard let view = self.input(tag) else { throw ViewNotMountedException() }
      MainActor.assumeIsolated { view.input.respond(instruction) }
    }.runOnQueue(.main)
  }

  /// The input with this tag, found on the main queue these functions run on: never by waiting for it.
  private func input(_ tag: Int) -> RemoteTextInputView? {
    dispatchPrecondition(condition: .onQueue(.main))
    return appContext?.findView(withTag: tag, ofType: RemoteTextInputView.self)
  }
}

/// The input is not mounted: its instruction is refused, as Expo's own view lookup refused it.
final class ViewNotMountedException: Exception {
  override var reason: String { "The text input is not mounted" }
}
final class RemoteTextInputView: ExpoView {
  let onProxyEvent = EventDispatcher()
  let input = RemoteInputTextView()
  var context: [String: Any]?
  var editingFocused = false
  var softKeyboard = false
  var keyboardMayReplaceText = true
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    input.deliver = { [weak self] in self?.onProxyEvent($0) }
    addSubview(input)
  }
  func configure() { input.configure(context, focused: editingFocused, softKeyboard: softKeyboard, keyboardMayReplaceText: keyboardMayReplaceText) }
  override func layoutSubviews() { super.layoutSubviews(); input.frame = bounds }
  override func didMoveToWindow() { super.didMoveToWindow(); if window == nil { input.resignFirstResponder() } else { configure() } }
}
