package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.AndroidPhoneWire
import com.opensteer.agentphone.wire.Ids
import com.opensteer.agentphone.wire.InstalledApp
import com.opensteer.agentphone.wire.InstalledAppsPage
import com.opensteer.agentphone.wire.InstalledAppsParams

/**
 * The phone's answer to `installed_apps`: the apps `launch` can open, so an
 * agent names a package rather than guessing one. It is the phone's
 * inventory, not its screen, so it reads no display and touches no session.
 *
 * Each package is listed once, under the label a person sees under its icon,
 * in one order whatever order Android lists them in: by label ignoring case,
 * then by package.
 */
object LaunchableApps {
    private val ORDER = compareBy<InstalledApp, String>(String.CASE_INSENSITIVE_ORDER) { it.label }.thenBy { it.packageName }

    /** Among one package's labels, ones that differ only in case are told apart by their exact text. */
    private val CHOICE = compareBy<InstalledApp, String>(String.CASE_INSENSITIVE_ORDER) { it.label }.thenBy { it.label }

    fun page(entries: List<LauncherEntry>, params: InstalledAppsParams): InstalledAppsPage {
        val matches = entries
            // Agents may not open this app, and `launch` refuses a name its schema does not allow.
            .filter { it.packageName != AndroidPhoneWire.AGENT_PHONE_PACKAGE && launchable(it.packageName) }
            .map { InstalledApp(label(it), it.packageName) }
            // A package with several launcher entries keeps the label that sorts first.
            .groupBy { it.packageName }
            .map { (_, labels) -> labels.minWith(CHOICE) }
            .filter { it.label.contains(params.query, ignoreCase = true) || it.packageName.contains(params.query, ignoreCase = true) }
            .sortedWith(ORDER)
        val apps = if (params.offset >= matches.size) {
            emptyList()
        } else {
            val start = params.offset.toInt()
            matches.subList(start, minOf(matches.size, start + params.limit))
        }
        return InstalledAppsPage(apps, matches.size)
    }

    private fun launchable(packageName: String) = packageName.length in 3..255 && Ids.androidPackage.matches(packageName)

    /** On one line, without padding, within the schema's 200 UTF-16 units and never through a character. */
    private fun label(entry: LauncherEntry): String {
        val label = collapse(entry.label).ifEmpty { entry.packageName }
        if (label.length <= AndroidPhoneWire.APP_LABEL_MAX_LENGTH) return label
        val end = if (label[AndroidPhoneWire.APP_LABEL_MAX_LENGTH - 1].isHighSurrogate()) {
            AndroidPhoneWire.APP_LABEL_MAX_LENGTH - 1
        } else {
            AndroidPhoneWire.APP_LABEL_MAX_LENGTH
        }
        return label.substring(0, end)
    }

    /** Every run of whitespace, line breaks included, as one space, and none at either end. */
    private fun collapse(text: String): String = buildString {
        var spaced = false
        for (char in text) {
            if (char.isWhitespace()) {
                spaced = isNotEmpty()
            } else {
                if (spaced) append(' ')
                spaced = false
                append(char)
            }
        }
    }
}
