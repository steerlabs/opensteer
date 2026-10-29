// @vitest-environment happy-dom

import {
  AgentPhoneEnrollments,
  agentPhoneAdb,
  setupAgentPhone,
  type AgentPhoneSetupResult,
} from "@opensteer/agent-phone-setup";
import {
  agentPhoneUsb,
  chooseAgentPhone,
  connectAgentPhone,
  grantedAgentPhones,
  type AgentPhoneUsbConnection,
  type AgentPhoneUsbDevice,
} from "@opensteer/agent-phone-setup/webusb";
import { MockHostClient } from "@opensteer/client/mock";
import { createId } from "@opensteer/core";
import type { DesktopUsbDeviceChoice, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentPhoneArtifact } from "../../computers/agent-phone-setup.js";
import { AddPhoneDialog } from "./add-phone-dialog.js";

vi.mock("@opensteer/agent-phone-setup", () => ({
  AgentPhoneEnrollments: vi.fn(),
  agentPhoneAdb: vi.fn(),
  agentPhoneSetupHost: vi.fn(),
  setupAgentPhone: vi.fn(),
}));
vi.mock("@opensteer/agent-phone-setup/webusb", () => ({
  agentPhoneCredentialStore: vi.fn(),
  agentPhoneUsb: vi.fn(),
  chooseAgentPhone: vi.fn(),
  connectAgentPhone: vi.fn(),
  grantedAgentPhones: vi.fn(),
}));
vi.mock("../../computers/agent-phone-setup.js", async (original) => ({
  ...(await original<typeof import("../../computers/agent-phone-setup.js")>()),
  loadAgentPhoneArtifact: vi.fn(),
}));

/**
 * Lifecycle failures, written before changing setup:
 * 1. Stop, the close button, Escape or unmount lets a pending chooser begin ADB/setup later.
 * 2. Closing leaves the desktop's outstanding chooser unanswered.
 * 3. A connection that finishes after cancellation begins setup instead of closing its ADB handle.
 * 4. A pending replug lookup restarts setup after close, or an old connection overtakes its replacement.
 * 5. Cancellation also prevents an open dialog from choosing, completing or resuming a phone normally.
 * 6. A run started by a replug or by "Try again" draws on a new enrollment sequence rather than
 *    the dialog's own, so it can mint while an earlier enrollment is still usable.
 */
