import type { PasswordSignInAccount } from "@opensteer/client/host";
import { createId } from "@opensteer/core";
import { hostApi } from "@opensteer/protocol";
import {
  DesktopDownloadSchema,
  DesktopDownloadTargetSchema,
  desktopDownloadsActiveLimit,
  desktopDownloadsFinishedLimit,
  type DesktopDownload,
  type DesktopDownloadActionResult,
  type DesktopDownloadsBridge,
  type DesktopDownloadsSnapshot,
  DeploymentAccessSnapshotSchema,
  DesktopAddDirectRouteInputSchema,
  DesktopConfigurePersonalRemoteAccessInputSchema,
  DesktopConnectPrivateDeploymentInputSchema,
  DesktopDeploymentSelectionSchema,
  DesktopDeploymentSummarySchema,
  DesktopHostHttpRequestSchema,
  DesktopHostHttpResultSchema,
  DesktopLocalExecutionInputSchema,
  DesktopLocalExecutionStatusSchema,
  DesktopAccountAuthStateSchema,
  DesktopOpenHostWebSocketInputSchema,
  DesktopPersonalDeploymentStatusSchema,
  DesktopPersonalPairingCodeSchema,
  DesktopPersonalRemoteAccessStatusSchema,
  DesktopSelectDeploymentInputSchema,
  DesktopStartLocalRunnerInputSchema,
  DesktopPasswordsSignInApproveInputSchema,
  DesktopPasswordsSignInCardInputSchema,
  type DesktopComputerUseApprovalPresentation,
  type DesktopPasswordsSignInCardState,
  type DesktopPasswordsStatus,
  type DesktopDeploymentSelection,
  type DesktopDeploymentSummary,
  type DesktopHostWebSocketEvent,
  type DesktopLocalExecutionStatus,
  type DesktopAccountAuthState,
  type DesktopPersonalDeploymentStatus,
  type DesktopPersonalAccountLinkStatus,
  type DesktopPersonalRemoteAccessStatus,
  type OpensteerDesktopBridge,
  type DeploymentAccessSnapshot,
  type DesktopComputerAppSetup,
} from "@opensteer/protocol/desktop";

import { previewBootstrap, previewDate, previewWorkspace } from "./preview-bootstrap.js";

const previewParameter = "desktop-preview";
const previewConnectOrigin = "https://preview-connect.opensteer.invalid";
const previewPersonalOrigin = "http://127.0.0.1:4310";
const previewPairingCode = `osp_${"p".repeat(43)}`;

/**
 * The rpc declaration owns the bootstrap contract, so the simulator derives its
 * route and response body from the same record the real client reads. A renamed
 * or reshaped member becomes a compile error here instead of an onboarding
 * preview that answers 501 to the only request the shell makes.
 */
const bootstrapMember = "bootstrap.get";
const bootstrapDeclaration = hostApi[bootstrapMember];
const bootstrapPath = `/v1/rpc/${bootstrapMember}`;
/** Bridge requests carry an origin-relative path; this base only makes it parseable. */
const previewRequestBase = "http://desktop-preview.invalid";

interface DesktopPreviewBridgeOptions {
  /** Delay between observable simulator phases. Browser previews use the
   * default; focused tests can shorten it without changing the state model. */
  readonly transitionDelayMs?: number;
}

/** The setup panel's preview: Messages, with this app switched on as the wrong row. */
let previewSetup: DesktopComputerAppSetup | null = {
  appIconPng: null,
  appName: "Opensteer",
  definitionId: "apple-messages",
  helperReachable: true,
  phase: "offer",
  steps: [
    { grant: "full-disk-access", kind: "settings", state: "current" },
    { grant: "automation", kind: "ask", state: "waiting" },
  ],
  targetName: "Messages",
  thisAppHasFullDiskAccess: true,
};

/**
 * An explicit development-only simulator for browser rendering of the
 * packaged Desktop journey. It implements the same bridge contract and emits
 * the same durable state transitions as Electron main, but never contacts an
 * Account, Host, or provider. A real preload bridge always wins in `main.tsx`,
 * and production builds compile this module out via `import.meta.env.DEV`.
 */
