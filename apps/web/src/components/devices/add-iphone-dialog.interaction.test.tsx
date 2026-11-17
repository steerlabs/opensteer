// @vitest-environment happy-dom
import type { DeploymentId } from "@opensteer/core";
import {
  createMockIphoneSetupPort,
  MockHostClient,
  mockIphoneScreenDeviceId,
  mockIphoneScreenDriverId,
  mockIphoneSetupCandidates,
  type MockIphoneSetupScene,
} from "@opensteer/client/mock";
import type { DesktopIphoneSetupStatus } from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { AddIphoneDialog, type ExistingIphoneTarget } from "./add-iphone-dialog.js";

const deploymentId = "dep_11111111-1111-4111-8111-111111111111" as DeploymentId;

let root: Root | undefined;
let client: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  client?.dispose();
  document.body.innerHTML = "";
});

function setupPort(
  start: MockIphoneSetupScene = "mac-checking",
  dispatch?: NonNullable<Parameters<typeof createMockIphoneSetupPort>[0]>["dispatch"],
) {
  const port = createMockIphoneSetupPort({
    start,
    driverRunnerId: mockIphoneScreenDriverId,
    ...(dispatch ? { dispatch } : {}),
  });
  for (const method of ["begin", "cancel", "choose", "help", "retry", "wifi", "attach"] as const)
    vi.spyOn(port, method);
  return port;
}

async function render(
  port: ReturnType<typeof setupPort>,
  options: { readonly onClose?: () => void; readonly existing?: ExistingIphoneTarget } = {},
) {
  client ??= new MockHostClient({ latencyMs: 0 });
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
          onClose={options.onClose ?? (() => undefined)}
          port={port}
          {...(options.existing ? { existing: options.existing } : {})}
        />
      </MemoryRouter>,
    );
  });
}

const buttons = () => [...document.querySelectorAll("button")];
const button = (label: string) =>
  buttons().find((element) => element.textContent?.trim().startsWith(label)) as
    HTMLButtonElement | undefined;
async function click(label: string) {
  const found = button(label);
  if (!found) throw new Error(`Missing ${label}`);
  await act(async () => found.click());
}
async function push(port: ReturnType<typeof setupPort>, scene: MockIphoneSetupScene) {
  await act(async () => {
    port.show(scene);
  });
}
const text = () => document.body.textContent ?? "";

it("follows what the Mac pushes, waits on the iPhone without a check button, and retries only when blocked", async () => {
  const port = setupPort();
  await render(port);
  expect(port.begin).toHaveBeenCalledWith({ deploymentId });
  expect(text()).toContain("You’ll need");

  await push(port, "xcode-missing");
  await click("Get Xcode");
  expect(port.help).toHaveBeenCalledWith({ setupId: port.current!.setupId, action: "get-xcode" });

  await push(port, "trust");
  expect(text()).toContain("Waiting for you to tap Trust…");
  expect(text()).not.toContain("You’ll need");
  expect(buttons().flatMap((element) => element.textContent?.trim() || [])).toEqual(["Cancel"]);

  await push(port, "prepare-failed");
  await click("Try again");
  expect(port.retry).toHaveBeenCalledExactlyOnceWith({ setupId: port.current!.setupId });
  expect(text()).toContain("Getting Sam’s iPhone ready");
});

it("asks which iPhone only among several, and can't pick one that isn't supported", async () => {
  const port = setupPort("choose");
  await render(port);
  const choices = [...document.querySelectorAll(".iphone-setup__choices > *")];
  expect(choices.map((choice) => choice.tagName)).toEqual(["BUTTON", "BUTTON", "DIV"]);
  expect(document.activeElement).toBe(choices[0]);
  expect(text()).toContain("An iPhone that hasn’t trusted this Mac yet");

  await act(async () => (choices[1] as HTMLButtonElement).click());
  expect(port.choose).toHaveBeenCalledExactlyOnceWith({
    setupId: port.current!.setupId,
    candidateId: mockIphoneSetupCandidates.untrusted.candidateId,
  });
});

it("starts a stopped setup over as a new one", async () => {
  const port = setupPort("broken");
  await render(port);
  const first = port.current!.setupId;
  await click("Start over");
  expect(port.cancel).toHaveBeenCalledWith({ setupId: first });
  expect(port.begin).toHaveBeenCalledTimes(2);
  expect(port.current!.setupId).not.toBe(first);

  // The new setup is the one followed: the old one's pushes no longer reach the dialog.
  await push(port, "trust");
  expect(text()).toContain("Tap Trust on your iPhone");
});

