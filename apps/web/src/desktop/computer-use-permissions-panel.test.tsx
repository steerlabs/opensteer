// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerUsePermissions } from "@opensteer/protocol";
import {
  ComputerUsePermissionsPanel,
  type ComputerUsePermissionsPanelBridge,
} from "./computer-use-permissions-panel.js";

const roots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function renderPanel(bridge: ComputerUsePermissionsPanelBridge): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<ComputerUsePermissionsPanel bridge={bridge} />);
    await Promise.resolve();
  });
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
}

describe("ComputerUsePermissionsPanel", () => {
  it("checks without prompting, then requests Screen Recording first", async () => {
    const request = vi.fn(async () => ({
      accessibility: "denied" as const,
      screenRecording: "denied" as const,
    }));
    const openSettings = vi.fn(async () => undefined);
    const bridge: ComputerUsePermissionsPanelBridge = {
      closeComputerUsePermissionsPanel: async () => undefined,
      computerUseOpenSystemSettings: openSettings,
      computerUsePermissionsGet: async () => ({
        accessibility: "denied",
        screenRecording: "denied",
      }),
      computerUsePermissionsRequest: request,
    };
    const container = await renderPanel(bridge);

    expect(request).not.toHaveBeenCalled();
    expect(button(container, "Enable Screen Recording")).toBeDefined();
    expect(button(container, "Enable Accessibility")).toBeUndefined();
    await act(async () => {
      button(container, "Enable Screen Recording")?.click();
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledExactlyOnceWith({ pane: "screen-recording" });
    expect(openSettings).not.toHaveBeenCalled();
    expect(button(container, "Open System Settings")).toBeDefined();
    expect(container.textContent).toContain("Follow the macOS prompt");
    await act(async () => {
      button(container, "Open System Settings")?.click();
      await Promise.resolve();
    });
    expect(openSettings).toHaveBeenCalledExactlyOnceWith({ pane: "screen-recording" });
    expect(container.textContent).toContain("switch on Opensteer Computer Use in System Settings.");
  });

  it("advances to Accessibility only when Screen Recording is on", async () => {
    let permissions: {
      accessibility: "denied" | "granted";
      screenRecording: "denied" | "granted";
    } = {
      accessibility: "denied",
      screenRecording: "denied",
    };
    const request = vi.fn(
      async ({ pane }: { readonly pane: "screen-recording" | "accessibility" }) => {
        permissions =
          pane === "screen-recording"
            ? { accessibility: "denied", screenRecording: "granted" }
            : { accessibility: "granted", screenRecording: "granted" };
        return permissions;
      },
    );
    const bridge: ComputerUsePermissionsPanelBridge = {
      closeComputerUsePermissionsPanel: async () => undefined,
      computerUseOpenSystemSettings: async () => undefined,
      computerUsePermissionsGet: async () => permissions,
      computerUsePermissionsRequest: request,
    };
    const container = await renderPanel(bridge);
    expect(button(container, "Enable Accessibility")).toBeUndefined();
    await act(async () => {
      button(container, "Enable Screen Recording")?.click();
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledWith({ pane: "screen-recording" });
    expect(button(container, "Enable Accessibility")).toBeDefined();
    await act(async () => {
      button(container, "Enable Accessibility")?.click();
      await Promise.resolve();
    });
    expect(request).toHaveBeenLastCalledWith({ pane: "accessibility" });
    expect(container.textContent).toContain("Computer use is ready.");
  });

  it("keeps the same grant available after a request failure", async () => {
    vi.useFakeTimers();
    let readFails = false;
    const request = vi.fn(async (): Promise<never> => {
      throw new Error("helper refused");
    });
    const bridge: ComputerUsePermissionsPanelBridge = {
      closeComputerUsePermissionsPanel: async () => undefined,
      computerUseOpenSystemSettings: async () => undefined,
      computerUsePermissionsGet: async () => {
        if (readFails) throw new Error("helper disconnected");
        return { accessibility: "granted", screenRecording: "denied" };
      },
      computerUsePermissionsRequest: request,
    };
    const container = await renderPanel(bridge);
    await act(async () => {
      button(container, "Enable Screen Recording")?.click();
      await Promise.resolve();
    });
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Could not request Screen Recording. Try again.",
    );
    readFails = true;
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Could not request Screen Recording. Try again.",
    );
    expect(button(container, "Enable Screen Recording")).toBeDefined();
  });

  it("ignores an old permission read after the person starts a request", async () => {
    vi.useFakeTimers();
    let resolveOldRead!: (value: ComputerUsePermissions) => void;
    let reads = 0;
    const bridge: ComputerUsePermissionsPanelBridge = {
      closeComputerUsePermissionsPanel: async () => undefined,
      computerUseOpenSystemSettings: async () => undefined,
      computerUsePermissionsGet: async () => {
        reads += 1;
        if (reads === 2) {
          return new Promise<ComputerUsePermissions>((resolve) => {
            resolveOldRead = resolve;
          });
        }
        return { accessibility: "denied", screenRecording: "denied" };
      },
      computerUsePermissionsRequest: async () => ({
        accessibility: "denied",
        screenRecording: "granted",
      }),
    };
    const container = await renderPanel(bridge);
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(reads).toBe(2);
    await act(async () => {
      button(container, "Enable Screen Recording")?.click();
      await Promise.resolve();
    });
    expect(button(container, "Enable Accessibility")).toBeDefined();
    await act(async () => resolveOldRead({ accessibility: "denied", screenRecording: "denied" }));
    expect(button(container, "Enable Accessibility")).toBeDefined();
  });

  it("does not open System Settings after the panel closes during a request", async () => {
    let resolveRequest!: (value: ComputerUsePermissions) => void;
    const openSettings = vi.fn(async () => undefined);
    const bridge: ComputerUsePermissionsPanelBridge = {
      closeComputerUsePermissionsPanel: async () => undefined,
      computerUseOpenSystemSettings: openSettings,
      computerUsePermissionsGet: async () => ({
        accessibility: "denied",
        screenRecording: "denied",
      }),
      computerUsePermissionsRequest: async () =>
        new Promise<ComputerUsePermissions>((resolve) => {
          resolveRequest = resolve;
        }),
    };
    const container = await renderPanel(bridge);
    await act(async () => {
      button(container, "Enable Screen Recording")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      button(container, "Not now")?.click();
      roots.pop()?.unmount();
    });
    await act(async () => resolveRequest({ accessibility: "denied", screenRecording: "denied" }));
    expect(openSettings).not.toHaveBeenCalled();
  });
});
