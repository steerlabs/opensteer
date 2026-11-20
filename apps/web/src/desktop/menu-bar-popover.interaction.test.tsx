// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { MenuBarStatus, OpensteerMenuBarBridge } from "@opensteer/client/computers";
import { MenuBarPopover, menuBarFailure, menuBarStoppedLine } from "./menu-bar-popover.js";
import { menuBarStates } from "./menu-bar-states.js";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

function bridge(
  initial: MenuBarStatus | null = menuBarStates.localHome,
): OpensteerMenuBarBridge & { push(next: MenuBarStatus): void } {
  let listener: ((next: MenuBarStatus) => void) | null = null;
  return {
    status: vi.fn(() =>
      initial ? Promise.resolve(initial) : new Promise<MenuBarStatus>(() => undefined),
    ),
    onStatus: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    setSwitch: vi.fn(async () => undefined),
    stopRow: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    setOpenAtLogin: vi.fn(async () => undefined),
    openApp: vi.fn(async () => undefined),
    openNeedsYou: vi.fn(async () => undefined),
    openSettings: vi.fn(async () => undefined),
    quitCompletely: vi.fn(async () => undefined),
    push: (next) => listener?.(next),
  };
}

async function render(value: OpensteerMenuBarBridge) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () => root.render(<MenuBarPopover bridge={value} />));
  const buttons = () => Array.from(node.querySelectorAll("button"));
  return {
    node,
    text: () => node.textContent ?? "",
    button: (label: string) => buttons().find((button) => button.textContent === label),
    close: async () => {
      await act(async () => root.unmount());
      node.remove();
    },
  };
}

describe("header", () => {
  it("shows Opensteer and Stop everything before anything has loaded", async () => {
    const value = bridge(null);
    const view = await render(value);
    try {
      expect(view.node.querySelector("h1")?.textContent).toBe("Opensteer");
      await act(async () => view.button("Stop everything on this Mac")!.click());
      expect(value.stop).toHaveBeenCalledOnce();
    } finally {
      await view.close();
    }
  });

  it("says this Mac has no Home yet, with no switches, Right now or Needs you", async () => {
    const view = await render(bridge(menuBarStates.noHome));
    try {
      expect(view.text()).toContain("This Mac isn’t connected to a Home yet.");
      expect(view.node.querySelector("#menu-bar-this-mac")).toBeNull();
      expect(view.text()).not.toContain("Right now");
      expect(view.text()).not.toContain("need");
    } finally {
      await view.close();
    }
  });

  it.each([
    ["localHome", ["Home: MacBook Pro", "This Mac is your Home · Running"]],
    ["remoteHome", ["Home: Office Mini", "Connected"]],
    ["twoHomes", ["Home: MacBook Pro", "Home: Office Mini", "Can’t reach Office Mini"]],
  ] as const)("says which Home this Mac works for: %s", async (state, lines) => {
    const view = await render(bridge(menuBarStates[state]));
    try {
      for (const line of lines) expect(view.text()).toContain(line);
    } finally {
      await view.close();
    }
  });

  it("says a Home is unreachable and that Stop still works", async () => {
    const view = await render(bridge(menuBarStates.unreachable));
    try {
      expect(view.text()).toContain("Can’t reach Office Mini");
      expect(view.text()).toContain("Works even while Office Mini is unreachable.");
    } finally {
      await view.close();
    }
  });
});

describe("Needs you", () => {
  it("opens the app at Needs you for the Home that has it", async () => {
    const value = bridge(menuBarStates.needsYou);
    const view = await render(value);
    try {
      await act(async () => view.button("3 need you")!.click());
      expect(value.openNeedsYou).toHaveBeenCalledWith("dep_home");
    } finally {
      await view.close();
    }
  });

  it("says nothing when no Home could say", async () => {
    const view = await render(bridge(menuBarStates.unreachable));
    try {
      expect(view.text()).not.toMatch(/needs? you/);
    } finally {
      await view.close();
    }
  });
});

