package com.opensteer.phonebrowser

import android.content.Context
import android.widget.Button
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

class PhoneBrowserDownload(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var downloadId = ""
  private val share = Button(context).apply {
    text = "Share download"
    setOnClickListener { try { PhoneBrowserNative.shareDownload?.invoke(downloadId) } catch (_: BrowserFailure) { } }
  }
  override val shouldUseAndroidLayout = true
  init { addView(share) }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    share.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    share.layout(0, 0, width, height)
  }
}
