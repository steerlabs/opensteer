package com.opensteer.composereditor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class ComposerEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpensteerComposerEditor")
    View(ComposerEditorView::class) {
      Prop("documentJson") { view: ComposerEditorView, json: String -> view.setDocumentJson(json) }
      Prop("themeJson") { view: ComposerEditorView, json: String -> view.setThemeJson(json) }
      Prop("placeholder") { view: ComposerEditorView, text: String -> view.setPlaceholder(text) }
      Prop("label") { view: ComposerEditorView, text: String -> view.setLabel(text) }
      Prop("typographyJson") { view: ComposerEditorView, json: String ->
        val typography = runCatching { JSONObject(json) }.getOrNull() ?: return@Prop
        view.setTypography(
          typography.optDouble("fontSize", 17.0).toFloat(),
          typography.optDouble("lineHeight", 24.0).toFloat(),
          typography.optDouble("paddingVertical", 0.0).toFloat(),
        )
      }
      Prop("editable") { view: ComposerEditorView, editable: Boolean -> view.setEditable(editable) }
      Prop("autoFocus") { view: ComposerEditorView, autoFocus: Boolean -> view.setAutoFocus(autoFocus) }
      Prop("maxBytes") { view: ComposerEditorView, maxBytes: Long -> view.maxBytes = maxBytes }
      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContentSizeChange",
        "onComposerEmptyBackspace",
      )
      AsyncFunction("focus") { view: ComposerEditorView -> view.focusEditor() }
      AsyncFunction("blur") { view: ComposerEditorView -> view.blurEditor() }
      AsyncFunction("setSelection") { view: ComposerEditorView, start: Int, end: Int -> view.setSelection(start, end) }
      AsyncFunction("readState") { view: ComposerEditorView -> view.readState() }
    }
  }
}
