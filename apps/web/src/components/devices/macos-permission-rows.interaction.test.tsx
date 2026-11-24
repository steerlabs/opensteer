// @vitest-environment happy-dom
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { desktopComputerUseOffInTrial } from "@opensteer/protocol/desktop";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  MacosPermissionRows,
  openAppsPermissionsPanel,
  readMacosGrants,
  type MacosGrants,
} from "./macos-permission-rows.js";

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

/** What Electron makes of a main-process refusal: its own prefix, then the error's name and words. */
const ipcRefusal = (channel: string, words: string) =>
  new Error(`Error invoking remote method '${channel}': ComputerUseHelperFailure: ${words}`);

function bridge(overrides: Partial<OpensteerDesktopBridge>): OpensteerDesktopBridge {
  return {
    checkFullDiskAccess: vi.fn(async () => ({ granted: true })),
    computerUsePermissionsGet: vi.fn(async () => ({
      accessibility: "denied" as const,
      screenRecording: "denied" as const,
    })),
    computerUsePermissionsRequest: vi.fn(async () => ({
      accessibility: "denied" as const,
      screenRecording: "denied" as const,
    })),
    requestFullDiskAccess: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as OpensteerDesktopBridge;
}

async function render(desktop: OpensteerDesktopBridge) {
  const first = await readMacosGrants(desktop);
  function Rows() {
    const [grants, setGrants] = useState<MacosGrants>(first);
    return (
      <MacosPermissionRows
        apps
        bridge={desktop}
        files={false}
        grants={grants}
        onAsked={() => void readMacosGrants(desktop).then(setGrants)}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Rows />));
}

const buttons = () =>
  [...document.querySelectorAll("button")].filter(
    (button) => button.textContent === "Open System Settings",
  );

it("says Apps are off in a trial instead of offering a button that does nothing", async () => {
  const off = () =>
    Promise.reject(
      ipcRefusal("opensteer.desktop.computer-use.permissions.get", desktopComputerUseOffInTrial),
    );
  const desktop = bridge({ computerUsePermissionsGet: vi.fn(off) });
  await render(desktop);
  expect(buttons()).toHaveLength(0);
  expect(document.body.textContent).toContain(desktopComputerUseOffInTrial);
  expect(desktop.computerUsePermissionsRequest).not.toHaveBeenCalled();
});

it("says so when opening System Settings fails, rather than nothing happening", async () => {
  const desktop = bridge({
    computerUsePermissionsRequest: vi.fn(() =>
      Promise.reject(
        ipcRefusal("opensteer.desktop.computer-use.permissions.request", "helper went away"),
      ),
    ),
  });
  await render(desktop);
  expect(buttons()).toHaveLength(2);
  await act(async () => buttons()[0]!.click());
  expect(desktop.computerUsePermissionsRequest).toHaveBeenCalledWith({ pane: "accessibility" });
  expect(document.body.textContent).toContain(
    "System Settings didn’t open. Open System Settings › Privacy & Security › Accessibility and turn on Opensteer.",
  );
});

it("says why the Apps permission panel cannot open, every way it can fail", async () => {
  const said: string[] = [];
  const say = (words: string) => said.push(words);
  await openAppsPermissionsPanel(
    bridge({
      openComputerUsePermissionsPanel: vi.fn(() =>
        Promise.reject(
          ipcRefusal("opensteer.desktop.computer-use.panel.open", desktopComputerUseOffInTrial),
        ),
      ),
    }),
    say,
  );
  await openAppsPermissionsPanel(
    bridge({
      openComputerUsePermissionsPanel: vi.fn(async () => ({
        opened: false as const,
        reason: "unsigned-build" as const,
      })),
    }),
    say,
  );
  await openAppsPermissionsPanel(
    bridge({ openComputerUsePermissionsPanel: vi.fn(async () => ({ opened: true as const })) }),
    say,
  );
  expect(said).toEqual([
    desktopComputerUseOffInTrial,
    "This build isn’t signed with a Developer ID, so it can’t set up computer use. See apps/desktop/README.md.",
  ]);
});
