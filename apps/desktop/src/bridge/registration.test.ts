import type { IpcMainInvokeEvent } from "electron";
import { createId } from "@opensteer/core";
import {
  DeploymentAccessSnapshotSchema,
  type DeploymentAccessSnapshot,
  type DesktopPasswordsStatus,
} from "@opensteer/protocol/desktop";
import { describe, expect, it, vi } from "vitest";
import type { DesktopHostTransport } from "../connections/host-transport.js";
import { AdHocSignedHelperError } from "../signed-helpers/signed-helper.js";
import { desktopBridgeChannels } from "./desktop-bridge-channels.js";
import { registerDesktopBridge } from "./registration.js";

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
    const unregister = registerDesktopBridge({
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
        approvalKey: async () => ({ keyId: `sha256:${"k".repeat(43)}`, publicKey: "key" }),
        dragIcon: async () => {
          throw new Error("not part of this test");
        },
        setup: computerAppSetupUnused,
        review: async () => ({ allowed: false }),
      },
      computerUse: {
        onActivationError: () => undefined,
        approvalGet: () => {
          throw new Error("no approval is open");
        },
        approvalRespond: () => undefined,
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
      personalRemote: personalRemote(),
      portal: { openExternal: vi.fn(async () => undefined), pickFolder: vi.fn(async () => null) },
      runner,
    });
    const event = ipcEvent("app://opensteer/workspaces");
    const envelope = { bridgeToken: "b".repeat(43) };

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
      desktopBridgeChannels.dictationEvent,
      desktopBridgeChannels.downloadsChanged,
      desktopBridgeChannels.workspaceTabCommand,
      desktopBridgeChannels.deploymentAccessSnapshotChanged,
      desktopBridgeChannels.hostWebSocketEvent,
      desktopBridgeChannels.localExecutionStatusChanged,
      desktopBridgeChannels.passwordsSignInChanged,
      desktopBridgeChannels.passwordsStatusChanged,
      desktopBridgeChannels.personalRemoteAccessStatusChanged,
      desktopBridgeChannels.notificationActivated,
      desktopBridgeChannels.usbDeviceChoice,
      desktopBridgeChannels.localVisibilityChanged,
      desktopBridgeChannels.browserPresentationEvent,
      desktopBridgeChannels.glassScene,
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

  it("reviews a page's setup request on the Deployment the page is attached to", async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
    const pageDeploymentId = createId("deployment");
    const review = vi.fn(async () => ({ allowed: true }));
    const transport = hostTransport(pageDeploymentId);
    registerDesktopBridge({
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
        approvalKey: async () => ({ keyId: `sha256:${"k".repeat(43)}`, publicKey: "key" }),
        dragIcon: async () => {
          throw new Error("not part of this test");
        },
        setup: computerAppSetupUnused,
        review,
      },
      computerUse: {
        onActivationError: () => undefined,
        approvalGet: () => {
          throw new Error("no approval is open");
        },
        approvalRespond: () => undefined,
        closePermissionsPanel: async () => undefined,
        openPermissionsPanel: async () => undefined,
        verifyBundledHelper: async () => undefined,
        openSystemSettings: async () => undefined,
        permissions: async () => ({ accessibility: "denied", screenRecording: "denied" }) as const,
        requestPermissions: async () =>
          ({ accessibility: "granted", screenRecording: "granted" }) as const,
      },
      fullDiskAccess: fullDiskAccess(),
      hostTransport: transport,
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
      passwords: passwordsPort().port,
      personalRemote: personalRemote(),
      portal: { openExternal: vi.fn(async () => undefined), pickFolder: vi.fn(async () => null) },
      runner: runnerController(),
    });
    const setupRequestId = "7c1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071";

    await expect(
      handlers.get(desktopBridgeChannels.reviewComputerAppSetup)?.(
        ipcEvent("app://opensteer/computers"),
        { bridgeToken: "b".repeat(43), input: { setupRequestId } },
      ),
    ).resolves.toEqual({ allowed: true });

    // The page's own Host calls reach the attached Deployment, so that is the
    // one it created the request on, and the review is handed exactly it.
    expect(transport.current).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(pageDeploymentId, setupRequestId);
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
        approvalKey: async () => ({ keyId: `sha256:${"k".repeat(43)}`, publicKey: "key" }),
        dragIcon: async () => {
          throw new Error("not part of this test");
        },
        setup: computerAppSetupUnused,
        review: async () => ({ allowed: false }),
      },
      computerUse: {
        onActivationError: () => undefined,
        approvalGet: () => {
          throw new Error("no approval is open");
        },
        approvalRespond: () => undefined,
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
      personalRemote: personalRemote(),
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
  broker: { agentSignIns: "on", vault: "ready" },
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
) {
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
    access: { ...accessOperationMocks(), snapshot, subscribe: vi.fn(() => () => undefined) },
    agentPhone: agentPhone(),
    bridgeToken: "b".repeat(43),
    computerApps: {
      approvalKey: async () => ({ keyId: `sha256:${"k".repeat(43)}`, publicKey: "key" }),
      dragIcon: async () => {
        throw new Error("not part of this test");
      },
      setup: computerAppSetupUnused,
      review: async () => ({ allowed: false }),
    },
    computerUse: {
      onActivationError: () => undefined,
      approvalGet: () => {
        throw new Error("no approval is open");
      },
      approvalRespond: () => undefined,
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
    personalRemote: personalRemote(),
    portal: { openExternal: vi.fn(async () => undefined), pickFolder: vi.fn(async () => null) },
    runner: runnerController(),
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

function runnerController() {
  const listeners = new Set<() => void>();
  const portableFs = {
    binaryPath: "/Applications/PortableFS.app",
    detail: "Ready",
    installAvailable: false,
    issue: null,
    state: "ready-to-mount" as const,
    version: "3.1.0",
  };
  const status = (deploymentId: ReturnType<typeof createId<"deployment">>) => ({
    available: true,
    computerName: "Studio Mac",
    deploymentId,
    mayRunAgents: true,
    platform: "macos" as const,
    portableFs,
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
    remove: vi.fn(async (deploymentId) => status(deploymentId)),
    notify: () => {
      for (const listener of listeners) listener();
    },
    portableFs: () => ({
      acknowledgeApproval: vi.fn(async () => portableFs),
      install: vi.fn(async () => portableFs),
      openSetup: vi.fn(async () => portableFs),
      requireReadyBinary: vi.fn(async () => portableFs.binaryPath),
      status: vi.fn(async () => portableFs),
    }),
    start: vi.fn(async (input) => status(input.deploymentId)),
    status: vi.fn(async (deploymentId) => status(deploymentId)),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
}

function personalRemote() {
  const status = {
    deploymentId: null,
    detail: "Unavailable",
    generation: 0,
    mode: "off" as const,
    phase: "unavailable" as const,
    retryable: false,
    routeOrigin: null,
    schemaVersion: 1 as const,
  };
  return {
    configure: vi.fn(async () => status),
    issuePairingCode: vi.fn(),
    status,
    subscribe: vi.fn(() => () => undefined),
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
      send: vi.fn(),
    },
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
}
