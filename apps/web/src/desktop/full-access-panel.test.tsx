// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FullAccessPanel, type FullAccessPanelBridge } from "./full-access-panel.js";

const mountedRoots: Root[] = [];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  vi.useRealTimers();
});

describe("FullAccessPanel", () => {
  it("asks macOS every second, says so when the grant lands, and closes itself", async () => {
    vi.useFakeTimers();
    let granted = false;
    const checkFullDiskAccess = vi.fn(async () => ({ granted }));
    const closeFullDiskAccessPanel = vi.fn(async () => undefined);
    const container = mount({ checkFullDiskAccess, closeFullDiskAccessPanel });

    expect(container.textContent).toContain(
      "Turn on Opensteer Beta in the macOS Full Disk Access list.",
    );
    expect(container.textContent).toContain(
      "macOS asks for your password or Touch ID, then offers to quit and reopen Opensteer Beta. Choose Quit & Reopen.",
    );
    // The transparent window shows only the card this attribute unpaints for.
    expect(document.documentElement.dataset["panel"]).toBe("full-access");

    await advance(1_000);
    expect(checkFullDiskAccess).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      "Turn on Opensteer Beta in the macOS Full Disk Access list",
    );

    granted = true;
    await advance(1_000);
    expect(container.textContent).toContain("macOS Full Disk Access is on.");
    expect(container.textContent).not.toContain(
      "Turn on Opensteer Beta in the macOS Full Disk Access list",
    );
    expect(closeFullDiskAccessPanel).not.toHaveBeenCalled();

    // Nothing is asked again once the answer is yes; the panel just leaves.
    await advance(1_200);
    expect(checkFullDiskAccess).toHaveBeenCalledTimes(2);
    expect(closeFullDiskAccessPanel).toHaveBeenCalledOnce();
  });
});

function mount(overrides: Partial<FullAccessPanelBridge>): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const bridge: FullAccessPanelBridge = {
    checkFullDiskAccess: async () => ({ granted: false }),
    closeFullDiskAccessPanel: async () => undefined,
    ...overrides,
  };
  act(() => root.render(<FullAccessPanel appName="Opensteer Beta" bridge={bridge} />));
  return container;
}

/** Runs the timers the panel set, then lets the promises they started settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
