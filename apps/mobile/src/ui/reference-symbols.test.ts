import { expect, it } from "vitest";
import { referenceSymbols } from "./reference-symbols.js";
import { symbolArt } from "./symbol-art.js";

// Android has no SF Symbols: a reference icon without stroke art falls back to a character.
it("draws every reference icon in strokes where there are no SF Symbols", () => {
  const missing = Object.entries(referenceSymbols).filter(([, name]) => !symbolArt[name]);
  expect(missing).toEqual([]);
});
