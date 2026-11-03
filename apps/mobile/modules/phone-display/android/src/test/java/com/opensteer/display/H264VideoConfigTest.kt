package com.opensteer.display

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class H264VideoConfigTest {
  @Test fun validatesRealKeyAndRefusesMalformedOrOversizeGeometry() {
    val root = generateSequence(File(".").canonicalFile) { it.parentFile }.first { File(it,"pnpm-workspace.yaml").isFile }
    val key = File(root,"apps/mobile/modules/phone-display/tests/native/fixtures/lime-key-128x128.h264").readBytes()
    assertTrue(H264VideoConfig.valid(key,128,128))
    assertFalse(H264VideoConfig.valid(key,3840,2160))
    assertFalse(H264VideoConfig.valid(key,Int.MAX_VALUE,Int.MAX_VALUE))
    for(size in 0..24)assertFalse(H264VideoConfig.valid(key.copyOf(size),128,128))
    assertFalse(H264VideoConfig.valid(byteArrayOf(0,0,0,1,0x67,66,0,31,0,0,0),128,128))
  }
}