describe("Right now", () => {
  it("lists what is using this Mac, with Stop only where this Mac can stop it", async () => {
    const value = bridge(menuBarStates.active);
    const view = await render(value);
    try {
      expect(view.text()).toContain("Right now");
      expect(view.text()).toContain("Book flights");
      expect(view.text()).toContain("Notes");
      expect(view.text()).toContain("A browser profile");
      expect(view.text()).toContain("Files and commands");
      const stops = Array.from(view.node.querySelectorAll(".menu-bar__row-stop"));
      expect(stops.map((stop) => stop.getAttribute("aria-label"))).toEqual(["Stop Book flights"]);
      await act(async () => (stops[0] as HTMLButtonElement).click());
      expect(value.stopRow).toHaveBeenCalledWith({ id: "apps:cus_1" });
    } finally {
      await view.close();
    }
  });
});

describe("This Mac", () => {
  it("writes a switch against the revision it shows", async () => {
    const value = bridge(menuBarStates.localHome);
    const view = await render(value);
    try {
      const apps = view.node.querySelector<HTMLInputElement>("#menu-bar-switch-apps")!;
      const input = apps.closest("li")!.querySelector("input")!;
      await act(async () => input.click());
      expect(value.setSwitch).toHaveBeenCalledWith({
        deploymentId: "dep_home",
        capability: "apps",
        on: true,
        revision: 7,
      });
    } finally {
      await view.close();
    }
  });

  it("keeps Stop everything available while a switch write is still waiting", async () => {
    const value = bridge(menuBarStates.localHome);
    value.setSwitch = vi.fn(() => new Promise<void>(() => undefined));
    const view = await render(value);
    try {
      const input = view.node
        .querySelector("#menu-bar-switch-apps")!
        .closest("li")!
        .querySelector("input")!;
      await act(async () => input.click());
      await act(async () => view.button("Stop everything on this Mac")!.click());
      expect(value.stop).toHaveBeenCalledOnce();
    } finally {
      await view.close();
    }
  });
});

describe("Stop everything", () => {
  it("stops with no question, then says when and offers Resume", async () => {
    const value = bridge(menuBarStates.localHome);
    const view = await render(value);
    try {
      await act(async () => view.button("Stop everything on this Mac")!.click());
      expect(value.stop).toHaveBeenCalledOnce();
      await act(async () => value.push(menuBarStates.stopped));
      expect(view.text()).toMatch(/Stopped everything on this Mac at .+\./);
      await act(async () => view.button("Resume")!.click());
      expect(value.resume).toHaveBeenCalledOnce();
    } finally {
      await view.close();
    }
  });

  it("keeps a Stop that did not fully take effect in view", async () => {
    const value = bridge(menuBarStates.localHome);
    value.stop = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'opensteer-menu-bar:stop': Error: Opensteer couldn’t save that.",
      );
    });
    const view = await render(value);
    try {
      await act(async () => view.button("Stop everything on this Mac")!.click());
      expect(view.node.querySelector('[role="alert"]')?.textContent).toBe(
        "Opensteer couldn’t save that.",
      );
    } finally {
      await view.close();
    }
  });
});

describe("footer", () => {
  it("opens the app, its Settings, and quits from the menu", async () => {
    const value = bridge(menuBarStates.localHome);
    const view = await render(value);
    try {
      await act(async () => view.button("Open Opensteer")!.click());
      expect(value.openApp).toHaveBeenCalledOnce();
      await act(async () => view.button("Settings…")!.click());
      expect(value.openSettings).toHaveBeenCalledOnce();
      expect(view.button("Quit")).toBeUndefined();
      await act(async () => view.node.querySelector<HTMLButtonElement>(".menu-bar__more")!.click());
      expect(view.text()).toContain("Open at login");
      await act(async () => view.button("Quit")!.click());
      expect(value.quitCompletely).toHaveBeenCalledOnce();
    } finally {
      await view.close();
    }
  });
});

it("writes the Stop time in local time and keeps Electron's prefix out of failures", () => {
  expect(menuBarStoppedLine("2026-11-20T10:42:00.000Z", "en-US")).toMatch(
    /^Stopped everything on this Mac at \d{1,2}:42\s?[AP]M\.$/u,
  );
  expect(menuBarStoppedLine(null)).toBeNull();
  expect(menuBarFailure(new Error(""))).toBe("That didn’t work. Try again.");
});
