// @vitest-environment happy-dom
import type { DeploymentId } from "@opensteer/core";
import type { IphoneSetupPort } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import type { DesktopIphoneSetupStatus } from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { AddIphoneDialog } from "./add-iphone-dialog.js";

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
  deviceId: null,
  driverGeneration: null,
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

async function render(port: ReturnType<typeof fakePort>, onClose = () => undefined) {
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