export function desktopPreviewBridge(
  search = typeof window === "undefined" ? "" : window.location.search,
  enabled = import.meta.env.DEV,
  options: DesktopPreviewBridgeOptions = {},
): OpensteerDesktopBridge | null {
  if (!enabled || new URLSearchParams(search).get(previewParameter) !== "first-run") return null;

  const transitionDelayMs = Math.max(0, options.transitionDelayMs ?? 280);
  const personalDeploymentId = createId("deployment");
  const privateDeploymentId = createId("deployment");
  const previewEnvironmentId = createId("environment");
  const previewRunnerId = createId("runner");
  const previewUserId = createId("user");
  const previewWorkspaceId = createId("workspace");
  const signedInDeployments = new Set<string>();
  const socketPaths = new Map<string, string>();
  let socketOrdinal = 0;

  let accountAuth = signedOutAccountAuth();
  let hostAuth: {
    deploymentId: string | null;
    status: "authorizing" | "error" | "signed-in" | "signed-out";
  } = { deploymentId: null, status: "signed-out" };
  let selection = DesktopDeploymentSelectionSchema.parse({
    deployments: [],
    revision: 0,
    schemaVersion: 1,
    selectedDeploymentId: null,
  });
  let personal = stoppedPersonalStatus();
  let remoteAccess = unavailableRemoteAccessStatus();
  let personalAccountLink: DesktopPersonalAccountLinkStatus = {
    account: null,
    deploymentId: null,
    displayName: null,
    status: "unavailable" as const,
    unlinkStep: null,
  };
  const localExecutions = new Map<string, DesktopLocalExecutionStatus>();
  const localExecutionFor = (input: unknown): DesktopLocalExecutionStatus => {
    const { deploymentId } = DesktopLocalExecutionInputSchema.parse(input);
    const existing = localExecutions.get(deploymentId);
    if (existing) return existing;
    const created = initialLocalExecutionStatus(deploymentId);
    localExecutions.set(deploymentId, created);
    return created;
  };

  const remoteAccessListeners = new Set<(status: DesktopPersonalRemoteAccessStatus) => void>();
  const passwordsListeners = new Set<(status: DesktopPasswordsStatus) => void>();
  const passwords = previewPasswordsStatus(search);
  const signInCardListeners = new Set<(state: DesktopPasswordsSignInCardState) => void>();
  let signInCard = previewPasswordsSignInCard(search);
  const moveSignInCard = (next: DesktopPasswordsSignInCardState) => {
    signInCard = next;
    emit(signInCardListeners, signInCard);
  };
  const localExecutionListeners = new Set<(status: DesktopLocalExecutionStatus) => void>();
  const socketListeners = new Set<(event: DesktopHostWebSocketEvent) => void>();
  const accessListeners = new Set<(snapshot: DeploymentAccessSnapshot) => void>();
  let accessRevision = 0;
  let personalGeneration = 0;

  function updateLocalExecution(status: DesktopLocalExecutionStatus): void {
    localExecutions.set(status.deploymentId, status);
    for (const listener of localExecutionListeners) listener(status);
  }

  const accessSnapshot = () =>
    DeploymentAccessSnapshotSchema.parse({
      account: {
        available: accountAuth.account.available,
        ...(accountAuth.account.detail ? { detail: accountAuth.account.detail } : {}),
        ...(accountAuth.account.identity?.email
          ? { email: accountAuth.account.identity.email }
          : {}),
        ...(accountAuth.account.identity
          ? {
              issuer: accountAuth.account.identity.issuer,
              subject: accountAuth.account.identity.subject,
            }
          : {}),
        status: accountAuth.account.status,
      },
      deployments: selection.deployments.map((candidate) => {
        const selected = candidate.id === selection.selectedDeploymentId;
        const status =
          selected && hostAuth.deploymentId === candidate.id
            ? hostAuth.status === "signed-in"
              ? "connected"
              : hostAuth.status === "authorizing"
                ? "authorizing"
                : hostAuth.status === "error"
                  ? "offline"
                  : "needs-sign-in"
            : candidate.onThisComputer && personal.state !== "ready"
              ? personal.state === "starting"
                ? "connecting"
                : "offline"
              : selected
                ? "connected"
                : "idle";
        return {
          ...candidate,
          // The preview has no Account behind it, so no row is an Account listing.
          accountAccess: null,
          availableActions: selected
            ? status === "connecting"
              ? (["cancel"] as const)
              : status === "authorizing"
                ? (["retry", "cancel"] as const)
                : status === "connected"
                  ? ([] as const)
                  : (["retry"] as const)
            : (["select"] as const),
          failure:
            status === "offline"
              ? {
                  code: "preview-host-offline",
                  detail: "This computer is not running Opensteer.",
                  retryable: true,
                }
              : status === "needs-sign-in"
                ? {
                    code: "host-sign-in-required",
                    detail: "Sign in to this server to continue.",
                    retryable: true,
                  }
                : null,
          source: candidate.onThisComputer ? "this-device" : "manual",
          status,
          statusInfo:
            candidate.onThisComputer && personal.state !== "ready"
              ? personal.state === "starting"
                ? ({ reason: null, status: "starting" } as const)
                : ({
                    reason: "This computer is not running Opensteer.",
                    status: "offline",
                  } as const)
              : ({ reason: null, status: "ready" } as const),
        };
      }),
      personalAccountLink,
      personalSetup: personal,
      revision: accessRevision,
      selectedDeploymentId: selection.selectedDeploymentId,
    });
  const emitAccess = () => {
    accessRevision += 1;
    emit(accessListeners, accessSnapshot());
  };
  const emitAuth = () => {
    emitAccess();
  };
  const emitPersonal = () => {
    emitAccess();
  };
  const emitRemoteAccess = () => emit(remoteAccessListeners, remoteAccess);
  const emitSelection = () => {
    emitAccess();
  };
  const emitSocket = (event: DesktopHostWebSocketEvent) => emit(socketListeners, event);
  const schedule = (phase: number, action: () => void) => {
    globalThis.setTimeout(action, transitionDelayMs * phase);
  };

  function updateAuthAccount(
    status: DesktopAccountAuthState["account"]["status"],
    detail: string | null,
  ) {
    const identity =
      status === "signed-out" || status === "error"
        ? null
        : status === "signed-in"
          ? (accountAuth.account.identity ?? previewAccountIdentity())
          : accountAuth.account.identity;
    accountAuth = DesktopAccountAuthStateSchema.parse({
      ...accountAuth,
      account: { available: true, detail, identity, status },
    });
    emitAuth();
  }

  function selectHost(deployment: DesktopDeploymentSummary, status?: "signed-in" | "signed-out") {
    hostAuth = {
      deploymentId: deployment.id,
      status: status ?? (signedInDeployments.has(deployment.id) ? "signed-in" : "signed-out"),
    };
    emitAuth();
  }

  function upsertAndSelect(deployment: DesktopDeploymentSummary) {
    const deployments = selection.deployments.filter(({ id }) => id !== deployment.id);
    selection = DesktopDeploymentSelectionSchema.parse({
      deployments: [...deployments, deployment],
      revision: selection.revision + 1,
      schemaVersion: 1,
      selectedDeploymentId: deployment.id,
    });
    emitSelection();
    selectHost(deployment);
  }

  const bridge = {
    downloads: desktopPreviewDownloads(),
    onWorkspaceTabCommand: () => () => undefined,
    getLocalVisibility: async () => true,
    onLocalVisibilityChanged: () => () => undefined,
    computerUseApprovalKey: async () => ({
      keyId: `sha256:${"p".repeat(43)}`,
      publicKey:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----\n",
    }),
    reviewComputerAppSetup: async () => ({ allowed: false }),
    // The preview carries no Agent Phone app and no USB phone to choose.
    readAgentPhoneArtifact: async () => null,
    onUsbDeviceChoice: () => () => undefined,
    chooseUsbDevice: async () => undefined,
    openComputerAppSetup: async () => ({ opened: true }),
    computerAppSetupStatus: async () => ({ setup: previewSetup }),
    computerAppSetupBegin: async () => {
      previewSetup = previewSetup && { ...previewSetup, phase: "steps" };
    },
    computerAppSetupShowAgain: async () => undefined,
    computerAppSetupStartDrag: async () => undefined,
    closeComputerAppSetup: async () => {
      previewSetup = null;
    },
    acknowledgePortableFsApproval: async (input) => {
      const localExecution = readyPortableFs(localExecutionFor(input));
      updateLocalExecution(localExecution);
      return localExecution;
    },

    addDirect: async (input) => {
      const parsed = DesktopAddDirectRouteInputSchema.parse(input);
      const target = deploymentById(selection, parsed.deploymentId);
      const routes = [
        ...target.routes
          .filter(({ origin }) => origin !== parsed.origin)
          .map((route) => ({ ...route, selected: false })),
        { kind: "direct" as const, origin: parsed.origin, selected: true },
      ];
      replaceDeployment({ ...target, activeOrigin: parsed.origin, routes });
    },

    cancel: async () => {
      emitAccess();
    },

    reauthorize: async () => {
      updateAuthAccount("authorizing", "Complete authorization in your browser.");
      schedule(1, () => {
        updateAuthAccount("signed-in", null);
      });
    },

    signIn: async () => {
      updateAuthAccount("authorizing", "Complete authorization in your browser.");
      schedule(1, () => {
        updateAuthAccount("signed-in", null);
      });
    },

    closeHostWebSocket: async (input) => {
      const path = socketPaths.get(input.connectionId);
      if (!path) return;
      socketPaths.delete(input.connectionId);
      emitSocket({
        code: input.code ?? 1_000,
        connectionId: input.connectionId,
        reason: input.reason ?? "",
        type: "close",
      });
    },

    configurePersonalRemoteAccess: async (input) => {
      const parsed = DesktopConfigurePersonalRemoteAccessInputSchema.parse(input);
      if (personal.state !== "ready" || personal.deploymentId === null) {
        throw new Error("Set up This Computer before configuring remote access.");
      }
      const generation = remoteAccess.generation + 1;
      if (parsed.mode === "off") {
        remoteAccess = DesktopPersonalRemoteAccessStatusSchema.parse({
          ...remoteAccess,
          detail: "Turning off remote access…",
          generation,
          mode: "off",
          phase: "revoking",
          retryable: false,
          routeOrigin: null,
        });
        emitRemoteAccess();
        schedule(1, () => {
          remoteAccess = DesktopPersonalRemoteAccessStatusSchema.parse({
            ...remoteAccess,
            detail: null,
            phase: "off",
          });
          emitRemoteAccess();
        });
        return remoteAccess;
      }

      const routeOrigin = parsed.mode === "connect" ? previewConnectOrigin : parsed.privateOrigin;
      const accountLinked = parsed.mode === "connect" && accountAuth.account.status === "signed-in";
      remoteAccess = DesktopPersonalRemoteAccessStatusSchema.parse({
        ...remoteAccess,
        detail: accountLinked || parsed.mode === "private" ? "Preparing access…" : "Signing in…",
        generation,
        mode: parsed.mode,
        phase: accountLinked || parsed.mode === "private" ? "provisioning" : "linking-account",
        retryable: true,
        routeOrigin,
      });
      emitRemoteAccess();
      schedule(1, () => {
        if (remoteAccess.generation !== generation) return;
        if (parsed.mode === "connect") updateAuthAccount("signed-in", null);
        remoteAccess = DesktopPersonalRemoteAccessStatusSchema.parse({
          ...remoteAccess,
          detail: "Preparing access…",
          phase: "provisioning",
        });
        emitRemoteAccess();
      });
      schedule(2, () => {
        if (remoteAccess.generation !== generation) return;
        remoteAccess = DesktopPersonalRemoteAccessStatusSchema.parse({
          ...remoteAccess,
          detail: null,
          phase: "ready",
          retryable: false,
        });
        emitRemoteAccess();
      });
      return remoteAccess;
    },

    connectPrivate: async (input) => {
      emitAccess();
      const parsed = DesktopConnectPrivateDeploymentInputSchema.parse(input);
      const connected = deployment({
        id: privateDeploymentId,
        kind: parsed.kind === "personal-pairing" ? "personal" : "self-hosted",
        name: new URL(parsed.origin).host,
        onThisComputer: false,
        origin: parsed.origin,
      });
      if (parsed.kind === "personal-pairing") signedInDeployments.add(connected.id);
      upsertAndSelect(connected);
      if (parsed.kind === "personal-pairing") selectHost(connected, "signed-in");
      emitAccess();
    },

    getDeploymentAccessSnapshot: async () => accessSnapshot(),
    listCloudDeployments: async () => ({ available: false, deployments: [] }),
    getLocalExecutionStatus: async (input) => localExecutionFor(input),
    getPersonalRemoteAccessStatus: async () => remoteAccess,

    hostRequest: async (input) => {
      const request = DesktopHostHttpRequestSchema.parse(input);
      const selected = selectedDeployment(selection);
      if (!selected || hostAuth.deploymentId !== selected.id || hostAuth.status !== "signed-in") {
        return jsonResponse(401, {
          error: {
            code: "unauthorized",
            message: "The onboarding preview Host is not signed in.",
            retryable: false,
          },
          ok: false,
        });
      }
      if (
        request.method === bootstrapDeclaration.method &&
        new URL(request.path, previewRequestBase).pathname === bootstrapPath
      ) {
        return jsonResponse(200, {
          data: bootstrapDeclaration.success.parse(
            previewBootstrap(selected, {
              environmentId: previewEnvironmentId,
              runnerId: previewRunnerId,
              userId: previewUserId,
              workspaceId: previewWorkspaceId,
            }),
          ),
          ok: true,
        });
      }
      return jsonResponse(501, {
        error: {
          code: "not_found",
          message: "This development simulator covers Desktop onboarding, not Host mutations.",
          retryable: false,
        },
        ok: false,
      });
    },
    hostBinaryOpen: async () => {
      throw new Error("Attachment transfer is unavailable in onboarding preview.");
    },
    hostBinaryWrite: async () => {
      throw new Error("Attachment transfer is unavailable in onboarding preview.");
    },
    hostBinaryFinish: async () => {
      throw new Error("Attachment transfer is unavailable in onboarding preview.");
    },
    hostBinaryRead: async () => {
      throw new Error("Attachment transfer is unavailable in onboarding preview.");
    },
    hostBinaryClose: async () => ({ ok: true, data: null }),

    installPortableFs: async (input) => {
      const localExecution = readyPortableFs(localExecutionFor(input));
      updateLocalExecution(localExecution);
      return localExecution;
    },

    issuePersonalPairingCode: async () => {
      if (remoteAccess.mode !== "private" || remoteAccess.phase !== "ready") {
        throw new Error("Enable Private network access before creating a pairing code.");
      }
      return DesktopPersonalPairingCodeSchema.parse({
        code: previewPairingCode,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        generation: remoteAccess.generation,
        routeOrigin: remoteAccess.routeOrigin,
        schemaVersion: 1,
      });
    },

    linkPersonal: async () => {
      if (personal.deploymentId === null)
        throw new Error("Set up This Computer before linking it.");
      updateAuthAccount("signed-in", null);
      personalAccountLink = {
        account: { issuer: "https://account.opensteer.test", subject: "preview-account" },
        deploymentId: personal.deploymentId,
        displayName: "Mac mini",
        status: "linked",
        unlinkStep: null,
      };
      emitAccess();
    },

    onDeploymentAccessSnapshotChanged: (listener) => subscribe(accessListeners, listener),
    onHostWebSocketEvent: (listener) => subscribe(socketListeners, listener),
    onLocalExecutionStatusChanged: (listener) => subscribe(localExecutionListeners, listener),
    onPersonalRemoteAccessStatusChanged: (listener) => subscribe(remoteAccessListeners, listener),
    onNotificationActivated: () => () => undefined,
    getNotificationSupport: async () => ({ supported: false }),
    showNotification: async () => ({ status: "unsupported" }),
    setBadgeCount: async () => undefined,

    openExternalUrl: async () => ({ opened: true }),
    openIntegrationAuthorization: async () => ({ opened: true }),

    openHostWebSocket: async (input) => {
      const parsed = DesktopOpenHostWebSocketInputSchema.parse(input);
      if (hostAuth.status !== "signed-in") {
        throw new Error("The onboarding preview Host is not signed in.");
      }
      socketOrdinal += 1;
      const connectionId = `desktop_host_socket_00000000-0000-4000-8000-${String(
        socketOrdinal,
      ).padStart(12, "0")}`;
      socketPaths.set(connectionId, parsed.path);
      queueMicrotask(() => emitSocket({ connectionId, type: "open" }));
      return { connectionId };
    },

    openPortableFsSetup: async (input) => localExecutionFor(input),

    // The preview has no macOS grant to read, and no pane or panel to open:
    // the four Full access calls answer without a Mac behind them.
    checkFullDiskAccess: async () => ({ granted: false }),
    // The computer-use panels, as the preview shows them: the permissions
    // card with Screen Recording already on, and an approval for Notes as the
    // picker asks it, or `&approval=task` as a task asks it, or
    // `&approval=policy` for turning automatic approval on.
    closeComputerUsePermissionsPanel: async () => undefined,
    computerUseApprovalGet: async () => previewComputerUseApproval(search),
    computerUseApprovalRespond: async () => undefined,
    computerUseOpenSystemSettings: async () => undefined,
    computerUsePermissionsGet: async () => ({
      accessibility: "denied" as const,
      screenRecording: "granted" as const,
    }),
    computerUsePermissionsRequest: async () => ({
      accessibility: "denied" as const,
      screenRecording: "granted" as const,
    }),
    openComputerUsePermissionsPanel: async () => ({ opened: true as const }),
    requestFullDiskAccess: async () => ({ opened: true }),
    closeFullDiskAccessPanel: async () => undefined,

    // Opensteer Passwords, set up and on, or the state `&passwords=` names;
    // a sign-in card on this Mac
    // starts where `&card=` says, and Allow and Only this time
    // move it on as Electron main would.
    onPasswordsStatusChanged: (listener) => subscribe(passwordsListeners, listener),
    passwordsOpen: async () => undefined,
    onPasswordsSignInChanged: (_input, listener) => subscribe(signInCardListeners, listener),
    passwordsSignInApprove: async (input) => {
      const { loginId } = DesktopPasswordsSignInApproveInputSchema.parse(input);
      const account =
        signInCard.stage === "approval"
          ? signInCard.accounts.find(({ id }) => id === loginId)
          : undefined;
      if (!account || new URLSearchParams(search).has("cancel-auth")) {
        return { message: "Touch ID was cancelled. Choose Allow to try again.", ok: false };
      }
      moveSignInCard({ account: account.username, stage: "authorized" });
      return { ok: true };
    },
    passwordsSignInGet: async (input) => {
      DesktopPasswordsSignInCardInputSchema.parse(input);
      return signInCard;
    },
    passwordsStatus: async () => passwords,

    // The onboarding preview has no file dialog to open.
    pickFolder: async () => null,

    select: async (input) => {
      const parsed = DesktopSelectDeploymentInputSchema.parse(input);
      const target = deploymentById(selection, parsed.deploymentId);
      selection = DesktopDeploymentSelectionSchema.parse({
        ...selection,
        deployments: selection.deployments.map((candidate) =>
          candidate.id === target.id ? { ...candidate, lastUsedAt: previewDate } : candidate,
        ),
        revision: selection.revision + 1,
        selectedDeploymentId: target.id,
      });
      emitSelection();
      selectHost(target, signedInDeployments.has(target.id) ? "signed-in" : "signed-out");
      if (!signedInDeployments.has(target.id)) {
        hostAuth = { deploymentId: target.id, status: "authorizing" };
        emitAuth();
        schedule(1, () => {
          if (hostAuth.deploymentId !== target.id) return;
          signedInDeployments.add(target.id);
          hostAuth = { deploymentId: target.id, status: "signed-in" };
          emitAuth();
        });
      }
    },

    sendHostWebSocket: async (input) => {
      if (!socketPaths.has(input.connectionId) || input.type !== "text") return;
      let frame: unknown;
      try {
        frame = JSON.parse(input.data);
      } catch {
        return;
      }
      if (!isSubscribeFrame(frame)) return;
      const selected = selectedDeployment(selection);
      if (!selected) return;
      const workspace = previewWorkspace(selected, previewWorkspaceId, previewEnvironmentId);
      emitSocket({
        connectionId: input.connectionId,
        data: JSON.stringify({
          snapshot: {
            notificationPreferences: [{ workspaceId: workspace.id, muted: false, revision: "0" }],
            readStates: [],
            messageWindows: [],
            messages: [],
            pendingRequestWindow: emptyWindow(),
            pendingRequests: [],
            runQueue: [],
            sequence: "0",
            serializedBytes: 2,
            threadWindow: emptyWindow(),
            threads: [],
            workspace,
          },
          type: "host.snapshot",
        }),
        type: "text",
      });
      emitSocket({
        connectionId: input.connectionId,
        data: JSON.stringify({
          sequence: "0",
          type: "host.synchronized",
          workspaceId: workspace.id,
        }),
        type: "text",
      });
    },

    signOut: async () => {
      updateAuthAccount("signed-out", null);
    },

    unlinkPersonal: async () => {
      personalAccountLink = {
        account: null,
        deploymentId: personal.deploymentId,
        displayName: personal.deploymentId ? "Mac mini" : null,
        status: personal.deploymentId ? "unlinked" : "unavailable",
        unlinkStep: null,
      };
      emitAccess();
    },

    startLocalRunner: async (input) => {
      const parsed = DesktopStartLocalRunnerInputSchema.parse(input);
      if (selection.selectedDeploymentId !== parsed.deploymentId) {
        throw new Error("The selected deployment changed before local agents could start.");
      }
      const localExecution = DesktopLocalExecutionStatusSchema.parse({
        ...localExecutionFor({ deploymentId: parsed.deploymentId }),
        runAgents: parsed.runAgents,
        runner: {
          detail: "Local agents are ready in this development preview.",
          enrolled: true,
          environmentId: previewEnvironmentId,
          runnerId: previewRunnerId,
          state: "running",
        },
      });
      updateLocalExecution(localExecution);
      return localExecution;
    },

    createPersonalDeployment: async () => {
      const generation = ++personalGeneration;
      personal = DesktopPersonalDeploymentStatusSchema.parse({
        ...stoppedPersonalStatus(),
        canStart: false,
        state: "starting",
        step: "checking-computer",
      });
      emitPersonal();
      schedule(1, () => {
        if (generation !== personalGeneration) return;
        personal = DesktopPersonalDeploymentStatusSchema.parse({
          ...personal,
          components: {
            ...personal.components,
            postgresql: { state: "starting", version: null },
          },
          step: "preparing-database",
        });
        emitPersonal();
      });
      schedule(2, () => {
        if (generation !== personalGeneration) return;
        personal = DesktopPersonalDeploymentStatusSchema.parse({
          ...personal,
          components: {
            ...personal.components,
            host: { state: "starting", version: null },
            postgresql: { state: "ready", version: "18" },
          },
          step: "starting-host",
        });
        emitPersonal();
      });
      schedule(3, () => {
        if (generation !== personalGeneration) return;
        personal = DesktopPersonalDeploymentStatusSchema.parse({
          ...personal,
          components: {
            ...personal.components,
            host: { state: "ready", version: "preview" },
          },
          step: "creating-main",
        });
        emitPersonal();
      });
      schedule(4, () => {
        if (generation !== personalGeneration) return;
        personal = DesktopPersonalDeploymentStatusSchema.parse({
          ...personal,
          components: {
            ...personal.components,
            runner: { state: "starting", version: null },
          },
          environmentId: previewEnvironmentId,
          step: "starting-local-agents",
        });
        emitPersonal();
      });
      schedule(5, () => {
        if (generation !== personalGeneration) return;
        personal = DesktopPersonalDeploymentStatusSchema.parse({
          ...personal,
          components: {
            ...personal.components,
            browser: { state: "starting", version: null },
            runner: { state: "ready", version: "preview" },
          },
          step: "connecting-computer",
        });
        emitPersonal();
      });
      schedule(6, () => {
        if (generation !== personalGeneration) return;
        const created = deployment({
          id: personalDeploymentId,
          kind: "personal",
          name: "Mac mini",
          onThisComputer: true,
          origin: previewPersonalOrigin,
        });
        signedInDeployments.add(created.id);
        upsertAndSelect(created);
        personal = DesktopPersonalDeploymentStatusSchema.parse({
          ...personal,
          components: {
            browser: { state: "ready", version: null },
            host: { state: "ready", version: "preview" },
            messaging: { state: "ready", version: null },
            postgresql: { state: "ready", version: "18" },
            runner: { state: "ready", version: "preview" },
          },
          deploymentId: created.id,
          environmentId: previewEnvironmentId,
          state: "ready",
          step: "ready",
        });
        remoteAccess = DesktopPersonalRemoteAccessStatusSchema.parse({
          deploymentId: created.id,
          detail: null,
          generation: 0,
          mode: "off",
          phase: "off",
          retryable: false,
          routeOrigin: null,
          schemaVersion: 1,
        });
        personalAccountLink = {
          account: null,
          deploymentId: created.id,
          displayName: "Mac mini",
          status: "unlinked",
          unlinkStep: null,
        };
        emitRemoteAccess();
        emitPersonal();
        selectHost(created, "signed-in");
      });
    },
    createCloudDeployment: async () => {
      throw new Error("Opensteer Cloud is unavailable in Desktop preview.");
    },
    deleteCloudDeployment: async () => {
      throw new Error("Opensteer Cloud is unavailable in Desktop preview.");
    },

    stopLocalRunner: async (input) => {
      const parsed = DesktopLocalExecutionInputSchema.parse(input);
      const localExecution = DesktopLocalExecutionStatusSchema.parse({
        ...localExecutionFor(parsed),
        runner: {
          detail: "Local agents are off.",
          enrolled: false,
          environmentId: null,
          runnerId: null,
          state: "disabled",
        },
      });
      updateLocalExecution(localExecution);
      return localExecution;
    },

    // Every place the preview lists is on this computer or answers at once.
    checkDeployments: async () => {
      emitAccess();
    },

    refreshDirectory: async () => {
      if (accountAuth.account.status !== "signed-in") {
        throw new Error("Sign in to Opensteer before refreshing your list.");
      }
      emitSelection();
    },

    removeFromAccount: async ({ deploymentId }) => {
      selection = DesktopDeploymentSelectionSchema.parse({
        ...selection,
        deployments: selection.deployments.filter(({ id }) => id !== deploymentId),
        revision: selection.revision + 1,
        selectedDeploymentId:
          selection.selectedDeploymentId === deploymentId ? null : selection.selectedDeploymentId,
      });
      emitSelection();
    },

    retry: async () => {
      if (selection.selectedDeploymentId) {
        await bridge.select({ deploymentId: selection.selectedDeploymentId });
      }
    },
    retryCloudDeployment: async () => {
      throw new Error("Opensteer Cloud is unavailable in Desktop preview.");
    },
  } satisfies OpensteerDesktopBridge;

  function replaceDeployment(next: DesktopDeploymentSummary) {
    selection = DesktopDeploymentSelectionSchema.parse({
      ...selection,
      deployments: selection.deployments.map((candidate) =>
        candidate.id === next.id ? next : candidate,
      ),
      revision: selection.revision + 1,
    });
    emitSelection();
  }

  return bridge;
}

