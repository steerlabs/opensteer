// @vitest-environment happy-dom

import { createId, emptyExecutionPreferences } from "@opensteer/core";
import type { HostSnapshot } from "@opensteer/client/host";
import { MockHostClient, mockPasswordSignInRequest } from "@opensteer/client/mock";
import {
  DesktopDeploymentSummarySchema,
  type DesktopPasswordsStatus,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellContext } from "../../app-shell.js";
import { SettingsSectionRoute, SettingsShell } from "../settings-shell.js";

/*
 * How Settings → Passwords could mislead or misfire:
 * - the section is missing from "What agents can use", or not right after Chrome;
 * - a browser tab, a phone-sized window or the desktop app on another computer
 *   draws controls that only work on the Mac that runs this Opensteer, or asks
 *   that Mac's bridge for a status it does not have;
 * - a server or cloud Opensteer points at a Mac it does not have;
 * - a Mac that can never keep Passwords is offered Set up;
 * - the status read fails, or the Mac says Passwords is unavailable, and the
 *   page offers no way to read it again;
 * - a change made in the Passwords window (turned off, a sign-in answered,
 *   setup finished) never reaches the page, or keeps arriving after it closed;
 * - it counts sign-ins the Mac no longer reports (the old queue), or misses the
 *   sign-in Requests waiting in conversations;
 * - Don’t allow all runs twice, declines anything but the waiting sign-ins, or
 *   uses anything but the decline command each card uses;
 * - Open Passwords asks for a view the window no longer has;
 * - a failure from the bridge is swallowed;
 * - a development build's vault is not marked as test data only.
 */

