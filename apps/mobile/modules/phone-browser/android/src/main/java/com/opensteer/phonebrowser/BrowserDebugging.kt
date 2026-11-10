package com.opensteer.phonebrowser

import android.content.Context
import android.content.pm.ApplicationInfo
import android.webkit.WebView

internal object BrowserDebugging {
  var release = true
    private set
  fun configure(context: Context) { release = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0 }
  fun set(enabled: Boolean) { if (enabled || release) WebView.setWebContentsDebuggingEnabled(enabled) }
}
