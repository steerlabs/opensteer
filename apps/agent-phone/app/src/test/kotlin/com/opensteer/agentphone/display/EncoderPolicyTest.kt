package com.opensteer.agentphone.display

import org.junit.Assert.*
import org.junit.Test

/** Failures: retry keeps rejected profile, hardware-only selection, High/Main or reordered SPS published. */
class EncoderPolicyTest {
    @Test fun configurationFallsBackThroughBaselineAndDefaultWithoutOptionalKeys() {
        val attempts = ArrayList<Pair<Int?, Boolean>>()
        val selected = EncoderPolicy.configure { profile, optional ->
            attempts += profile to optional
            if (profile != null) throw IllegalArgumentException("unsupported")
        }
        assertNull(selected.first)
        assertEquals(listOf(65536 to true, 65536 to false, 1 to false, null to false), attempts)
    }
    @Test fun acceptsOnlyBaselineSpsAndMonotonicOutput() {
        assertEquals("avc1.42C01F", EncoderPolicy.codec(byteArrayOf(0,0,0,1,0x67,0x42,0xC0.toByte(),0x1F)))
        assertEquals("avc1.42001F", EncoderPolicy.codec(byteArrayOf(0,0,1,0x67,0x42,0,0x1F)))
        assertThrows(IllegalArgumentException::class.java) { EncoderPolicy.codec(byteArrayOf(0,0,1,0x67,0x64,0,0x1F)) }
        assertTrue(EncoderPolicy.ordered(100, 101))
        assertFalse(EncoderPolicy.ordered(100, 99))
    }
}
