import {
  createIntegrationId,
  buildIntegrationAuthorizationAppReturn,
} from "@opensteer/integration-core";
import { DesktopIntegrationAuthorizations } from "../app/integration-authorizations.js";
import type { IpcMainInvokeEvent } from "electron";
import { createId } from "@opensteer/core";
import {
  DeploymentAccessSnapshotSchema,
  type DeploymentAccessSnapshot,
  type DesktopPasswordsStatus,
} from "@opensteer/protocol/desktop";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { DesktopHostTransport } from "../connections/host-transport.js";
import { AdHocSignedHelperError } from "../signed-helpers/signed-helper.js";
import { desktopBridgeChannels } from "./desktop-bridge-channels.js";
import { registerDesktopBridge } from "./registration.js";
import { DesktopWebLinks } from "../app/web-links.js";

it.each(["personal", "self-hosted"] as const)(
  "delivers web links by the supervised Host's policy: %s",
  (kind) => {
    const deploymentId = createId("deployment");
    const event = ipcEvent("app://opensteer/");
    const links = new DesktopWebLinks(() => undefined);
    const access = {
      ...accessOperationMocks(),
      snapshot: () =>
        ({
          ...snapshot(),
          selectedDeploymentId: deploymentId,
          deployments: [{ id: deploymentId, status: "connected", kind }],
        }) as unknown as DeploymentAccessSnapshot,
      subscribe: () => () => undefined,
    };
    const handlers = registerWith(passwordsPort(), {}, undefined, {
      access,
      isWorkspaceContents: (sender) => sender === event.sender,
      webLinks: links,
    });
    try {
      handlers.invoke(desktopBridgeChannels.webLinkDelivery, event, {
        bridgeToken: "b".repeat(43),
        input: {
          deploymentId,
          userId: createId("user"),
          generation: crypto.randomUUID(),
          ready: true,
        },
      });
      links.accept("https://example.com/from-host");
      expect(event.sender.send).toHaveBeenCalledTimes(kind === "personal" ? 1 : 0);
    } finally {
      handlers.unregister();
      links.dispose();
    }
  },
);

/** The setup guide's surface, which these tests do not exercise. */
const computerAppSetupUnused = {
  begin: async () => undefined,
  close: async () => undefined,
  dragItem: () => null,
  open: async () => ({ opened: false }),
  showAgain: async () => undefined,
  status: async () => ({ setup: null }),
};