function previewComputerUseApproval(search: string): DesktopComputerUseApprovalPresentation {
  const variant = new URLSearchParams(search).get("approval");
  const shared = {
    deploymentName: "Alex's Deployment",
    machineName: "Alex's MacBook Pro",
    token: "preview",
  };
  if (variant === "policy") return { ...shared, appApproval: "automatic", kind: "policy" };
  const task = variant === "task";
  return {
    ...shared,
    access: "read-write",
    accessLabel: "Can see and control",
    accessSummary:
      "Agents can see the app and click, type, scroll, press keys, and open it in the background. What the app can do, agents can do through it.",
    app: {
      bundleId: task ? "com.apple.finder" : "com.apple.Notes",
      displayName: task ? "Finder" : "Notes",
      iconPng: null,
      path: task ? "/System/Library/CoreServices/Finder.app" : "/System/Applications/Notes.app",
      reason: null,
      risk: task ? "elevated" : "standard",
    },
    kind: "app",
    reason: task ? "Collect the signed contracts from Downloads into the deal folder." : null,
    threadTitle: task ? "Close the Q3 deals" : null,
    workspaceName: task ? "Sales" : null,
  };
}

function previewPasswordsStatus(search: string): DesktopPasswordsStatus {
  const variant = new URLSearchParams(search).get("passwords");
  switch (variant) {
    case "unsupported":
      return { availability: "unsupported", reason: "hardware" };
    case "unavailable":
      return {
        availability: "unavailable",
        message: "Opensteer Passwords isn’t responding. Quit and reopen Opensteer.",
      };
    case "not-set-up":
    case "needs-reset":
      return {
        availability: "available",
        broker: { agentSignIns: "off", vault: variant },
        development: false,
      };
    default:
      return {
        availability: "available",
        broker: { agentSignIns: "on", vault: "ready" },
        development: variant === "development",
      };
  }
}

