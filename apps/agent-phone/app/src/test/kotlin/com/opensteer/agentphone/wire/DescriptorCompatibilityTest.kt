package com.opensteer.agentphone.wire

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** The signed descriptor evolves under Host-first upgrades; old Hosts need not accept new phone descriptors. */
class DescriptorCompatibilityTest {
    @Test fun liveDisplayDocumentsHostFirstUpgradeOrder() {
        val docs = File(System.getProperty("opensteer.repositoryRoot"), "docs/agent-phone.md").readText()
        assertTrue(docs.contains("Upgrade the Host before its phones"))
    }
}