const roots: Root[] = [];
const noOp = () => undefined;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("Settings → Passwords on the Mac that keeps them", () => {
  it("sits right after Chrome in what agents can use", async () => {
    const page = await mount({ bridge: fakeBridge(available("not-set-up")).bridge });
    const links = [
      ...page.querySelectorAll<HTMLAnchorElement>(
        ".settings-navigation__group .settings-navigation__link",
      ),
    ].map((link) => link.getAttribute("href"));
    expect(links.slice(-2)).toEqual(["/settings/chrome", "/settings/passwords"]);
    expect(page.querySelector(".settings-section__title")?.textContent).toBe("Passwords");
  });

  it("explains Passwords before setup and opens setup in the Passwords window", async () => {
    const fake = fakeBridge(available("not-set-up"));
    const page = await mount({ bridge: fake.bridge });
    expect(text(page)).toContain(
      "Let agents sign in to websites and apps with passwords saved on this Mac. Opensteer never sends your password to the agent; it types it into the website or app, which can read it. You allow an account with Touch ID or your Mac password.",
    );
    expect(text(page)).toContain("Import from Chrome, Safari, Firefox, 1Password or Bitwarden.");
    expect(text(page)).toContain(
      "Opensteer fills the fields the agent focuses on, in the browser, on your phone or in Mac apps.",
    );
    expect(text(page)).toContain(
      "In the browser, each password goes only to its own website. In apps, the agent checks it’s the real app.",
    );
    expect(buttons(page)).toEqual(["Set up Passwords"]);
    await click(button(page, "Set up Passwords"));
    expect(fake.bridge.passwordsOpen).toHaveBeenCalledExactlyOnceWith();
  });

  it("shows what agents may do and follows changes made in the window", async () => {
    const fake = fakeBridge(available("ready"));
    const page = await mount({ bridge: fake.bridge });
    expect(text(page)).toContain("Agents can sign in with your passwords");
    expect(page.querySelector(".chip")?.textContent).toBe("On");
    expect(text(page)).not.toContain("Waiting for you");
    expect(text(page)).toContain(
      "You allow an account once per Workspace with Touch ID or your Mac password. After that, agents there sign in with it on their own.",
    );
    expect(text(page)).toContain("Take that access away any time in the Passwords window.");
    expect(text(page)).toContain("Sign-ins can stay saved in the browser profile.");
    expect(text(page)).toContain("Sites you allowed from Chrome keep using Chrome.");
    expect(buttons(page)).toEqual(["Open Passwords"]);
    await click(button(page, "Open Passwords"));
    expect(fake.bridge.passwordsOpen).toHaveBeenCalledExactlyOnceWith();

    // The person turns agent sign-ins off in the Passwords window.
    await act(async () => fake.emit(available("ready", { agentSignIns: "off" })));
    expect(page.querySelector(".chip")?.textContent).toBe("Off");
  });

  it("declines every sign-in waiting in a conversation, once each, as its card would", async () => {
    const first = mockPasswordSignInRequest({ index: 1 });
    const second = mockPasswordSignInRequest({ index: 2 });
    const client = new MockHostClient({ latencyMs: 0, pendingRequests: [first, second] });
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const settle = client.dispatch.bind(client);
    // Each decline settles its own Request once the gate opens, as the Host's would.
    const dispatch = vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      await gate;
      return settle(command);
    });
    const fake = fakeBridge(available("ready"));
    const page = await mount({ bridge: fake.bridge, client });
    expect(text(page)).toContain("Waiting for you");
    expect(text(page)).toContain("2 sign-ins to answer in their conversations");
    expect(buttons(page)).toEqual(["Don’t allow all", "Open Passwords"]);

    await click(button(page, "Don’t allow all"));
    expect(button(page, "Not allowing…").disabled).toBe(true);
    await click(button(page, "Not allowing…"));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      dispatch.mock.calls
        .map(([command]) => ("requestId" in command ? command.requestId : null))
        .sort(),
    ).toEqual([first.id, second.id]);
    expect(
      dispatch.mock.calls.every(([command]) => command.type === "browser.password-sign-in.decline"),
    ).toBe(true);
    await act(async () => {
      open();
      await gate;
    });
    await act(async () => undefined);
    expect(text(page)).not.toContain("Waiting for you");
    expect(buttons(page)).toEqual(["Open Passwords"]);
  });

  it("stops listening once the page closes", async () => {
    const fake = fakeBridge(available("ready"));
    await mount({ bridge: fake.bridge });
    expect(fake.listeners.size).toBe(1);
    for (const root of roots.splice(0)) act(() => root.unmount());
    expect(fake.listeners.size).toBe(0);
  });

  it("counts and declines only sign-ins still waiting for the person", async () => {
    const approval = mockPasswordSignInRequest({ index: 1 });
    const signingIn = mockPasswordSignInRequest({ index: 2 });
    const needsYou = mockPasswordSignInRequest({ index: 3 });
    const client = new MockHostClient({
      latencyMs: 0,
      pendingRequests: [approval, signingIn, needsYou],
    });
    const dispatch = vi.spyOn(client, "dispatch");
    const fake = fakeBridge(available("ready"));
    if (signingIn.payload.kind !== "browser.password-sign-in") throw new Error("Expected sign-in");
    const signingInOperationId = signingIn.payload.operationId;
    fake.bridge.passwordsSignInGet.mockImplementation(async ({ operationId }) =>
      operationId === signingInOperationId
        ? { stage: "authorized", account: "t•••@example.com" }
        : { stage: "approval", accounts: [], site: "https://github.com" },
    );
    const page = await mount({ bridge: fake.bridge, client });
    expect(text(page)).toContain("2 sign-ins to answer in their conversations");
    await click(button(page, "Don’t allow all"));
    expect(
      dispatch.mock.calls
        .map(([command]) => ("requestId" in command ? command.requestId : null))
        .sort(),
    ).toEqual([approval.id, needsYou.id].sort());
    expect(
      client.getSnapshot().waitingRequests.some(({ request }) => request.id === signingIn.id),
    ).toBe(true);
  });

  it.each([
    ["platform", "Passwords is available in the Opensteer app on a Mac."],
    [
      "hardware",
      "This Mac can’t keep Opensteer Passwords. It needs Touch ID–class security hardware (Apple silicon, or an Intel Mac with a T2 chip).",
    ],
    ["os", "Opensteer Passwords doesn’t work on this version of macOS yet."],
  ] as const)("offers nothing on a Mac that can’t keep Passwords (%s)", async (reason, message) => {
    const page = await mount({
      bridge: fakeBridge({ availability: "unsupported", reason }).bridge,
    });
    expect(text(page)).toContain(message);
    expect(buttons(page)).toEqual([]);
  });

  it("says why Passwords can’t be reached, and reads it again on Try again", async () => {
    const fake = fakeBridge({ availability: "unavailable", message: "Passwords isn’t running." });
    const page = await mount({ bridge: fake.bridge });
    expect(text(page)).toContain("Passwords isn’t running.");
    fake.set(available("ready"));
    await click(button(page, "Try again"));
    expect(fake.bridge.passwordsStatus).toHaveBeenCalledTimes(2);
    expect(text(page)).toContain("Agents can sign in with your passwords");
  });

  it("shows a failed read with Try again rather than loading forever", async () => {
    const fake = fakeBridge(new Error("The Opensteer app couldn’t reach Passwords."));
    const page = await mount({ bridge: fake.bridge });
    expect(text(page)).toContain("The Opensteer app couldn’t reach Passwords.");
    expect(buttons(page)).toEqual(["Try again"]);
  });

  it("starts fresh when the saved passwords came from another Mac", async () => {
    const fake = fakeBridge(available("needs-reset"));
    const page = await mount({ bridge: fake.bridge });
    expect(text(page)).toContain(
      "Set up Opensteer Passwords again. The passwords saved here before can’t be opened on this Mac.",
    );
    await click(button(page, "Open Passwords"));
    expect(fake.bridge.passwordsOpen).toHaveBeenCalledExactlyOnceWith();
  });

  it("marks a development build as test data only", async () => {
    const page = await mount({
      bridge: fakeBridge(available("ready", { development: true })).bridge,
    });
    expect(text(page)).toContain("Development build: use test passwords only.");
    const release = await mount({ bridge: fakeBridge(available("ready")).bridge });
    expect(text(release)).not.toContain("Development build");
  });

  it("says a failed action under the card that raised it", async () => {
    const fake = fakeBridge(available("not-set-up"));
    vi.mocked(fake.bridge.passwordsOpen).mockRejectedValueOnce(
      new Error("Opensteer Passwords didn’t open."),
    );
    const page = await mount({ bridge: fake.bridge });
    await click(button(page, "Set up Passwords"));
    expect(page.querySelector("[role=alert]")?.textContent).toBe(
      "Opensteer Passwords didn’t open.",
    );
    expect(button(page, "Set up Passwords").disabled).toBe(false);
  });
});

