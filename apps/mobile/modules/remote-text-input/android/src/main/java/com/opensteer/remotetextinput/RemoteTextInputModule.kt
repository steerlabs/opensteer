package com.opensteer.remotetextinput
import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher

class RemoteTextInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RemoteTextInput")
    View(RemoteTextInputView::class) {
      Events("onProxyEvent")
      Prop("context") { view: RemoteTextInputView, value: Map<String, Any?>? -> view.editingContext = value; view.configure() }
      Prop("focused") { view: RemoteTextInputView, value: Boolean -> view.focused = value; view.configure() }
      AsyncFunction("finishComposition") { view: RemoteTextInputView -> view.input.finishComposition() }
      AsyncFunction("respond") { view: RemoteTextInputView, instruction: Map<String, Any?> -> view.input.respond(instruction) }
    }
  }
}
class RemoteTextInputView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onProxyEvent by EventDispatcher<Map<String, Any?>>()
  val input = RemoteInputEditText(context)
  var editingContext: Map<String, Any?>? = null
  var focused = false
  init { addView(input, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)); input.deliver = { onProxyEvent(it) } }
  fun configure() = input.configure(editingContext, focused)
}