describe("desktop bridge", () => {
  it("authorizes device intents, rejects renderer origins, and returns only a binding proof", async () => {
    const runner = runnerController();
    const handlers = registerWith(passwordsPort(), {}, undefined, { runner });
    const event = ipcEvent("app://opensteer/");
    const deploymentId = createId("deployment");
    const sessionId = createId("authSession");
    const envelope = { bridgeToken: "b".repeat(43), input: { deploymentId, sessionId } };
    try {
      await expect(
        handlers.invoke(desktopBridgeChannels.signDeviceSessionBinding, event, envelope),
      ).resolves.toEqual({
        issuedAt: expect.any(String),
        signature: "s".repeat(86),
      });
      expect(runner.signDeviceSessionBinding).toHaveBeenCalledWith({ deploymentId, sessionId });
      await expect(
        handlers.invoke(desktopBridgeChannels.signDeviceSessionBinding, event, {
          ...envelope,
          input: { ...envelope.input, origin: "https://attacker.test" },
        }),
      ).rejects.toThrow();
      await expect(
        handlers.invoke(desktopBridgeChannels.leaveDeployment, ipcEvent("https://attacker.test/"), {
          bridgeToken: "b".repeat(43),
          input: { deploymentId },
        }),
      ).rejects.toThrow();
      expect(runner.leaveDeployment).not.toHaveBeenCalled();
      await handlers.invoke(desktopBridgeChannels.leaveDeployment, event, {
        bridgeToken: "b".repeat(43),
        input: { deploymentId },
      });
      expect(runner.leaveDeployment).toHaveBeenCalledWith({ deploymentId });
    } finally {
      handlers.unregister();
    }
  });

  it("exposes one deployment-access snapshot stream and bounded intents", async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
    const accessOperations = accessOperationMocks();
    const requestPermissions = vi.fn(
      async () => ({ accessibility: "denied", screenRecording: "denied" }) as const,
    );
    const accessListeners = new Set<(snapshot: DeploymentAccessSnapshot) => void>();
    const runner = runnerController();
    const access = {
      ...accessOperations,
      snapshot: snapshot,
      subscribe: vi.fn((listener: (value: DeploymentAccessSnapshot) => void) => {
        accessListeners.add(listener);
        return () => accessListeners.delete(listener);
      }),
    };
    const event = ipcEvent("app://opensteer/workspaces");
    const integrationAuthorizations = new DesktopIntegrationAuthorizations(
      {
        application: "desktop",
        clientId: "opensteer-desktop",
        accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
        hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
      },
      () => {},
    );
    const unregister = registerDesktopBridge({
      integrationAuthorizations,
      isWorkspaceContents: (sender) => sender === event.sender,
      updates: {
        state: () => ({
          status: "idle",
          channel: "stable",
          latestVersion: null,
          currentVersion: "0.1.396",
          availableVersion: null,
          downloadPercent: null,
          failed: null,
        }),
        subscribe: () => () => undefined,
        setChannel: async (channel) => ({
          status: "unavailable",
          channel,
          latestVersion: null,
          currentVersion: "0.1.396",
          availableVersion: null,
          downloadPercent: null,
          failed: null,
        }),
        download: async () => undefined,
        restart: () => undefined,
      },
      deploymentUpdates: () => {
        throw new Error("not part of this test");
      },
      downloads: {
        snapshot: () => ({ downloads: [] }),
        subscribe: () => () => undefined,
        open: async () => ({ status: "missing" }),
        show: () => ({ status: "missing" }),
        cancel: () => ({ status: "missing" }),
      },
      localVisibility: { getSnapshot: () => true, subscribe: () => () => undefined },
      access,
      agentPhone: agentPhone(),
      computerApps: {
        dragIcon: async () => {
          throw new Error("not part of this test");
        },
        setup: computerAppSetupUnused,
      },
      computerUse: {
        onActivationError: () => undefined,

        closePermissionsPanel: async () => undefined,
        openPermissionsPanel: async () => undefined,
        verifyBundledHelper: async () => undefined,
        openSystemSettings: async () => undefined,
        permissions: async () => ({ accessibility: "denied", screenRecording: "denied" }) as const,
        requestPermissions,
      },
      bridgeToken: "b".repeat(43),
      fullDiskAccess: fullDiskAccess(),
      hostTransport: hostTransport(),
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
      passwords: passwordsPort().port,

      notifications: { openSettings: vi.fn(async () => undefined) },
      tailscale: tailscalePort(),
      portal: { openExternal: vi.fn(async () => undefined), pickFolder: vi.fn(async () => null) },
      runner,
    });
    const envelope = { bridgeToken: "b".repeat(43) };

    const started = {
      deploymentId: createId("deployment"),
      userId: createId("user"),
      attemptId: createIntegrationId("oauthAttempt"),
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    await integrationAuthorizations.register(started);
    const callback = {
      deploymentId: started.deploymentId,
      attemptId: started.attemptId,
      returnProof: "r".repeat(43),
    };
    const url = buildIntegrationAuthorizationAppReturn("desktop", callback);
    integrationAuthorizations.accept(url);
    const subscribe = handlers.get(desktopBridgeChannels.integrationAuthorizationSubscription)!;
    subscribe(event, {
      ...envelope,
      input: {
        deploymentId: started.deploymentId,
        userId: started.userId,
        generation: crypto.randomUUID(),
        ready: true,
      },
    });
    await integrationAuthorizations.settled();
    expect(event.sender.send).toHaveBeenCalledWith(
      desktopBridgeChannels.integrationAuthorizationReturn,
      callback,
    );
    const fire = (name: string) => {
      const once = event.sender.once as unknown as Mock<
        (eventName: string, listener: () => void) => void
      >;
      for (const [eventName, listener] of once.mock.calls) if (eventName === name) listener();
    };
    const nextReturn = async () => {
      const attempt = { ...started, attemptId: createIntegrationId("oauthAttempt") };
      await integrationAuthorizations.register(attempt);
      const next = {
        deploymentId: attempt.deploymentId,
        attemptId: attempt.attemptId,
        returnProof: "s".repeat(43),
      };
      integrationAuthorizations.accept(buildIntegrationAuthorizationAppReturn("desktop", next));
      await integrationAuthorizations.settled();
      return [desktopBridgeChannels.integrationAuthorizationReturn, next] as const;
    };
    // Electron reports a route change as a load; only a new document ends the subscription.
    fire("did-start-loading");
    expect(event.sender.send).toHaveBeenCalledWith(...(await nextReturn()));
    fire("did-navigate");
    expect(event.sender.send).not.toHaveBeenCalledWith(...(await nextReturn()));
    await handlers.get(desktopBridgeChannels.finishIntegrationAuthorization)!(event, {
      ...envelope,
      input: { deploymentId: started.deploymentId, attemptId: started.attemptId },
    });
    expect(integrationAuthorizations.accept(url)).toBe(false);

    const setChannel = handlers.get(desktopBridgeChannels.setUpdateChannel)!;
    await expect(setChannel(event, { ...envelope, input: "beta" })).resolves.toMatchObject({
      channel: "beta",
    });
    await expect(setChannel(event, { ...envelope, input: "insider" })).rejects.toThrow();
    await expect(
      setChannel(ipcEvent("https://example.com"), { ...envelope, input: "stable" }),
    ).rejects.toThrow();

    const requestPermission = handlers.get(desktopBridgeChannels.requestComputerUsePermissions);
    await expect(
      requestPermission?.(event, { ...envelope, input: { pane: "screen-recording" } }),
    ).resolves.toEqual({ accessibility: "denied", screenRecording: "denied" });
    expect(requestPermissions).toHaveBeenCalledExactlyOnceWith("screen-recording");
    for (const input of [{}, { pane: "all" }, { pane: "screen-recording", url: "file:///" }]) {
      await expect(requestPermission?.(event, { ...envelope, input })).rejects.toThrow();
    }
    expect(requestPermissions).toHaveBeenCalledOnce();

    expect(
      handlers.get(desktopBridgeChannels.getDeploymentAccessSnapshot)?.(event, envelope),
    ).toEqual(snapshot());
    await handlers.get(desktopBridgeChannels.signIn)?.(event, envelope);
    await handlers.get(desktopBridgeChannels.createPersonalDeployment)?.(event, envelope);
    expect(accessOperations.signIn).toHaveBeenCalledOnce();
    expect(accessOperations.createPersonalDeployment).toHaveBeenCalledOnce();

    const deploymentId = createId("deployment");
    await handlers.get(desktopBridgeChannels.getLocalExecutionStatus)?.(event, {
      ...envelope,
      input: { deploymentId },
    });
    runner.notify();
    await vi.waitFor(() =>
      expect(event.sender.send).toHaveBeenCalledWith(
        desktopBridgeChannels.localExecutionStatusChanged,
        expect.objectContaining({
          deploymentId,
          runner: expect.objectContaining({ state: "disabled" }),
        }),
      ),
    );

    for (const listener of accessListeners) listener(snapshot(2));
    expect(event.sender.send).toHaveBeenCalledWith(
      desktopBridgeChannels.deploymentAccessSnapshotChanged,
      snapshot(2),
    );
    expect(Object.keys(desktopBridgeChannels)).not.toEqual(
      expect.arrayContaining([
        "beginAccountSignIn",
        "beginHostSignIn",
        "getDeploymentSelection",
        "getNativeAuthState",
        "startPersonalDeployment",
      ]),
    );
    expect(
      Object.values(desktopBridgeChannels).filter((channel) => channel.includes(".access.")),
    ).toHaveLength(16);
    const notificationChannels = new Set<string>([
      desktopBridgeChannels.integrationAuthorizationReturn,
      desktopBridgeChannels.mcpAuthorization,
      desktopBridgeChannels.teamLink,
      desktopBridgeChannels.dictationEvent,
      desktopBridgeChannels.downloadsChanged,
      desktopBridgeChannels.updateChanged,
      desktopBridgeChannels.workspaceTabCommand,
      desktopBridgeChannels.deploymentAccessSnapshotChanged,
      desktopBridgeChannels.hostWebSocketEvent,
      desktopBridgeChannels.localExecutionStatusChanged,
      desktopBridgeChannels.passwordsStatusChanged,
      desktopBridgeChannels.notificationActivated,
      desktopBridgeChannels.usbDeviceChoice,
      desktopBridgeChannels.agentPhoneAdbAuthorize,
      desktopBridgeChannels.localVisibilityChanged,
      desktopBridgeChannels.browserPresentationEvent,
      desktopBridgeChannels.glassScene,
      // The autofill popup's own page speaks these on its view, never the app's bridge.
      desktopBridgeChannels.autofillScene,
      desktopBridgeChannels.autofillMeasured,
      desktopBridgeChannels.autofillChoose,
    ]);
    expect(new Set(handlers.keys())).toEqual(
      new Set(
        Object.values(desktopBridgeChannels).filter(
          (channel) => !notificationChannels.has(channel),
        ),
      ),
    );

    unregister();
    expect(handlers).toHaveLength(0);
  });

  it("rejects callers outside the bundled main frame", async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
    const unregister = registerDesktopBridge({
      downloads: {
        snapshot: () => ({ downloads: [] }),
        subscribe: () => () => undefined,
        open: async () => ({ status: "missing" }),
        show: () => ({ status: "missing" }),
        cancel: () => ({ status: "missing" }),
      },
      localVisibility: { getSnapshot: () => true, subscribe: () => () => undefined },
      agentPhone: agentPhone(),
      computerApps: {
        dragIcon: async () => {
          throw new Error("not part of this test");
        },
        setup: computerAppSetupUnused,
      },
      computerUse: {
        onActivationError: () => undefined,

        closePermissionsPanel: async () => undefined,
        openPermissionsPanel: async () => undefined,
        verifyBundledHelper: async () => undefined,
        openSystemSettings: async () => undefined,
        permissions: async () => ({ accessibility: "denied", screenRecording: "denied" }) as const,
        requestPermissions: async () =>
          ({ accessibility: "granted", screenRecording: "granted" }) as const,
      },
      access: {
        ...accessOperationMocks(),
        snapshot,
        subscribe: vi.fn(() => () => undefined),
      },
      bridgeToken: "b".repeat(43),
      fullDiskAccess: fullDiskAccess(),
      hostTransport: hostTransport(),
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
      passwords: passwordsPort().port,

      notifications: { openSettings: vi.fn(async () => undefined) },
      tailscale: tailscalePort(),
      portal: { openExternal: vi.fn(async () => undefined), pickFolder: vi.fn(async () => null) },
      runner: runnerController(),
    });
    expect(() =>
      handlers.get(desktopBridgeChannels.getDeploymentAccessSnapshot)?.(
        ipcEvent("https://attacker.invalid"),
        { bridgeToken: "b".repeat(43) },
      ),
    ).toThrow("bundled Opensteer application");
    unregister();
  });

  it("answers the permissions panel with why a build cannot use computer use", async () => {
    const event = ipcEvent("app://opensteer/settings/computers");
    const envelope = { bridgeToken: "b".repeat(43) };
    const opened: string[] = [];
    const openPermissionsPanel = async () => {
      opened.push("opened");
    };
    const refused = registerWith(passwordsPort(), {
      openPermissionsPanel,
      verifyBundledHelper: async () => {
        throw new AdHocSignedHelperError("Opensteer Computer Use");
      },
    });
    await expect(
      refused.invoke(desktopBridgeChannels.openComputerUsePermissionsPanel, event, envelope),
    ).resolves.toEqual({ opened: false, reason: "unsigned-build" });
    expect(opened).toEqual([]);
    refused.unregister();

    const failing = registerWith(passwordsPort(), {
      openPermissionsPanel,
      verifyBundledHelper: async () => {
        throw new Error("codesign could not read the helper.");
      },
    });
    await expect(
      failing.invoke(desktopBridgeChannels.openComputerUsePermissionsPanel, event, envelope),
    ).rejects.toThrow("codesign could not read the helper.");
    failing.unregister();

    const signed = registerWith(passwordsPort(), { openPermissionsPanel });
    await expect(
      signed.invoke(desktopBridgeChannels.openComputerUsePermissionsPanel, event, envelope),
    ).resolves.toEqual({ opened: true });
    expect(opened).toEqual(["opened"]);
    signed.unregister();
  });

  it("serves Opensteer Passwords to the bundled app and pushes its status", async () => {
    const handlers = registerWith(passwordsPort());
    const { calls, notify } = handlers.passwords;
    const event = ipcEvent("app://opensteer/settings/passwords");
    const envelope = { bridgeToken: "b".repeat(43) };

    await expect(
      handlers.invoke(desktopBridgeChannels.getPasswordsStatus, event, envelope),
    ).resolves.toEqual({ ok: true, value: readyStatus });
    // A page outside the bundled app reads nothing.
    await expect(
      handlers.invoke(desktopBridgeChannels.getPasswordsStatus, ipcEvent("https://evil.test"), {
        ...envelope,
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("bundled Opensteer application"),
    });

    await handlers.invoke(desktopBridgeChannels.openPasswords, event, envelope);
    expect(calls).toEqual(["status", "open"]);

    // The renderer that asked for the status hears every later change.
    const changed: DesktopPasswordsStatus = {
      availability: "unavailable",
      message: "Opensteer Passwords is not running on this Mac.",
    };
    notify(changed);
    expect(event.sender.send).toHaveBeenCalledWith(
      desktopBridgeChannels.passwordsStatusChanged,
      changed,
    );
    // A destroyed renderer is skipped, and a malformed status reaches nobody.
    (event.sender as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;
    notify({ availability: "available", broker: readyStatus.broker, development: false });
    expect(event.sender.send).toHaveBeenCalledOnce();
    handlers.unregister();
  });

  it("keeps a renderer's unreadable realtime frames in the desktop log, as bounded metadata", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const handlers = registerWith(passwordsPort(), {}, log);
    const event = ipcEvent("app://opensteer/workspaces");
    const report = (input: unknown) =>
      handlers.invoke(desktopBridgeChannels.reportRealtimeDiagnostic, event, {
        bridgeToken: "b".repeat(43),
        input,
      });
    const record = {
      apiEpoch: 4,
      bytes: 128,
      category: "schema",
      envelopeType: "host.snapshot",
      event: "host.realtime.frame-rejected",
      issuePaths: ["snapshot.threads.[].status", "snapshot.threads.[].modelSelection.options.*"],
    };
    try {
      report(record);
      expect(log).toHaveBeenCalledExactlyOnceWith("host.realtime.frame-rejected", {
        apiEpoch: 4,
        bytes: 128,
        category: "schema",
        envelopeType: "host.snapshot",
        issuePaths: "snapshot.threads.[].status;snapshot.threads.[].modelSelection.options.*",
        suppressed: 0,
      });
      const secret = "https://private.test/page?token=os_secret_PRIVATE";
      for (const smuggled of [
        { ...record, frame: "os_secret_PRIVATE-FRAME" },
        { ...record, envelopeType: secret },
        { ...record, issuePaths: [secret] },
        { ...record, issuePaths: [`snapshot.threads.[].${secret}`] },
      ])
        expect(() => report(smuggled)).toThrow();
      expect(log).toHaveBeenCalledOnce();

      log.mockClear();
      for (let reported = 0; reported < 130; reported += 1) report(record);
      expect(log).toHaveBeenCalledTimes(119);
      vi.advanceTimersByTime(10_000);
      log.mockClear();
      report(record);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "host.realtime.frame-rejected",
        expect.objectContaining({ suppressed: 11 }),
      );
    } finally {
      handlers.unregister();
    }
  });

  it("logs where a renderer failed, and refuses the error's own words", () => {
    const log = vi.fn();
    const handlers = registerWith(passwordsPort(), {}, log);
    const report = (input: unknown) =>
      handlers.invoke(
        desktopBridgeChannels.reportRendererFailure,
        ipcEvent("app://opensteer/workspaces"),
        { bridgeToken: "b".repeat(43), input },
      );
    const record = {
      componentFrames: ["at VoiceAsk (app://opensteer/assets/app.js:1:2)"],
      errorFrames: ["at Island (app://opensteer/assets/app.js:3:4)", "at render (app.js:5:6)"],
      errorName: "TypeError",
    };
    try {
      report(record);
      expect(log).toHaveBeenCalledExactlyOnceWith("desktop.renderer.failed", {
        componentFrames: "at VoiceAsk (app://opensteer/assets/app.js:1:2)",
        errorFrames: "at Island (app://opensteer/assets/app.js:3:4);at render (app.js:5:6)",
        errorName: "TypeError",
        suppressed: 0,
      });
      for (const smuggled of [
        { ...record, message: "os_secret_PRIVATE" },
        { ...record, errorName: "os_secret PRIVATE" },
      ])
        expect(() => report(smuggled)).toThrow();
      expect(log).toHaveBeenCalledOnce();
    } finally {
      handlers.unregister();
    }
  });

  it("refuses a malformed Passwords status rather than forwarding it", async () => {
    const malformed = passwordsPort({
      availability: "available",
      broker: { agentSignIns: "maybe", vault: "ready" },
      development: false,
    } as unknown as DesktopPasswordsStatus);
    const handlers = registerWith(malformed);

    await expect(
      handlers.invoke(
        desktopBridgeChannels.getPasswordsStatus,
        ipcEvent("app://opensteer/settings/passwords"),
        { bridgeToken: "b".repeat(43) },
      ),
    ).resolves.toEqual({
      ok: false,
      message: "Opensteer could not read that Passwords request or answer.",
    });
    handlers.unregister();
  });
});

