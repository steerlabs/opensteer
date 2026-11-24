package com.opensteer.remotetextinput

internal class RemoteInputGate {
  var deliver: ((Map<String, Any?>) -> Unit)? = null
  var contextId: String? = null
  var apply: ((Map<String, Any?>) -> Unit)? = null
  private val jobs = mutableListOf<() -> Unit>()
  private var next = 0
  private var waiting: Pair<Int, () -> Unit>? = null
  private var running = false
  /** Whether a job or an answered event's default is running: a change now came through the gate. */
  val inTurn: Boolean get() = running
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
  /**
   * CY10: a place in the order now, for an event known only later (an outside edit, once it has
   * settled): everything after it waits for it. The returned call gives it: its event is made and
   * delivered at its turn, or at once if its turn has come.
   */
  fun reserve(make: () -> Map<String, Any?>): () -> Unit {
    var given = false
    var reached = false
    enqueue {
      reached = true
      if (given) event(make()) else waiting = held
    }
    return {
      if (!given) {
        given = true
        if (reached) {
          waiting = null
          event(make())
        }
      }
    }
  }
  /** A reserved place whose event has not come: nothing after it runs. */
  private val held: Pair<Int, () -> Unit> = -1 to {}
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
