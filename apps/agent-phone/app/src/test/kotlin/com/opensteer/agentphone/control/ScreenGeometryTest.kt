package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.PixelSize
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Screenshot size and encoding. Failure modes:
 *
 * 1. a picture larger than 1,440 px on its long side or 1.15 MP, which a
 *    model resizes, moving every point it reads off it;
 * 2. a picture enlarged past the display;
 * 3. a point mapped back to the display off by the rounding of the scale, or
 *    a point outside the picture accepted;
 * 4. a JPEG whose base64 overruns 600,000 bytes sent, rather than stepping the
 *    quality down or giving up honestly.
 */
class ScreenGeometryTest {
    @Test
    fun fitsCommonDisplaysUnderBothBudgets() {
        val cases = mapOf(
            PixelSize(1080, 2400) to PixelSize(648, 1440),
            PixelSize(2400, 1080) to PixelSize(1440, 648),
            PixelSize(1440, 3120) to PixelSize(664, 1440),
            PixelSize(720, 1600) to PixelSize(648, 1440),
            PixelSize(1200, 1200) to PixelSize(1072, 1072),
            PixelSize(720, 1280) to PixelSize(720, 1280),
        )
        for ((display, expected) in cases) {
            val fitted = ScreenGeometry.fit(display, maxLongSide = 1_440, maxPixels = 1_150_000)
            assertEquals("fit of $display", expected, fitted)
            assertTrue(fitted.width * fitted.height <= 1_150_000)
        }
        assertEquals(PixelSize(460, 1024), ScreenGeometry.fit(PixelSize(1080, 2400), maxLongSide = 1_024, maxPixels = Int.MAX_VALUE))
    }

    @Test
    fun mapsScreenshotPointsToDisplayPixels() {
        val mapping = ScreenMapping(display = PixelSize(1080, 2400), screenshot = PixelSize(648, 1440))
        assertEquals(DisplayPoint(0, 0), mapping.toDisplay(0, 0))
        assertEquals(DisplayPoint(1079, 2399), mapping.toDisplay(647, 1439))
        assertEquals(DisplayPoint(540, 1200), mapping.toDisplay(324, 720))
        assertNull(mapping.toDisplay(648, 10))
        assertNull(mapping.toDisplay(10, 1440))
        assertEquals(com.opensteer.agentphone.wire.PixelRect(6, 12, 60, 18), mapping.toScreenshot(com.opensteer.agentphone.wire.PixelRect(10, 20, 100, 30)))
    }

    @Test
    fun stepsJpegQualityDownUntilTheBase64Fits() {
        val tried = mutableListOf<Int>()
        val bytes = JpegBudget.encode(maxBase64Length = 400) { quality ->
            tried += quality
            ByteArray(if (quality > 60) 600 else 300)
        }
        assertEquals(listOf(85, 75, 65, 55), tried)
        assertArrayEquals(ByteArray(300), bytes)
        assertNull(JpegBudget.encode(maxBase64Length = 4) { ByteArray(10) })
    }
}