/** A saved login as the preview's Mac offers it, ids numbered from `n`. */
function previewAccount(
  n: number,
  input: Partial<PasswordSignInAccount> & { readonly username: string },
): PasswordSignInAccount {
  return {
    host: "github.com",
    id: `0192f4a1-8888-4000-8000-${String(n).padStart(12, "0")}`,
    label: null,
    onPage: true,
    revision: 3,
    updatedAt: "2026-06-15T12:00:00.000Z",
    ...input,
  };
}

/** Two saved GitHub accounts, the second with a label and a long username. */
const previewSignInAccounts = [
  previewAccount(1, { username: "alex@example.com" }),
  previewAccount(2, {
    label: "Work",
    revision: 7,
    username: "alex.demo+platform-operations@corporate-example-holdings.com",
  }),
] as const;

/**
 * Twelve saved amazon.com logins as the broker sends them while the agent is
 * on www.amazon.com: one exact copy folded away, the page's accounts first,
 * then the AWS consoles by host, username and newest.
 */
const previewAmazonAccounts: readonly PasswordSignInAccount[] = [
  ...[
    "jordan3696@example.com",
    "morgan@example.com",
    "alex@company.example",
    "alex901@example.com",
  ].map((username, index) => previewAccount(100 + index, { host: "www.amazon.com", username })),
  ...(
    [
      ["portal.aws.amazon.com", "alex@example.com", "2025-08-10"],
      ["signin.aws.amazon.com", "alex@company.example", "2025-12-01"],
      ["signin.aws.amazon.com", "alex@example.com", "2026-03-14"],
      ["signin.aws.amazon.com", "alex@example.com", "2025-11-02"],
      ["signin.aws.amazon.com", "alex@example.com", "2025-06-20"],
      ["signin.aws.amazon.com", "alex@example.com", "2024-09-08"],
      ["us-east-1.signin.aws.amazon.com", "alex@example.com", "2025-02-17"],
    ] as const
  ).map(([host, username, day], index) =>
    previewAccount(110 + index, {
      host,
      onPage: false,
      updatedAt: `${day}T12:00:00.000Z`,
      username,
    }),
  ),
];

