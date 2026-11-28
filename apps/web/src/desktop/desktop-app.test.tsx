// @vitest-environment happy-dom

import { createId } from "@opensteer/core";
import {
  MockCloudComputerAccount,
  mockCloudComputerDeploymentId,
  type MockCloudComputerScene,
} from "@opensteer/client/mock";
import {
  DeploymentAccessSnapshotSchema,
  DesktopDeploymentSummarySchema,
  DesktopPersonalDeploymentStatusSchema,
  type DeploymentAccessSnapshot,
  type DesktopPersonalDeploymentStatus,
  type DeploymentAccessDeployment,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
// Preload the lazy app bundle outside per-test timeouts so fake-timer gate checks run immediately.
import "../app.js";
import {
  forgetRemoteAccessOnStart,
  remoteAccessWishHeld,
} from "../components/first-run/remote-access-on-start.js";
import {
  DesktopApp,
  chooserNotice,
  desktopAccessPresentationFromSnapshot,
  placeAwaitingSignIn,
} from "./desktop-app.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps confirmation fenced while exposing its failure, retry, leave and the chooser", async () => {
  const selected = accessDeployment("needs-sign-in");
  const access = snapshot({ deployments: [selected], selectedDeploymentId: selected.id });
  const retryGate = Promise.withResolvers<void>();
  const retryDeviceConnection = vi.fn(async () => retryGate.promise);
  const leaveDeployment = vi.fn(async () => undefined);
  const setUpDevice = vi.fn();
  const bridge = {
    retryDeviceConnection,
    leaveDeployment,
    setUpDevice,
    checkDeployments: async () => undefined,
    getDeploymentAccessSnapshot: async () => access,
    getLocalExecutionStatus: async () => ({
      deploymentId: selected.id,
      runner: {
        state: "failed",
        detail: "Home is offline; runner route refused the connection.",
        enrolled: true,
        runnerId: createId("runner"),
        environmentId: null,
      },
      membership: {
        state: "active",
        sessionState: "confirming",
        runnerId: createId("runner"),
        generation: 3,
      },
    }),
    onHostWebSocketEvent: () => () => undefined,
    onDeploymentAccessSnapshotChanged: () => () => undefined,
    onNotificationActivated: () => () => undefined,
    onLocalExecutionStatusChanged: () => () => undefined,
  } as unknown as OpensteerDesktopBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DesktopApp bridge={bridge} />));
    await vi.waitFor(() => expect(container.textContent).toContain("Home is offline"));
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === label,
      );
      expect(button, label).toBeDefined();
      await act(async () => button!.click());
    };
    await click("Retry");
    expect(retryDeviceConnection).toHaveBeenCalledWith({ deploymentId: selected.id });
    await click("Leave this Opensteer");
    expect(leaveDeployment).toHaveBeenCalledWith({ deploymentId: selected.id });
    await act(async () => retryGate.resolve());
    await click("Choose an Opensteer");
    expect(container.textContent).toContain("Open your Opensteer");
    expect(container.textContent).not.toContain("Checking this Mac’s connection");
    expect(setUpDevice).not.toHaveBeenCalled();
  } finally {
    retryGate.resolve();
    await act(async () => root.unmount());
    container.remove();
  }
});

it("lets a connecting place go back and shows cancellation failures", async () => {
  const cancel = vi.fn(async () => {
    throw new Error("The connection could not be cancelled.");
  });
  const connecting = accessDeployment("connecting");
  const access = snapshot({
    deployments: [connecting],
    selectedDeploymentId: connecting.id,
  });
  const bridge = {
    cancel,
    getDeploymentAccessSnapshot: async () => access,
    onHostWebSocketEvent: () => () => undefined,
    onDeploymentAccessSnapshotChanged: () => () => undefined,
    onNotificationActivated: () => () => undefined,
    getLocalExecutionStatus: async () => {
      throw new Error("No local execution in this test.");
    },
    onLocalExecutionStatusChanged: () => () => undefined,
  } as unknown as OpensteerDesktopBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<DesktopApp bridge={bridge} />));
  await vi.waitFor(() => {
    expect(container.textContent).toContain("Back");
  });

  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Back",
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());

  expect(cancel).toHaveBeenCalledOnce();
  // The failure is said in the app's words, never the exception's own text.
  await vi.waitFor(() => {
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "That didn’t work. Try again.",
    );
  });
  expect(container.textContent).not.toContain("The connection could not be cancelled.");

  await act(async () => root.unmount());
  container.remove();
});

