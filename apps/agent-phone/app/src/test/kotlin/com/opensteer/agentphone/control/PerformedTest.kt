package com.opensteer.agentphone.control

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What one completed action did, in the Mac's words. Failure modes: a
 * password echoed, a line over 160 UTF-16 code units, a cut that splits an
 * emoji, a typed line break that breaks the line.
 */
class PerformedTest {
    @Test
    fun describesActionsInThePastTense() {
        assertEquals("Tapped \"Send\"", Performed.tap(ElementName("Send", "button"), null, 1))
        assertEquals("Double-tapped at (10, 20)", Performed.tap(null, ScreenshotPoint(10, 20), 2))
        assertEquals("Typed \"hi↵there\" into \"Message\"", Performed.typed("hi\nthere", ElementName("Message", "edittext"), secure = false))
        assertEquals("Typed 8 characters into \"Password\"", Performed.typed("hunter22", ElementName("Password", "edittext"), secure = true))
        assertEquals("Pressed Back", Performed.navigate(com.opensteer.agentphone.wire.Navigation.BACK))
        assertEquals("Waited 1.5 s", Performed.waited(1_500))
    }

    @Test
    fun staysWithinOneHundredSixtyCodeUnitsWithoutSplittingAnEmoji() {
        val line = Performed.typed("😀".repeat(100), ElementName("x".repeat(200), "edittext"), secure = false)
        assertTrue(line.length <= 160)
        assertEquals("Typed \"" + "😀".repeat(19) + "…\" into \"" + "x".repeat(39) + "…\"", line)
    }
}