/** Forty logins for a team's GitHub: thirty on the page, ten on two other hosts. */
const previewManyAccounts: readonly PasswordSignInAccount[] = Array.from(
  { length: 40 },
  (_, index) => {
    const onPage = index < 30;
    const host = onPage ? "github.com" : index < 36 ? "gist.github.com" : "docs.github.com";
    const number = String(index + 1).padStart(2, "0");
    return previewAccount(200 + index, {
      host,
      onPage,
      username: index % 7 === 3 ? `release-bot-${number}` : `qa-${number}@example-team.dev`,
    });
  },
);

/** The same username saved three times on one host, and twice with labels. */
const previewDuplicateAccounts: readonly PasswordSignInAccount[] = [
  previewAccount(300, { updatedAt: "2026-09-02T12:00:00.000Z", username: "alex@example.com" }),
  previewAccount(301, { updatedAt: "2026-02-11T12:00:00.000Z", username: "alex@example.com" }),
  previewAccount(302, { updatedAt: "2026-02-03T12:00:00.000Z", username: "alex@example.com" }),
  previewAccount(303, { label: "Personal", username: "jo@example.com" }),
  previewAccount(304, { label: "Work", username: "jo@example.com" }),
];

/** Usernames and a label far wider than the card. */
const previewLongAccounts: readonly PasswordSignInAccount[] = [
  previewAccount(400, {
    username:
      "alex.demo+platform-operations-and-finance-reconciliation@corporate-example-holdings.com",
  }),
  previewAccount(401, {
    label:
      "Shared operations account used by the finance and reconciliation team in the Seoul office",
    username: "finance-reconciliation-shared-mailbox@corporate-example-holdings.com",
  }),
  previewAccount(402, { username: "a".repeat(64) }),
  previewAccount(403, { username: "alex@example.com" }),
];