describe("Settings → Passwords anywhere else", () => {
  it("names the Mac that keeps them, from a browser or another computer's app", async () => {
    const tab = await mount({});
    expect(text(tab)).toContain(
      "Passwords are kept in the Opensteer app on Mac mini. Set them up and manage them there.",
    );
    expect(buttons(tab)).toEqual([]);

    const fake = fakeBridge(available("ready"));
    const remote = await mount({ bridge: fake.bridge, onThisComputer: false });
    expect(text(remote)).toContain("Passwords are kept in the Opensteer app on Mac mini.");
    expect(fake.bridge.passwordsStatus).not.toHaveBeenCalled();
    expect(fake.listeners.size).toBe(0);
  });

  it("says a server or cloud Opensteer has none yet", async () => {
    const page = await mount({ server: true });
    expect(text(page)).toContain(
      "Saved-password sign-ins are available on a Personal Opensteer for now.",
    );
    expect(text(page)).not.toContain("Mac mini");
    expect(buttons(page)).toEqual([]);
  });
});

function available(
  vault: "needs-reset" | "not-set-up" | "ready",
  broker: { readonly agentSignIns?: "off" | "on"; readonly development?: boolean } = {},
): DesktopPasswordsStatus {
  return {
    availability: "available",
    broker: { agentSignIns: broker.agentSignIns ?? "on", vault },
    development: broker.development ?? false,
  };
}

