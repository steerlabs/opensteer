package com.opensteer.pastetarget

import android.content.Context
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.widget.EditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

class PasteTargetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpensteerPasteTarget")
    View(PasteTargetView::class) {
      Events("onPasteImages")
      Prop("maxBytes") { view: PasteTargetView, value: Long -> view.maxBytes = value }
    }
  }
}

/**
 * Takes the images a paste, a keyboard's image insertion or a drop delivers to
 * the text field it holds, through AndroidX's receive-content listener; text in
 * the same payload goes on to the field as before.
 */
class PasteTargetView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onPasteImages by EventDispatcher<Map<String, Any>>()
  private val listener = OnReceiveContentListener { _, payload -> receive(payload) }
  /** The most one image may hold where the field sends it; a larger one is reported, not kept. */
  var maxBytes = 0L

  override fun onViewAdded(child: View) {
    super.onViewAdded(child)
    fields(child).forEach { ViewCompat.setOnReceiveContentListener(it, arrayOf("image/*"), listener) }
  }

  override fun onViewRemoved(child: View) {
    fields(child).forEach { ViewCompat.setOnReceiveContentListener(it, null, null) }
    super.onViewRemoved(child)
  }

  private fun fields(view: View): List<EditText> = when (view) {
    is EditText -> listOf(view)
    is ViewGroup -> (0 until view.childCount).flatMap { fields(view.getChildAt(it)) }
    else -> emptyList()
  }

  private fun receive(payload: ContentInfoCompat): ContentInfoCompat? {
    val resolver = context.contentResolver
    val split = payload.partition { item -> item.uri?.let { resolver.getType(it)?.startsWith("image/") } == true }
    val images = split.first ?: return split.second
    val uris = (0 until images.clip.itemCount).mapNotNull { images.clip.getItemAt(it).uri }
    // Read while the paste's or keyboard's read grant is still held.
    val limit = maxBytes
    copier.execute {
      val copied = uris.map { copy(it, limit) }
      post {
        onPasteImages(
          mapOf(
            "images" to copied.filterIsInstance<Copied.Image>().map { it.image },
            "failed" to copied.count { it == Copied.Failed },
            "tooLarge" to copied.count { it == Copied.TooLarge },
          ),
        )
      }
    }
    return split.second
  }

  private sealed interface Copied {
    data class Image(val image: Map<String, Any>) : Copied
    data object Failed : Copied
    data object TooLarge : Copied
  }

  private fun copy(uri: Uri, limit: Long): Copied {
    val resolver = context.contentResolver
    val mediaType = resolver.getType(uri) ?: "image/png"
    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mediaType) ?: "img"
    val directory = File(context.cacheDir, "pasted-images").apply { mkdirs() }
    val file = File(directory, "${UUID.randomUUID()}.$ext")
    return try {
      val within = resolver.openInputStream(uri)?.use { input ->
        file.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            // A provider decides how much it sends; stop at what the field could send on.
            if (total > limit) return@use false
            output.write(buffer, 0, read)
          }
          true
        }
      } ?: throw IllegalStateException("The pasted image could not be opened.")
      if (within) {
        Copied.Image(mapOf("uri" to Uri.fromFile(file).toString(), "mediaType" to mediaType, "name" to "Pasted image.$ext"))
      } else {
        file.delete()
        Copied.TooLarge
      }
    } catch (_: Exception) {
      // A provider can revoke its grant or refuse the read.
      file.delete()
      Copied.Failed
    }
  }

  private companion object {
    val copier = Executors.newSingleThreadExecutor()
  }
}
