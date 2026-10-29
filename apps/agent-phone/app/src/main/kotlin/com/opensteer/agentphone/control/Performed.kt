package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.AndroidPhoneWire
import com.opensteer.agentphone.wire.Navigation
import com.opensteer.agentphone.wire.ScrollDirection

/** How a person names an element: its label, else what it is. */
data class ElementName(val label: String?, val role: String)

/**
 * What one completed action did, in the words the Mac uses
 * (`ActionDescription.swift`): a past-tense verb and the element as the person
 * sees it. Typed text is never repeated for a password field, only counted.
 * Every line is at most 160 UTF-16 code units and never splits a character.
 */
object Performed {
    private const val QUOTED_LIMIT = 40

    fun tap(element: ElementName?, point: ScreenshotPoint?, count: Int): String =
        finish("${if (count == 2) "Double-tapped" else "Tapped"} ${where(element, point)}")

    fun longPressed(element: ElementName?, point: ScreenshotPoint?): String = finish("Long-pressed ${where(element, point)}")

    fun swiped(from: ScreenshotPoint, to: ScreenshotPoint): String =
        finish("Swiped from (${from.x}, ${from.y}) to (${to.x}, ${to.y})")

    fun dragged(element: ElementName?, from: ScreenshotPoint, to: ScreenshotPoint): String =
        finish("Dragged ${where(element, from)} to (${to.x}, ${to.y})")

    fun typed(text: String, field: ElementName?, secure: Boolean, submitted: Boolean = false): String {
        val into = field?.let { " into ${name(it)}" } ?: ""
        val what = if (secure) characters(text.codePointCount(0, text.length)) else quoted(text)
        return finish("Typed $what$into${if (submitted) " and submitted" else ""}")
    }

    fun cleared(field: ElementName): String = finish("Cleared ${name(field)}")

    fun navigate(to: Navigation): String = when (to) {
        Navigation.BACK -> "Pressed Back"
        Navigation.HOME -> "Pressed Home"
        Navigation.RECENTS -> "Opened Recents"
        Navigation.NOTIFICATIONS -> "Opened notifications"
        Navigation.QUICK_SETTINGS -> "Opened Quick Settings"
    }

    fun launched(packageName: String): String = finish("Opened $packageName")

    fun scrolled(direction: ScrollDirection, element: ElementName?, amount: Int): String {
        val place = element?.let { " in ${name(it)}" } ?: ""
        val times = if (amount > 1) " ${amount}×" else ""
        return finish("Scrolled ${direction.wire}$times$place")
    }

    fun woke(): String = "Turned the screen on"

    fun waited(milliseconds: Int): String {
        var number = String.format(java.util.Locale.ROOT, "%.2f", milliseconds / 1_000.0)
        number = number.trimEnd('0').trimEnd('.')
        return "Waited $number s"
    }

    private fun where(element: ElementName?, point: ScreenshotPoint?): String = when {
        element != null -> name(element)
        point != null -> "at (${point.x}, ${point.y})"
        else -> "the screen"
    }

    private fun name(element: ElementName): String =
        element.label?.let(::clean)?.takeIf { it.isNotEmpty() }?.let(::quoted) ?: "the ${element.role}"

    private fun quoted(text: String): String {
        val visible = text.replace("\r\n", "↵").replace('\n', '↵').replace('\r', '↵').replace('\t', '⇥')
        return "\"${clip(visible, QUOTED_LIMIT)}\""
    }

    private fun characters(count: Int) = if (count == 1) "1 character" else "$count characters"

    private fun clean(text: String) = text.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")

    /** Cuts to at most `limit` UTF-16 code units, ellipsis included, between characters. */
    private fun clip(text: String, limit: Int): String {
        if (text.length <= limit) return text
        val budget = limit - 1
        var end = 0
        while (end < text.length) {
            val next = text.offsetByCodePoints(end, 1)
            if (next > budget) break
            end = next
        }
        return text.substring(0, end) + "…"
    }

    private fun finish(text: String): String =
        clip(text.map { if (it == '\n' || it == '\r' || it == '\t') ' ' else it }.joinToString(""), AndroidPhoneWire.PERFORMED_MAX_LENGTH)
}
