package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.AuxiliaryFence
import com.opensteer.agentphone.wire.JsonObject

/** One open `integrations` stream, as the module sees it: its fence, and a way to send on it. */
interface ModuleStream {
    val fence: AuxiliaryFence

    /** False when the frame did not leave: the stream is closed, or its lease ran out. */
    fun send(frame: JsonObject): Boolean
}

/**
 * The stream everything on this phone answers on, while there is one.
 *
 * Every frame is built when it is sent, from the attached stream's own fence,
 * so nothing is ever stamped for a stream other than the one it goes out on.
 * Work begun for an earlier stream never reaches here: detaching the module
 * forgets every request that stream carried.
 */
class StreamOutbox {
    private var current: ModuleStream? = null

    val attached: ModuleStream? get() = current

    fun attach(stream: ModuleStream) {
        current = stream
    }

    fun detach() {
        current = null
    }

    fun send(build: (AuxiliaryFence) -> JsonObject): Boolean {
        val stream = current ?: return false
        return stream.send(build(stream.fence))
    }
}
