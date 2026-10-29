package com.opensteer.agentphone.control

import org.junit.Assert.*
import org.junit.Test

/** Failures: bullets written back, Unicode split, shadow crossing nodes/leases, unknown secrets overwritten. */
class OwnerPasswordTest {
    @Test fun editsUseOnlyOwnerShadowAndRespectSelection() {
        val shadow = OwnerPassword()
        assertEquals(TextInsertion("a", 1), shadow.edit("node", 0, -1, -1, "a", 0))
        assertEquals(TextInsertion("a🙂", 3), shadow.edit("node", 1, 1, 1, "🙂", 0))
        assertEquals(TextInsertion("a", 1), shadow.edit("node", 3, 3, 3, null, 1))
        assertEquals(TextInsertion("b", 1), shadow.edit("node", 1, 0, 1, "b", 0))
    }
    @Test fun refusesUnknownOrChangedFieldAndForgetsLease() {
        val shadow = OwnerPassword()
        assertNull(shadow.edit("unknown", 4, 4, 4, "x", 0))
        assertNotNull(shadow.edit("one", 0, 0, 0, "a", 0))
        assertNull(shadow.edit("two", 1, 1, 1, "b", 0))
        assertNull(shadow.edit("one", 2, 2, 2, "b", 0))
        shadow.clear()
        assertNull(shadow.edit("one", 1, 1, 1, "b", 0))
    }
}
