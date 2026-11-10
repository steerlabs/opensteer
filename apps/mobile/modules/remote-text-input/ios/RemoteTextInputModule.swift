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
      // Expo view functions run on the main queue; keep their FIFO work synchronous.
      AsyncFunction("finishComposition") { (view: RemoteTextInputView) in
        MainActor.assumeIsolated { view.input.unmarkText() }
      }
      AsyncFunction("respond") { (view: RemoteTextInputView, instruction: [String: Any]) in
        MainActor.assumeIsolated { view.input.respond(instruction) }
      }
    }
  }
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
