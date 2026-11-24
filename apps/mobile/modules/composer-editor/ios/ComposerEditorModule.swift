import ExpoModulesCore

public final class ComposerEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpensteerComposerEditor")
    Constant("draftPasteVersion") { 1 }
    Events("onDraftPaste")
    View(ComposerEditorView.self) {
      Prop("documentJson") { (view: ComposerEditorView, json: String) in view.setDocumentJson(json) }
      Prop("themeJson") { (view: ComposerEditorView, json: String) in view.setThemeJson(json) }
      Prop("placeholder") { (view: ComposerEditorView, text: String) in view.setPlaceholder(text) }
      Prop("label") { (view: ComposerEditorView, text: String) in view.setLabel(text) }
      Prop("typographyJson") { (view: ComposerEditorView, json: String) in
        guard let data = json.data(using: .utf8),
              let typography = try? JSONDecoder().decode([String: Double].self, from: data) else { return }
        view.setTypography(
          fontSize: CGFloat(typography["fontSize"] ?? 17),
          lineHeight: CGFloat(typography["lineHeight"] ?? 24),
          paddingVertical: CGFloat(typography["paddingVertical"] ?? 0)
        )
      }
      Prop("editable") { (view: ComposerEditorView, editable: Bool) in view.setEditable(editable) }
      Prop("autoFocus") { (view: ComposerEditorView, autoFocus: Bool) in view.setAutoFocus(autoFocus) }
      Prop("maxBytes") { (view: ComposerEditorView, maxBytes: Int) in view.maxBytes = maxBytes }
      Prop("pasteTarget") { [weak self] (view: ComposerEditorView, target: String?) in
        view.deliverDraftPaste = target.map { target in
          { [weak self] pasted in self?.sendEvent("onDraftPaste", ["target": target, "pasted": pasted]) }
        }
      }
      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContentSizeChange",
        "onComposerEmptyBackspace"
      )
    }
    // JavaScript reads this to call the editor's functions by its tag. A function whose argument
    // is a view makes Expo resolve it on the JavaScript thread by waiting for the main thread,
    // which deadlocks while React holds the main thread waiting for JavaScript. These take the
    // tag and find the view on the main queue they run on.
    Constant("viewTagFunctions") { 1 }
    AsyncFunction("focusForView") { (tag: Int) -> Void in self.editor(tag)?.focusEditor() }.runOnQueue(.main)
    AsyncFunction("blurForView") { (tag: Int) -> Void in self.editor(tag)?.blurEditor() }.runOnQueue(.main)
    AsyncFunction("setSelectionForView") { (tag: Int, start: Int, end: Int) -> Void in
      self.editor(tag)?.setSelection(start: start, end: end)
    }.runOnQueue(.main)
    AsyncFunction("readStateForView") { (tag: Int) -> [String: Any] in
      guard let editor = self.editor(tag) else { throw EditorNotMountedException() }
      return editor.readState()
    }.runOnQueue(.main)
  }

  /// The editor with this tag, found on the main queue these functions run on: never by waiting for it.
  private func editor(_ tag: Int) -> ComposerEditorView? {
    dispatchPrecondition(condition: .onQueue(.main))
    return appContext?.findView(withTag: tag, ofType: ComposerEditorView.self)
  }
}

/// The editor is not mounted: its state is not read, as Expo's own view lookup refused it.
final class EditorNotMountedException: Exception {
  override var reason: String { "The composer editor is not mounted" }
}
