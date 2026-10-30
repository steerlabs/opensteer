// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import * as dictation from "@opensteer/client/dictation";
import { Composer } from "../components/composer.js";
import { DictationContext } from "../components/dictation.js";
import { installDictation } from "./dictation-runtime.js";

it("does no dictation work without a bridge port", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const windowListener = vi.spyOn(window, "addEventListener");
  const documentListener = vi.spyOn(document, "addEventListener");
  const construct = vi.spyOn(dictation, "DictationController");
  const controller = installDictation(undefined);
  expect(controller).toBeNull();
  expect(windowListener).not.toHaveBeenCalled();
  expect(documentListener).not.toHaveBeenCalled();
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    act(() =>
      root.render(
        <DictationContext value={controller}>
          <Composer onSend={async () => {}} placeholder="Reply" />
        </DictationContext>,
      ),
    );
    expect(construct).not.toHaveBeenCalled();
    expect(node.querySelector('[title="Dictate"]')).toBeNull();
    expect(node.querySelector('[aria-live="polite"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.restoreAllMocks();
  }
});
