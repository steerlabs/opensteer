package com.opensteer.remotetextinput

/**
 * What a touch on the hidden typing field does. Its text and cursor are invisible, so a touch
 * focuses it and does nothing else: TextView's own touch handling, which selects a word on a
 * double tap or a long press, never sees it. A long press offers Paste, the one thing the edit
 * menu is for here. The person moves the caret on the page, or with the keyboard.
 */
internal class RemoteInputTouch(private val longPressMs: Long, private val slop: Float) {
  enum class Action { DOWN, MOVE, UP, CANCEL }
  enum class Outcome { FOCUS, OFFER_PASTE }

  private var downAt = -1L
  private var downX = 0f
  private var downY = 0f
  /** The press is still a candidate for a tap or a long press. */
  private var pressing = false

  fun onTouch(action: Action, timeMs: Long, x: Float, y: Float): Outcome? {
    when (action) {
      Action.DOWN -> { downAt = timeMs; downX = x; downY = y; pressing = true }
      Action.MOVE -> if (pressing && (Math.abs(x - downX) > slop || Math.abs(y - downY) > slop)) pressing = false
      Action.UP -> {
        val tap = pressing && timeMs - downAt < longPressMs
        pressing = false
        return if (tap) Outcome.FOCUS else null
      }
      Action.CANCEL -> pressing = false
    }
    return null
  }

  /** The long-press timer fired: Paste is offered if the press is still where it began. */
  fun longPress(timeMs: Long): Outcome? {
    if (!pressing || timeMs - downAt < longPressMs) return null
    pressing = false
    return Outcome.OFFER_PASTE
  }
}
