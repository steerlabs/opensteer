package com.opensteer.phonebrowser

internal data class PageChooser(val epoch: Int, val generation: Int, val document: String, val person: Boolean) {
  fun current(epoch: Int, generation: Int, document: String?) =
    this.generation == generation && this.document == document && (person || this.epoch == epoch)
  fun survivesFence() = person
}

internal class PageClose {
  private var closed = false
  fun close(reference: Map<String, Any?>, destroy: () -> Unit, emit: (Map<String, Any?>) -> Unit) {
    if (closed) return
    closed = true
    destroy()
    emit(reference + ("type" to "closed"))
  }
}