it("carries setup from creating this computer straight into the app it opens", async () => {
  let access = snapshot({
    account: { available: false, status: "signed-out" },
    personalSetup: personalStatus({
      canStart: true,
      deploymentId: null,
      name: "Studio Mac",
      state: "stopped",
      step: null,
    }),
  });
  const listeners = new Set<(next: DeploymentAccessSnapshot) => void>();
  const emit = (next: DeploymentAccessSnapshot) => {
    access = next;
    for (const listener of listeners) listener(next);
  };
  const createPersonalDeployment = vi.fn(async () => undefined);
  const bridge = {
    createPersonalDeployment,
    getDeploymentAccessSnapshot: async () => access,
    onHostWebSocketEvent: () => () => undefined,
    onDeploymentAccessSnapshotChanged: (listener: (next: DeploymentAccessSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onNotificationActivated: () => () => undefined,
    getLocalExecutionStatus: async () => {
      throw new Error("No local execution in this test.");
    },
    onLocalExecutionStatusChanged: () => () => undefined,
  } as unknown as OpensteerDesktopBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<DesktopApp bridge={bridge} />));
  await vi.waitFor(() => expect(container.textContent).toContain("Welcome to Opensteer"));
  expect(container.textContent).toContain("Studio Mac");

  // The name is chosen before setup creates anything, and setup is created with it.
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.startsWith(label),
    )!;
  await act(async () => button("Rename").click());
  const field = container.querySelector<HTMLInputElement>("#desktop-entry-name")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "Workshop",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => field.form!.requestSubmit());
  expect(container.textContent).toContain("Workshop");
  await act(async () => button("Start Opensteer on this").click());
  expect(createPersonalDeployment).toHaveBeenCalledExactlyOnceWith({ name: "Workshop" });

  // What the supervisor sends: the Deployment's id from the first step, long
  // before the list has it, and then listed before it attaches. Neither may
  // bring back the screens from before setup began.
  const personalId = createId("deployment");
  const steps = [
    { deployments: [], step: "checking-computer" as const },
    { deployments: [], step: "starting-host" as const },
    {
      deployments: [{ ...accessDeployment("idle"), ...personalSummary(personalId) }],
      step: "preparing-agent-home" as const,
    },
  ];
  for (const [index, { deployments, step }] of steps.entries()) {
    await act(async () =>
      emit(
        snapshot({
          account: { available: false, status: "signed-out" },
          deployments,
          personalSetup: personalStatus({ deploymentId: personalId, name: "Workshop", step }),
          revision: index + 2,
          selectedDeploymentId: deployments.length ? personalId : null,
        }),
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Starting Opensteer on this "));
    expect(container.textContent).toContain("Workshop");
    expect(container.textContent).not.toContain("Welcome to Opensteer");
    expect(container.textContent).not.toContain("Open your Opensteer");
  }

  // Ready, and the app is still attaching: setup's own frame stays up rather
  // than a separate loading screen.
  await act(async () =>
    emit(
      snapshot({
        account: { available: false, status: "signed-out" },
        deployments: [{ ...accessDeployment("connecting"), ...personalSummary(personalId) }],
        personalSetup: personalStatus({
          deploymentId: personalId,
          name: "Workshop",
          state: "ready",
          step: "ready",
        }),
        revision: 10,
        selectedDeploymentId: personalId,
      }),
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Your AI"));
  expect(container.textContent).not.toContain("Opening Opensteer…");

  await act(async () => root.unmount());
  container.remove();
});

it("wishes Remote access on only for On this Mac while signed in, and answers the card Not now for a Home without an account", async () => {
  const personalId = createId("deployment");
  const run = async (account: DeploymentAccessSnapshot["account"]) => {
    localStorage.clear();
    let access = snapshot({
      account,
      personalSetup: personalStatus({
        canStart: true,
        deploymentId: null,
        name: "Studio Mac",
        state: "stopped",
        step: null,
      }),
    });
    const listeners = new Set<(next: DeploymentAccessSnapshot) => void>();
    const bridge = {
      checkDeployments: vi.fn(async () => undefined),
      cloudComputerRead: vi.fn(async () => ({
        ok: false,
        failure: { kind: "unavailable", message: "None in this test." },
      })),
      createPersonalDeployment: vi.fn(async () => undefined),
      getDeploymentAccessSnapshot: async () => access,
      onHostWebSocketEvent: () => () => undefined,
      onDeploymentAccessSnapshotChanged: (listener: (next: DeploymentAccessSnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onNotificationActivated: () => () => undefined,
      getLocalExecutionStatus: async () => {
        throw new Error("No local execution in this test.");
      },
      onLocalExecutionStatusChanged: () => () => undefined,
    } as unknown as OpensteerDesktopBridge;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<DesktopApp bridge={bridge} />));
    const find = (label: string) =>
      vi.waitFor(() => {
        const found = [...container.querySelectorAll("button")].find((candidate) =>
          candidate.textContent?.startsWith(label),
        );
        if (!found) throw new Error(`No ${label} in ${container.textContent ?? ""}`);
        return found;
      });
    if (account.status !== "signed-in") {
      const without = await find("Use without an account");
      await act(async () => without.click());
    }
    const start = await find(account.status === "signed-in" ? "On this Mac" : "Start Opensteer on");
    await act(async () => start.click());
    access = snapshot({
      account,
      deployments: [{ ...accessDeployment("connecting"), ...personalSummary(personalId) }],
      personalSetup: personalStatus({
        deploymentId: personalId,
        name: "Studio Mac",
        step: "ready",
      }),
      revision: 5,
      selectedDeploymentId: personalId,
    });
    await act(async () => {
      for (const listener of listeners) listener(access);
    });
    const outcome = {
      wish: remoteAccessWishHeld(),
      card: localStorage.getItem(`opensteer.sign-in-invite.v1:${personalId}`),
    };
    await act(async () => root.unmount());
    container.remove();
    forgetRemoteAccessOnStart();
    return outcome;
  };
  expect(
    await run({
      available: true,
      issuer: "https://accounts.opensteer.test",
      status: "signed-in",
      subject: "acct_a",
    } as never),
  ).toEqual({ wish: true, card: null });
  // Started without an account: no wish, and not asked to sign in on the next screen.
  expect(await run({ available: true, status: "signed-out" } as never)).toEqual({
    wish: false,
    card: "not-now",
  });
});

it("never wishes Remote access on for a separate Opensteer started from the list", async () => {
  localStorage.clear();
  const listed: DeploymentAccessDeployment = {
    ...accessDeployment("idle"),
    name: "Studio",
    source: "account",
  };
  const account = {
    available: true,
    issuer: "https://accounts.opensteer.test",
    status: "signed-in",
    subject: "acct_a",
  } as never;
  let access = snapshot({
    account,
    deployments: [listed],
    personalSetup: personalStatus({ canStart: true, state: "stopped", step: null }),
  });
  const listeners = new Set<(next: DeploymentAccessSnapshot) => void>();
  const createPersonalDeployment = vi.fn(async () => undefined);
  const bridge = {
    checkDeployments: async () => undefined,
    createPersonalDeployment,
    getDeploymentAccessSnapshot: async () => access,
    onHostWebSocketEvent: () => () => undefined,
    onDeploymentAccessSnapshotChanged: (listener: (next: DeploymentAccessSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onNotificationActivated: () => () => undefined,
    onLocalExecutionStatusChanged: () => () => undefined,
  } as unknown as OpensteerDesktopBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.startsWith(label),
    );
  await act(async () => root.render(<DesktopApp bridge={bridge} />));
  await vi.waitFor(() => expect(container.textContent).toContain("Studio"));
  await act(async () => button("Other ways in")!.click());
  await act(async () => button("Start a separate Opensteer on this")!.click());
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Start separate Opensteer")!
      .click(),
  );
  expect(createPersonalDeployment).toHaveBeenCalledTimes(1);
  const personalId = createId("deployment");
  access = snapshot({
    account,
    deployments: [listed, { ...accessDeployment("connecting"), ...personalSummary(personalId) }],
    personalSetup: personalStatus({ deploymentId: personalId, name: "Workshop", step: "ready" }),
    revision: 5,
    selectedDeploymentId: personalId,
  });
  await act(async () => {
    for (const listener of listeners) listener(access);
  });
  expect(remoteAccessWishHeld()).toBe(false);
  expect(localStorage.getItem(`opensteer.setup.remote-access.v1:${personalId}`)).toBeNull();
  await act(async () => root.unmount());
  container.remove();
});

describe("the front door", () => {
  /** The desktop app on a Mac with nothing on it yet, in the given account state. */
  async function door(input: {
    readonly account: DeploymentAccessSnapshot["account"];
    readonly cloud?: MockCloudComputerScene;
  }) {
    localStorage.clear();
    let access = snapshot({
      account: input.account,
      personalSetup: personalStatus({
        canStart: true,
        deploymentId: null,
        name: "Studio Mac",
        state: "stopped",
        step: null,
      }),
    });
    const listeners = new Set<(next: DeploymentAccessSnapshot) => void>();
    const cloud = new MockCloudComputerAccount(input.cloud ?? "none");
    const bridge = {
      cancel: vi.fn(async () => undefined),
      checkDeployments: vi.fn(async () => undefined),
      cloudComputerAct: vi.fn((command: never) => cloud.act(command)),
      cloudComputerRead: vi.fn(() => cloud.read()),
      createPersonalDeployment: vi.fn(async () => undefined),
      getDeploymentAccessSnapshot: async () => access,
      linkPersonal: vi.fn(async () => undefined),
      onHostWebSocketEvent: () => () => undefined,
      onDeploymentAccessSnapshotChanged: (listener: (next: DeploymentAccessSnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onNotificationActivated: () => () => undefined,
      getLocalExecutionStatus: async () => {
        throw new Error("No local execution in this test.");
      },
      onLocalExecutionStatusChanged: () => () => undefined,
      openExternalUrl: vi.fn(async () => ({ opened: true })),
      select: vi.fn(async () => undefined),
      signIn: vi.fn(async () => undefined),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(<DesktopApp bridge={bridge as unknown as OpensteerDesktopBridge} />),
    );
    await vi.waitFor(() => expect(container.textContent).not.toContain("Opening Opensteer…"));
    for (let flush = 0; flush < 3; flush += 1) await act(async () => undefined);
    const buttons = () => [...container.querySelectorAll("button")];
    const button = (label: string) => {
      const found = buttons().find((candidate) => candidate.textContent?.startsWith(label));
      if (!found) throw new Error(`No ${label} in ${container.textContent ?? ""}`);
      return found;
    };
    const emit = async (next: DeploymentAccessSnapshot) => {
      access = next;
      await act(async () => {
        for (const listener of listeners) listener(next);
      });
    };
    const close = async () => {
      await act(async () => root.unmount());
      container.remove();
    };
    return { bridge, button, buttons, close, container, emit };
  }

  it("leads with the Opensteer account, with using it without an account a small link", async () => {
    const app = await door({ account: { available: true, status: "signed-out" } });
    expect(app.container.textContent).toContain("Welcome to Opensteer");
    expect(app.container.textContent).toContain(
      "Sign in with your Opensteer account. Your phone and connected agents can then reach your Opensteer from anywhere.",
    );
    // One primary action, and it is signing in.
    const primary = app
      .buttons()
      .filter((candidate) => candidate.classList.contains("btn--primary"));
    expect(primary.map((candidate) => candidate.textContent)).toEqual(["Sign in"]);
    expect(app.button("Use without an account").classList.contains("link-btn")).toBe(true);
    expect(app.button("Other ways in").classList.contains("link-btn")).toBe(true);
    expect(app.container.textContent).not.toContain("Start Opensteer on");
    await act(async () => app.button("Sign in").click());
    expect(app.bridge.signIn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("starts a Home without an account exactly as before, with no account call on the way", async () => {
    const app = await door({ account: { available: true, status: "signed-out" } });
    await act(async () => app.button("Use without an account").click());
    expect(app.container.textContent).toContain("Use Opensteer without an account");
    expect(app.container.textContent).toContain(
      "Your agent lives and works here. No account needed.",
    );
    await act(async () => app.button("Rename").click());
    const field = app.container.querySelector<HTMLInputElement>("#desktop-entry-name")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        field,
        "Workshop",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => field.form!.requestSubmit());
    await act(async () => app.button("Start Opensteer on this").click());
    expect(app.bridge.createPersonalDeployment).toHaveBeenCalledExactlyOnceWith({
      name: "Workshop",
    });
    const personalId = createId("deployment");
    await app.emit(
      snapshot({
        account: { available: true, status: "signed-out" },
        deployments: [{ ...accessDeployment("connecting"), ...personalSummary(personalId) }],
        personalSetup: personalStatus({
          deploymentId: personalId,
          name: "Workshop",
          step: "ready",
        }),
        revision: 5,
        selectedDeploymentId: personalId,
      }),
    );
    // Nothing on this path reaches the Opensteer account.
    expect(app.bridge.signIn).not.toHaveBeenCalled();
    expect(app.bridge.linkPersonal).not.toHaveBeenCalled();
    expect(app.bridge.cloudComputerRead).not.toHaveBeenCalled();
    expect(app.bridge.openExternalUrl).not.toHaveBeenCalled();
    expect(remoteAccessWishHeld()).toBe(false);
    await app.close();
  });

  it("keeps a pairing code and an address under Other ways in", async () => {
    const app = await door({ account: { available: true, status: "signed-out" } });
    await act(async () => app.button("Other ways in").click());
    expect(app.container.textContent).toContain("From the Mac your Opensteer runs on.");
    await act(async () => app.button("Use a pairing code").click());
    expect(app.container.querySelector("#desktop-connect-code")).not.toBeNull();
    await act(async () => app.button("Back").click());
    expect(app.container.textContent).toContain("Welcome to Opensteer");
    await app.close();
  });

  it("keeps the welcome it always had in a build with no account to sign in to", async () => {
    const app = await door({ account: { available: false, status: "signed-out" } });
    expect(app.container.textContent).toContain("Your AI agent, working on your computer.");
    expect(app.button("Start Opensteer on this")).toBeTruthy();
    expect(app.container.textContent).toContain(
      "It’s already running on another computer. Use its pairing code.",
    );
    expect(app.container.textContent).not.toContain("Use without an account");
    await app.close();
  });

  it("asks where an account with no Opensteer should have it, with the price checkout sells", async () => {
    const app = await door({
      account: {
        available: true,
        email: "ada@example.test",
        portalOrigin: "https://app.opensteer.example",
        status: "signed-in",
      },
      cloud: "checkout",
    });
    await vi.waitFor(() =>
      expect(app.container.textContent).toContain("$20.00 a month. Always on."),
    );
    expect(app.container.textContent).toContain("Where should your Opensteer live?");
    expect(app.container.textContent).toContain("Signed in as ada@example.test");
    expect(app.button("On this Mac").textContent).toContain("Free. Works while this Mac is awake.");
    expect(app.container.textContent).toContain(
      "Your phone and connected agents can reach it from anywhere. You can turn this off in Settings.",
    );
    expect(app.button("On an Opensteer Cloud Computer").textContent).toContain(
      "$20.00 a month. Always on. This Mac can be one of its devices.",
    );
    await act(async () => app.button("On an Opensteer Cloud Computer").click());
    expect(app.bridge.openExternalUrl).toHaveBeenCalledWith({
      url: "https://app.opensteer.example/cloud-computer/checkout",
    });
    await vi.waitFor(() =>
      expect(app.container.textContent).toContain("Finish checkout in your browser"),
    );
    // Back from the browser, the account reports the Cloud Computer it set up for them...
    for (let read = 0; read < 6; read += 1)
      await act(async () => window.dispatchEvent(new Event("focus")));
    // ...and once the account lists it, it opens by itself.
    const cloudHome: DeploymentAccessDeployment = {
      ...accessDeployment("idle"),
      id: mockCloudComputerDeploymentId,
      source: "account",
    };
    await app.emit(
      snapshot({
        account: { available: true, status: "signed-in" },
        deployments: [cloudHome],
        revision: 9,
      }),
    );
    await vi.waitFor(() =>
      expect(app.bridge.select).toHaveBeenCalledWith({ deploymentId: cloudHome.id }),
    );
    await app.close();
  });

  it("lets a person turn back from checkout to both choices, and opens nothing", async () => {
    const app = await door({
      account: {
        available: true,
        portalOrigin: "https://app.opensteer.example",
        status: "signed-in",
      },
    });
    await vi.waitFor(() => expect(app.button("On an Opensteer Cloud Computer")).toBeTruthy());
    await act(async () => app.button("On an Opensteer Cloud Computer").click());
    await vi.waitFor(() =>
      expect(app.container.textContent).toContain("Finish checkout in your browser"),
    );
    await act(async () => app.button("Choose something else").click());
    expect(app.container.textContent).not.toContain("Finish checkout in your browser");
    expect(app.button("On this Mac")).toBeTruthy();
    expect(app.button("On an Opensteer Cloud Computer")).toBeTruthy();
    const reads = app.bridge.cloudComputerRead.mock.calls.length;
    await act(async () => undefined);
    expect(app.bridge.cloudComputerRead.mock.calls.length).toBe(reads);
    expect(app.bridge.select).not.toHaveBeenCalled();
    await app.close();
  });

  it("ends following checkout when its account signs out, so the next account sees both choices", async () => {
    vi.useFakeTimers();
    try {
      const accountA = {
        available: true,
        issuer: "https://accounts.opensteer.test",
        portalOrigin: "https://app.opensteer.example",
        status: "signed-in",
        subject: "acct_a",
      } as never;
      const app = await door({ account: accountA });
      await vi.waitFor(() => expect(app.button("On an Opensteer Cloud Computer")).toBeTruthy());
      await act(async () => app.button("On an Opensteer Cloud Computer").click());
      await vi.waitFor(() =>
        expect(app.container.textContent).toContain("Finish checkout in your browser"),
      );
      // A signs out in this window, and B, whose account has no Opensteer, signs in.
      const personalSetup = personalStatus({
        canStart: true,
        deploymentId: null,
        name: "Studio Mac",
        state: "stopped",
        step: null,
      });
      await app.emit(
        snapshot({
          account: { available: true, status: "signed-out" },
          personalSetup,
          revision: 7,
        }),
      );
      await app.emit(
        snapshot({
          personalSetup,
          account: {
            available: true,
            issuer: "https://accounts.opensteer.test",
            portalOrigin: "https://app.opensteer.example",
            status: "signed-in",
            subject: "acct_b",
          } as never,
          revision: 8,
        }),
      );
      await vi.waitFor(() => expect(app.button("On this Mac")).toBeTruthy());
      expect(app.container.textContent).not.toContain("Finish checkout in your browser");
      expect(app.button("On an Opensteer Cloud Computer")).toBeTruthy();
      // Nothing keeps reading for A's checkout.
      const reads = app.bridge.cloudComputerRead.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(app.bridge.cloudComputerRead.mock.calls.length).toBe(reads);
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits on nothing when the system browser refuses the address", async () => {
    const app = await door({
      account: {
        available: true,
        portalOrigin: "https://app.opensteer.example",
        status: "signed-in",
      },
    });
    app.bridge.openExternalUrl.mockRejectedValueOnce(new Error("External links must use HTTPS"));
    await vi.waitFor(() => expect(app.button("On an Opensteer Cloud Computer")).toBeTruthy());
    await act(async () => app.button("On an Opensteer Cloud Computer").click());
    await vi.waitFor(() =>
      expect(app.container.textContent).toContain(
        "Your browser couldn’t open the Opensteer website. Try again.",
      ),
    );
    expect(app.container.textContent).not.toContain("Finish checkout in your browser");
    expect(app.button("On this Mac")).toBeTruthy();
    await app.close();
  });

  it("offers no Cloud Computer to buy while checkout sells none", async () => {
    const app = await door({
      account: {
        available: true,
        portalOrigin: "https://app.opensteer.example",
        status: "signed-in",
      },
      cloud: "not-for-sale",
    });
    await vi.waitFor(() =>
      expect(app.button("On an Opensteer Cloud Computer").textContent).toContain(
        "Not available yet",
      ),
    );
    expect(app.button("On an Opensteer Cloud Computer").disabled).toBe(true);
    expect(app.container.textContent).not.toContain("$20.00");
    await app.close();
  });
});

it("opens this computer's Host only once main has attached it", async () => {
  const personalId = createId("deployment");
  const restarting = {
    canStart: true,
    issue: {
      code: "host-unavailable" as const,
      component: "host" as const,
      detail: "Restarting Host in 2 seconds.",
      repairAction: "restart-opensteer" as const,
    },
  };
  const local = (
    status: DeploymentAccessDeployment["status"],
    attachmentKey: string,
    state: DesktopPersonalDeploymentStatus["state"],
    revision: number,
  ) =>
    snapshot({
      deployments: [{ ...accessDeployment(status), ...personalSummary(personalId), attachmentKey }],
      personalSetup: personalStatus({
        deploymentId: personalId,
        state,
        step: null,
        ...(state === "degraded" ? restarting : {}),
      }),
      revision,
      selectedDeploymentId: personalId,
    });
  let access = local("idle", "loopback", "starting", 1);
  const listeners = new Set<(next: DeploymentAccessSnapshot) => void>();
  const retry = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  // The place list's own badge read (attention) is not the window's connection.
  const placeListReads = ["/v1/rpc/attention.get"];
  // The window opens its Host by attaching its socket, then reading over HTTP: both count.
  const hostRequests: string[] = [];
  const bridge = {
    cancel,
    cancelHostRequest: async () => undefined,
    checkDeployments: async () => undefined,
    retry,
    getDeploymentAccessSnapshot: async () => access,
    openHostWebSocket: async (input: { path: string; expectedDeploymentId: string }) => {
      hostRequests.push(`/host/${input.expectedDeploymentId}${input.path}`);
      return new Promise<never>(() => undefined);
    },
    onHostWebSocketEvent: () => () => undefined,
    onDeploymentAccessSnapshotChanged: (listener: (next: DeploymentAccessSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onNotificationActivated: () => () => undefined,
    onLocalExecutionStatusChanged: () => () => undefined,
  } as unknown as OpensteerDesktopBridge;
  const emit = async (next: DeploymentAccessSnapshot) => {
    access = next;
    await act(async () => {
      for (const listener of listeners) listener(next);
    });
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = url.startsWith("app://opensteer/host/") ? new URL(url).pathname : null;
    if (path && !placeListReads.some((read) => path.endsWith(read))) hostRequests.push(path);
    return new Promise<Response>(() => undefined);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DesktopApp bridge={bridge} />));
    await vi.waitFor(() => expect(container.textContent).toContain("Starting Opensteer"));

    // The Host came up and main is attaching it: nothing here is the window's to open yet.
    await emit(local("idle", "owner", "ready", 2));
    await emit(local("connecting", "owner", "ready", 3));
    expect(hostRequests).toEqual([]);

    await emit(local("connected", "owner", "ready", 4));
    await vi.waitFor(() => expect(hostRequests.length).toBeGreaterThan(0));
    expect(hostRequests.every((path) => path.startsWith(`/host/${personalId}/`))).toBe(true);

    // The Host restarts and comes back as the same identity: still main's to attach first.
    const beforeRestart = hostRequests.length;
    await emit(local("connecting", "loopback", "degraded", 5));
    // The restart says what it is doing and can be tried again by hand.
    expect(container.textContent).toContain("Restarting Host in 2 seconds.");
    const tryAgain = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    await act(async () => tryAgain!.click());
    expect(retry).toHaveBeenCalledOnce();
    // Back stops waiting; a row main no longer holds goes back to the places.
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Back",
    );
    await act(async () => back!.click());
    expect(cancel).toHaveBeenCalledOnce();
    await emit(local("idle", "loopback", "degraded", 6));
    expect(container.textContent).not.toContain("Restarting Host in 2 seconds.");
    await emit(local("connecting", "owner", "degraded", 7));
    await emit(local("connecting", "owner", "ready", 8));
    expect(hostRequests.length).toBe(beforeRestart);
    await emit(local("connected", "owner", "ready", 9));
    await vi.waitFor(() => expect(hostRequests.length).toBeGreaterThan(beforeRestart));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    fetch.mockRestore();
  }
});

it("keeps a verified local owner client connecting while the browser reports offline, unlike a remote place", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  const onLineDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
  Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => false });

  const localId = createId("deployment");
  const remoteId = createId("deployment");
  const otherId = createId("deployment");
  const otherPlace = { ...accessDeployment("idle"), id: otherId, name: "Studio" };
  const placeListReads = ["/v1/rpc/attention.get"];
  const hostRequests: string[] = [];
  const makeBridge = (access: DeploymentAccessSnapshot) =>
    ({
      cancel: async () => undefined,
      cancelHostRequest: async () => undefined,
      checkDeployments: async () => undefined,
      retry: async () => undefined,
      getDeploymentAccessSnapshot: async () => access,
      getLocalExecutionStatus: async ({ deploymentId }: { readonly deploymentId: string }) => ({
        deploymentId,
        runner: { enrolled: false, runnerId: null },
      }),
      openHostWebSocket: async (input: { path: string; expectedDeploymentId: string }) => {
        hostRequests.push(`/host/${input.expectedDeploymentId}${input.path}`);
        return new Promise<never>(() => undefined);
      },
      onHostWebSocketEvent: () => () => undefined,
      onDeploymentAccessSnapshotChanged: () => () => undefined,
      onNotificationActivated: () => () => undefined,
      onLocalExecutionStatusChanged: () => () => undefined,
    }) as unknown as OpensteerDesktopBridge;

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = url.startsWith("app://opensteer/host/") ? new URL(url).pathname : null;
    if (path && !placeListReads.some((read) => path.endsWith(read))) hostRequests.push(path);
    return new Promise<Response>(() => undefined);
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    // Verified local owner route ignores navigator.onLine === false and external offline events,
    // stays honestly connecting past the 5 s hold, and keeps Other computers reachable.
    const localAccess = snapshot({
      deployments: [
        {
          ...accessDeployment("connected"),
          ...personalSummary(localId),
          access: "owner",
          attachmentKey: "owner",
        },
        otherPlace,
      ],
      personalSetup: personalStatus({ deploymentId: localId, state: "ready", step: null }),
      revision: 1,
      selectedDeploymentId: localId,
    });
    await act(async () => {
      root.render(<DesktopApp bridge={makeBridge(localAccess)} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hostRequests.some((path) => path.startsWith(`/host/${localId}/`))).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(container.textContent).toContain("Connecting to Workshop…");
    expect(container.textContent).toContain(
      "Opensteer on this computer is taking longer than usual to respond.",
    );
    expect(container.textContent).not.toContain("You're offline");
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Other computers",
    ]);

    // Remote Connect place respects navigator.onLine === false: sends nothing, shows offline
    // after the 5 s hold, omits Try again, and still keeps Other computers reachable.
    await act(async () => root.unmount());
    hostRequests.length = 0;
    const remoteRoot = createRoot(container);
    try {
      const remoteAccess = snapshot({
        deployments: [
          {
            ...accessDeployment("connected"),
            id: remoteId,
            access: "connect",
            attachmentKey: "connect",
            onThisComputer: false,
          },
          otherPlace,
        ],
        revision: 1,
        selectedDeploymentId: remoteId,
      });
      await act(async () => {
        remoteRoot.render(<DesktopApp bridge={makeBridge(remoteAccess)} />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(container.textContent).toContain("Connecting to Server…");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(hostRequests.filter((path) => path.startsWith(`/host/${remoteId}/`))).toEqual([]);
      expect(container.textContent).toContain("You're offline");
      expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
        "Other computers",
      ]);
    } finally {
      await act(async () => remoteRoot.unmount());
    }
  } finally {
    container.remove();
    fetch.mockRestore();
    if (onLineDescriptor) Object.defineProperty(Navigator.prototype, "onLine", onLineDescriptor);
    vi.useRealTimers();
  }
});

it.each([
  ["listed", () => ({ deployments: [{ ...accessDeployment("idle"), name: "Studio" }] })],
  [
    "listed but unavailable",
    () => ({
      deployments: [],
      unavailable: [
        {
          accountAccess: "owner" as const,
          deploymentId: createId("deployment"),
          name: "Studio",
          reason: "host-too-old" as const,
        },
      ],
    }),
  ],
])(
  "asks before starting a separate Opensteer when the person already has one %s",
  async (_, rows) => {
    const access = snapshot({
      ...rows(),
      personalSetup: personalStatus({ canStart: true, state: "stopped", step: null }),
    });
    const createPersonalDeployment = vi.fn(async () => undefined);
    const bridge = {
      checkDeployments: async () => undefined,
      createPersonalDeployment,
      getDeploymentAccessSnapshot: async () => access,
      onHostWebSocketEvent: () => () => undefined,
      onDeploymentAccessSnapshotChanged: () => () => undefined,
      onNotificationActivated: () => () => undefined,
      onLocalExecutionStatusChanged: () => () => undefined,
    } as unknown as OpensteerDesktopBridge;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const button = (label: string) =>
      [...document.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.startsWith(label),
      );
    try {
      await act(async () => root.render(<DesktopApp bridge={bridge} />));
      await vi.waitFor(() => expect(container.textContent).toContain("Studio"));
      expect(button("Start Opensteer on")).toBeUndefined();
      expect(button("Start a separate Opensteer")).toBeUndefined();

      // Starting another one here is one of the other ways in, not a choice beside the list.
      await act(async () => button("Other ways in")!.click());
      await act(async () => button("Start a separate Opensteer on this")!.click());
      expect(document.body.textContent).toContain("Nothing from Studio comes with it.");
      await act(async () => button("Cancel")!.click());
      expect(createPersonalDeployment).not.toHaveBeenCalled();

      await act(async () => button("Start a separate Opensteer on this")!.click());
      await act(async () => button("Start separate Opensteer")!.click());
      expect(createPersonalDeployment).toHaveBeenCalledExactlyOnceWith({});

      // A list that couldn't be read may hold one too: nothing offers Start until it's read.
      await act(async () => root.unmount());
      const failed = snapshot({
        ...access,
        directoryFailure: { code: "directory-unavailable", detail: "Offline.", retryable: true },
      });
      const again = createRoot(container);
      await act(async () =>
        again.render(
          <DesktopApp bridge={{ ...bridge, getDeploymentAccessSnapshot: async () => failed }} />,
        ),
      );
      await vi.waitFor(() => expect(container.textContent).toContain("Studio"));
      expect(button("Start")).toBeUndefined();
      await act(async () => again.unmount());
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("asks a Mac that joined an Opensteer to sign in again, then reopens that one", async () => {
  const joined: DeploymentAccessDeployment = {
    ...accessDeployment("idle"),
    name: "Studio",
    source: "account",
  };
  const access = snapshot({ deployments: [joined] });
  const calls: string[] = [];
  const bridge = {
    cancel: async () => undefined,
    checkDeployments: async () => undefined,
    select: async ({ deploymentId }: { deploymentId: string }) => {
      calls.push(`select ${deploymentId}`);
    },
    signIn: async () => {
      calls.push("sign in");
    },
  };

  const notice = chooserNotice(placeAwaitingSignIn(access), access, bridge);
  expect(notice?.title).toBe("Sign in again to keep using Studio");
  await notice?.action?.run();
  expect(calls).toEqual([`select ${joined.id}`, "sign in"]);

  // While the browser sign-in is out, there is always a way to stop waiting.
  const authorizing = {
    ...access,
    account: { ...access.account, status: "authorizing" as const },
  };
  expect(chooserNotice(placeAwaitingSignIn(authorizing), authorizing, bridge)?.action?.label).toBe(
    "Cancel",
  );

  // Signed in, or with another place already on screen, there is nothing to reopen.
  expect(placeAwaitingSignIn({ ...access, selectedDeploymentId: joined.id })).toBeUndefined();
  expect(
    placeAwaitingSignIn({ ...access, account: { ...access.account, status: "signed-in" } }),
  ).toBeUndefined();
});

function personalSummary(id: string) {
  return DesktopDeploymentSummarySchema.parse({
    ...deployment,
    activeOrigin: "http://127.0.0.1:45000",
    canonicalOrigin: "http://127.0.0.1:45000",
    id,
    kind: "personal",
    name: "Workshop",
    onThisComputer: true,
    routes: [{ kind: "canonical", origin: "http://127.0.0.1:45000", selected: true }],
  });
}

function personalStatus(
  overrides: Partial<DesktopPersonalDeploymentStatus> = {},
): DesktopPersonalDeploymentStatus {
  return DesktopPersonalDeploymentStatusSchema.parse({
    canStart: false,
    components: {
      browser: { state: "stopped", version: null },
      host: { state: "starting", version: null },
      messaging: { state: "stopped", version: null },
      postgresql: { state: "ready", version: "18" },
      runner: { state: "stopped", version: null },
    },
    deploymentId: null,
    environmentId: null,
    issue: null,
    schemaVersion: 1,
    state: "starting",
    step: "checking-computer",
    ...overrides,
  });
}

const deployment = DesktopDeploymentSummarySchema.parse({
  activeOrigin: "https://server.example.test",
  canonicalOrigin: "https://server.example.test",
  id: createId("deployment"),
  kind: "personal",
  lastUsedAt: "2026-08-20T10:00:00.000Z",
  name: "Server",
  onThisComputer: false,
  access: "native",
  routes: [{ kind: "canonical", origin: "https://server.example.test", selected: true }],
});

function snapshot(overrides: Partial<DeploymentAccessSnapshot> = {}): DeploymentAccessSnapshot {
  return DeploymentAccessSnapshotSchema.parse({
    account: { available: true, status: "signed-out" },
    deployments: [],
    personalAccountLink: {
      account: null,
      deploymentId: null,
      displayName: null,
      status: "unavailable",
      unlinkStep: null,
    },
    personalSetup: null,
    revision: 1,
    selectedDeploymentId: null,
    ...overrides,
  });
}

describe("Desktop snapshot presentation", () => {
  it("maps fresh, picker, authorization, blocked, and ready snapshots without orchestration", () => {
    // With nothing open, the list of places (or, when there are none, the
    // welcome that shows in its place) is where a person starts.
    expect(desktopAccessPresentationFromSnapshot(snapshot())).toBe("picker");
    // A setup that failed before its Deployment was listed keeps its own
    // screen, with its reason and Try again; Welcome could not retry it.
    const unlisted = personalStatus({
      canStart: true,
      deploymentId: createId("deployment"),
      issue: {
        code: "database-unavailable",
        component: "postgresql",
        detail: "Another app is using port 5432. Quit it, then try again.",
        repairAction: "restart-opensteer",
      },
      state: "repair-required",
      step: null,
    });
    expect(desktopAccessPresentationFromSnapshot(snapshot({ personalSetup: unlisted }))).toBe(
      "personal",
    );
    // Once listed, the list's own retry and cancel apply, as for any place.
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [{ ...accessDeployment("idle"), id: unlisted.deploymentId! }],
          personalSetup: unlisted,
          selectedDeploymentId: unlisted.deploymentId!,
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          account: { available: true, status: "signed-in" },
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("connected")],
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("needs-sign-in")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("verified");
    // Waiting on this Host's own browser sign-in belongs on the screen that
    // says so and offers a way out, never on the bare connecting spinner.
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("authorizing")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("verified");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("connecting")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("waiting");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("offline")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("blocked");
    // A cancelled attachment leaves the selected row idle, and the Directory is
    // where a person picks up again — never a spinner with nothing behind it.
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("idle")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("needs-remote-access")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("picker");
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          deployments: [accessDeployment("connected")],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("ready");
    // An Account place whose sign-in ended waits in the list for that sign-in,
    // never on a server's own sign-in page it could not satisfy.
    expect(
      desktopAccessPresentationFromSnapshot(
        snapshot({
          account: { available: true, status: "error" },
          deployments: [{ ...accessDeployment("needs-sign-in"), source: "account" }],
          selectedDeploymentId: deployment.id,
        }),
      ),
    ).toBe("picker");
  });
});

/**
 * Only states the real attachment observer can publish. A row waiting to sign
 * in always carries the retryable failure the supervisor attaches to it, and a
 * row this Desktop is not attached to is `idle` with nothing wrong.
 */
function accessDeployment(
  status: DeploymentAccessDeployment["status"],
): DeploymentAccessDeployment {
  const summary = deployment;
  const failure =
    status === "needs-sign-in"
      ? {
          code: "host-sign-in-required" as const,
          detail: "Sign in to this server to continue.",
          retryable: true,
        }
      : status === "offline"
        ? {
            code: "host-access-blocked" as const,
            detail: "This connection was refused.",
            retryable: false,
          }
        : null;
  return {
    ...summary,
    accountAccess: null,
    availableActions:
      status === "connecting"
        ? ["cancel"]
        : status === "authorizing"
          ? ["retry", "cancel"]
          : status === "connected" || status === "needs-remote-access"
            ? []
            : ["retry"],
    failure,
    source: "manual" as const,
    status,
    statusInfo:
      status === "needs-remote-access"
        ? { reason: `Turn on remote access on ${summary.name}.`, status: "offline" }
        : { reason: null, status: "ready" },
  };
}
