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
    openRow: vi.fn(async () => undefined),
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

  it("says it could not check, never a count, when no Home could say", async () => {
    const view = await render(bridge(menuBarStates.unreachable));
    try {
      expect(view.text()).toContain("Couldn’t check Office Mini for what needs you");
      expect(view.text()).not.toMatch(/\d+ needs? you/);
    } finally {
      await view.close();
    }
  });
});

describe("Right now", () => {
  it("lists who is using what, with no control but the row itself", async () => {
    const value = bridge(menuBarStates.active);
    const view = await render(value);
    try {
      expect(view.text()).toContain("Right now");
      const rows = Array.from(view.node.querySelectorAll(".menu-bar__activity-row"));
      expect(rows.map((row) => row.textContent)).toEqual([
        "Book flightsNotes",
        "An agentA browser profile",
        "Clean up downloadsWorking on this Mac",
      ]);
      expect(view.node.querySelectorAll(".menu-bar__activity button button")).toHaveLength(0);
      expect(view.text()).not.toMatch(/Stopping…|Didn’t stop/u);
      expect(view.button("Stop")).toBeUndefined();
    } finally {
      await view.close();
    }
  });

  it("opens a row's task in the app, and the app where the record names no task", async () => {
    const value = bridge(menuBarStates.active);
    const view = await render(value);
    try {
      const rows = Array.from(
        view.node.querySelectorAll<HTMLButtonElement>(".menu-bar__activity-row"),
      );
      await act(async () => rows[2]!.click());
      expect(value.openRow).toHaveBeenCalledWith({ deploymentId: "dep_home", threadId: "thr_1" });
      await act(async () => rows[0]!.click());
      expect(value.openApp).toHaveBeenCalledTimes(1);
      expect(value.openRow).toHaveBeenCalledTimes(1);
    } finally {
      await view.close();
    }
  });

  it("names a connected agent as its connection proved it, with the task it works on", async () => {
    const value = bridge(menuBarStates.agents);
    const view = await render(value);
    try {
      const rows = Array.from(view.node.querySelectorAll(".menu-bar__activity-row"));
      expect(rows.map((row) => row.textContent)).toEqual([
        "Says it is GrokA browser profile · Friday dinner",
        "Claude CodeWorking on this Mac · Rename photos",
        "Verified: ClaudeWorking on this Mac · Compare flights",
      ]);
      // Only the verified one wears the check and its platform's logo.
      expect(rows.map((row) => row.querySelector(".menu-bar__verified") !== null)).toEqual([
        false,
        false,
        true,
      ]);
      expect(rows.map((row) => row.querySelector(".provider-logo") !== null)).toEqual([
        false,
        false,
        true,
      ]);
      await act(async () => (rows[1] as HTMLButtonElement).click());
      expect(value.openRow).toHaveBeenCalledWith({ deploymentId: "dep_office", threadId: "thr_3" });
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
        machineId: "rnr_00000000-0000-4000-8000-000000000001",
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
      expect(view.text()).toContain("MacBook Pro shows this Mac as stopped too.");
      // Stop is about agents: the person's own tabs and watching from the phone go on.
      expect(view.text()).toContain(
        "Agents can’t use this Mac until you resume. Your own tabs keep working, and you can still watch this Mac from your phone.",
      );
      expect(view.text()).not.toMatch(/can’t watch|tabs (?:stop|close)/u);
      await act(async () => view.button("Resume")!.click());
      expect(value.resume).toHaveBeenCalledOnce();
    } finally {
      await view.close();
    }
  });

  it("says stopping, with nothing else to press, until the Stop is confirmed", async () => {
    const value = bridge(menuBarStates.stopping);
    const view = await render(value);
    try {
      expect(view.text()).toContain("Stopping agents on this Mac…");
      expect(view.text()).not.toMatch(/Stopped everything/);
      expect(view.button("Resume")).toBeUndefined();
      expect(view.button("Stop everything on this Mac")).toBeUndefined();
    } finally {
      await view.close();
    }
  });

  it("never says stopped for a Stop that did not finish, and offers Stop everything again", async () => {
    const value = bridge(menuBarStates.stopFailed);
    const view = await render(value);
    try {
      expect(view.text()).not.toMatch(/Stopped everything|until you resume/);
      expect(view.text()).toContain("Couldn’t confirm everything stopped");
      expect(view.button("Resume")).toBeUndefined();
      expect(view.node.querySelector('[role="alert"]')?.textContent).toMatch(
        /didn’t stop \(tasks on this Mac’s Home\)\. Press Stop everything to try again\./,
      );
      await act(async () => view.button("Stop everything on this Mac")!.click());
      expect(value.stop).toHaveBeenCalledOnce();
    } finally {
      await view.close();
    }
  });

  it("offers Resume without claiming an unconfirmed stop ended all work", async () => {
    const view = await render(
      bridge({
        ...menuBarStates.stopFailed,
        stop: {
          ...menuBarStates.stopFailed.stop,
          phase: "stopped",
          stoppedAt: null,
          problem: "Couldn't confirm that one device connection on this Mac stopped.",
        },
      }),
    );
    try {
      expect(view.text()).not.toMatch(/Stopped everything|until you resume/);
      expect(view.text()).toContain(
        "Couldn't confirm that one device connection on this Mac stopped.",
      );
      expect(view.button("Resume")).toBeDefined();
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