/**
 * A sign-in card's stage, as `&card=` names it: `approval` (default, two
 * accounts), `approval-one`, `approval-none`, `approval-amazon` (the twelve
 * amazon.com logins), `approval-off-page` (the same with the agent on none of
 * their pages), `approval-many` (forty), `approval-duplicates`,
 * `approval-long`, `authorized` or `gone`.
 */
export function previewPasswordsSignInCard(search: string): DesktopPasswordsSignInCardState {
  const site = "https://github.com";
  const approval = (
    accounts: readonly PasswordSignInAccount[],
    on = site,
  ): DesktopPasswordsSignInCardState => ({ accounts: [...accounts], site: on, stage: "approval" });
  switch (new URLSearchParams(search).get("card")) {
    case "approval-one":
      return approval([previewSignInAccounts[0]]);
    case "approval-none":
      return approval([]);
    case "approval-amazon":
      return approval(previewAmazonAccounts, "https://amazon.com");
    case "approval-off-page":
      return approval(
        // The broker's order with no account on the page: by host, then username.
        [...previewAmazonAccounts.slice(4), ...previewAmazonAccounts.slice(0, 4)].map(
          (account) => ({ ...account, onPage: false }),
        ),
        "https://amazon.com",
      );
    case "approval-many":
      return approval(previewManyAccounts);
    case "approval-duplicates":
      return approval(previewDuplicateAccounts);
    case "approval-long":
      return approval(previewLongAccounts);
    case "authorized":
      return { account: "t•••@example.com", stage: "authorized" };
    case "gone":
      return { stage: "gone" };
    default:
      return approval(previewSignInAccounts);
  }
}