describe("AddPhoneDialog setup lifecycle", () => {
  const roots: Root[] = [];
  const usb = new EventTarget() as unknown as USB;
  const chosen = { name: "Pixel", raw: {}, serial: "pixel-serial" } as AgentPhoneUsbDevice;
  const choice: DesktopUsbDeviceChoice = {
    choiceId: "11111111-1111-4111-8111-111111111111",
    devices: [
      { deviceId: "first", name: "Pixel", serialNumber: "first-serial" },
      { deviceId: "second", name: "Pixel", serialNumber: "second-serial" },
    ],
  };
  const done: AgentPhoneSetupResult = { outcome: "done", runnerId: createId("runner") };

  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(agentPhoneUsb).mockReturnValue(usb);
    vi.mocked(loadAgentPhoneArtifact).mockResolvedValue({
      bytes: new Uint8Array([1]),
      manifest: {},
    });
    vi.mocked(chooseAgentPhone).mockResolvedValue(chosen);
    vi.mocked(grantedAgentPhones).mockResolvedValue([chosen]);
    vi.mocked(connectAgentPhone).mockResolvedValue(connection());
    vi.mocked(setupAgentPhone).mockReturnValue(
      Promise.withResolvers<AgentPhoneSetupResult>().promise,
    );
  });

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
  });

  function connection() {
    const close = vi.fn(async () => undefined);
    return {
      adb: { close } as unknown as Extract<
        AgentPhoneUsbConnection,
        { readonly kind: "connected" }
      >["adb"],
      kind: "connected" as const,
    };
  }

  async function mount(desktopBridge: OpensteerDesktopBridge | null = null) {
    const client = new MockHostClient({ latencyMs: 0 });
    const refresh = vi.spyOn(client, "refresh").mockResolvedValue(undefined);
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AddPhoneDialog
            client={client}
            deploymentKind="server"
            deploymentName="My Opensteer"
            desktopBridge={desktopBridge}
            homeName="Mac mini"
            onClose={onClose}
          />
        </MemoryRouter>,
      );
    });
    return { container, onClose, refresh, root };
  }

  function button(container: HTMLElement, name: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
    );
    if (!found) throw new Error(`No button ${name}: ${container.textContent}`);
    return found;
  }

  async function click(container: HTMLElement, name: string) {
    await act(async () => button(container, name).click());
  }

  async function usbEvent(type: "connect" | "disconnect") {
    await act(async () =>
      usb.dispatchEvent(Object.assign(new Event(type), { device: chosen.raw })),
    );
  }

  it.each(["Stop setup", "Close", "Escape"])(
    "%s invalidates a pending chooser before the parent unmounts",
    async (closeWith) => {
      const selection = Promise.withResolvers<AgentPhoneUsbDevice | null>();
      vi.mocked(chooseAgentPhone).mockReturnValue(selection.promise);
      const page = await mount();
      await click(page.container, "Choose the phone");
      if (closeWith === "Escape") {
        await act(async () => {
          page.container
            .querySelector("[role=dialog]")!
            .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        });
      } else {
        await click(page.container, closeWith);
      }
      expect(page.onClose).toHaveBeenCalledOnce();
      await act(async () => selection.resolve(chosen));
      expect(connectAgentPhone).not.toHaveBeenCalled();
      expect(setupAgentPhone).not.toHaveBeenCalled();
    },
  );

  it("unmount invalidates a chooser that has no connection to abort yet", async () => {
    const selection = Promise.withResolvers<AgentPhoneUsbDevice | null>();
    vi.mocked(chooseAgentPhone).mockReturnValue(selection.promise);
    const page = await mount();
    await click(page.container, "Choose the phone");
    act(() => page.root.unmount());
    roots.splice(roots.indexOf(page.root), 1);
    await act(async () => selection.resolve(chosen));
    expect(connectAgentPhone).not.toHaveBeenCalled();
    expect(setupAgentPhone).not.toHaveBeenCalled();
  });

  it("Stop declines the known desktop USB choice immediately", async () => {
    const selection = Promise.withResolvers<AgentPhoneUsbDevice | null>();
    vi.mocked(chooseAgentPhone).mockReturnValue(selection.promise);
    let receiveChoice: (value: DesktopUsbDeviceChoice) => void = () => undefined;
    const chooseUsbDevice = vi.fn(async () => selection.resolve(null));
    const bridge = {
      chooseUsbDevice,
      onUsbDeviceChoice: (listener: typeof receiveChoice) => {
        receiveChoice = listener;
        return () => undefined;
      },
    } as unknown as OpensteerDesktopBridge;
    const page = await mount(bridge);
    await click(page.container, "Choose the phone");
    await act(async () => receiveChoice(choice));
    await click(page.container, "Stop setup");
    expect(chooseUsbDevice).toHaveBeenCalledExactlyOnceWith({
      choiceId: choice.choiceId,
      deviceId: null,
    });
    expect(connectAgentPhone).not.toHaveBeenCalled();
    expect(setupAgentPhone).not.toHaveBeenCalled();
  });

  it("closes an ADB connection that resolves after Stop instead of starting setup", async () => {
    const opening = Promise.withResolvers<AgentPhoneUsbConnection>();
    vi.mocked(connectAgentPhone).mockReturnValue(opening.promise);
    const page = await mount();
    await click(page.container, "Choose the phone");
    const signal = vi.mocked(connectAgentPhone).mock.calls[0]![1].signal;
    await click(page.container, "Stop setup");
    expect(signal.aborted).toBe(true);
    const late = connection();
    await act(async () => opening.resolve(late));
    expect(late.adb.close).toHaveBeenCalledOnce();
    expect(agentPhoneAdb).not.toHaveBeenCalled();
    expect(setupAgentPhone).not.toHaveBeenCalled();
    expect(page.refresh).not.toHaveBeenCalled();
  });

  it("closing a pending replug lookup prevents it from reconnecting", async () => {
    const devices = Promise.withResolvers<AgentPhoneUsbDevice[]>();
    vi.mocked(grantedAgentPhones).mockReturnValue(devices.promise);
    const page = await mount();
    await click(page.container, "Choose the phone");
    expect(setupAgentPhone).toHaveBeenCalledOnce();
    await usbEvent("disconnect");
    await usbEvent("connect");
    expect(grantedAgentPhones).toHaveBeenCalledOnce();
    await click(page.container, "Close");
    await act(async () => devices.resolve([chosen]));
    expect(connectAgentPhone).toHaveBeenCalledOnce();
    expect(setupAgentPhone).toHaveBeenCalledOnce();
  });

  it("a newer replug lookup supersedes an older pending lookup", async () => {
    const older = Promise.withResolvers<AgentPhoneUsbDevice[]>();
    const newer = Promise.withResolvers<AgentPhoneUsbDevice[]>();
    vi.mocked(grantedAgentPhones)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const page = await mount();
    await click(page.container, "Choose the phone");
    await usbEvent("disconnect");
    await usbEvent("connect");
    await usbEvent("connect");
    await act(async () => older.resolve([chosen]));
    expect(connectAgentPhone).toHaveBeenCalledOnce();
    await act(async () => newer.resolve([chosen]));
    expect(connectAgentPhone).toHaveBeenCalledTimes(2);
    expect(setupAgentPhone).toHaveBeenCalledTimes(2);
  });

  it("a setup result received after Stop cannot refresh the Host or finish the dialog", async () => {
    const setup = Promise.withResolvers<AgentPhoneSetupResult>();
    vi.mocked(setupAgentPhone).mockReturnValue(setup.promise);
    const page = await mount();
    await click(page.container, "Choose the phone");
    const signal = vi.mocked(setupAgentPhone).mock.calls[0]![0].signal;
    await click(page.container, "Stop setup");
    expect(signal.aborted).toBe(true);
    await act(async () => setup.resolve(done));
    expect(page.refresh).not.toHaveBeenCalled();
    expect(page.container.textContent).not.toContain("The phone is ready");
  });

  it("an old connection cannot start setup after a replug starts its replacement", async () => {
    const first = Promise.withResolvers<AgentPhoneUsbConnection>();
    const second = Promise.withResolvers<AgentPhoneUsbConnection>();
    vi.mocked(connectAgentPhone)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const page = await mount();
    await click(page.container, "Choose the phone");
    await usbEvent("disconnect");
    await usbEvent("connect");
    expect(connectAgentPhone).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(connection()));
    expect(setupAgentPhone).toHaveBeenCalledOnce();
    const old = connection();
    await act(async () => first.resolve(old));
    expect(old.adb.close).toHaveBeenCalledOnce();
    expect(setupAgentPhone).toHaveBeenCalledOnce();
  });

  it("a chosen phone still completes setup and shows its page", async () => {
    vi.mocked(setupAgentPhone).mockResolvedValue(done);
    const page = await mount();
    await click(page.container, "Choose the phone");
    expect(setupAgentPhone).toHaveBeenCalledOnce();
    expect(page.refresh).toHaveBeenCalledOnce();
    expect(page.container.textContent).toContain("The phone is ready");
    expect(page.container.querySelector("a[href]")?.getAttribute("href")).toBe(
      `/settings/computers/${done.runnerId}`,
    );
  });

  it("an open dialog resumes the selected phone after unplugging and replugging", async () => {
    const page = await mount();
    await click(page.container, "Choose the phone");
    const firstSignal = vi.mocked(setupAgentPhone).mock.calls[0]![0].signal;
    await usbEvent("disconnect");
    expect(firstSignal.aborted).toBe(true);
    expect(page.container.textContent).toContain("The phone was unplugged");
    vi.mocked(setupAgentPhone).mockResolvedValue(done);
    await usbEvent("connect");
    expect(connectAgentPhone).toHaveBeenCalledTimes(2);
    expect(setupAgentPhone).toHaveBeenCalledTimes(2);
    const [first, resumed] = vi.mocked(setupAgentPhone).mock.calls.map(([options]) => options);
    expect(resumed!.signal.aborted).toBe(false);
    expect(resumed!.enrollments).toBe(first!.enrollments);
    expect(page.container.textContent).toContain("The phone is ready");
  });

  it("Try again continues the dialog's enrollments", async () => {
    vi.mocked(setupAgentPhone).mockResolvedValueOnce({
      issue: { code: "host-unreachable", detail: null },
      outcome: "issue",
      runnerId: null,
    });
    const page = await mount();
    await click(page.container, "Choose the phone");
    vi.mocked(setupAgentPhone).mockResolvedValueOnce(done);
    await click(page.container, "Try again");
    const [first, retried] = vi.mocked(setupAgentPhone).mock.calls.map(([options]) => options);
    expect(first!.enrollments).toBeInstanceOf(AgentPhoneEnrollments);
    expect(retried!.enrollments).toBe(first!.enrollments);
    expect(page.container.textContent).toContain("The phone is ready");
  });
});
