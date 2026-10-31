// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DesktopBrowserPresentationTargetSchema } from "@opensteer/protocol/desktop";
import { nativeBrowserPresented } from "./native-browser-overlays.js";

it("stops the document sampling its backdrop while a native page shows through it", () => {
  const style = document.createElement("style");
  style.textContent = ["tokens.css", "voice.css", "watch.css", "desktop.css"]
    .map((file) => readFileSync(`apps/web/src/styles/${file}`, "utf8"))
    .join("\n");
  document.head.append(style);
  // happy-dom cannot evaluate prefers-reduced-transparency; exercise the glass material,
  // which only leaf floats carry (the voice island can hold a menu, so it is opaque).
  const blur = "blur(20px)";
  document.documentElement.style.setProperty("--blur-glass", blur);
  // happy-dom caches computed style across ancestor class changes: read fresh elements.
  const backdrop = (className: string) => {
    const element = document.createElement("div");
    element.className = className;
    document.body.append(element);
    const filter = getComputedStyle(element).backdropFilter;
    element.remove();
    return filter;
  };

  try {
    expect(backdrop("computer-watch__status--over")).toBe(blur);

    nativeBrowserPresented(
      DesktopBrowserPresentationTargetSchema.parse({
        presentationId: crypto.randomUUID(),
        revision: 1,
      }),
    );
    expect(backdrop("computer-watch__status--over")).toBe("none");

    nativeBrowserPresented(null);
    expect(backdrop("computer-watch__status--over")).toBe(blur);
  } finally {
    nativeBrowserPresented(null);
    document.documentElement.style.removeProperty("--blur-glass");
    style.remove();
  }
});
