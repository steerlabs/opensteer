// @vitest-environment happy-dom
import type { DeploymentId } from "@opensteer/core";
import type { IphoneSetupPort } from "@opensteer/client/host";
import { MockHostClient, mockIphoneScreenDeviceId } from "@opensteer/client/mock";
import type { DesktopIphoneSetupStatus } from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { AddIphoneDialog, type ExistingIphoneTarget } from "./add-iphone-dialog.js";

const deploymentId = "dep_11111111-1111-4111-8111-111111111111" as DeploymentId;
const setupId = "22222222-2222-4222-8222-222222222222";
const status = (patch: Partial<DesktopIphoneSetupStatus>): DesktopIphoneSetupStatus => ({
  setupId,
  deploymentId,
  step: "choose",
  reason: null,
  recoverable: true,
  personAction: "choose-phone",
  candidates: [
    {
      candidateId: "33333333-3333-4333-8333-333333333333",
      name: "Sam’s iPhone",
      model: "iPhone 17",
      osVersion: "27.1",
      reason: null,
    },
  ],
  attachCommand: null,
  target: null,
  deviceId: null,
  driverGeneration: null,
  wifiEnabled: false,
  ...patch,
});

let root: Root | undefined;
let client: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  client?.dispose();
  document.body.innerHTML = "";
});

function fakePort(overrides: { readonly begin?: () => Promise<DesktopIphoneSetupStatus> } = {}) {
  return {
    begin: vi.fn(overrides.begin ?? (async () => status({}))),
    choose: vi.fn(async () => status({ step: "trust", personAction: "unlock-and-trust" })),
    advance: vi.fn(async ({ step }: { step: string }) =>
      step === "trust"
        ? status({ step: "developer-mode", personAction: "continue" })
        : status({
            step: "developer-mode",
            reason: "developer-mode-required",
            personAction: "enable-developer-mode",
          }),
    ),
    status: vi.fn(async () => status({})),
    cancel: vi.fn(async () => undefined),
  };
}

async function render(
  port: ReturnType<typeof fakePort>,
  onClose = () => undefined,
  existing?: ExistingIphoneTarget,
) {
  client = new MockHostClient({ latencyMs: 0 });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AddIphoneDialog
          client={client!}
          deploymentId={deploymentId}
          deploymentName="Home"
          onClose={onClose}
          port={port as unknown as IphoneSetupPort}
          {...(existing ? { existing } : {})}
        />
      </MemoryRouter>,
    );
  });
}

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => {
    button.click();
  });
}

it("waits for the person to pick even a lone iPhone, carries on until a typed reason, and checks that same step again", async () => {
  const port = fakePort();
  const onClose = vi.fn();
  await render(port, onClose);
  expect(port.begin).toHaveBeenCalledWith({ deploymentId });
  expect(port.choose).not.toHaveBeenCalled();

  await click("Choose Sam’s iPhone");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Turn on Developer Mode"), {
    timeout: 1000,
  });
  expect(port.advance.mock.calls.map(([input]) => input.step)).toEqual(["trust", "developer-mode"]);

  await click("Check again");
  expect(port.advance).toHaveBeenLastCalledWith({ setupId, step: "developer-mode" });
  expect(port.advance).toHaveBeenCalledTimes(3);

  await click("Cancel");
  expect(onClose).toHaveBeenCalledOnce();
  act(() => root?.unmount());
  root = undefined;
  expect(port.cancel).toHaveBeenCalledWith({ setupId });
});

it("cancels the setup the Mac began after the dialog already closed", async () => {
  let resolveBegin: (value: DesktopIphoneSetupStatus) => void = () => undefined;
  const port = fakePort({
    begin: vi.fn(
      () => new Promise<DesktopIphoneSetupStatus>((resolve) => (resolveBegin = resolve)),
    ),
  });
  await render(port);
  act(() => root?.unmount());
  root = undefined;
  expect(port.cancel).not.toHaveBeenCalled();
  await act(async () => resolveBegin(status({})));
  expect(port.cancel).toHaveBeenCalledWith({ setupId });
});