it("cancels setup on the Mac when the dialog closes, even one that began as it closed", async () => {
  const onClose = vi.fn();
  const port = setupPort("trust");
  await render(port, { onClose });
  const id = port.current!.setupId;
  await click("Cancel");
  expect(onClose).toHaveBeenCalledOnce();
  act(() => root?.unmount());
  root = undefined;
  expect(port.cancel).toHaveBeenCalledWith({ setupId: id });

  let resolve: (status: DesktopIphoneSetupStatus) => void = () => undefined;
  const late = setupPort();
  vi.mocked(late.begin).mockImplementation(() => new Promise((done) => (resolve = done)));
  await render(late);
  act(() => root?.unmount());
  root = undefined;
  expect(late.cancel).not.toHaveBeenCalled();
  await act(async () =>
    resolve({ ...port.current!, setupId: "77777777-7777-4777-8777-777777777777" }),
  );
  expect(late.cancel).toHaveBeenCalledWith({ setupId: "77777777-7777-4777-8777-777777777777" });
});

it("fixes an existing iPhone's setup under its own name", async () => {
  const existing = {
    kind: "existing",
    deviceId: mockIphoneScreenDeviceId,
    expectedGeneration: 1,
  } as const;
  const port = setupPort("name");
  await render(port, { existing });
  expect(port.begin).toHaveBeenCalledWith({ deploymentId, target: existing });
  expect(text()).toContain("Fix setup for Work iPhone");
  expect(text()).not.toContain("You’ll need");
  expect(document.querySelector("input")).toBeNull();

  await click("Connect it again");
  expect(port.attach).toHaveBeenCalledExactlyOnceWith({ setupId: port.current!.setupId });
  await push(port, "done");
  expect(text()).toContain("Work iPhone is set up again");
  expect(text()).not.toContain("What can your agent do with it?");
});

it("adds a new iPhone under its name, then sets what the agent may do through the Host", async () => {
  client = new MockHostClient({ latencyMs: 0 });
  const host = client;
  const port = setupPort("name", (command) => host.dispatch(command));
  await render(port);
  const input = document.querySelector("input") as HTMLInputElement;
  expect(input.value).toBe("Sam’s iPhone 17 Pro");
  expect(document.activeElement).toBe(input);

  await click("Add iPhone");
  expect(port.attach).toHaveBeenCalledExactlyOnceWith({
    setupId: port.current!.setupId,
    name: "Sam’s iPhone 17 Pro",
  });
  await vi.waitFor(() => expect(port.current?.deviceId).not.toBeNull(), { timeout: 1000 });
  const deviceId = port.current!.deviceId!;
  await push(port, "done");
  await vi.waitFor(() => expect(text()).toContain("What can your agent do with it?"), {
    timeout: 1000,
  });
  const radio = (title: string) =>
    [...document.querySelectorAll<HTMLLabelElement>(".iphone-setup__access label")]
      .find((label) => label.textContent?.startsWith(title))!
      .querySelector("input")!;
  await vi.waitFor(() => expect(radio("Not yet").checked).toBe(true), { timeout: 1000 });

  await act(async () => radio("View and control").click());
  await vi.waitFor(
    () => {
      const phone = host.getSnapshot().machines.find(({ id }) => id === deviceId);
      expect(phone?.capabilities?.apps.enabled).toBe(true);
      expect(radio("View and control").checked).toBe(true);
    },
    { timeout: 2000 },
  );
  expect(text()).toContain("Open the iPhone’s page");
});

it("keeps the highest revision across pushed updates and call replies", async () => {
  const port = setupPort("xcode-missing");
  await render(port);
  const stale = port.current!;
  const reply = Promise.withResolvers<DesktopIphoneSetupStatus>();
  vi.mocked(port.help).mockReturnValueOnce(reply.promise);
  await click("Get Xcode");
  await push(port, "wifi-local-network");
  await act(async () => reply.resolve(stale));
  expect(button("Open Local Network settings")).toBeDefined();

  const newerReply = Promise.withResolvers<DesktopIphoneSetupStatus>();
  vi.mocked(port.help).mockReturnValueOnce(newerReply.promise);
  await click("Open Local Network settings");
  await push(port, "xcode-missing");
  await act(async () =>
    newerReply.resolve({
      ...port.current!,
      revision: port.current!.revision + 10,
      action: "open-xcode",
      reason: "xcode-setup-required",
    }),
  );
  expect(button("Open Xcode")).toBeDefined();
  await push(port, "xcode-missing");
  expect(button("Open Xcode")).toBeDefined();
});

it("opens Local Network settings through the Mac's offered help action", async () => {
  const port = setupPort("wifi-local-network");
  await render(port);
  await click("Open Local Network settings");
  expect(port.help).toHaveBeenCalledExactlyOnceWith({
    setupId: port.current!.setupId,
    action: "open-local-network",
  });
});

it("retries a failed Host attach with the original command and finishes", async () => {
  const dispatch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
    type: "iphone.screen.attach",
    deviceId: mockIphoneScreenDeviceId,
    generation: 1,
  });
  const port = setupPort("name", dispatch);
  await render(port);
  await click("Add iPhone");
  expect(text()).toContain("Couldn’t reach Home");
  await click("Try again");
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch.mock.calls[1]![0]).toEqual(dispatch.mock.calls[0]![0]);
  expect(port.current).toMatchObject({
    reason: "assignment-pending",
    deviceId: mockIphoneScreenDeviceId,
  });
});
