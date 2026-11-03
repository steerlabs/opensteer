package com.opensteer.display

/** Validate Baseline SPS allocation limits before creating a browser decoder. */
internal object H264VideoConfig {
  fun valid(bytes: ByteArray, width: Int, height: Int): Boolean = runCatching {
    require(bytes.size in 5..4_194_304)
    require(width in 2..3840 && height in 2..2160 && width * height <= 3840 * 2160)
    val units = ArrayList<ByteArray>()
    var start = -1; var i = 0
    while (i + 3 <= bytes.size) {
      val length = if (bytes[i] == 0.toByte() && bytes[i + 1] == 0.toByte() && bytes[i + 2] == 1.toByte()) 3
        else if (i + 4 <= bytes.size && bytes[i] == 0.toByte() && bytes[i + 1] == 0.toByte() && bytes[i + 2] == 0.toByte() && bytes[i + 3] == 1.toByte()) 4 else 0
      if (length == 0) { i++; continue }
      if (start >= 0 && start < i) units.add(bytes.copyOfRange(start, i))
      require(units.size <= 4096)
      start = i + length; i = start
    }
    if (start >= 0 && start < bytes.size) units.add(bytes.copyOfRange(start, bytes.size))
    require(units.any { it[0].toInt() and 31 == 8 } && units.any { it[0].toInt() and 31 == 5 })
    val sps = units.single { it[0].toInt() and 31 == 7 }
    require(sps.size in 5..4096 && sps[1].toInt() and 255 == 66)
    val rbsp = ArrayList<Int>(); var zeros = 0
    for (at in 4 until sps.size) { val value = sps[at].toInt() and 255; if (zeros >= 2 && value == 3) { zeros = 0; continue }; rbsp.add(value); zeros = if (value == 0) zeros + 1 else 0 }
    var bit = 0
    fun read(count: Int): Int { require(count in 0..24 && bit + count <= rbsp.size * 8); var value = 0; repeat(count) { value = (value shl 1) or ((rbsp[bit / 8] shr (7 - bit % 8)) and 1); bit++ }; return value }
    fun ue(): Int { var zeros = 0; while (read(1) == 0) { zeros++; require(zeros <= 16) }; return (1 shl zeros) - 1 + read(zeros) }
    require(ue() <= 31); require(ue() <= 12)
    when (ue()) { 0 -> require(ue() <= 12); 2 -> Unit; else -> error("Unsupported picture order") }
    require(ue() <= 16); read(1)
    val columns = ue() + 1; val rows = ue() + 1
    require(columns <= 240 && rows <= 135)
    require(read(1) == 1); read(1)
    var left = 0; var right = 0; var top = 0; var bottom = 0
    if (read(1) == 1) { left = ue(); right = ue(); top = ue(); bottom = ue() }
    require(columns * 16 - 2 * (left + right) == width && rows * 16 - 2 * (top + bottom) == height)
    true
  }.getOrDefault(false)
}
