// @vitest-environment happy-dom
import type { DesktopBrowserPresentationEvent } from "@opensteer/protocol/desktop";
import { afterEach, expect, it } from "vitest";
import { interactionRevision, observeInteraction } from "./interaction.js";

afterEach(() => {
  Reflect.deleteProperty(window, "opensteerDesktop");
});

it("counts the person's input into the desktop app's native page, which no DOM listener sees", () => {
  let deliver: ((event: DesktopBrowserPresentationEvent) => void) | null = null;
  Object.defineProperty(window, "opensteerDesktop", {
    configurable: true,
    value: {
      browserPresentation: {
        onEvent(listener: (event: DesktopBrowserPresentationEvent) => void) {
          deliver = listener;
          return () => {
            deliver = null;
          };
        },
      },
      onLocalVisibilityChanged: () => () => undefined,
      getLocalVisibility: () => new Promise<boolean>(() => undefined),
    },
  });
  const stop = observeInteraction();
  const before = interactionRevision();
  deliver!({ type: "window-focus", focused: false });
  expect(interactionRevision()).toBe(before);
  deliver!({ type: "page-input" });
  expect(interactionRevision()).toBe(before + 1);
  stop();
  expect(deliver).toBeNull();
});
