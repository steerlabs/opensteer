let measureContext: CanvasRenderingContext2D | null | undefined;

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
