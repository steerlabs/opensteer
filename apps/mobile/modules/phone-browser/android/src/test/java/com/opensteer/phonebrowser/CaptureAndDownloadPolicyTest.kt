package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test

class CaptureAndDownloadPolicyTest {
  @Test fun densityUsesCssGeometryInsteadOfMultiplyingThePhonesPixelRatioAgain() {
    assertEquals(300 to 600,CaptureRaster.size(1080.0,2160.0,400.0,800.0,0.75,true))
    assertEquals(1080 to 2160,CaptureRaster.size(1080.0,2160.0,400.0,800.0,1.0,false))
    assertThrows(BrowserFailure::class.java) { CaptureRaster.size(1080.0,2160.0,7680.0,4320.0,2.0,true) }
  }
  @Test fun downloadRefetchesCannotAddProfileCookiesToAnotherOrigin() {
    assertTrue(DownloadCookies.maySend("https://bank.example/page","https://bank.example/file"))
    assertTrue(DownloadCookies.maySend("https://bank.example:443/page","https://bank.example/file"))
    assertFalse(DownloadCookies.maySend("https://other.example/page","https://bank.example/file"))
    assertFalse(DownloadCookies.maySend("http://bank.example/page","https://bank.example/file"))
    assertFalse(DownloadCookies.maySend("https://bank.example:444/page","https://bank.example/file"))
    assertFalse(DownloadCookies.maySend("about:blank","https://bank.example/file"))
  }
}
