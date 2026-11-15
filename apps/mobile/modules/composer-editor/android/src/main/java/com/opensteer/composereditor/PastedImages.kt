package com.opensteer.composereditor

import android.content.Context
import android.net.Uri
import android.webkit.MimeTypeMap
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** Images pasted, inserted by a keyboard or dropped into the editor, copied to private files. */
internal object PastedImages {
  private val copier = Executors.newSingleThreadExecutor()

  private sealed interface Copied {
    data class Image(val image: Map<String, Any>) : Copied
    data object Failed : Copied
    data object TooLarge : Copied
  }

  /** Copies on a background thread, then `deliver`s `{ images, failed, tooLarge }` through `post`. */
  fun copy(
    context: Context,
    uris: List<Uri>,
    maxBytes: Long,
    post: (Runnable) -> Unit,
    deliver: (Map<String, Any>) -> Unit,
  ) {
    // Read while the paste's or keyboard's read grant is still held.
    copier.execute {
      val copied = uris.map { copy(context, it, maxBytes) }
      post(
        Runnable {
          deliver(
            mapOf(
              "images" to copied.filterIsInstance<Copied.Image>().map { it.image },
              "failed" to copied.count { it == Copied.Failed },
              "tooLarge" to copied.count { it == Copied.TooLarge },
            ),
          )
        },
      )
    }
  }

  private fun copy(context: Context, uri: Uri, limit: Long): Copied {
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
}
