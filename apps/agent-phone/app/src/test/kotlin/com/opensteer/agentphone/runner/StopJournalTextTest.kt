package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.WireException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * How the phone writes its owner's unrecorded Stops to disk. Failure modes:
 *
 * 1. a Stop, its Run or the order pressed lost between writing and reading;
 * 2. another identity's Stops, left from before a re-pairing, read as this
 *    one's: replayed to the wrong Host, or refusing that Host's Runs;
 * 3. something unreadable on disk read as Stops, rather than refused, so the
 *    caller can say so and start over — including a value stored as another
 *    type, which Android hands back as that type.
 */
class StopJournalTextTest {
    private val runner = "rnr_33333333-3333-4333-8333-333333333333"
    private val stops = listOf(
        PendingStop("cus_44444444-4444-4444-8444-444444444444", "run_55555555-5555-4555-8555-555555555555"),
        PendingStop("cus_66666666-6666-4666-8666-666666666666", "run_77777777-7777-4777-8777-777777777777"),
    )

    @Test
    fun keepsEveryStopAndItsOrder() {
        assertEquals(stops, StopJournalText.decode(runner, StopJournalText.encode(runner, stops)))
    }

    @Test
    fun anotherIdentitysStopsAreNotThisOnes() {
        val other = "rnr_88888888-8888-4888-8888-888888888888"
        assertEquals(emptyList<PendingStop>(), StopJournalText.decode(other, StopJournalText.encode(runner, stops)))
    }

    @Test
    fun refusesWhatItCannotRead() {
        for (text in listOf(
            "not json",
            """{"runnerId":"$runner"}""",
            """{"runnerId":"$runner","stops":[{"runId":"run_55555555-5555-4555-8555-555555555555"}]}""",
            """{"runnerId":"$runner","stops":[{"runId":"nope","sessionId":"cus_44444444-4444-4444-8444-444444444444"}]}""",
            """{"runnerId":"$runner","stops":[],"extra":true}""",
        )) {
            assertThrows(text, WireException::class.java) { StopJournalText.decode(runner, text) }
        }
        for (stored in listOf<Any>(1, true, 1.5f, 7L, setOf("x"))) {
            assertThrows("$stored", WireException::class.java) { StopJournalText.decode(runner, stored) }
        }
        assertEquals(emptyList<PendingStop>(), StopJournalText.decode(runner, null))
    }
}
