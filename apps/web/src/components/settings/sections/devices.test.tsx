// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AgentDevicesSection } from "./agent-devices.js";
import { describe, expect, it, vi } from "vitest";
import { unwrapRpcResult } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { SettingsSignOut } from "../primitives.js";
import { revokeCurrentSession } from "./devices.js";

describe("device disconnection", () => {
  it("revokes the current authenticated Host session", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const before = unwrapRpcResult(await client.rpc["sessions.list"]({}));
    const current = before.sessions.find((session) => session.current);
    const dispatch = vi.spyOn(client, "dispatch");

    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    let completed: Promise<void> | null = null;
    try {
      await act(async () =>
        root.render(
          createElement(SettingsSignOut, {
            label: "Session actions",
            warning: "This device loses access. Your work stays here.",
            pending: false,
            onConfirm: () => {
              completed = revokeCurrentSession(client);
            },
          }),
        ),
      );
      await act(async () => node.querySelector<HTMLButtonElement>("button")!.click());
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click(),
      );
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "Your work stays here",
      );
      expect(dispatch).not.toHaveBeenCalled();
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[role="dialog"] .btn--danger')!.click(),
      );
      await completed;
    } finally {
      act(() => root.unmount());
      node.remove();
    }

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: current?.id, type: "session.revoke" }),
    );
    expect(unwrapRpcResult(await client.rpc["sessions.list"]({})).sessions).toEqual([]);
  });

  it("does not report success when the authenticated session is no longer listed", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    await revokeCurrentSession(client);

    await expect(revokeCurrentSession(client)).rejects.toThrow(
      "This device no longer has an active session.",
    );
  });
});

const shell = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../../app-shell.js", () => ({ useShell: () => shell.value }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("opens inline device enrollment without leaving the device list", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  const rpc = client.rpc;
  const read = vi.fn(rpc["devices.overview.get"]);
  Object.defineProperty(client, "rpc", {
    value: new Proxy(rpc, {
      get: (target, key) => (key === "devices.overview.get" ? read : Reflect.get(target, key)),
    }),
  });
  shell.value = {
    hostClient: client,
    snapshot: client.getSnapshot(),
    desktopBridge: null,
    desktopDeployment: null,
    localExecutionStatus: null,
    localExecutionAction: null,
    localExecutionError: null,
  };
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(createElement(MemoryRouter, null, createElement(AgentDevicesSection))),
    );
    read.mockClear();
    shell.value = {
      ...(shell.value as object),
      snapshot: { ...client.getSnapshot(), machineRevision: 99 },
    };
    await act(async () =>
      root.render(createElement(MemoryRouter, null, createElement(AgentDevicesSection))),
    );
    expect(read).toHaveBeenCalledTimes(1);
    const add = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Add device",
    )!;
    await act(async () => add.click());
    expect(node.textContent).toContain("Android Agent Phone");
    const computer = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Computer",
    )!;
    await act(async () => computer.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Add a computer");
    expect(node.querySelector(".settings-device-list")).not.toBeNull();
  } finally {
    act(() => root.unmount());
    node.remove();
    client.dispose();
  }
});
