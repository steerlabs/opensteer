// Adapted from T3 Code's T3ContextChip.kt and ComposerChipSpan
// (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
package com.opensteer.composereditor

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.ReplacementSpan
import androidx.core.graphics.PathParser
import kotlin.math.ceil
import kotlin.math.min

/** The colours a chip is drawn in, from the app's theme. */
data class ChipColors(
  val text: Int,
  val glyph: Int,
  val fill: Int,
  val rim: Int,
  val edge: Int,
  val selectedRim: Int,
)

/**
 * The transcript's surface chip at text size, drawn over a reference's Markdown
 * source: plate fill, rim, glyph and one line of title. The source stays the text.
 */
class ComposerChipSpan(
  label: String,
  /** The glyph as one 24×24 SVG stroke path, the art the transcript's chip draws. */
  art: String,
  textSize: Float,
  lineHeight: Float,
  maximumWidth: Float,
  private val density: Float,
  private val colors: ChipColors,
  private val isSelected: (start: Int, end: Int) -> Boolean,
) : ReplacementSpan() {
  private val labelPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    this.textSize = textSize * 0.92f
    typeface = Typeface.DEFAULT
    color = colors.text
  }
  private val glyphPath = glyphPath(art)
  private val glyphPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = 1.8f
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
    color = colors.glyph
  }
  private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = colors.fill }
  private val rimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val em = labelPaint.textSize
  private val height = min(ceil(em * 1.45f), lineHeight)
  private val left = em * 0.32f
  private val gap = em * 0.3f
  private val right = em * 0.5f
  private val glyphSlot = em
  val width: Int
  private val title: String

  init {
    val cap = min(em * 24, maximumWidth.coerceAtLeast(em * 4))
    val room = (cap - left - glyphSlot - gap - right).coerceAtLeast(0f)
    title = TextUtils.ellipsize(label, labelPaint, room, TextUtils.TruncateAt.END).toString()
    width = ceil(left + glyphSlot + gap + labelPaint.measureText(title) + right).toInt()
  }

  override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
    fm?.let {
      val base = paint.fontMetricsInt
      it.top = base.top
      it.ascent = base.ascent
      it.descent = base.descent
      it.bottom = base.bottom
    }
    return width
  }

  override fun draw(
    canvas: Canvas,
    text: CharSequence,
    start: Int,
    end: Int,
    x: Float,
    top: Int,
    y: Int,
    bottom: Int,
    paint: Paint,
  ) {
    val metrics = paint.fontMetrics
    // Centred on the line's text, so the chip sits on the baseline without growing the line.
    val chipTop = y + (metrics.ascent + metrics.descent - height) / 2
    val selected = isSelected(start, end)
    val stroke = if (selected) 1.5f * density else density
    val half = stroke / 2
    val plate = RectF(x + half, chipTop + half, x + width - half, chipTop + height - half)
    val radius = plate.height() / 2
    canvas.drawRoundRect(plate, radius, radius, fillPaint)
    canvas.save()
    canvas.clipRect(plate.left, plate.top, plate.right, plate.top + density)
    rimPaint.color = colors.edge
    rimPaint.strokeWidth = density
    canvas.drawRoundRect(RectF(plate.left, plate.top + density, plate.right, plate.bottom), radius, radius, rimPaint)
    canvas.restore()
    rimPaint.color = if (selected) colors.selectedRim else colors.rim
    rimPaint.strokeWidth = stroke
    canvas.drawRoundRect(plate, radius, radius, rimPaint)
    glyphPath?.let { path ->
      // The art's 24-unit box at 0.9 of the label's size, centred in the glyph's slot.
      val side = em * 0.9f
      canvas.save()
      canvas.translate(x + left + (glyphSlot - side) / 2, chipTop + (height - side) / 2)
      canvas.scale(side / 24f, side / 24f)
      canvas.drawPath(path, glyphPaint)
      canvas.restore()
    }
    val labelMetrics = labelPaint.fontMetrics
    canvas.drawText(
      title,
      x + left + glyphSlot + gap,
      chipTop + height / 2 - (labelMetrics.ascent + labelMetrics.descent) / 2,
      labelPaint,
    )
  }
}

private val glyphPaths = HashMap<String, Path?>()

/** Parsed once per path: chips are re-spanned as the person types. */
private fun glyphPath(art: String): Path? =
  if (art.isEmpty()) null else glyphPaths.getOrPut(art) { runCatching { PathParser.createPathFromPathData(art) }.getOrNull() }
