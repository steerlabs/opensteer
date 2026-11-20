// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MenuBarStatus, OpensteerMenuBarBridge } from "@opensteer/client/computers";
import { MenuBarPopover, menuBarFailure } from "./menu-bar-popover.js";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const status: MenuBarStatus = {
  schemaVersion: 1,
  homes: [
    {
      deploymentId: "dep_home",
      role: "home",
      tone: "ok",
      line: "This Mac is your Home — running",
      editable: true,
      switches: [
        { capability: "browser", label: "Browser", detail: "Always on", on: true, fixed: true },
        {
          capability: "apps",
          label: "Apps",
          detail: "See and control apps",
          on: false,
          fixed: false,
        },
      ],
    },
  ],
  activity: ["Running: Book flights"],
  stopped: false,
  stopLine: "Stop cuts agents off this Mac’s apps and tabs and disconnects it as a Device.",
  openAtLogin: true,
};

function bridge(): OpensteerMenuBarBridge & { push(next: MenuBarStatus): void } {
  let listener: ((next: MenuBarStatus) => void) | null = null;
  return {
    status: vi.fn(async () => status),
    onStatus: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    setSwitch: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    setOpenAtLogin: vi.fn(async () => undefined),
    openApp: vi.fn(async () => undefined),
    quitCompletely: vi.fn(async () => undefined),
    push: (next) => listener?.(next),
  };
}

async function render(value: OpensteerMenuBarBridge) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<MenuBarPopover bridge={value} />));
  return {
    node,
    button: (label: string) =>
      Array.from(node.querySelectorAll("button")).find((button) => button.textContent === label)!,
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
    },
  };
}

it("shows the Home, this Mac's switches and what is running, and writes a switch", async () => {
  const value = bridge();
  const view = await render(value);
  try {
    expect(view.node.textContent).toContain("This Mac is your Home — running");
    expect(view.node.textContent).toContain("Running: Book flights");
    const apps = view.node.querySelector<HTMLInputElement>('input[aria-labelledby$="-apps"]')!;
    await act(async () => apps.click());
    expect(value.setSwitch).toHaveBeenCalledWith({
      deploymentId: "dep_home",
      capability: "apps",
      on: true,
    });
  } finally {
    await view.close();
  }
});

it("stops, then offers Resume once main says it is stopped", async () => {
  const value = bridge();
  const view = await render(value);
  try {
    await act(async () => view.button("Stop").click());
    expect(value.stop).toHaveBeenCalledOnce();
    await act(async () => value.push({ ...status, stopped: true, stopLine: "Stopped." }));
    await act(async () => view.button("Resume").click());
    expect(value.resume).toHaveBeenCalledOnce();
  } finally {
    await view.close();
  }
});

it("opens the app, quits completely, and says why something failed", async () => {
  const value = bridge();
  value.quitCompletely = vi.fn(async () => {
    throw new Error(
      "Error invoking remote method 'opensteer-menu-bar:quit-completely': Error: Opensteer is busy.",
    );
  });
  const view = await render(value);
  try {
    await act(async () => view.button("Open Opensteer").click());
    expect(value.openApp).toHaveBeenCalledOnce();
    await act(async () => view.button("Quit Opensteer Completely").click());
    expect(view.node.querySelector('[role="alert"]')?.textContent).toBe("Opensteer is busy.");
  } finally {
    await view.close();
  }
  expect(menuBarFailure(new Error(""))).toBe("That didn’t work. Try again.");
});
