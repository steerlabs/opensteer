import ExpoModulesCore

public final class ComposerEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OpensteerComposerEditor")
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
      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContentSizeChange",
        "onComposerEmptyBackspace"
      )
      AsyncFunction("focus") { (view: ComposerEditorView) in view.focusEditor() }
      AsyncFunction("blur") { (view: ComposerEditorView) in view.blurEditor() }
      AsyncFunction("setSelection") { (view: ComposerEditorView, start: Int, end: Int) in
        view.setSelection(start: start, end: end)
      }
      AsyncFunction("readState") { (view: ComposerEditorView) -> [String: Any] in view.readState() }
    }
  }
}
