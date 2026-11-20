// @vitest-environment happy-dom

import { MockHostClient } from "@opensteer/client/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { transcriptImageRead, useImageActions, type ImageRead } from "./image-actions.js";
import { ToastProvider } from "./toast.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function Shown({ read }: { readonly read: ImageRead }) {
  const actions = useImageActions(read);
  return (
    <>
      <button type="button" {...actions.target}>
        Screenshot
      </button>
      {actions.menu}
    </>
  );
}

function render(read: ImageRead) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ToastProvider>
        <Shown read={read} />
      </ToastProvider>,
    ),
  );
  const image = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Screenshot",
  )!;
  act(() => {
    image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  return [...document.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];
}

it("copies the original as PNG within the click, reading it only once asked", async () => {
  const original = new File([new Uint8Array([137, 80, 78, 71])], "plot.png", {
    type: "image/png",
  });
  const read = vi.fn(async () => original);
  const written: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(items: Record<string, unknown>) {
        written.push(items);
      }
    },
  );
  const write = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { write } });

  const items = render(read);
  expect(items.map((item) => item.textContent)).toEqual(["Copy image", "Download"]);
  expect(read).not.toHaveBeenCalled();

  act(() => items[0]!.click());
  // The write starts in the gesture with the bytes still on their way.
  expect(write).toHaveBeenCalledTimes(1);
  expect(written[0]!["image/png"]).toBeInstanceOf(Promise);
  await expect(written[0]!["image/png"]).resolves.toBe(original);
  expect(read).toHaveBeenCalledTimes(1);
});

it("offers only Download where the page has no clipboard for images", () => {
  vi.stubGlobal("ClipboardItem", undefined);
  expect(render(async () => new File([], "plot.png")).map((item) => item.textContent)).toEqual([
    "Download",
  ]);
});

it("tells the person to update the Device when the image original cannot be read", async () => {
  vi.stubGlobal("ClipboardItem", undefined);
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    vi.spyOn(client.transcriptFiles, "original").mockResolvedValue({ status: "update-required" });
    const items = render(transcriptImageRead(client, null, { kind: "path", path: "plot.png" }));
    await act(async () => items[0]!.click());
    expect(document.body.textContent).toContain(
      "Update Opensteer on the device that holds this file.",
    );
  } finally {
    client.dispose();
  }
});
