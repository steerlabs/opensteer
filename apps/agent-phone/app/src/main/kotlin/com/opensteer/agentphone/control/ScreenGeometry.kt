package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.PixelRect
import com.opensteer.agentphone.wire.PixelSize
import java.util.Base64

/**
 * The size a picture of the display is sent at. It is the largest that keeps
 * within both budgets — the long side and the pixel count every current
 * vision model reads without resizing, which would move every point it
 * reads off the picture — and never larger than the display.
 */
object ScreenGeometry {
    fun fit(display: PixelSize, maxLongSide: Int, maxPixels: Int): PixelSize {
        val long = maxOf(display.width, display.height)
        var size = if (long > maxLongSide) {
            // Integer arithmetic, so the long side lands on the budget exactly.
            if (display.width >= display.height) {
                PixelSize(maxLongSide, maxOf(1, (display.height.toLong() * maxLongSide / display.width).toInt()))
            } else {
                PixelSize(maxOf(1, (display.width.toLong() * maxLongSide / display.height).toInt()), maxLongSide)
            }
        } else {
            display
        }
        val pixels = size.width.toLong() * size.height
        if (pixels > maxPixels) {
            val scale = Math.sqrt(maxPixels.toDouble() / pixels)
            size = PixelSize(maxOf(1, (size.width * scale).toInt()), maxOf(1, (size.height * scale).toInt()))
            while (size.width.toLong() * size.height > maxPixels) {
                size = if (size.width >= size.height) size.copy(width = size.width - 1) else size.copy(height = size.height - 1)
            }
        }
        return size
    }
}

/** The exact mapping between one observation's screenshot pixels and the display's pixels. */
data class ScreenMapping(val display: PixelSize, val screenshot: PixelSize) {
    /** The display pixel under the centre of a screenshot pixel, or null outside the screenshot. */
    fun toDisplay(x: Int, y: Int): DisplayPoint? {
        if (x !in 0 until screenshot.width || y !in 0 until screenshot.height) return null
        return DisplayPoint(
            ((2L * x + 1) * display.width / (2L * screenshot.width)).toInt(),
            ((2L * y + 1) * display.height / (2L * screenshot.height)).toInt(),
        )
    }

    fun toScreenshot(rect: PixelRect): PixelRect = PixelRect(
        scale(rect.left, screenshot.width, display.width),
        scale(rect.top, screenshot.height, display.height),
        scale(rect.right, screenshot.width, display.width),
        scale(rect.bottom, screenshot.height, display.height),
    )

    private fun scale(value: Int, to: Int, from: Int) = ((value.toLong() * to + from / 2) / from).toInt()
}

/** JPEG encoding inside a base64 budget, stepping quality down rather than sending too much. */
object JpegBudget {
    private val QUALITIES = listOf(85, 75, 65, 55, 45, 35)

    /** The first encoding that fits, or null when even the lowest quality does not. */
    fun encode(maxBase64Length: Int, encode: (quality: Int) -> ByteArray): ByteArray? {
        for (quality in QUALITIES) {
            val bytes = encode(quality)
            if (base64Length(bytes.size) <= maxBase64Length) return bytes
        }
        return null
    }

    fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    private fun base64Length(size: Int) = 4 * ((size + 2) / 3)
}