function deployment(input: {
  readonly id: ReturnType<typeof createId<"deployment">>;
  readonly kind: "personal" | "self-hosted";
  readonly name: string;
  readonly onThisComputer: boolean;
  readonly origin: string;
}): DesktopDeploymentSummary {
  return DesktopDeploymentSummarySchema.parse({
    activeOrigin: input.origin,
    canonicalOrigin: input.origin,
    id: input.id,
    kind: input.kind,
    lastUsedAt: previewDate,
    name: input.name,
    access: input.onThisComputer ? "owner" : "native",
    onThisComputer: input.onThisComputer,
    routes: [{ kind: "canonical", origin: input.origin, selected: true }],
  });
}

function deploymentById(
  selection: DesktopDeploymentSelection,
  deploymentId: string,
): DesktopDeploymentSummary {
  const target = selection.deployments.find(({ id }) => id === deploymentId);
  if (!target) throw new Error("Cannot select a deployment that is not in this app’s catalog.");
  return target;
}

function selectedDeployment(
  selection: DesktopDeploymentSelection,
): DesktopDeploymentSummary | undefined {
  return selection.deployments.find(({ id }) => id === selection.selectedDeploymentId);
}

function stoppedPersonalStatus(): DesktopPersonalDeploymentStatus {
  return DesktopPersonalDeploymentStatusSchema.parse({
    canStart: true,
    components: {
      browser: { state: "stopped", version: null },
      host: { state: "stopped", version: null },
      messaging: { state: "stopped", version: null },
      postgresql: { state: "stopped", version: null },
      runner: { state: "stopped", version: null },
    },
    deploymentId: null,
    environmentId: null,
    issue: null,
    schemaVersion: 1,
    state: "stopped",
    step: null,
  });
}

