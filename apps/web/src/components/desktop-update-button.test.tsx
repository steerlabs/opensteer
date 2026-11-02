// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DesktopUpdateState, DesktopUpdatesBridge } from "@opensteer/protocol/desktop";
import { DesktopUpdateButton, DesktopUpdateFeedback } from "./desktop-update-button.js";
import { ToastProvider } from "./toast.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("offers the download, its progress and the restart, and confirms a download finished while hidden", async () => {
  const state = (change: Partial<DesktopUpdateState>): DesktopUpdateState => ({
    status: "idle",
    currentVersion: "0.1.396",
    availableVersion: "0.1.397",
    downloadPercent: null,
    failed: null,
    ...change,
  });
  let push!: (value: DesktopUpdateState) => void;
  const bridge = {
    get: vi.fn(async () => state({ availableVersion: null })),
    onChanged: (listener) => {
      push = listener;
      return () => undefined;
    },
    download: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
  } satisfies DesktopUpdatesBridge;
  Object.assign(window, { opensteerDesktop: { updates: bridge } });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (sidebar: boolean) =>
    act(async () =>
      root.render(
        <ToastProvider>
          <DesktopUpdateFeedback />
          {sidebar ? <DesktopUpdateButton /> : null}
        </ToastProvider>,
      ),
    );
  await render(true);
  expect(bridge.get).toHaveBeenCalledOnce();
  expect(container.querySelector("button")).toBeNull();
  const button = () => container.querySelector<HTMLButtonElement>(".sidebar__update")!;
  const show = (change: Partial<DesktopUpdateState>) => act(() => push(state(change)));

  show({ status: "available" });
  expect(button().textContent).toBe("Update available");
  expect(button().title).toBe("Download version 0.1.397");
  act(() => button().click());
  expect(bridge.download).toHaveBeenCalledOnce();

  show({ status: "downloading", downloadPercent: 41 });
  expect(button().textContent).toBe("Downloading update… 41%");
  expect(button().disabled).toBe(true);
  expect(container.textContent).not.toContain("Update downloaded");

  // Settings or a collapsed sidebar hides the button while the download finishes.
  await render(false);
  show({ status: "downloaded" });
  await render(true);
  expect(button().textContent).toBe("Restart to update");
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Update downloaded. Restart to install it.",
  );
  act(() => button().click());
  expect(bridge.restart).toHaveBeenCalledOnce();

  show({ status: "error", failed: "download" });
  expect(button().textContent).toBe("Update failed. Try again");
  act(() => button().click());
  expect(bridge.download).toHaveBeenCalledTimes(2);

  // A failed check is the menu's to report; the sidebar shows nothing for it.
  show({ status: "error", failed: "check", availableVersion: null });
  expect(container.querySelector("button.sidebar__update")).toBeNull();
  act(() => root.unmount());
});