function wifiPort(failures: readonly DesktopIphoneSetupStatus[]) {
  const replies = [...failures];
  let wifiEnabled = false;
  return {
    ...fakePort(),
    choose: vi.fn(async () => status({ step: "observe", personAction: "continue" })),
    advance: vi.fn(async () => status({ step: "wifi", personAction: "choose-wifi" })),
    wifi: vi.fn(async ({ action }: { action: string }) => {
      const failure = action === "skip" ? undefined : replies.shift();
      if (failure) return failure;
      wifiEnabled = action !== "skip";
      return status({ step: "attach", personAction: "continue", wifiEnabled });
    }),
    attach: vi.fn(async (_input: { setupId: string; name?: string }) =>
      status({
        step: "done",
        personAction: "none",
        deviceId: "dev_55555555-5555-4555-8555-555555555555",
        wifiEnabled,
      }),
    ),
  };
}

it("offers Wi‑Fi after the first look and adds the iPhone under its shown name when kept to the cable", async () => {
  const port = wifiPort([]);
  await render(port);
  await click("Choose Sam’s iPhone");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Also use it over Wi‑Fi?"), {
    timeout: 1000,
  });

  await click("Only when plugged in");
  expect(port.wifi).toHaveBeenCalledExactlyOnceWith({ setupId, action: "skip" });
  await click("Add iPhone");
  expect(port.attach).toHaveBeenCalledExactlyOnceWith({ setupId, name: "Sam’s iPhone" });
  expect(document.body.textContent).toContain("It works while it’s plugged into this Mac.");
});

it("retries Wi‑Fi with the fix each reason names, then adds it for the same Wi‑Fi", async () => {
  const port = wifiPort([
    status({ step: "wifi", reason: "wifi-not-enabled", personAction: "retry" }),
    status({ step: "wifi", reason: "wifi-pairing-required", personAction: "retry" }),
  ]);
  await render(port);
  await click("Choose Sam’s iPhone");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Also use it over Wi‑Fi?"), {
    timeout: 1000,
  });

  await click("Use Wi‑Fi too");
  expect(document.body.textContent).toContain("Wi‑Fi access didn’t turn on");
  await click("Try again");
  expect(document.body.textContent).toContain("Pair the iPhone for Wi‑Fi");
  await click("Pair again");
  expect(port.wifi.mock.calls.map(([input]) => input.action)).toEqual(["enable", "enable", "pair"]);

  await click("Add iPhone");
  expect(document.body.textContent).toContain(
    "It works while it’s plugged in or on the same Wi‑Fi as this Mac.",
  );
});

it("sets an existing iPhone up again under its own name, skipping the name step", async () => {
  const target = {
    kind: "existing",
    deviceId: mockIphoneScreenDeviceId,
    expectedGeneration: 2,
  } as const;
  const port = wifiPort([]);
  port.begin.mockImplementation(async () => status({ target }));
  port.choose.mockImplementation(async () =>
    status({ step: "observe", personAction: "continue", target }),
  );
  port.advance.mockImplementation(async () =>
    status({ step: "wifi", personAction: "choose-wifi", target }),
  );
  port.wifi.mockImplementation(async () =>
    status({ step: "attach", personAction: "continue", target }),
  );
  port.attach.mockImplementation(async () =>
    status({ step: "done", personAction: "none", deviceId: mockIphoneScreenDeviceId, target }),
  );
  await render(port, undefined, target);
  expect(port.begin).toHaveBeenCalledWith({ deploymentId, target });
  await vi.waitFor(
    () => expect(document.body.textContent).toContain("Which iPhone is Work iPhone?"),
    { timeout: 1000 },
  );
  expect(document.body.textContent).toContain("Set up Work iPhone again");

  await click("Choose Sam’s iPhone");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Also use it over Wi‑Fi?"), {
    timeout: 1000,
  });
  await click("Only when plugged in");
  expect(document.querySelector("input")).toBeNull();
  expect(document.body.textContent).toContain("Work iPhone keeps its name, approvals and tab.");
  await click("Connect it again");
  expect(port.attach).toHaveBeenCalledExactlyOnceWith({ setupId });
  expect(document.body.textContent).toContain("Work iPhone is connected again");
  expect(document.body.textContent).not.toContain("Open the iPhone’s page");
});