function unavailableRemoteAccessStatus(): DesktopPersonalRemoteAccessStatus {
  return DesktopPersonalRemoteAccessStatusSchema.parse({
    deploymentId: null,
    detail: "Set up This Computer before configuring remote access.",
    generation: 0,
    mode: "off",
    phase: "unavailable",
    retryable: false,
    routeOrigin: null,
    schemaVersion: 1,
  });
}

function initialLocalExecutionStatus(
  deploymentId: DesktopLocalExecutionStatus["deploymentId"],
): DesktopLocalExecutionStatus {
  return DesktopLocalExecutionStatusSchema.parse({
    available: true,
    computerName: "Preview MacBook",
    deploymentId,
    mayRunAgents: true,
    platform: "macos",
    portableFs: {
      binaryPath: null,
      detail:
        "PortableFS is needed only when this computer is enabled to run agents for a Cloud or self-hosted deployment.",
      installAvailable: true,
      issue: null,
      state: "missing",
      version: null,
    },
    runAgents: false,
    runner: {
      detail: "Local agents are off.",
      enrolled: false,
      environmentId: null,
      runnerId: null,
      state: "disabled",
    },
    schemaVersion: 4,
  });
}

function readyPortableFs(current: DesktopLocalExecutionStatus): DesktopLocalExecutionStatus {
  return DesktopLocalExecutionStatusSchema.parse({
    ...current,
    portableFs: {
      binaryPath: "/Applications/PortableFS.app",
      detail: "PortableFS is ready for shared-storage Workspaces.",
      installAvailable: false,
      issue: null,
      state: "ready-to-mount",
      version: "preview",
    },
  });
}

function signedOutAccountAuth(): DesktopAccountAuthState {
  return DesktopAccountAuthStateSchema.parse({
    account: { available: true, detail: null, identity: null, status: "signed-out" },
    schemaVersion: 2,
  });
}

function previewAccountIdentity() {
  return {
    email: "preview@opensteer.invalid",
    issuer: "https://accounts.opensteer.invalid",
    subject: "acct_00000000-0000-4000-8000-000000000001",
  };
}

function emptyWindow() {
  return { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
}

function jsonResponse(status: number, body: unknown) {
  return DesktopHostHttpResultSchema.parse({
    ok: true,
    data: { body: JSON.stringify(body), headers: { contentType: "application/json" }, status },
  });
}

function isSubscribeFrame(value: unknown): value is { readonly type: "client.subscribe" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "client.subscribe"
  );
}

function subscribe<Value>(
  listeners: Set<(value: Value) => void>,
  listener: (value: Value) => void,
) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit<Value>(listeners: ReadonlySet<(value: Value) => void>, value: Value) {
  for (const listener of listeners) listener(value);
}

export interface DesktopPreviewDownloads extends DesktopDownloadsBridge {
  readonly actions: {
    readonly action: "open" | "show" | "cancel";
    readonly target: { readonly id: string };
  }[];
  scriptDownload(download: DesktopDownload): void;
  scriptActionResult(
    action: "open" | "show" | "cancel",
    id: string,
    status: DesktopDownloadActionResult["status"],
  ): void;
}

/** Scripted downloads use the same id-only actions and lifetime bounds as Electron main. */
export function desktopPreviewDownloads(
  initial: readonly DesktopDownload[] = [],
): DesktopPreviewDownloads {
  let downloads: DesktopDownload[] = [];
  const listeners = new Set<(snapshot: DesktopDownloadsSnapshot) => void>();
  const actions: DesktopPreviewDownloads["actions"] = [];
  const results = new Map<string, DesktopDownloadActionResult["status"]>();
  const snapshot = (): DesktopDownloadsSnapshot => ({
    downloads: downloads.map((download) => ({ ...download })),
  });
  function scriptDownload(value: DesktopDownload) {
    let download = DesktopDownloadSchema.parse(value);
    const existing = downloads.find(({ id }) => id === download.id);
    if (
      download.state === "progressing" &&
      existing?.state !== "progressing" &&
      downloads.filter((item) => item.state === "progressing").length >= desktopDownloadsActiveLimit
    ) {
      download = { ...download, state: "failed" };
    }
    downloads = existing
      ? downloads.map((item) => (item.id === download.id ? download : item))
      : [download, ...downloads];
    let finished = 0;
    downloads = downloads.filter(
      (item) => item.state === "progressing" || ++finished <= desktopDownloadsFinishedLimit,
    );
    emit(listeners, snapshot());
  }
  for (const download of [...initial].reverse()) scriptDownload(download);
  async function act(
    action: "open" | "show" | "cancel",
    input: unknown,
  ): Promise<DesktopDownloadActionResult> {
    const target = DesktopDownloadTargetSchema.parse(input);
    actions.push({ action, target });
    const download = downloads.find(({ id }) => id === target.id);
    if (!download || download.state !== (action === "cancel" ? "progressing" : "completed"))
      return { status: "missing" };
    const status = results.get(`${action}:${target.id}`) ?? "done";
    if (status === "done" && action === "cancel")
      scriptDownload({ ...download, state: "cancelled" });
    return { status };
  }
  return {
    actions,
    get: async () => snapshot(),
    onChanged: (listener) => subscribe(listeners, listener),
    open: (input) => act("open", input),
    show: (input) => act("show", input),
    cancel: (input) => act("cancel", input),
    scriptDownload,
    scriptActionResult: (action, id, status) => {
      results.set(`${action}:${id}`, status);
    },
  };
}
