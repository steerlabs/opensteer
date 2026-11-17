let measureContext: CanvasRenderingContext2D | null | undefined;

/**
 * The font an element draws in, as a canvas reads it. Not `style.font`: that
 * shorthand reads empty when a longhand it cannot express is set, as
 * ProseMirror's `font-variant-ligatures: none` is on every composer field.
 */
export function canvasFont(
  style: Pick<CSSStyleDeclaration, "fontStyle" | "fontWeight" | "fontSize" | "fontFamily">,
): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

/** How wide `text` runs in a CSS `font`; null where nothing can measure it. */
export function textWidth(font: string, text: string): number | null {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return null;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}
