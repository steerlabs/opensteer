package com.opensteer.remotetextinput

internal class RemoteInputGate {
  var deliver: ((Map<String, Any?>) -> Unit)? = null
  var contextId: String? = null
  var apply: ((Map<String, Any?>) -> Unit)? = null
  private val jobs = mutableListOf<() -> Unit>()
  private var next = 0
  private var waiting: Pair<Int, () -> Unit>? = null
  private var running = false
  private var insertion = 0
  fun enqueue(job: () -> Unit) {
    if (running) jobs.add(insertion++, job) else jobs.add(job)
    drain()
  }
  fun event(event: Map<String, Any?>, action: () -> Unit = {}) {
    next += 1
    waiting = next to action
    deliver?.invoke(mapOf("id" to next, "event" to event, "contextId" to contextId))
  }
  fun notify(event: Map<String, Any?>) = enqueue { this.event(event) }
  fun respond(instruction: Map<String, Any?>) {
    val id = (instruction["id"] as? Number)?.toInt() ?: return
    if (id == 0) { apply?.invoke(instruction); return }
    val current = waiting ?: return
    if (current.first != id) return
    waiting = null
    running = true; insertion = 0
    if (instruction["preventDefault"] != true) current.second()
    apply?.invoke(instruction)
    running = false
    drain()
  }
  private fun drain() {
    if (running) return
    while (waiting == null && jobs.isNotEmpty()) {
      running = true; insertion = 0
      jobs.removeAt(0)()
      running = false
    }
  }
}
