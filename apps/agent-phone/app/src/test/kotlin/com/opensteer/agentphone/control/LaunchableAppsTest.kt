package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.AndroidPhoneWire
import com.opensteer.agentphone.wire.InstalledApp
import com.opensteer.agentphone.wire.InstalledAppsParams
import com.opensteer.agentphone.wire.MAX_SAFE_INTEGER
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's answer to `installed_apps`, from the launcher entries Android
 * lists. Failure modes, each an agent that cannot `launch` what it was shown
 * or is shown the same thing differently each time:
 *
 * 1. this app listed, which agents may not open;
 * 2. a package with several launcher entries listed twice, or given whichever
 *    label Android happened to list first;
 * 3. a label that is blank, padded, broken over lines, longer than 200 UTF-16
 *    units or cut through a surrogate pair — or a real label replaced by the
 *    package name;
 * 4. a package name the `launch` action's schema would refuse;
 * 5. a query matched case-sensitively, or against the label only;
 * 6. sorting that is case-sensitive or unstable between equal labels;
 * 7. `total` counting the page rather than every match, or an offset past the
 *    end — up to the largest safe integer — failing instead of answering empty.
 */
class LaunchableAppsTest {
    private val mail = LauncherEntry("com.example.mail", "Mail")
    private val maps = LauncherEntry("com.google.android.apps.maps", "  Google\n  Maps ")
    private val settings = LauncherEntry("com.android.settings", "Settings")

    private fun page(entries: List<LauncherEntry>, query: String = "", limit: Int = 50, offset: Long = 0) =
        LaunchableApps.page(entries, InstalledAppsParams(query, limit, offset))

    @Test
    fun listsEachLaunchablePackageOnceButNeverThisApp() {
        val listed = page(
            listOf(
                settings,
                LauncherEntry(AndroidPhoneWire.AGENT_PHONE_PACKAGE, "Opensteer Agent Phone"),
                mail,
                LauncherEntry("com.example.mail", "Mail Compose"),
                LauncherEntry("android", "System"),
                LauncherEntry("1bad.package", "Bad"),
            ),
        )
        assertEquals(listOf(InstalledApp("Mail", "com.example.mail"), InstalledApp("Settings", "com.android.settings")), listed.apps)
        assertEquals(2, listed.total)
    }

    @Test
    fun choosesTheSameLabelWhateverOrderAndroidListsEntriesIn() {
        val entries = listOf(LauncherEntry("com.example.mail", "Mail Compose"), mail, settings)
        assertEquals(page(entries), page(entries.reversed()))
        assertEquals("Mail", page(entries).apps.first().label)
    }

    @Test
    fun normalizesLabelsAndFallsBackToThePackageOnlyWhenBlank() {
        val blank = LauncherEntry("com.example.blank", " \t\n ")
        val long = LauncherEntry("com.example.long", "a" + "😀".repeat(150))
        val apps = page(listOf(maps, blank, long)).apps.associate { it.packageName to it.label }
        assertEquals("Google Maps", apps.getValue(maps.packageName))
        assertEquals("com.example.blank", apps.getValue(blank.packageName))
        val cut = apps.getValue(long.packageName)
        assertEquals("a" + "😀".repeat(99), cut)
        assertTrue(cut.length <= 200 && !cut.last().isHighSurrogate())
    }

    @Test
    fun matchesTheQueryCaseInsensitivelyByLabelOrPackage() {
        val entries = listOf(mail, maps, settings)
        assertEquals(listOf("com.example.mail"), page(entries, query = "MAIL").apps.map { it.packageName })
        assertEquals(listOf("com.android.settings"), page(entries, query = "android.SET").apps.map { it.packageName })
        assertEquals(listOf("com.google.android.apps.maps"), page(entries, query = "google maps").apps.map { it.packageName })
        assertEquals(0, page(entries, query = "calendar").total)
    }

    @Test
    fun sortsByLabelIgnoringCaseThenByPackage() {
        val entries = listOf(
            LauncherEntry("com.example.b", "beta"),
            LauncherEntry("com.example.z", "Alpha"),
            LauncherEntry("com.example.a", "alpha"),
        )
        assertEquals(listOf("com.example.a", "com.example.z", "com.example.b"), page(entries).apps.map { it.packageName })
    }

    @Test
    fun countsEveryMatchAndPagesAfterwards() {
        val entries = (1..120).map { LauncherEntry("com.example.app$it", "App %03d".format(it)) }
        val second = page(entries, limit = 50, offset = 50)
        assertEquals(120, second.total)
        assertEquals("App 051", second.apps.first().label)
        assertEquals(50, second.apps.size)
        assertEquals(20, page(entries, limit = 50, offset = 100).apps.size)
        assertEquals(emptyList<InstalledApp>(), page(entries, offset = 120).apps)
        val farAway = page(entries, offset = MAX_SAFE_INTEGER)
        assertEquals(emptyList<InstalledApp>(), farAway.apps)
        assertEquals(120, farAway.total)
    }
}