function fakeBridge(initial: DesktopPasswordsStatus | Error) {
  let current = initial;
  const listeners = new Set<(status: DesktopPasswordsStatus) => void>();
  const bridge = {
    passwordsSignInGet: vi.fn(
      async (_input: {
        readonly operationId: string;
      }): ReturnType<OpensteerDesktopBridge["passwordsSignInGet"]> => ({
        stage: "approval",
        accounts: [],
        site: "https://github.com",
      }),
    ),
    onPasswordsSignInChanged: vi.fn(() => () => undefined),
    onPasswordsStatusChanged: vi.fn((listener: (status: DesktopPasswordsStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    passwordsOpen: vi.fn(async () => undefined),
    passwordsStatus: vi.fn(async () => {
      if (current instanceof Error) throw current;
      return current;
    }),
  };
  return {
    bridge: bridge as typeof bridge & OpensteerDesktopBridge,
    emit: (status: DesktopPasswordsStatus) => {
      for (const listener of listeners) listener(status);
    },
    listeners,
    set: (status: DesktopPasswordsStatus) => {
      current = status;
    },
  };
}

async function mount(input: {
  readonly bridge?: OpensteerDesktopBridge;
  readonly client?: MockHostClient;
  readonly onThisComputer?: boolean;
  readonly server?: boolean;
}): Promise<HTMLElement> {
  const hostClient = input.client ?? new MockHostClient({ latencyMs: 0 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = () => root.render(page(hostClient, input));
  hostClient.subscribe(render);
  await act(async () => render());
  await act(async () => undefined);
  return container;
}

function page(
  hostClient: MockHostClient,
  input: {
    readonly bridge?: OpensteerDesktopBridge;
    readonly onThisComputer?: boolean;
    readonly server?: boolean;
  },
) {
  const base = hostClient.getSnapshot();
  const snapshot: HostSnapshot = input.server
    ? {
        ...base,
        deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
        identityConfig: base.identityConfig && {
          ...base.identityConfig,
          deployment: { cloud: true, kind: "self-hosted", name: "Design Cloud" },
          publicOrigin: "https://design.example.test",
        },
      }
    : base;
  const origin = "http://127.0.0.1:43110";
  const context: ShellContext = {
    actionError: null,
    askOpensteerAbout: noOp,
    clearActionError: noOp,
    clearHomeHandoff: noOp,
    createThreadAndSend: async () => null,
    defaultPlacement: undefined,
    deploymentAccess: null,
    desktopBridge: input.bridge ?? null,
    desktopDeployment:
      input.bridge && !input.server
        ? DesktopDeploymentSummarySchema.parse({
            access: input.onThisComputer === false ? "connect" : "owner",
            activeOrigin: origin,
            canonicalOrigin: origin,
            id: createId("deployment"),
            kind: "personal",
            lastUsedAt: null,
            name: "Mac mini",
            onThisComputer: input.onThisComputer ?? true,
            routes: [{ kind: "canonical", origin, selected: true }],
          })
        : null,
    executionPreferences: emptyExecutionPreferences,
    homeDraft: "",
    homeHandoff: null,
    homeThreadId: null,
    hostClient,
    localExecutionAction: null,
    localExecutionError: null,
    localExecutionStatus: null,
    openHarnessAuthentication: null,
    refreshHarnessCatalog: async () => undefined,
    leaveSettings: noOp,
    openMobileNavigation: noOp,
    openNewWorkspace: noOp,
    openSharing: noOp,
    performLocalExecutionAction: async () => undefined,
    placements: [],
    rememberExecution: noOp,
    reportActionError: noOp,
    setTaskDone: noOp,
    setHomeDraft: noOp,
    snapshot: { ...snapshot, connection: "connected" },
    writeInChat: noOp,
  };
  return (
    <MemoryRouter initialEntries={["/settings/passwords"]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route element={<SettingsShell />} path="settings">
            <Route element={<SettingsSectionRoute section="passwords" />} path="passwords" />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function content(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".settings-content") ?? container;
}

function text(container: HTMLElement): string {
  return content(container).textContent ?? "";
}

function buttons(container: HTMLElement): readonly string[] {
  return [...content(container).querySelectorAll(".settings-content__inner button")].map(
    (candidate) => candidate.textContent ?? "",
  );
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...content(container).querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${label}: ${buttons(container).join(", ")}`);
  }
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}
