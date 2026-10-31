// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DesktopBrowserPresentationTargetSchema } from "@opensteer/protocol/desktop";
import { nativeBrowserPresented } from "./native-browser-overlays.js";

it("stops the document sampling its backdrop while a native page shows through it", () => {
  const style = document.createElement("style");
  style.textContent = ["voice.css", "watch.css", "desktop.css"]
    .map((file) => readFileSync(`apps/web/src/styles/${file}`, "utf8"))
    .join("\n");
  document.head.append(style);
  // happy-dom caches computed style across ancestor class changes: read fresh elements.
  const backdrop = (className: string) => {
    const element = document.createElement("div");
    element.className = className;
    document.body.append(element);
    return getComputedStyle(element).backdropFilter;
  };

  nativeBrowserPresented(
    DesktopBrowserPresentationTargetSchema.parse({
      presentationId: crypto.randomUUID(),
      revision: 1,
    }),
  );
  expect(backdrop("voice-island")).toBe("none");
  expect(backdrop("watch-theater")).toBe("none");

  nativeBrowserPresented(null);
  expect(backdrop("voice-island")).toContain("blur");
});
