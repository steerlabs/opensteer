// @vitest-environment happy-dom
import { MockHostClient, mockWorkPolicy, type MockWorkHomeScene } from "@opensteer/client/mock";
import { workAuditKindValues } from "@opensteer/control-plane-protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext, useShell } from "./app-shell.js";
import { DevicesSection } from "./devices/devices-page.js";
import { SetUpThisMac } from "./devices/set-up-this-mac.js";
import type { ThisDevice } from "./devices/this-device.js";
import { WorkHomePolicyPage } from "./settings/sections/work-home-policy.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.dispose();
  host = undefined;
  document.body.replaceChildren();
});

/** A Settings-sized shell over a mock Home: a work Home under `scene`, or a personal one. */
async function render(element: ReactNode, scene: MockWorkHomeScene | null, at = "/") {
  host = new MockHostClient({
    latencyMs: 0,
    ...(scene ? { workPolicy: mockWorkPolicy(scene) } : {}),
  });
  const context = {
    hostClient: host,
    snapshot: host.getSnapshot(),
    desktopBridge: null,
    desktopDeployment: null,
    deploymentAccess: { deployments: [] },
    openMobileNavigation: () => undefined,
  } as unknown as React.ContextType<typeof ShellContext>;
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <ShellContext value={context}>
          <Routes>
            <Route element={element} path="/settings/work" />
            <Route element={<p>General</p>} path="/settings/general" />
            <Route element={element} path="/" />
          </Routes>
        </ShellContext>
      </MemoryRouter>,
    ),
  );
  return container;
}

const addButton = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Add a device"),
  )!;

describe("a work Home's Devices", () => {
  it("shows adding a device as unavailable, with why, when only its Cloud Computer may join", async () => {
    const container = await render(<DevicesSection />, "strict");
    await vi.waitFor(() => expect(addButton(container).disabled).toBe(true));
    expect(container.querySelector("#devices-add-limit")?.textContent).toBe(
      "Your organization doesn’t allow this",
    );
    expect(container.textContent).toContain("Northwind Logistics");
  });

  it("offers adding a device when the person may connect their own", async () => {
    const container = await render(<DevicesSection />, "open");
    await vi.waitFor(() => expect(container.textContent).toContain("Northwind Logistics"));
    expect(addButton(container).disabled).toBe(false);
    expect(container.textContent).not.toContain("doesn’t allow");
  });
});

describe("a personal Home", () => {
  it("looks as it always did: no mark, no limit, no page", async () => {
    const devices = await render(<DevicesSection />, null);
    await vi.waitFor(() => expect(addButton(devices)).toBeDefined());
    // The policy read settles to nothing; the screen never changes for it.
    await act(async () => host!.rpc["personal.shell.get"]({}));
    expect(addButton(devices).disabled).toBe(false);
    expect(devices.textContent).not.toContain("Work ·");
    expect(devices.textContent).not.toContain("organization");
    act(() => root?.unmount());
    host!.dispose();

    const page = await render(<WorkHomePolicyPage />, null, "/settings/work");
    await vi.waitFor(() => expect(page.textContent).toBe("General"));
  });
});

describe("What your organization can see", () => {
  it("says what it decided, exactly which records leave this Home, and what never does", async () => {
    const container = await render(<WorkHomePolicyPage />, "strict", "/settings/work");
    await vi.waitFor(() =>
      expect(container.querySelector("h1")?.textContent).toBe("What Northwind Logistics can see"),
    );
    expect(container.textContent).toContain("Only you can sign in to it.");
    expect(container.textContent).toContain(
      "Northwind Logistics can’t watch it, answer its Requests or act for you.",
    );
    const decides = container.querySelector('[aria-labelledby="work-home-decides"]')!;
    expect([...decides.querySelectorAll(".work-see__value")].map((v) => v.textContent)).toEqual([
      "Supervised",
      "Not allowed",
      "Not allowed",
      "Only this Cloud Computer",
    ]);
    expect(decides.textContent).toContain("Version 3");
    const records = container.querySelectorAll(".work-see__list li");
    expect(records).toHaveLength(workAuditKindValues.length);
    expect(records[0]?.textContent).toBe("An agent was connected, and by whom");
    const never = container.querySelector('[aria-labelledby="work-home-never"]')!.textContent;
    for (const item of [
      "Page content",
      "Screenshots",
      "Messages or prompts",
      "File names or paths",
    ])
      expect(never).toContain(item);
  });
});

/** The Mac's own step before it joins: its name and switches, and Connect. */
function joining() {
  const setUp = vi.fn(async () => undefined);
  const device = {
    step: "choose",
    stage: null,
    cause: null,
    choice: null,
    computerName: "Alex’s MacBook Air",
    homeName: "Northwind Cloud Computer",
    opensteerName: "Northwind Cloud Computer",
    devicesAvailable: true,
    setUp,
  } as unknown as ThisDevice;
  function TestSetup() {
    return <SetUpThisMac bridge={{} as never} device={device} hostClient={useShell().hostClient} />;
  }
  return { element: <TestSetup />, setUp };
}
const connect = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Connect")!;

describe("a Mac about to join", () => {
  it("says whose work Home it is joining, and joins", async () => {
    const { element, setUp } = joining();
    const container = await render(element, "open");
    expect(container.querySelector('[role="note"]')?.textContent).toBe(
      "This device is joining a work Home owned by Northwind Logistics. Northwind Logistics will see that it joined, never what’s on it.",
    );
    await act(async () => connect(container).click());
    expect(setUp).toHaveBeenCalledOnce();
  });

  it("says its organization keeps other devices out, and Connect waits", async () => {
    const { element, setUp } = joining();
    const container = await render(element, "strict");
    expect(container.querySelector('[role="note"]')?.textContent).toBe(
      "Northwind Logistics doesn’t allow other devices to join this work Home.",
    );
    expect(connect(container).disabled).toBe(true);
    await act(async () => connect(container).click());
    expect(setUp).not.toHaveBeenCalled();
  });

  it("joins a personal Home as it always did, with nothing new said", async () => {
    const { element, setUp } = joining();
    const container = await render(element, null);
    expect(container.querySelector('[role="note"]')).toBeNull();
    expect(container.textContent).not.toContain("work Home");
    await act(async () => connect(container).click());
    expect(setUp).toHaveBeenCalledOnce();
  });

  it("waits until the Home’s policy is known", async () => {
    const { element, setUp } = joining();
    const container = await render(element, null);
    // The shell hasn't brought the policy yet.
    const { effectiveWorkPolicy: _notYet, ...unknown } = host!.getSnapshot();
    await act(async () => {
      vi.spyOn(host!, "getSnapshot").mockReturnValue(unknown);
      host!.applyWorkPolicy(null);
    });
    expect(connect(container).disabled).toBe(true);
    await act(async () => connect(container).click());
    expect(setUp).not.toHaveBeenCalled();
    await act(async () => {
      vi.mocked(host!.getSnapshot).mockRestore();
      host!.applyWorkPolicy(null);
    });
    expect(connect(container).disabled).toBe(false);
    await act(async () => connect(container).click());
    expect(setUp).toHaveBeenCalledOnce();
  });
});
