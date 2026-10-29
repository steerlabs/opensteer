package com.opensteer.agentphone.control

import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/** Serializes agent observation screenshots across Android's accessibility screenshot interval. */
class ScreenshotTurns {
    private val turn = ReentrantLock()

    /** Runs `take` for an agent once the turn is free, waiting at most `waitMs`; null if it never came. */
    fun <T> forAgent(waitMs: Long, take: () -> T): T? {
        val held = turn.tryLock(waitMs.coerceAtLeast(0), TimeUnit.MILLISECONDS)
        if (!held) return null
        try {
            return take()
        } finally {
            turn.unlock()
        }
    }

}