const readyStatus = {
  availability: "available",
  broker: { agentSignIns: "on", personFill: "off", personSave: "off", vault: "ready" },
  development: false,
} as const satisfies DesktopPasswordsStatus;

function passwordsPort(status: DesktopPasswordsStatus = readyStatus) {
  const calls: string[] = [];
  const listeners = new Set<(status: DesktopPasswordsStatus) => void>();
  return {
    calls,
    notify: (next: DesktopPasswordsStatus) => {
      for (const listener of listeners) listener(next);
    },
    port: {
      open: async () => {
        calls.push("open");
      },
      signIns: {
        get: () => ({ stage: "gone" as const }),
        approve: async () => ({ ok: true as const }),
        subscribe: () => () => undefined,
      },
      status: async () => {
        calls.push("status");
        return status;
      },
      subscribe: (listener: (status: DesktopPasswordsStatus) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

function registerWith(
  passwords: ReturnType<typeof passwordsPort>,
  computerUse: Partial<Parameters<typeof registerDesktopBridge>[0]["computerUse"]> = {},
  log?: Parameters<typeof registerDesktopBridge>[0]["log"],
  overrides: Partial<Parameters<typeof registerDesktopBridge>[0]> = {},
) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  const unregister = registerDesktopBridge({
    ...(log ? { log } : {}),
    downloads: {
      snapshot: () => ({ downloads: [] }),
      subscribe: () => () => undefined,
      open: async () => ({ status: "missing" }),
      show: () => ({ status: "missing" }),
      cancel: () => ({ status: "missing" }),
    },
    localVisibility: { getSnapshot: () => true, subscribe: () => () => undefined },
    access: { ...accessOperationMocks(), snapshot, subscribe: vi.fn(() => () => undefined) },
    agentPhone: agentPhone(),
    bridgeToken: "b".repeat(43),
    computerApps: {
      dragIcon: async () => {
        throw new Error("not part of this test");
      },
      setup: computerAppSetupUnused,
    },
    computerUse: {
      onActivationError: () => undefined,

      closePermissionsPanel: async () => undefined,
      openPermissionsPanel: async () => undefined,
      openSystemSettings: async () => undefined,
      permissions: async () => ({ accessibility: "denied", screenRecording: "denied" }) as const,
      requestPermissions: async () =>
        ({ accessibility: "granted", screenRecording: "granted" }) as const,
      verifyBundledHelper: async () => undefined,
      ...computerUse,
    },
    fullDiskAccess: fullDiskAccess(),
    hostTransport: hostTransport(),
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    passwords: passwords.port,

    notifications: { openSettings: vi.fn(async () => undefined) },
    tailscale: tailscalePort(),
    portal: { openExternal: vi.fn(async () => undefined), pickFolder: vi.fn(async () => null) },
    runner: runnerController(),
    ...overrides,
  });
  return {
    invoke: (channel: string, event: IpcMainInvokeEvent, envelope: unknown) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler(event, envelope);
    },
    passwords,
    unregister,
  };
}

function accessOperationMocks() {
  const operation = () => vi.fn(async () => undefined);
  return {
    addDirect: operation(),
    cancel: operation(),
    checkDeployments: operation(),
    connectPrivate: operation(),
    createPersonalDeployment: operation(),
    deploymentPolicy: vi.fn(() => undefined),
    linkPersonal: operation(),
    reauthorize: operation(),
    refreshDirectory: operation(),
    removeFromAccount: operation(),
    retry: operation(),
    select: operation(),
    signIn: operation(),
    signOut: operation(),
    unlinkPersonal: operation(),
  };
}

function snapshot(revision = 1) {
  return DeploymentAccessSnapshotSchema.parse({
    account: { available: true, status: "signed-out" },
    deployments: [],
    directoryFailure: null,
    personalAccountLink: {
      account: null,
      deploymentId: null,
      displayName: null,
      status: "unavailable",
      unlinkStep: null,
    },
    personalSetup: null,
    revision,
    selectedDeploymentId: null,
    unavailable: [],
  });
}

function tailscalePort() {
  return {
    share: vi.fn(async () => ({ ok: true as const, origin: "https://studio.tailnet.ts.net" })),
    status: vi.fn(async () => ({ state: "not-installed" as const })),
  };
}

function runnerController() {
  const listeners = new Set<() => void>();
  const status = (deploymentId: ReturnType<typeof createId<"deployment">>) => ({
    available: true,
    computerName: "Studio Mac",
    deploymentId,
    mayRunAgents: true,
    platform: "macos" as const,
    runAgents: false,
    runner: {
      detail: "This Mac is not in this Deployment.",
      enrolled: false,
      environmentId: null,
      runnerId: null,
      state: "disabled" as const,
    },
    schemaVersion: 4 as const,
  });
  return {
    prepareDeviceSetup: vi.fn(async () => ({
      runnerId: createId("runner"),
      publicKeyPem: "preview-key",
    })),
    accountSignOutPreview: vi.fn(async () => []),
    setUpDevice: vi.fn(async (input) => status(input.deploymentId)),
    signDeviceSessionBinding: vi.fn(async () => ({
      issuedAt: new Date().toISOString(),
      signature: "s".repeat(86),
    })),
    leaveDeployment: vi.fn(async () => undefined),
    recheckEngines: vi.fn(),
    remove: vi.fn(async (deploymentId) => status(deploymentId)),
    notify: () => {
      for (const listener of listeners) listener();
    },
    start: vi.fn(async (input) => status(input.deploymentId)),
    status: vi.fn(async (deploymentId) => status(deploymentId)),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
}

function hostTransport(deploymentId = createId("deployment")) {
  return {
    closeBinary: vi.fn(async () => undefined),
    closeBinaryForOwner: vi.fn(async () => undefined),
    openBinary: vi.fn(async () => ({ transferId: crypto.randomUUID() })),
    writeBinary: vi.fn(async () => undefined),
    finishBinary: vi.fn(async () => ({
      body: "{}",
      headers: { contentType: "application/json" },
      status: 200,
    })),
    readBinary: vi.fn(async () => ({
      bytes: new Uint8Array(),
      contentType: "application/octet-stream",
      done: true,
      etag: null,
      fileSizeBytes: null,
      fileTruncated: null,
      lastModified: null,
      sizeBytes: 0,
      status: 200,
    })),
    closeSocketsForOwner: vi.fn(),
    closeWebSocket: vi.fn(),
    current: vi.fn(
      async () =>
        ({ resolved: { deploymentId } }) as unknown as Awaited<
          ReturnType<DesktopHostTransport["current"]>
        >,
    ),
    integrationAuthorizationOrigin: vi.fn(async () => "https://host.example.test"),
    openWebSocket: vi.fn(),
    request: vi.fn(async () => ({
      body: "{}",
      headers: { contentType: "application/json" },
      status: 200,
    })),
    sendWebSocket: vi.fn(),
  };
}

function agentPhone() {
  return { chooseUsbDevice: vi.fn(), readArtifact: vi.fn(async () => null) };
}

function fullDiskAccess() {
  return {
    check: vi.fn(async () => false),
    closePanel: vi.fn(async () => undefined),
    request: vi.fn(async () => undefined),
  };
}

function ipcEvent(url: string): IpcMainInvokeEvent {
  const mainFrame = { url };
  return {
    sender: {
      id: 7,
      isDestroyed: () => false,
      mainFrame,
      once: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(),
    },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
}
