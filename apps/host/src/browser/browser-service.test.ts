import {
  createId,
  OpensteerError,
  RunIdSchema,
  SequenceSchema,
  type AgentEvent,
  type BrowserProfileGrantId,
  type BrowserProfileId,
  type EnvironmentId,
  type Request,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { BrowserHistoryStore, WorkspaceTabStore } from "@opensteer/database";
import {
  BrowserAttachTicketClaimsSchema,
  browserCaptureMaxTargets,
  BrowserClientMessageSchema,
  browserHostMethods,
  BrowserServerMessageSchema,
  browserSessionMaxThreads,
  BrowserSurfaceIdSchema,
  BrowserSurfaceSchema,
  BrowserTabSummaryViewSchema,
  createBrowserSessionId,
  decodeBrowserFrameEnvelope,
  RunnerBrowserModuleSchema,
  type BrowserProfileAccess,
  type BrowserSessionId,
  type HostedBrowserSessionState,
} from "@opensteer/protocol";
import { BrowserPasskeyOfferSchema } from "@opensteer/protocol/passkeys";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createHash, generateKeyPairSync, randomUUID, verify, type KeyObject } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { installWebSocketLiveness } from "../server/websocket-liveness.js";
import {
  BrowserLocalProfiles,
  type BrowserLocalProfileRepository,
} from "./browser-local-profiles.js";
import {
  BrowserService,
  type ActiveBrowserProfileGrant,
  type BrowserConsumerPeer,
  type BrowserProfileRecord,
  type BrowserRuntimeTarget,
  type BrowserRuntimeTargetResolver,
  type BrowserSessionRecord,
  type BrowserSessionRepository,
  type BrowserUsageCredit,
  type BrowserUsePage,
} from "./browser-service.js";
import { BrowserAttachTicketSigner } from "./browser-ticket.js";

const editingEvidenceRoot =
  process.env.OPENSTEER_BROWSER_SERVICE_EVIDENCE_DIR ??
  `/tmp/opensteer-browser-service-${randomUUID()}`;

const cleanups: Array<() => Promise<void>> = [];

/**
 * One computer's browser, reachable at a test runtime's socket. Every browser
 * belongs to a Runner now, so even the simplest case names a machine.
 */
function runnerTarget(options: {
  readonly initialPageMismatch?: boolean;
  readonly navigationVersion?: boolean;
  readonly navigationAttributionVersion?: boolean;
  readonly passkeysEnabled?: boolean;
  readonly passkeys?: boolean;
  readonly sharedControl?: boolean;
  readonly targetControl?: boolean;
  readonly rasterDemand?: boolean;
  readonly editing?: boolean | 1 | 2 | undefined;
  readonly clipboard?: boolean | undefined;
  readonly workspaceTabRestoreVersion?: boolean;
  readonly environmentIds?: readonly EnvironmentId[];
  readonly label?: string;
  readonly runnerId?: RunnerId;
  readonly runtimeId?: string;
  readonly url: URL;
}): BrowserRuntimeTargetResolver & { readonly runnerId: RunnerId } {
  const runnerId = options.runnerId ?? createId("runner");
  const runtimeId = options.runtimeId ?? "runtime-1";
  const url = browserRuntimeSocketUrl(options.url);
  return {
    placements: () => [
      {
        available: true,
        environmentIds: [...(options.environmentIds ?? [])],
        kind: "runner" as const,
        label: options.label ?? "Test computer",
        runnerId,
        runtimeId,
      },
    ],
    resolve: (placement) =>
      placement.runnerId === runnerId
        ? {
            connect: (ticket) => {
              const socket = new WebSocket(url, {
                followRedirects: false,
                headers: { authorization: `Bearer ${ticket}` },
                perMessageDeflate: false,
              });
              {
                const claims = BrowserAttachTicketClaimsSchema.parse(
                  JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString("utf8")),
                );
                Object.assign(socket, {
                  initialPage: {
                    operationKey: options.initialPageMismatch
                      ? "wrong-operation"
                      : claims.initialNavigation!.operationKey,
                    surfaceId: "page-1",
                    navigation: claims.initialNavigation!.url ? "submitted" : "blank",
                  },
                });
              }
              installWebSocketLiveness(socket);
              return socket;
            },
            localProfileStorage: fixtureStorage,
            navigationVersion: options.navigationVersion ?? false,
            navigationAttributionVersion: options.navigationAttributionVersion ?? false,
            passkeys: options.passkeys === true,
            cdpBoundary: true,
            workspaceTabRestoreVersion: options.workspaceTabRestoreVersion ?? false,
            sharedControl: options.sharedControl ?? true,
            editing: options.editing === true ? 1 : options.editing || undefined,
            clipboard: options.clipboard,
            targetControl: options.targetControl ?? false,
            rasterDemand: options.rasterDemand ?? false,
            placementKey: `runner:${runnerId}:${runtimeId}`,
            runtimeId,
          }
        : undefined,
    runnerId,
  };
}

function browserRuntimeSocketUrl(value: URL): URL {
  const url = new URL(value);
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1/browser";
  return url;
}

const fixtureStorage = {
  engine: "electron" as const,
  storageInstanceId: "20000000-0000-4000-8000-000000000001",
};
function nativeProfileOptions() {
  const bindings = new Map<string, import("@opensteer/protocol").BrowserProfileStorage>();
  return {
    ...profileStateOptions,
    localProfiles: new BrowserLocalProfiles({
      deploymentId: createId("deployment"),
      baseUrl: new URL("https://host.test"),
      repository: {
        listPendingBrowserProfileDeletions: async () => [],
        getBrowserProfileStorage: async (id: BrowserProfileId) =>
          bindings.get(id) ?? { kind: "unbound" },
        bindBrowserProfile: async (binding: import("@opensteer/protocol").LocalProfileBinding) => {
          const storage = { kind: "local" as const, binding, initialized: false };
          bindings.set(binding.profileId, storage);
          return storage;
        },
      } as unknown as BrowserLocalProfileRepository,
    }),
  };
}
const profileStateOptions = {
  onSessionsChanged: () => undefined,
  onWorkspaceEvent: () => undefined,
  hostOrigin: new URL("https://host.test"),
};

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

describe("BrowserService", () => {
  it("bounds queued database admission and fences it when the owner retries after timeout", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId, "main");
    const entered = Promise.withResolvers<void>(),
      release =
        Promise.withResolvers<
          Awaited<ReturnType<MemoryBrowserRepository["findMainWorkspaceForOwner"]>>
        >();
    const original = repository.findMainWorkspaceForOwner.bind(repository);
    const workspace = await original(ownerId);
    vi.spyOn(repository, "findMainWorkspaceForOwner").mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const bind = vi.spyOn(repository, "bindBrowserTabOpen"),
      create = vi.spyOn(repository, "createBrowserSession");
    const service = freshService({ keys, runtime, repository });
    vi.useFakeTimers();
    try {
      const opening = service.openTab(ownerId, {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        idempotencyKey: "deadline-admission",
      });
      const rejected = expect(opening).rejects.toMatchObject({ reason: "browser-open.timeout" });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(18_000);
      await rejected;
      release.resolve(workspace);
      await vi.advanceTimersByTimeAsync(0);
      expect(bind).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(runtime.connectionCount()).toBe(0);
    } finally {
      release.resolve(workspace);
      vi.useRealTimers();
    }
  });
  it("orders profile deletion after startup admission so a late browser cannot escape erasure", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const profile = repository.addHostedProfile("Delete during startup");
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const createSession = repository.createBrowserSession.bind(repository);
    vi.spyOn(repository, "createBrowserSession").mockImplementation(async (input) => {
      const result = await createSession(input);
      entered.resolve();
      await release.promise;
      return result;
    });
    const deleted = vi.spyOn(repository, "deleteBrowserProfile");
    const service = freshService({ keys, repository, runtime });
    const opening = service
      .start({ ownerId, workspaceId, profileId: profile.id })
      .catch((error) => error);
    await withTimeout(entered.promise, 1_000, {
      timeoutError: () => new Error("startup never reserved its session"),
    });
    const deleting = service.deleteProfile({ ownerId, profileId: profile.id });
    try {
      expect(deleted).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await deleting;
      await opening;
    }
    expect(deleted).toHaveBeenCalledOnce();
    expect(await repository.getBrowserProfile(profile.id, ownerId)).toBeNull();
    expect(
      (await repository.listBrowserSessions(ownerId)).every((session) => terminal(session.state)),
    ).toBe(true);
  });

  it("starts independent profiles without waiting for another runtime's readiness", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      deferInitialSnapshot: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const first = repository.addHostedProfile("First"),
      second = repository.addHostedProfile("Second");
    const service = freshService({ keys, repository, runtime });
    const openings: Promise<unknown>[] = [
      service.start({ ownerId, workspaceId, profileId: first.id }),
    ];
    try {
      await vi.waitFor(
        () => expect(runtime.connectionCount(), "first profile did not reach the runtime").toBe(1),
        { timeout: 1_000 },
      );
      openings.push(service.start({ ownerId, workspaceId, profileId: second.id }));
      await vi.waitFor(
        () =>
          expect(
            runtime.connectionCount(),
            "independent profile remained behind startup readiness",
          ).toBe(2),
        { timeout: 1_000 },
      );
    } finally {
      runtime.releaseInitialSnapshots();
      await Promise.all(openings);
    }
  });

  it("signs initial navigation and returns its existing page without Host CDP navigation", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(() => service.close());
    const command = {
      type: "browser.tab.open" as const,
      idempotencyKey: randomUUID(),
      identity: { kind: "guest" as const },
      url: "https://example.com/start",
    };
    const opened = await service.openTab(ownerId, command);
    expect(runtime.lastClaims()).toMatchObject({
      initialNavigation: {
        operationKey: createHash("sha256")
          .update(`${ownerId}:${command.idempotencyKey}`)
          .digest("hex"),
        url: command.url,
      },
    });
    expect(opened).toMatchObject({ tabId: "page-1" });
    expect(runtime.receivedCommands().filter((command) => command.type === "cdp.command")).toEqual(
      [],
    );
    expect(await service.openTab(ownerId, command)).toEqual(opened);
    expect(runtime.connectionCount()).toBe(1);
  });

  it("records a native initial open only when its attributed document commits", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      navigationAttribution: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId, "main");
    const profile = repository.addHostedProfile("Native history");
    const recordVisit = vi.fn<BrowserHistoryStore["recordVisit"]>().mockResolvedValue(true);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      history: {
        recordVisit,
        list: async () => ({ entries: [], icons: [] }),
      } as unknown as BrowserHistoryStore,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({
        url: runtime.url,
        navigationAttributionVersion: true,
      }),
    });
    cleanups.push(() => service.close());
    const command = {
      type: "browser.tab.open" as const,
      identity: { kind: "profile" as const, profileId: profile.id },
      idempotencyKey: "native-history",
      url: "https://history.example/",
      typed: true,
    };
    await service.openTab(ownerId, command);
    const navigationId = runtime.lastClaims()!.initialNavigation?.navigationId;
    expect(navigationId).toEqual(expect.any(String));
    expect(recordVisit).not.toHaveBeenCalled();
    expect(runtime.receivedCommands().filter((command) => command.type === "cdp.command")).toEqual(
      [],
    );
    runtime.sendServer({
      type: "navigation.committed",
      navigationId,
      surfaceId: "page-1",
      documentId: "native-document",
      url: "https://history.example/redirected",
    });
    await vi.waitFor(
      () =>
        expect(recordVisit).toHaveBeenCalledExactlyOnceWith({
          profileId: profile.id,
          ownerId,
          typed: true,
          title: "",
          url: "https://history.example/redirected",
        }),
      { timeout: 1000 },
    );
    await service.openTab(ownerId, command);
    expect(recordVisit).toHaveBeenCalledOnce();
  });

  it("durably replays a failed initial open without starting another browser", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const create = vi.spyOn(repository, "createBrowserSession");
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({
        url: runtime.url,
        initialPageMismatch: true,
      }),
    });
    cleanups.push(() => service.close());
    const command = {
      type: "browser.tab.open" as const,
      identity: { kind: "guest" as const },
      idempotencyKey: randomUUID(),
    };
    await expect(service.openTab(ownerId, command)).rejects.toBeDefined();
    expect(
      (await repository.getBrowserTabOpen(ownerId, command.idempotencyKey))?.outcome,
    ).toMatchObject({ kind: "failed" });
    await expect(service.openTab(ownerId, command)).rejects.toMatchObject({
      reason: "browser-tab-open-failed",
    });
    expect(create).toHaveBeenCalledOnce();
    await expect(
      service.openTab(ownerId, { ...command, url: "https://different.test/" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("replays a failed additional tab while leaving the shared browser ready", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = freshService({ keys, repository, runtime });
    const opened = await service.start({ ownerId, workspaceId, fresh: true });
    const command = {
      type: "browser.tab.open" as const,
      sessionId: opened.session.id,
      idempotencyKey: randomUUID(),
    };
    const opening = service.openTab(ownerId, command);
    const refused = expect(opening).rejects.toMatchObject({ reason: "browser-tab-open-failed" });
    const request = await runtime.nextCommand();
    expect(request.type).toBe("cdp.command");
    runtime.sendServer({
      type: "cdp.error",
      requestId: request.requestId,
      error: { code: "conflict", message: "Could not create page", retryable: false },
    });
    await refused;
    expect((await repository.getBrowserSessionForOwner(opened.session.id, ownerId))?.state).toBe(
      "ready",
    );
    await expect(service.openTab(ownerId, command)).rejects.toMatchObject({
      reason: "browser-tab-open-failed",
    });
    expect(runtime.receivedCommands()).toHaveLength(1);
    const retry = service.openTab(ownerId, { ...command, idempotencyKey: randomUUID() });
    const retried = expect(retry).rejects.toMatchObject({ reason: "browser-tab-open-failed" });
    const next = await runtime.nextCommand();
    runtime.sendServer({
      type: "cdp.error",
      requestId: next.requestId,
      error: { code: "conflict", message: "Could not create page", retryable: false },
    });
    await retried;
    expect(runtime.receivedCommands()).toHaveLength(2);
  });

  it("keeps an unanswered additional tab recoverable by its original key", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = freshService({ keys, repository, runtime });
    const opened = await service.start({ ownerId, workspaceId, fresh: true });
    const command = {
      type: "browser.tab.open" as const,
      sessionId: opened.session.id,
      idempotencyKey: randomUUID(),
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let request: Record<string, unknown>;
    try {
      const opening = service.openTab(ownerId, command);
      const unknown = expect(opening).rejects.toMatchObject({
        reason: "browser-tab-open-outcome-unknown",
      });
      request = await runtime.nextCommand();
      await vi.advanceTimersByTimeAsync(20_000);
      await unknown;
    } finally {
      vi.useRealTimers();
    }
    expect((await repository.getBrowserTabOpen(ownerId, command.idempotencyKey))?.outcome).toEqual({
      kind: "pending",
    });
    const retry = service.openTab(ownerId, command);
    const resent = await runtime.nextCommand();
    expect(resent).toMatchObject({
      type: "cdp.command",
      command: {
        parameters: {
          idempotencyKey: (request.command as { parameters: { idempotencyKey: string } }).parameters
            .idempotencyKey,
        },
      },
    });
    runtime.sendServer({
      type: "cdp.result",
      requestId: resent.requestId,
      result: { tabId: "page-2" },
    });
    await expect(retry).resolves.toMatchObject({ tabId: "page-2" });
  });

  it("refuses mismatched initial page readiness", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({
        url: runtime.url,
        initialPageMismatch: true,
      }),
    });
    cleanups.push(() => service.close());
    await expect(service.start({ ownerId, workspaceId, fresh: true })).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
    expect((await repository.listBrowserSessions(ownerId))[0]?.state).toBe("failed");
  });

  it("keeps native profiles on their computer, refuses old runtimes and omits saved site data", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const profile = repository.addHostedProfile("Native");
    const relay = runnerTarget({ url: runtime.url });
    const binding = {
      version: 1 as const,
      deploymentId: createId("deployment"),
      profileId: profile.id,
      runnerId: relay.runnerId,
      storageInstanceId: randomUUID(),
      bindingId: randomUUID(),
      engine: "electron" as const,
    };
    const localProfiles = new BrowserLocalProfiles({
      deploymentId: binding.deploymentId,
      baseUrl: new URL("https://host.test"),
      repository: {
        getBrowserProfileStorage: async () => ({
          kind: "local",
          binding,
          initialized: true,
        }),
        listPendingBrowserProfileDeletions: async () => [],
      } as unknown as BrowserLocalProfileRepository,
    });
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      localProfiles,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: relay,
    });
    cleanups.push(() => service.close());
    await expect(service.start({ ownerId, workspaceId, profileId: profile.id })).rejects.toThrow(
      "This computer's profile storage changed. Restore the original storage instance.",
    );
    await expect(
      service.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: randomUUID(),
        identity: { kind: "profile", profileId: profile.id },
        placement: { kind: "runner", runnerId: createId("runner") },
      }),
    ).rejects.toThrow("owning computer");
    expect(runtime.connectionCount()).toBe(0);
    const offline = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      localProfiles,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: { placements: () => [], resolve: () => undefined },
    });
    cleanups.push(() => offline.close());
    await expect(
      offline.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: randomUUID(),
        identity: { kind: "profile", profileId: profile.id },
      }),
    ).rejects.toThrow("Waiting for this computer");
  });

  it.each([false, true])(
    "retains the same icon after an agent-only visit and clear/revisit (already present: %s)",
    async (present) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
      });
      const ownerId = createId("user"),
        workspaceId = createId("workspace");
      const repository = new MemoryBrowserRepository(ownerId, workspaceId);
      const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
      let visited = false;
      const recordVisit = vi
        .fn<BrowserHistoryStore["recordVisit"]>()
        .mockImplementation(async () => {
          visited = true;
          return true;
        });
      const retainIcon = vi
        .fn<BrowserHistoryStore["retainIcon"]>()
        .mockImplementation(async () => visited);
      const service = freshService({
        keys,
        runtime,
        repository,
        history: {
          recordVisit,
          retainIcon,
          retitle: async () => false,
          clear: async () => {
            visited = false;
            return true;
          },
          list: async () => ({ entries: [], icons: [] }),
        } as unknown as BrowserHistoryStore,
      });
      const opened = await service.start({ ownerId, workspaceId, profileId: profile.id });
      const peer = new RecordingPeer("history-icons");
      const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
      const favicon = "data:image/png;base64,AAAA";
      const snapshot = async (documentId: string, withIcon: boolean) => {
        const previous = peer.textFrames.length;
        runtime.sendServer({
          type: "browser.surfaces.changed",
          surfaces: [
            {
              id: "page-1",
              active: true,
              title: "",
              documentId,
              url: `https://icons.example/${documentId}`,
              ...(withIcon ? { favicon } : {}),
            },
          ],
        });
        await vi.waitFor(() => expect(peer.textFrames.length).toBeGreaterThan(previous), {
          timeout: 1_000,
        });
        await service.readHistory(ownerId, profile.id);
      };
      await snapshot("agent", true);
      expect(retainIcon).toHaveBeenCalledTimes(1); // No retained history exists yet.
      for (const documentId of ["person", "revisit"]) {
        await attachment.handle(
          Buffer.from(
            JSON.stringify({
              type: "navigation.go",
              surfaceId: "page-1",
              url: `https://icons.example/${documentId}`,
            }),
          ),
          false,
        );
        const command = await runtime.nextCommand();
        await snapshot(documentId, present);
        runtime.sendServer({
          type: "navigation.committed",
          navigationId: command.navigationId,
          surfaceId: "page-1",
          documentId,
          url: `https://icons.example/${documentId}`,
        });
        await snapshot(documentId, true);
        expect(recordVisit).toHaveBeenLastCalledWith(
          expect.objectContaining({
            url: `https://icons.example/${documentId}`,
            ...(present ? { favicon } : {}),
          }),
        );
        if (!present)
          expect(retainIcon).toHaveBeenLastCalledWith({
            profileId: profile.id,
            origin: "https://icons.example",
            favicon,
          });
        if (!present) expect(retainIcon).toHaveBeenCalledTimes(documentId === "person" ? 2 : 3);
        expect(peer.textFrames.some((frame) => frame.includes('"navigation.committed"'))).toBe(
          false,
        );
        await service.forgetHistory(ownerId, {
          profileId: profile.id,
          idempotencyKey: `clear-${documentId}`,
        });
      }
      attachment.close();
    },
  );

  it.each(["same-document", "replaced", "unannounced"] as const)(
    "records attribution using its committed URL and document metadata (%s)",
    async (mode) => {
      const replaced = mode === "replaced";
      const metadataKnown = mode === "same-document";
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
      });
      const ownerId = createId("user"),
        workspaceId = createId("workspace");
      const repository = new MemoryBrowserRepository(ownerId, workspaceId);
      const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
      const recordVisit = vi.fn<BrowserHistoryStore["recordVisit"]>().mockResolvedValue(true);
      const retitle = vi.fn<BrowserHistoryStore["retitle"]>().mockResolvedValue(true);
      const service = freshService({
        keys,
        runtime,
        repository,
        history: {
          recordVisit,
          retitle,
          retainIcon: async () => false,
          list: async () => ({ entries: [], icons: [] }),
        } as unknown as BrowserHistoryStore,
      });
      const opened = await service.start({ ownerId, workspaceId, profileId: profile.id });
      const peer = new RecordingPeer("history-late");
      const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
      await attachment.handle(
        Buffer.from(
          JSON.stringify({
            type: "navigation.go",
            surfaceId: "page-1",
            url: "https://person.example/",
          }),
        ),
        false,
      );
      const command = await runtime.nextCommand();
      const snapshot = async (title: string) => {
        const previous = peer.textFrames.length;
        runtime.sendServer({
          type: "browser.surfaces.changed",
          surfaces: [
            {
              id: "page-1",
              active: true,
              documentId: replaced ? "agent" : "person",
              title,
              url: "https://person.example/agent-route",
              favicon: "data:image/png;base64,AAAA",
            },
          ],
        });
        await vi.waitFor(() => expect(peer.textFrames.length).toBeGreaterThan(previous), {
          timeout: 1_000,
        });
        await service.readHistory(ownerId, profile.id);
      };
      if (mode !== "unannounced") await snapshot("Current");
      const event = {
        type: "navigation.committed",
        navigationId: command.navigationId,
        surfaceId: "page-1",
        documentId: "person",
        url: "https://person.example/#committed",
      };
      runtime.sendServer(event);
      await snapshot("Better");
      expect(recordVisit).toHaveBeenCalledExactlyOnceWith({
        profileId: profile.id,
        ownerId,
        url: event.url,
        typed: false,
        title: metadataKnown ? "Current" : "",
        ...(metadataKnown ? { favicon: "data:image/png;base64,AAAA" } : {}),
      });
      if (replaced) expect(retitle).not.toHaveBeenCalled();
      else
        expect(retitle).toHaveBeenCalledExactlyOnceWith({
          profileId: profile.id,
          url: event.url,
          title: "Better",
        });
      runtime.sendServer(event);
      await snapshot("Better");
      expect(recordVisit).toHaveBeenCalledTimes(1);
      attachment.close();
    },
  );

  it.each(
    [false, true].flatMap((cleared) =>
      (["tab-open", "person-start", "agent-start"] as const).map((path) => ({ cleared, path })),
    ),
  )(
    "attributes initial person navigation for $path (cleared during startup=$cleared)",
    async ({ cleared, path }) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
        deferInitialSnapshot: true,
      });
      const ownerId = createId("user"),
        workspaceId = createId("workspace");
      const repository = new MemoryBrowserRepository(ownerId, workspaceId, "main");
      const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
      const recordVisit = vi.fn<BrowserHistoryStore["recordVisit"]>().mockResolvedValue(true);
      const history = {
        recordVisit,
        clear: async () => undefined,
        retainIcon: async () => undefined,
        list: async () => ({ entries: [], icons: [] }),
      } as unknown as BrowserHistoryStore;
      const service = freshService({ keys, runtime, repository, history });
      const opening =
        path === "tab-open"
          ? service.openTab(ownerId, {
              type: "browser.tab.open",
              identity: { kind: "profile", profileId: profile.id },
              url: "https://amazon.com/",
              typed: true,
              idempotencyKey: "initial-open",
            })
          : service.start(
              {
                ownerId,
                workspaceId,
                profileId: profile.id,
                initialUrl: "https://amazon.com/",
                ...(path === "agent-start"
                  ? { origin: "agent", agentBindingId: "initial-agent" }
                  : {}),
              },
              path === "person-start" ? { typed: false } : undefined,
            );
      void opening.catch(() => undefined);
      await vi.waitFor(() => expect(runtime.connectionCount()).toBe(1), { timeout: 1_000 });
      if (cleared)
        await service.forgetHistory(ownerId, {
          profileId: profile.id,
          idempotencyKey: "clear-during-start",
        });
      runtime.releaseInitialSnapshots();
      runtime.sendServer({
        type: "browser.surfaces.changed",
        surfaces: [
          {
            id: "page-1",
            active: true,
            documentId: "initial-blank",
            title: "",
            url: "about:blank",
          },
        ],
      });
      const navigate = await runtime.nextCommand();
      expect(navigate).toMatchObject({ type: "cdp.command", command: { method: "Page.navigate" } });
      if (path === "agent-start") expect(navigate).not.toHaveProperty("navigationId");
      else expect(navigate.navigationId).toEqual(expect.any(String));
      runtime.sendServer({
        type: "browser.surfaces.changed",
        surfaces: [
          {
            id: "page-1",
            active: true,
            documentId: "after-clear",
            title: "Amazon",
            url: "https://www.amazon.com/",
          },
        ],
      });
      if (navigate.navigationId)
        runtime.sendServer({
          type: "navigation.committed",
          navigationId: navigate.navigationId,
          surfaceId: "page-1",
          documentId: "after-clear",
          url: "https://www.amazon.com/",
        });
      runtime.sendServer({ type: "cdp.result", requestId: navigate.requestId, result: {} });
      await opening;
      await service.readHistory(ownerId, profile.id);
      if (path === "agent-start") expect(recordVisit).not.toHaveBeenCalled();
      else
        await vi.waitFor(
          () =>
            expect(
              recordVisit,
              "Initial browser commit was not recorded",
            ).toHaveBeenCalledExactlyOnceWith({
              profileId: profile.id,
              ownerId,
              url: "https://www.amazon.com/",
              title: "Amazon",
              typed: path === "tab-open",
            }),
          { timeout: 1_000 },
        );
    },
  );

  it("records each browser-attributed commit once, including overlapping viewers, titles and icons", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
    const recordVisit = vi.fn<BrowserHistoryStore["recordVisit"]>().mockResolvedValue(true);
    const retitle = vi.fn<BrowserHistoryStore["retitle"]>().mockResolvedValue(true);
    const retainIcon = vi.fn<BrowserHistoryStore["retainIcon"]>().mockResolvedValue(true);
    const history = {
      recordVisit,
      retitle,
      retainIcon,
      list: async () => ({ entries: [], icons: [] }),
    } as unknown as BrowserHistoryStore;
    const onError = vi.fn(),
      onHistoryChanged = vi.fn();
    const service = freshService({ keys, runtime, repository, history, onError, onHistoryChanged });
    const opened = await service.start({ ownerId, workspaceId, profileId: profile.id });
    const peer = new RecordingPeer("history-person");
    const first = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    const second = await service.attach(
      ownerId,
      opened.session.id,
      new RecordingPeer("second-person"),
      consumerOptions(),
    );
    const send = async (message: Record<string, unknown>, attachment = first) => {
      await attachment.handle(Buffer.from(JSON.stringify(message)), false);
      return runtime.nextCommand();
    };
    const iconA = "data:image/png;base64,AAAA",
      iconB = "data:image/png;base64,BBBB";
    const snapshot = async (documentId: string | null, extra: Record<string, unknown> = {}) => {
      const previous = peer.textFrames.length;
      const { navigationId, ...surfaceExtra } = extra;
      runtime.sendServer({
        type: "browser.surfaces.changed",
        surfaces:
          documentId === null
            ? []
            : [
                {
                  id: "page-1",
                  documentId,
                  active: true,
                  title: "",
                  url: "https://history.example/",
                  ...surfaceExtra,
                },
              ],
      });
      if (navigationId)
        runtime.sendServer({
          type: "navigation.committed",
          navigationId,
          surfaceId: "page-1",
          documentId,
          url: extra.url ?? "https://history.example/",
        });
      await vi.waitFor(() => expect(peer.textFrames.length).toBeGreaterThan(previous), {
        timeout: 1_000,
      });
      await service.readHistory(ownerId, profile.id);
      expect(peer.textFrames.at(-1)).not.toContain("navigationId");
    };
    const go = (url = "https://history.example/", typed = false, attachment = first) =>
      send({ type: "navigation.go", surfaceId: "page-1", url, typed }, attachment);
    const a = await go("https://a.example/", true);
    const b = await go("https://b.example/", false, second);
    expect(a.navigationId).toEqual(expect.any(String));
    expect(b.navigationId).not.toBe(a.navigationId);
    // A's commit must not consume B's typed flag or B's attribution.
    await snapshot("a", { url: "https://a.example/", navigationId: a.navigationId, loading: true });
    await snapshot("b", {
      url: "https://b.example/",
      navigationId: b.navigationId,
      loading: true,
      favicon: iconA,
    });
    expect(recordVisit.mock.calls.map(([visit]) => [visit.url, visit.typed])).toEqual([
      ["https://a.example/", true],
      ["https://b.example/", false],
    ]);
    await snapshot("b", {
      url: "https://b.example/",
      navigationId: b.navigationId,
      title: "Better title",
      favicon: iconA,
    });
    expect(recordVisit).toHaveBeenCalledTimes(2);
    expect(retitle).toHaveBeenCalledExactlyOnceWith({
      profileId: profile.id,
      url: "https://b.example/",
      title: "Better title",
    });
    await snapshot("agent", {
      url: "https://b.example/agent",
      title: "Agent title",
      favicon: iconB,
    });
    expect(retitle).toHaveBeenCalledTimes(1);
    expect(retainIcon.mock.calls.map(([icon]) => icon.favicon)).toEqual([iconA, iconB]);
    expect(onHistoryChanged).toHaveBeenCalledTimes(5);
    // A download commits no document. Back cannot consume its uncommitted id.
    await go("https://download.example/file", true);
    await send({ type: "navigation.back", surfaceId: "page-1" });
    await snapshot("back", { url: "https://b.example/" });
    expect(recordVisit).toHaveBeenCalledTimes(2);
    // Closed surfaces discard ids even if a runtime later reuses a surface name.
    const closed = await go();
    await snapshot(null);
    await snapshot("recreated", { navigationId: closed.navigationId });
    expect(recordVisit).toHaveBeenCalledTimes(2);
    recordVisit.mockRejectedValueOnce(new Error("https://secret.example/token"));
    const failed = await go();
    await snapshot("failed-write", { navigationId: failed.navigationId });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toBe("Error: Browser history persistence failed");
    expect(peer.closed).toBeNull();
    await snapshot("failed-write", { navigationId: failed.navigationId });
    expect(recordVisit).toHaveBeenCalledTimes(3);
    // An older runtime, or an unissued attribution, cannot create visits.
    await go();
    await snapshot("old-runtime");
    await snapshot("unissued", { navigationId: randomUUID() });
    expect(recordVisit).toHaveBeenCalledTimes(3);
    first.close();
    second.close();
  });

  it.each(["Runtime.evaluate", "Input.dispatchMouseEvent"])(
    "ignores an agent %s during a pending person navigation",
    async (method) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
      });
      const ownerId = createId("user"),
        workspaceId = createId("workspace");
      const repository = new MemoryBrowserRepository(ownerId, workspaceId);
      const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
      await repository.createBrowserProfileGrant({
        createdBy: ownerId,
        profileId: profile.id,
        workspaceId,
        access: "full-control",
      });
      const recordVisit = vi.fn().mockResolvedValue(true);
      const history = {
        recordVisit,
        list: async () => ({ entries: [], icons: [] }),
      } as unknown as BrowserHistoryStore;
      const service = freshService({ keys, runtime, repository, history });
      const opened = await service.start({ ownerId, workspaceId, profileId: profile.id });
      const peer = new RecordingPeer("person");
      const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
      const agent = await service.attachCdpForAgent(
        { ownerId, workspaceId, sessionId: opened.session.id, agentBindingId: "history-agent" },
        () => {},
      );
      await attachment.handle(
        Buffer.from(
          JSON.stringify({
            type: "navigation.go",
            surfaceId: "page-1",
            url: "https://person.example/",
            typed: true,
          }),
        ),
        false,
      );
      const person = await runtime.nextCommand();
      const action = agent.request({
        method,
        parameters:
          method === "Runtime.evaluate"
            ? { expression: "location.href='https://agent.example/'" }
            : { type: "mousePressed", x: 1, y: 1 },
      });
      const command = await runtime.nextCommand();
      runtime.sendServer({ type: "cdp.result", requestId: command.requestId, result: {} });
      await action;
      const snapshot = async (documentId: string, url: string, navigationId?: unknown) => {
        const previous = peer.textFrames.length;
        runtime.sendServer({
          type: "browser.surfaces.changed",
          surfaces: [
            {
              id: "page-1",
              documentId,
              url,
              title: "",
              active: true,
            },
          ],
        });
        if (navigationId)
          runtime.sendServer({
            type: "navigation.committed",
            navigationId,
            surfaceId: "page-1",
            documentId,
            url,
          });
        await vi.waitFor(() => expect(peer.textFrames.length).toBeGreaterThan(previous), {
          timeout: 1_000,
        });
        await service.readHistory(ownerId, profile.id);
      };
      await snapshot("agent", "https://agent.example/");
      expect(recordVisit).not.toHaveBeenCalled();
      await snapshot("person", "https://person.example/", person.navigationId);
      expect(recordVisit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ url: "https://person.example/", typed: true }),
      );
      agent.close();
      attachment.close();
    },
  );

  it("attributes tab-open commits before the tab id reply and ignores an agent takeover", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
    const recordVisit = vi.fn().mockResolvedValue(true);
    const service = freshService({
      keys,
      runtime,
      repository,
      history: {
        recordVisit,
        list: async () => ({ entries: [], icons: [] }),
      } as unknown as BrowserHistoryStore,
    });
    const opened = await service.start({ ownerId, workspaceId, profileId: profile.id });
    const peer = new RecordingPeer("person");
    const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    const open = async (key: string, attributed: boolean) => {
      const input = {
        type: "browser.tab.open" as const,
        sessionId: opened.session.id,
        url: "https://person.example/",
        idempotencyKey: key,
      };
      const opening = service.openTab(ownerId, input);
      const command = await runtime.nextCommand();
      const previous = peer.textFrames.length;
      runtime.sendServer({
        type: "browser.surfaces.changed",
        surfaces: [
          {
            id: key,
            active: true,
            documentId: key,
            title: "",
            url: attributed ? input.url : "https://agent.example/",
            loading: true,
          },
        ],
      });
      if (attributed)
        runtime.sendServer({
          type: "navigation.committed",
          navigationId: command.navigationId,
          surfaceId: key,
          documentId: key,
          url: input.url,
        });
      await vi.waitFor(() => expect(peer.textFrames.length).toBeGreaterThan(previous), {
        timeout: 1_000,
      });
      await service.readHistory(ownerId, profile.id);
      expect(recordVisit).toHaveBeenCalledTimes(attributed ? 1 : 0);
      runtime.sendServer({
        type: "cdp.result",
        requestId: command.requestId,
        result: { tabId: key },
      });
      await opening;
      await service.openTab(ownerId, input);
    };
    await open("takeover", false);
    await open("person", true);
    expect(recordVisit).toHaveBeenCalledTimes(1);
    attachment.close();
  });

  it.each(["guest", "older-runtime"] as const)(
    "records no visits for %s and never trusts a consumer's navigation id",
    async (kind) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
        navigationAttribution: kind !== "older-runtime",
      });
      const ownerId = createId("user"),
        workspaceId = createId("workspace");
      const repository = new MemoryBrowserRepository(ownerId, workspaceId);
      const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
      const recordVisit = vi.fn();
      const service = freshService({
        keys,
        runtime,
        repository,
        navigationAttribution: kind !== "older-runtime",
        history: {
          recordVisit,
          list: async () => ({ entries: [], icons: [] }),
        } as unknown as BrowserHistoryStore,
      });
      const opened = await service.start({
        ownerId,
        workspaceId,
        ...(kind === "guest" ? {} : { profileId: profile.id }),
      });
      const peer = new RecordingPeer("person");
      const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
      const forged = randomUUID();
      await attachment.handle(
        Buffer.from(
          JSON.stringify({
            type: "navigation.go",
            url: "https://person.example/",
            navigationId: forged,
          }),
        ),
        false,
      );
      expect(await runtime.nextCommand()).not.toHaveProperty("navigationId");
      const previous = peer.textFrames.length;
      runtime.sendServer({
        type: "browser.surfaces.changed",
        surfaces: [
          {
            id: "page-1",
            active: true,
            url: "https://person.example/",
            title: "",
            documentId: "person",
          },
        ],
      });
      runtime.sendServer({
        type: "navigation.committed",
        navigationId: forged,
        surfaceId: "page-1",
        documentId: "person",
        url: "https://person.example/",
      });
      await vi.waitFor(() => expect(peer.textFrames.length).toBeGreaterThan(previous), {
        timeout: 1_000,
      });
      await service.readHistory(ownerId, profile.id);
      expect(recordVisit).not.toHaveBeenCalled();
      attachment.close();
    },
  );

  it("never attributes a resumed tab open after an uncertain response or a replayed clear", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
    const recordVisit = vi.fn().mockResolvedValue(true);
    const history = {
      recordVisit,
      clear: async () => false,
      list: async () => ({ entries: [], icons: [] }),
    } as unknown as BrowserHistoryStore;
    const service = freshService({ keys, runtime, repository, history });
    const opened = await service.start({ ownerId, workspaceId, profileId: profile.id });
    const peer = new RecordingPeer("person");
    const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    const input = {
      type: "browser.tab.open" as const,
      sessionId: opened.session.id,
      url: "https://old.example/",
      idempotencyKey: "lost-open",
    };
    const opening = service.openTab(ownerId, input);
    const rejected = expect(opening).rejects.toMatchObject({
      code: "conflict",
      reason: "browser-tab-open-failed",
    });
    const command = await runtime.nextCommand();
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [
        {
          id: "page-1",
          documentId: "old",
          title: "Old",
          url: input.url,
          active: true,
        },
      ],
    });
    runtime.sendServer({
      type: "navigation.committed",
      navigationId: command.navigationId,
      surfaceId: "page-1",
      documentId: "old",
      url: input.url,
    });
    runtime.sendServer({
      type: "cdp.error",
      requestId: command.requestId,
      error: { code: "internal", message: "Response lost", retryable: true },
    });
    await rejected;
    await service.forgetHistory(ownerId, { profileId: profile.id, idempotencyKey: "clear" });
    expect(recordVisit).toHaveBeenCalledTimes(1);
    recordVisit.mockClear();
    const count = runtime.receivedCommands().length;
    await expect(service.openTab(ownerId, input)).rejects.toMatchObject({
      reason: "browser-tab-open-failed",
    });
    expect(runtime.receivedCommands()).toHaveLength(count);
    await service.readHistory(ownerId, profile.id);
    expect(recordVisit).not.toHaveBeenCalled();
    await attachment.handle(
      Buffer.from(
        JSON.stringify({ type: "navigation.go", surfaceId: "page-1", url: "https://new.example/" }),
      ),
      false,
    );
    const navigation = await runtime.nextCommand();
    await service.forgetHistory(ownerId, { profileId: profile.id, idempotencyKey: "clear" });
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [
        {
          id: "page-1",
          documentId: "new",
          title: "New",
          url: "https://new.example/",
          active: true,
        },
      ],
    });
    runtime.sendServer({
      type: "navigation.committed",
      navigationId: navigation.navigationId,
      surfaceId: "page-1",
      documentId: "new",
      url: "https://new.example/",
    });
    await vi.waitFor(() => expect(recordVisit).toHaveBeenCalled(), { timeout: 1_000 });
    expect(recordVisit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: "https://new.example/" }),
    );
    attachment.close();
  });

  it("prunes expired history during existing browser maintenance without breaking startup on failure", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const repository = new MemoryBrowserRepository(createId("user"), createId("workspace"));
    const prune = vi.fn().mockRejectedValue(new Error("https://secret.example/"));
    const onError = vi.fn();
    const service = freshService({
      keys,
      runtime,
      repository,
      history: { prune } as unknown as BrowserHistoryStore,
      onError,
    });
    await service.initialize();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toBe("Error: Browser history persistence failed");
    const changes = [{ ownerId: createId("user"), profileId: createId("browserProfile") }];
    const onHistoryChanged = vi.fn();
    const publishing = freshService({
      keys,
      runtime,
      repository,
      history: { prune: async () => changes } as unknown as BrowserHistoryStore,
      onHistoryChanged,
    });
    await publishing.pruneHistory();
    expect(onHistoryChanged).toHaveBeenCalledExactlyOnceWith(
      changes[0]!.ownerId,
      changes[0]!.profileId,
    );
  });

  it("replaces baseline copy/cut with one native operation and isolates alternating editing copies", async () => {
    vi.stubEnv("OPENSTEER_BROWSER_DIAGNOSTICS", "1");
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => {});
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      editing: true,
      targetedStreaming: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      editing: true,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "legacy-copy",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const old = new RecordingPeer("legacy-copy"),
      modern = new RecordingPeer("editing-copy"),
      watch = new RecordingPeer("watch-copy");
    const baseline = await service.attach(ownerId, opened.session.id, old, consumerOptions());
    const editing = await service.attach(ownerId, opened.session.id, modern, {
      ...consumerOptions(),
      editing: 1,
    });
    const watching = await service.attach(ownerId, opened.session.id, watch, {
      ...consumerOptions(),
      mode: "watch",
      editing: 1,
    });
    const send = (attachment: typeof baseline, message: object) =>
      attachment.handle(Buffer.from(JSON.stringify(message)), false);
    for (const [index, operation] of ["copy", "cut", "copy"].entries()) {
      const text = `native-${index}`;
      let command: Record<string, unknown>;
      if (index === 1) {
        await send(editing, {
          type: `clipboard.${operation}`,
          surfaceId: "page-1",
          operationId: randomUUID(),
        });
        command = await runtime.nextCommand();
      } else {
        await send(baseline, {
          type: "input.key",
          surfaceId: "page-1",
          action: "down",
          code: "KeyC",
          key: "c",
          modifiers: ["meta"],
        });
        command = await runtime.nextCommand();
        expect(command.type).toBe("clipboard.copy");
        await send(baseline, {
          type: "input.key",
          surfaceId: "page-1",
          action: "up",
          code: "KeyC",
          key: "c",
          modifiers: ["meta"],
        });
      }
      await send(baseline, { type: "navigation.reload" });
      expect(await runtime.nextCommand()).toMatchObject({ type: "navigation.reload" });
      runtime.sendServer({
        type: "clipboard.result",
        surfaceId: "page-1",
        operationId: command.operationId,
        consumerToken: command.consumerToken,
        outcome: operation === "cut" ? "cut" : "copied",
        items: [{ type: "text/plain", size: Buffer.byteLength(text) }],
      });
      runtime.sendServer({
        type: "clipboard.part",
        consumerToken: command.consumerToken,
        part: {
          operationId: command.operationId,
          index: 0,
          data: Buffer.from(text).toString("base64"),
        },
      });
      if (index === 1) await waitFor(() => modern.text().some((m) => m.type === "clipboard.part"));
      else
        await waitFor(() =>
          old.text().some((m) => m.type === "clipboard.data" && "text" in m && m.text === text),
        );
    }
    await send(baseline, {
      type: "input.key",
      surfaceId: "page-1",
      action: "down",
      code: "KeyX",
      key: "x",
      modifiers: ["control"],
    });
    expect(await runtime.nextCommand()).toMatchObject({ type: "clipboard.cut" });
    await send(baseline, {
      type: "input.key",
      surfaceId: "page-1",
      action: "up",
      code: "KeyX",
      key: "x",
      modifiers: [],
    });
    await send(baseline, {
      type: "input.key",
      surfaceId: "page-1",
      action: "down",
      code: "KeyA",
      key: "a",
      modifiers: [],
    });
    expect(await runtime.nextCommand()).toMatchObject({ type: "input.key", key: "a" });
    await send(baseline, { type: "clipboard.paste", surfaceId: "page-1", text: "a" });
    expect(await runtime.nextCommand()).toMatchObject({ type: "clipboard.paste", text: "a" });
    expect(
      old
        .text()
        .filter((m) => m.type === "clipboard.data")
        .map((m) => ("text" in m ? m.text : undefined)),
    ).toEqual(["native-0", "native-2"]);
    expect(old.text().some((m) => ["clipboard.result", "clipboard.part"].includes(m.type))).toBe(
      false,
    );
    expect(modern.text().some((m) => m.type === "clipboard.data")).toBe(false);
    expect(watch.text().some((m) => m.type.startsWith("clipboard."))).toBe(false);
    const counters = JSON.stringify(diagnostics.mock.calls);
    expect(counters).toContain("clipboard.copied");
    expect(counters).not.toContain("native-0");
    const evidence = `${editingEvidenceRoot}/legacy-copy`;
    await mkdir(evidence, { recursive: true });
    console.info(`Browser service editing evidence: ${evidence}`);
    await writeFile(
      `${evidence}/report.json`,
      JSON.stringify(
        { passed: true, baseline: old.text(), editing: modern.text(), watch: watch.text() },
        null,
        2,
      ),
    );
    baseline.close();
    editing.close();
    watching.close();
    diagnostics.mockRestore();
  });

  it.each([
    [undefined, undefined, [undefined, undefined, undefined]],
    [1, true, [undefined, 1, 1]],
    [2, false, [undefined, undefined, 2]],
    [2, true, [undefined, 1, 2]],
  ] as const)(
    "projects every viewer version for runtime %s clipboard %s",
    async (version, clipboard, expectedVersions) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        editing: version,
        clipboard,
      });
      const ownerId = createId("user"),
        workspaceId = createId("workspace");
      const service = freshService({
        keys,
        runtime,
        editing: version,
        clipboard,
        repository: new MemoryBrowserRepository(ownerId, workspaceId),
      });
      const opened = await service.openAgentSession({
        agentBindingId: `split-${version}-${clipboard}`,
        ownerId,
        workspaceId,
        fresh: true,
      });
      expect(runtime.lastClaims()?.editingVersion).toBe(version);
      expect(runtime.lastClaims()).toMatchObject(version === 2 ? { clipboard } : {});
      const evidence: unknown[] = [];
      const nextInput = async () => {
        for (;;) {
          const command = await runtime.nextCommand();
          if (command.type !== "stream.subscribe" && command.type !== "stream.unsubscribe")
            return command;
        }
      };
      for (const requested of [undefined, 1, 2] as const) {
        for (const mode of ["control", "watch"] as const) {
          const peer = new RecordingPeer(`split-${requested}-${mode}`);
          const attachment = await service.attach(ownerId, opened.session.id, peer, {
            ...consumerOptions(),
            mode,
            editing: requested,
          });
          const snapshot = peer
            .text()
            .map((message) => BrowserServerMessageSchema.parse(message))
            .find((message) => message.type === "browser.snapshot");
          const expected = expectedVersions[requested ?? 0];
          expect(snapshot?.type).toBe("browser.snapshot");
          if (snapshot?.type !== "browser.snapshot") throw new Error("No projected snapshot");
          expect(snapshot.editingVersion).toBe(expected);
          expect(snapshot).toEqual(expect.objectContaining(expected === 2 ? { clipboard } : {}));
          if (expected !== 2) expect(snapshot).not.toHaveProperty("clipboard");
          await attachment.handle(Buffer.from(JSON.stringify({ type: "stream.subscribe" })), false);
          if (version)
            runtime.sendServer({
              type: "browser.editing",
              surfaceId: "page-1",
              context: { contextId: randomUUID(), field: null, caret: null },
            });
          if (mode === "watch")
            runtime.sendServer({
              type: "clipboard.data",
              surfaceId: "page-1",
              text: "watch-secret",
            });
          const marker = `split-marker-${requested}-${mode}`;
          runtime.sendServer({
            type: "browser.error",
            error: { code: "conflict", message: marker, retryable: false },
          });
          await waitFor(() =>
            peer
              .text()
              .map((message) => BrowserServerMessageSchema.parse(message))
              .some(
                (message) => message.type === "browser.error" && message.error.message === marker,
              ),
          );
          expect(peer.text().some((message) => message.type === "browser.editing")).toBe(
            Boolean(expected),
          );
          if (mode === "watch")
            expect(peer.text().some((message) => message.type.startsWith("clipboard."))).toBe(
              false,
            );
          if (mode === "control") {
            const command = { type: "input.command", surfaceId: "page-1", command: "selectAll" };
            if (expected) {
              await attachment.handle(Buffer.from(JSON.stringify(command)), false);
              expect(await nextInput()).toMatchObject(command);
            } else
              await expect(
                attachment.handle(Buffer.from(JSON.stringify(command)), false),
              ).rejects.toThrow("not negotiated");
            if (version === 2 && !clipboard) {
              await attachment.handle(
                Buffer.from(
                  JSON.stringify({
                    type: "input.key",
                    surfaceId: "page-1",
                    action: "down",
                    code: "KeyC",
                    key: "c",
                    modifiers: ["meta"],
                  }),
                ),
                false,
              );
              const copy = await nextInput();
              expect(copy).toMatchObject({ type: "input.key", key: "c" });
              expect(copy.consumerToken).toBeTypeOf("string");
              runtime.sendServer({
                type: "clipboard.data",
                surfaceId: "page-1",
                consumerToken: copy.consumerToken,
                text: "baseline-copy",
              });
              await waitFor(() => peer.text().some((message) => message.type === "clipboard.data"));
              await expect(
                attachment.handle(
                  Buffer.from(
                    JSON.stringify({
                      type: "clipboard.copy",
                      surfaceId: "page-1",
                      operationId: randomUUID(),
                    }),
                  ),
                  false,
                ),
              ).rejects.toThrow();
            }
          }
          evidence.push({ requested, mode, expected, messages: peer.text() });
          attachment.close();
        }
      }
      const path = `${editingEvidenceRoot}/split-${version}-${clipboard}`;
      await mkdir(path, { recursive: true });
      await writeFile(
        `${path}/report.json`,
        JSON.stringify({ passed: true, version, clipboard, evidence }, null, 2),
      );
      console.info(`Browser split projection evidence: ${path}`);
    },
  );
  it("sends a viewer editing only for the surface it subscribed to", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
      editing: 2,
      clipboard: false,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      editing: 2,
      clipboard: false,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "editing-routing",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const targeted = new RecordingPeer("editing-routing-targeted");
    const workspace = new RecordingPeer("editing-routing-workspace");
    const attachments = await Promise.all(
      [targeted, workspace].map((peer) =>
        service.attach(ownerId, opened.session.id, peer, { ...consumerOptions(), editing: 2 }),
      ),
    );
    // A download opens a second surface that comes forward over the watched one.
    runtime.sendServer({
      type: "browser.surfaces.changed",
      inventoryRevision: 2,
      surfaces: [
        { active: false, id: "page-integration", title: "Integration page", url: "about:blank" },
        { active: true, id: "page-download", title: "Download", url: "about:blank" },
      ],
    });
    const context = (surfaceId: string) => ({
      type: "browser.editing",
      surfaceId,
      context: { contextId: randomUUID(), field: null, caret: null },
    });
    const editing = (peer: RecordingPeer) =>
      peer
        .text()
        .map((message) => BrowserServerMessageSchema.parse(message))
        .flatMap((message) => (message.type === "browser.editing" ? [message.surfaceId] : []));
    let markers = 0;
    const flush = async () => {
      const marker = `editing-routing-${markers++}`;
      runtime.sendServer({
        type: "browser.error",
        error: { code: "conflict", message: marker, retryable: false },
      });
      for (const peer of [targeted, workspace])
        await waitFor(() =>
          peer
            .text()
            .map((message) => BrowserServerMessageSchema.parse(message))
            .some(
              (message) => message.type === "browser.error" && message.error.message === marker,
            ),
        );
    };
    runtime.sendServer(context("page-integration"));
    runtime.sendServer(context("page-download"));
    await flush();
    expect(editing(targeted)).toEqual([]);
    expect(editing(workspace)).toEqual([]);
    const late = new RecordingPeer("editing-routing-late");
    const lateAttachment = await service.attach(ownerId, opened.session.id, late, {
      ...consumerOptions(),
      editing: 2,
    });
    expect(editing(late)).toEqual([]);
    await lateAttachment.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-integration" })),
      false,
    );
    await waitFor(() => editing(late).length > 0);
    expect(editing(late)).toEqual(["page-integration"]);
    lateAttachment.close();

    await attachments[0]!.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-integration" })),
      false,
    );
    await attachments[1]!.handle(Buffer.from(JSON.stringify({ type: "stream.subscribe" })), false);
    await flush();
    expect(editing(targeted)).toEqual(["page-integration"]);
    expect(editing(workspace)).toEqual(["page-download"]);

    runtime.sendServer(context("page-download"));
    runtime.sendServer(context("page-integration"));
    await flush();
    expect(editing(targeted)).toEqual(["page-integration", "page-integration"]);
    expect(editing(workspace)).toEqual(["page-download", "page-download"]);
    for (const attachment of attachments) attachment.close();
  });

  it("sends an unattributed copy only to the one viewer who could have made it", async () => {
    const keys = generateKeyPairSync("ed25519");
    // A Browser Runtime from before targeted streaming and editing: keys go
    // unstamped and its copies come back without a consumer token.
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "unattributed-copy",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const copier = new RecordingPeer("unattributed-copier");
    const other = new RecordingPeer("unattributed-other");
    const copierAttachment = await service.attach(
      ownerId,
      opened.session.id,
      copier,
      consumerOptions(),
    );
    const otherAttachment = await service.attach(
      ownerId,
      opened.session.id,
      other,
      consumerOptions(),
    );
    const copyKey = Buffer.from(
      JSON.stringify({
        type: "input.key",
        surfaceId: "page-integration",
        action: "down",
        code: "KeyC",
        key: "c",
        modifiers: ["meta"],
      }),
    );
    const copies = (peer: RecordingPeer) =>
      peer
        .text()
        .flatMap((message) =>
          message.type === "clipboard.data" && "text" in message ? [message.text] : [],
        );
    let markers = 0;
    const flush = async (peers: RecordingPeer[]) => {
      const marker = `unattributed-${markers++}`;
      runtime.sendServer({
        type: "browser.error",
        error: { code: "conflict", message: marker, retryable: false },
      });
      for (const peer of peers)
        await waitFor(() =>
          peer
            .text()
            .map((message) => BrowserServerMessageSchema.parse(message))
            .some(
              (message) => message.type === "browser.error" && message.error.message === marker,
            ),
        );
    };
    await copierAttachment.handle(copyKey, false);
    const forwarded = await runtime.nextCommand();
    expect(forwarded).toMatchObject({ type: "input.key", key: "c" });
    expect(forwarded).not.toHaveProperty("consumerToken");
    runtime.sendServer({ type: "clipboard.data", surfaceId: "page-integration", text: "own" });
    await flush([copier, other]);
    expect(copies(copier)).toEqual(["own"]);
    expect(copies(other)).toEqual([]);

    // The other viewer types too; then the copier copies and leaves before
    // its text returns. The one remaining viewer did not make that copy.
    await otherAttachment.handle(
      Buffer.from(
        JSON.stringify({
          type: "input.key",
          surfaceId: "page-integration",
          action: "down",
          code: "KeyA",
          key: "a",
          modifiers: [],
        }),
      ),
      false,
    );
    await runtime.nextCommand();
    await copierAttachment.handle(copyKey, false);
    await runtime.nextCommand();
    copierAttachment.close();
    runtime.sendServer({ type: "clipboard.data", surfaceId: "page-integration", text: "departed" });
    await flush([other]);
    expect(copies(other)).toEqual([]);

    // Once two viewers have sent such keys, no later copy can be attributed.
    await otherAttachment.handle(copyKey, false);
    await runtime.nextCommand();
    runtime.sendServer({
      type: "clipboard.data",
      surfaceId: "page-integration",
      text: "ambiguous",
    });
    await flush([other]);
    expect(copies(other)).toEqual([]);
    otherAttachment.close();
  });

  it("does not credit a newcomer with an unattributed copy it never sent", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "unattributed-newcomer",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const copier = new RecordingPeer("unattributed-departing");
    const copierAttachment = await service.attach(
      ownerId,
      opened.session.id,
      copier,
      consumerOptions(),
    );
    await copierAttachment.handle(
      Buffer.from(
        JSON.stringify({
          type: "input.key",
          surfaceId: "page-integration",
          action: "down",
          code: "KeyC",
          key: "c",
          modifiers: ["meta"],
        }),
      ),
      false,
    );
    await runtime.nextCommand();
    copierAttachment.close();
    const newcomer = new RecordingPeer("unattributed-newcomer");
    const newcomerAttachment = await service.attach(
      ownerId,
      opened.session.id,
      newcomer,
      consumerOptions(),
    );
    runtime.sendServer({ type: "clipboard.data", surfaceId: "page-integration", text: "stale" });
    runtime.sendServer({
      type: "browser.error",
      error: { code: "conflict", message: "newcomer-processed", retryable: false },
    });
    await waitFor(() =>
      newcomer
        .text()
        .map((message) => BrowserServerMessageSchema.parse(message))
        .some(
          (message) =>
            message.type === "browser.error" && message.error.message === "newcomer-processed",
        ),
    );
    expect(newcomer.text().some((message) => message.type === "clipboard.data")).toBe(false);
    newcomerAttachment.close();
  });

  it("stamps editing activation independently of targeted streaming", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", { editing: true });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      editing: true,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "editing-activation",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const evidence: Record<string, unknown>[] = [];
    const forgedToken = randomUUID();
    for (const editing of [true, false]) {
      const peer = new RecordingPeer(`editing-${editing}`);
      const attachment = await service.attach(ownerId, opened.session.id, peer, {
        ...consumerOptions(),
        editing: editing ? 1 : undefined,
      });
      await attachment.handle(
        Buffer.from(
          JSON.stringify({
            type: "input.key",
            surfaceId: "page-1",
            action: "down",
            key: "c",
            code: "KeyC",
            modifiers: [],
            targeted: false,
            consumerToken: forgedToken,
          }),
        ),
        false,
      );
      const key = await runtime.nextCommand();
      expect(key.type).toBe("input.key");
      expect(key).not.toHaveProperty("targeted");
      expect(key.consumerToken).not.toBe(forgedToken);
      expect(key.consumerToken).toBeTypeOf("string");
      evidence.push({ editing, key });
      attachment.close();
    }
    expect(
      new Set(evidence.map((entry) => (entry.key as Record<string, unknown>).consumerToken)).size,
    ).toBe(2);
    const path = `${editingEvidenceRoot}/host-activation`;
    await mkdir(path, { recursive: true });
    console.info(`Browser service editing evidence: ${path}`);
    await writeFile(`${path}/report.json`, JSON.stringify({ passed: true, evidence }, null, 2));
  });

  it("refuses a malformed clipboard stream once and never forwards its remaining bytes", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
      editing: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      editing: true,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "editing-parts",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const peer = new RecordingPeer("editing-parts");
    const attachment = await service.attach(ownerId, opened.session.id, peer, {
      ...consumerOptions(),
      editing: 1,
    });
    const send = (message: object) =>
      attachment.handle(Buffer.from(JSON.stringify(message)), false);
    const operationId = randomUUID();
    await send({
      type: "clipboard.paste-data",
      surfaceId: "page-1",
      operationId,
      items: [{ type: "text/plain", size: 1 }],
    });
    const paste = await runtime.nextCommand();
    await send({ type: "clipboard.part", part: { operationId, index: 0, data: "!" } });
    expect(peer.text().filter((m) => m.type === "clipboard.result")).toHaveLength(1);
    await send({
      type: "clipboard.part",
      part: { operationId, index: 0, data: Buffer.from("x").toString("base64") },
    });
    await send({ type: "navigation.reload" });
    expect(await runtime.nextCommand()).toMatchObject({ type: "navigation.reload" });
    runtime.sendServer({
      type: "clipboard.result",
      operationId,
      surfaceId: "page-1",
      consumerToken: paste.consumerToken,
      outcome: "stale",
    });
    runtime.sendServer({ type: "browser.dialog.changed", dialog: null });
    await waitFor(() => peer.text().some((m) => m.type === "browser.dialog.changed"));
    expect(peer.text().filter((m) => m.type === "clipboard.result")).toHaveLength(1);
    expect(peer.closed).toBeNull();
    const evidence = `${editingEvidenceRoot}/host-malformed-parts`;
    await mkdir(evidence, { recursive: true });
    console.info(`Browser service editing evidence: ${evidence}`);
    await writeFile(
      `${evidence}/report.json`,
      JSON.stringify({ passed: true, messages: peer.text() }, null, 2),
    );
    attachment.close();
  });

  it("disposes a committed durable close by exact ID without a stale public inventory precondition", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    let sessionId: BrowserSessionId;
    const groupId = createBrowserSessionId();
    const tabId = BrowserSurfaceIdSchema.parse("page-1");
    const close = vi.fn(async () => ({ groupId }));
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      connectTimeoutMs: 2000,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({ url: runtime.url }),
      workspaceTabs: {
        close,
        session: async () => repository.session(sessionId),
        lineageForSession: async () => groupId,
        read: async () => ({ id: groupId, tabs: [] }),
        suspend: async () => undefined,
      } as unknown as WorkspaceTabStore,
    });
    cleanups.push(() => service.close());
    sessionId = (await service.start({ fresh: true, ownerId, workspaceId })).session.id;
    const closing = service.closeWorkspaceTab(ownerId, tabId);
    const settled = closing.then(
      () => "closed",
      () => "rejected",
    );
    const command = await runtime.nextCommand();
    expect(close).toHaveBeenCalledOnce();
    const cdp = command as {
      requestId: string;
      command: { method: string; parameters: { durable?: boolean } };
    };
    if (!cdp.command.parameters.durable) {
      runtime.sendServer({
        type: "cdp.error",
        requestId: cdp.requestId,
        error: { code: "conflict", message: "The browser inventory changed." },
      });
    } else {
      runtime.sendServer({ type: "browser.surfaces.changed", inventoryRevision: 2, surfaces: [] });
      runtime.sendServer({
        type: "cdp.result",
        requestId: cdp.requestId,
        result: { outcome: "tab-closed" },
      });
    }
    expect(await settled).toBe("closed");
    expect(cdp.command).toMatchObject({
      method: browserHostMethods.closeTab,
      parameters: { surfaceId: tabId, durable: true },
    });
  });
  it("publishes a page's own title for the same document while its untitled read is still answering", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    let notices = 0;
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
      connectTimeoutMs: 2_000,
      onCatalogChanged: () => {
        notices += 1;
      },
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(() => service.close());
    const sessionId = (await service.start({ fresh: true, ownerId, workspaceId })).session.id;
    const tab = async () => (await service.readTabCatalog(ownerId, sessionId)).tabs[0];
    const page = {
      active: true,
      id: "page-1",
      documentId: "document-pay",
      title: "",
      url: "https://site.test/pay",
    };
    // The page commits; its title is not read yet.
    let seen = notices;
    runtime.sendServer({ type: "browser.surfaces.changed", surfaces: [page] });
    await waitFor(() => notices > seen);
    expect(await tab()).toMatchObject({ documentId: "document-pay", title: "" });
    let answered = false;
    const reading = service
      .readContextCandidate(ownerId, { sessionId, tabId: BrowserSurfaceIdSchema.parse("page-1") })
      .finally(() => {
        answered = true;
      });
    const command = (await runtime.nextCommand()) as {
      requestId: string;
      command: { method: string };
    };
    expect(command.command.method).toBe(browserHostMethods.contextCandidate);
    // The page names itself while its read is out: viewers hear of it then,
    // through the ordinary coalesced notice, for the same document.
    seen = notices;
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [{ ...page, title: "Automatic context /pay" }],
    });
    await waitFor(() => notices > seen);
    expect(await tab()).toMatchObject({
      documentId: "document-pay",
      title: "Automatic context /pay",
    });
    expect(answered).toBe(false);
    // The read answers as the page was when it was read; the Host adds no title.
    runtime.sendServer({
      type: "cdp.result",
      requestId: command.requestId,
      result: {
        sessionId,
        tabId: "page-1",
        documentId: "document-pay",
        title: "",
        url: page.url,
      },
    });
    expect(await reading).toMatchObject({
      documentId: "document-pay",
      title: "",
      url: page.url,
    });
  });

  it.each([undefined, 1, 2])("disables unsupported navigation feature versions (%s)", (version) => {
    expect(
      RunnerBrowserModuleSchema.parse({ runtimeId: "test", navigationVersion: version })
        .navigationVersion,
    ).toBe(version === 1 ? 1 : undefined);
  });
  it.each([undefined, 1, 2])(
    "negotiates attribution only for supported advertisements (%s)",
    async (version) => {
      const advertised = RunnerBrowserModuleSchema.parse({
        runtimeId: "test",
        navigationAttributionVersion: version,
      });
      expect(advertised.navigationAttributionVersion).toBe(version === 1 ? 1 : undefined);
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
      const ownerId = createId("user"),
        workspaceId = createId("workspace");
      const repository = new MemoryBrowserRepository(ownerId, workspaceId);
      const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
      const service = freshService({
        keys,
        runtime,
        repository,
        navigationAttribution: advertised.navigationAttributionVersion === 1,
        history: {
          list: async () => ({ entries: [], icons: [] }),
        } as unknown as BrowserHistoryStore,
      });
      const opened = await service.start({ ownerId, workspaceId, profileId: profile.id });
      const claims = JSON.parse(JSON.stringify(runtime.lastClaims()));
      if (version === 1) expect(claims.navigationAttributionVersion).toBe(1);
      else {
        expect(claims).not.toHaveProperty("navigationAttributionVersion");
        BrowserAttachTicketClaimsSchema.parse(claims);
      }
      const attachment = await service.attach(
        ownerId,
        opened.session.id,
        new RecordingPeer("attribution"),
        consumerOptions(),
      );
      try {
        await attachment.handle(
          Buffer.from(JSON.stringify({ type: "navigation.go", url: "https://person.example/" })),
          false,
        );
        const command = await runtime.nextCommand();
        if (version === 1) expect(command.navigationId).toEqual(expect.any(String));
        else {
          expect(command).not.toHaveProperty("navigationId");
          BrowserClientMessageSchema.parse(command);
        }
      } finally {
        attachment.close();
      }
    },
  );
  it.each([false, true])(
    "negotiates navigation and keeps strict viewers compatible (%s)",
    async (capable) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        navigation: true,
        targetedStreaming: true,
      });
      const ownerId = createId("user");
      const workspaceId = createId("workspace");
      const service = new BrowserService({
        ...nativeProfileOptions(),
        ...profileStateOptions,
        repository: new MemoryBrowserRepository(ownerId, workspaceId),
        connectTimeoutMs: 2000,
        signer: new BrowserAttachTicketSigner({
          keyId: "host-primary",
          privateKey: keys.privateKey,
        }),
        targetResolver: runnerTarget({
          url: runtime.url,
          navigationVersion: capable,
          targetControl: true,
        }),
      });
      cleanups.push(() => service.close());
      const opened = await service.start({ fresh: true, ownerId, workspaceId });
      expect(runtime.lastClaims()?.navigationVersion).toBe(capable ? 1 : undefined);
      expect(opened.session.navigationVersion).toBe(capable ? 1 : undefined);
      expect((await service.bootstrap(ownerId)).sessions[0]?.navigationVersion).toBe(
        capable ? 1 : undefined,
      );
      expect((await service.readTabCatalog(ownerId, opened.session.id)).tabs[0]).toMatchObject(
        capable ? { canGoBack: false, canGoForward: false } : {},
      );
      if (!capable)
        expect(
          (await service.readTabCatalog(ownerId, opened.session.id)).tabs[0],
        ).not.toHaveProperty("canGoBack");
      const control = new RecordingPeer("navigation-control");
      const watch = new RecordingPeer("navigation-watch");
      const attachment = await service.attach(
        ownerId,
        opened.session.id,
        control,
        consumerOptions(),
      );
      const watching = await service.attach(ownerId, opened.session.id, watch, {
        ...consumerOptions(),
        mode: "watch",
      });
      const surface = {
        active: true,
        id: "page-1",
        title: "Next",
        url: "https://example.com/next",
        ...(capable ? { canGoBack: true, canGoForward: false } : {}),
      };
      runtime.sendServer({ type: "browser.surfaces.changed", surfaces: [surface] });
      await waitFor(() => control.textFrames.length === 2 && watch.textFrames.length === 2);
      const oldSurface = BrowserSurfaceSchema.omit({ canGoBack: true, canGoForward: true });
      for (const peer of [control, watch])
        for (const raw of peer.textFrames) {
          const frame = BrowserServerMessageSchema.parse(JSON.parse(raw));
          if (frame.type !== "browser.snapshot" && frame.type !== "browser.surfaces.changed")
            throw new Error("Expected viewer surfaces");
          for (const surface of frame.surfaces)
            expect(oldSurface.safeParse(surface).success).toBe(true);
        }
      const catalog = await service.readTabCatalog(ownerId, opened.session.id);
      expect(catalog.tabs[0]?.canGoBack).toBe(capable ? true : undefined);
      expect(catalog.tabs[0]?.canGoForward).toBe(capable ? false : undefined);
      const oldTab = BrowserTabSummaryViewSchema.omit({
        canGoBack: true,
        canGoForward: true,
      }).parse(catalog.tabs[0]);
      expect(oldTab).not.toHaveProperty("canGoBack");
      expect(oldTab).not.toHaveProperty("canGoForward");
      const send = (message: object) =>
        attachment.handle(Buffer.from(JSON.stringify(message)), false);
      if (capable) {
        await send({ type: "navigation.reload", surfaceId: "page-1", ignoreCache: true });
        expect(await runtime.nextCommand()).toMatchObject({
          type: "navigation.reload",
          surfaceId: "page-1",
          ignoreCache: true,
        });
      } else
        for (const ignoreCache of [false, true])
          await expect(
            send({ type: "navigation.reload", surfaceId: "page-1", ignoreCache }),
          ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        watching.handle(
          Buffer.from(JSON.stringify({ type: "navigation.reload", ignoreCache: true })),
          false,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await send({ type: "navigation.reload", surfaceId: "page-1" });
      expect(await runtime.nextCommand()).toEqual({
        type: "navigation.reload",
        surfaceId: "page-1",
      });
    },
  );
  it.each([false, true])(
    "advertises durable participation only for a negotiated session (%s)",
    async (capable) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
      });
      const ownerId = createId("user");
      const workspaceId = createId("workspace");
      const repository = new MemoryBrowserRepository(ownerId, workspaceId);
      const service = new BrowserService({
        ...nativeProfileOptions(),
        ...profileStateOptions,
        repository,
        connectTimeoutMs: 2000,
        signer: new BrowserAttachTicketSigner({
          keyId: "host-primary",
          privateKey: keys.privateKey,
        }),
        targetResolver: runnerTarget({ url: runtime.url, workspaceTabRestoreVersion: capable }),
        workspaceTabs: {
          list: async () => [],
          record: async () => false,
          suspend: async () => undefined,
        } as unknown as WorkspaceTabStore,
      });
      cleanups.push(() => service.close());
      const opened = await service.start({ fresh: true, ownerId, workspaceId });
      expect(runtime.lastClaims()?.workspaceTabRestoreVersion).toBe(capable ? 1 : undefined);
      expect(opened.session.workspaceTabRestoreVersion).toBe(capable ? 1 : undefined);
      const bootstrap = await service.bootstrap(ownerId);
      expect(bootstrap.workspaceTabRestoreVersion).toBe(1);
      expect(bootstrap.sessions[0]?.workspaceTabRestoreVersion).toBe(capable ? 1 : undefined);
    },
  );
  it("resolves an authorized group read from a replacement session outside bootstrap", async () => {
    const keys = generateKeyPairSync("ed25519");
    const ownerId = createId("user");
    const groupId = createBrowserSessionId();
    const sessionId = createBrowserSessionId();
    const group = { id: groupId, tabs: [] };
    const read = vi.fn(async (_ownerId: UserId, id: BrowserSessionId) =>
      id === groupId ? group : null,
    );
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository: new MemoryBrowserRepository(ownerId, createId("workspace")),
      signer: new BrowserAttachTicketSigner({ keyId: "test", privateKey: keys.privateKey }),
      targetResolver: { placements: () => [], resolve: () => undefined },
      workspaceTabs: {
        read,
        lineageForSession: async (id: BrowserSessionId) => (id === sessionId ? groupId : null),
        suspend: async () => undefined,
      } as unknown as WorkspaceTabStore,
    });
    cleanups.push(() => service.close());
    await expect(service.readWorkspaceTabs(ownerId, sessionId)).resolves.toEqual(group);
    expect(read).toHaveBeenCalledWith(ownerId, groupId);
  });
  it("keeps control targets outside capture capacity and clears a closed target", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
      targetControl: true,
    });
    const opened = await service.openAgentSession({
      agentBindingId: "run:control-capacity",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const peer = new RecordingPeer("capacity-native");
    const native = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    const surfaces = Array.from({ length: browserCaptureMaxTargets + 1 }, (_, index) => ({
      active: index === 0,
      id: `page-${index + 1}`,
      title: "Tab",
      url: "about:blank",
    }));
    runtime.sendServer({ type: "browser.surfaces.changed", surfaces });
    await waitFor(() => peer.text().some(({ type }) => type === "browser.surfaces.changed"));
    const surfaceId = surfaces.at(-1)!.id;
    await native.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId, frames: false })),
      false,
    );
    expect(await runtime.nextCommand()).toEqual({
      type: "stream.subscribe",
      surfaceId,
      frames: false,
    });
    for (const surface of surfaces.slice(0, browserCaptureMaxTargets)) {
      const stream = await service.attach(
        ownerId,
        opened.session.id,
        new RecordingPeer(surface.id),
        consumerOptions(),
      );
      await stream.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: surface.id })),
        false,
      );
      expect(await runtime.nextCommand()).toEqual({
        type: "stream.subscribe",
        surfaceId: surface.id,
      });
    }
    runtime.sendServer({ type: "browser.surfaces.changed", surfaces: surfaces.slice(0, -1) });
    expect(await runtime.nextCommand()).toEqual({ type: "stream.unsubscribe", surfaceId });
    await native.handle(
      Buffer.from(JSON.stringify({ type: "stream.unsubscribe", surfaceId })),
      false,
    );
    native.close();
  });

  it("observes a native target without pictures and aggregates mixed consumers per surface", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = freshService({ keys, repository, runtime, targetControl: true });
    const opened = await service.openAgentSession({
      agentBindingId: "run:native",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const native = new RecordingPeer("native");
    const attachment = await service.attach(ownerId, opened.session.id, native, consumerOptions());
    const send = (message: object) =>
      attachment.handle(Buffer.from(JSON.stringify(message)), false);
    const surfaces = [
      { active: true, id: "page-1", title: "One", url: "about:blank" },
      { active: false, id: "page-2", title: "Two", url: "about:blank" },
    ];
    runtime.sendServer({ type: "browser.surfaces.changed", surfaces });
    const dialog = {
      id: "00000000-0000-4000-8000-000000000002",
      surfaceId: "page-2",
      type: "alert",
      message: "Second page",
    };
    runtime.sendServer({ type: "browser.dialog.changed", surfaceId: "page-2", dialog });
    runtime.sendServer({ type: "browser.surfaces.changed", surfaces });
    await waitFor(
      () => native.text().filter(({ type }) => type === "browser.surfaces.changed").length === 2,
    );
    await send({ type: "stream.subscribe", surfaceId: "page-2", frames: false });
    expect(await runtime.nextCommand()).toEqual({
      type: "stream.subscribe",
      surfaceId: "page-2",
      frames: false,
    });
    expect(native.textFrames.map((frame) => JSON.parse(frame))).toContainEqual({
      type: "browser.dialog.changed",
      surfaceId: "page-2",
      dialog,
    });
    await expect(send({ type: "navigation.reload", surfaceId: "page-1" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await send({
      type: "dialog.respond",
      surfaceId: "page-2",
      dialogId: "00000000-0000-4000-8000-000000000002",
      accept: true,
    });
    expect(await runtime.nextCommand()).toMatchObject({
      type: "dialog.respond",
      surfaceId: "page-2",
      dialogId: "00000000-0000-4000-8000-000000000002",
    });
    const before = native.textFrames.length;
    runtime.sendServer({ type: "browser.dialog.changed", surfaceId: "page-1", dialog: null });
    runtime.sendServer({ type: "browser.dialog.changed", surfaceId: "page-2", dialog: null });
    await waitFor(() => native.textFrames.length > before);
    expect(native.textFrames.slice(before).map((frame) => JSON.parse(frame))).toEqual([
      { type: "browser.dialog.changed", surfaceId: "page-2", dialog: null },
    ]);

    const streamed = new RecordingPeer("streamed");
    const stream = await service.attach(ownerId, opened.session.id, streamed, consumerOptions());
    await stream.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-2" })),
      false,
    );
    expect(await runtime.nextCommand()).toEqual({ type: "stream.subscribe", surfaceId: "page-2" });
    // Another control consumer must not downgrade the shared picture subscription.
    const second = await service.attach(
      ownerId,
      opened.session.id,
      new RecordingPeer("second-native"),
      consumerOptions(),
    );
    await second.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-2", frames: false })),
      false,
    );
    const pageTwoFrame = browserFrame(1, "page-2");
    runtime.sendFrame(pageTwoFrame);
    await waitFor(() => streamed.binaryFrames.length === 1);
    expect(native.binaryFrames).toHaveLength(0);
    await stream.handle(
      Buffer.from(JSON.stringify({ type: "stream.unsubscribe", surfaceId: "page-2" })),
      false,
    );
    expect(await runtime.nextCommand()).toEqual({
      type: "stream.subscribe",
      surfaceId: "page-2",
      frames: false,
    });
    second.close();
    await send({ type: "stream.subscribe", surfaceId: "page-1", frames: false });
    expect(await runtime.nextCommand()).toEqual({
      type: "stream.unsubscribe",
      surfaceId: "page-2",
    });
    expect(await runtime.nextCommand()).toEqual({
      type: "stream.subscribe",
      surfaceId: "page-1",
      frames: false,
    });
    attachment.close();
    expect(await runtime.nextCommand()).toEqual({
      type: "stream.unsubscribe",
      surfaceId: "page-1",
    });
  });

  it("clears picture credit when switching the same consumer to control and back", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
      targetControl: true,
    });
    const opened = await service.openAgentSession({
      agentBindingId: "run:switch",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const peer = new RecordingPeer("switch");
    const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    const send = (message: object) =>
      attachment.handle(Buffer.from(JSON.stringify(message)), false);
    await send({ type: "stream.subscribe", surfaceId: "page-1" });
    expect(await runtime.nextCommand()).toEqual({ type: "stream.subscribe", surfaceId: "page-1" });
    runtime.sendFrame(browserFrame(1));
    await waitFor(() => peer.binaryFrames.length === 1);
    await send({ type: "stream.subscribe", surfaceId: "page-1", frames: false });
    expect(await runtime.nextCommand()).toEqual({
      type: "stream.subscribe",
      surfaceId: "page-1",
      frames: false,
    });
    runtime.sendFrame(browserFrame(2));
    const before = peer.textFrames.length;
    runtime.sendServer({ type: "browser.dialog.changed", surfaceId: "page-1", dialog: null });
    await waitFor(() => peer.textFrames.length > before);
    expect(peer.binaryFrames).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(16_000);
      expect(peer.closed).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    await send({ type: "stream.subscribe", surfaceId: "page-1" });
    expect(await runtime.nextCommand()).toEqual({ type: "stream.subscribe", surfaceId: "page-1" });
    // No cached picture from before control-only is replayed.
    expect(peer.binaryFrames).toHaveLength(1);
    runtime.sendFrame(browserFrame(3));
    await waitFor(() => peer.binaryFrames.length === 2);
    await send({ type: "stream.unsubscribe" });
    expect(await runtime.nextCommand()).toEqual({
      type: "stream.unsubscribe",
      surfaceId: "page-1",
    });
    await send({ type: "navigation.reload", surfaceId: "page-2" });
    expect(await runtime.nextCommand()).toMatchObject({
      type: "navigation.reload",
      surfaceId: "page-2",
    });
  });

  it("refuses control-only on an older Runtime without altering its picture subscription", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "run:old-control",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const peer = new RecordingPeer("old-control");
    const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    const send = (message: object) =>
      attachment.handle(Buffer.from(JSON.stringify(message)), false);
    await send({ type: "stream.subscribe", surfaceId: "page-1" });
    expect(await runtime.nextCommand()).toEqual({ type: "stream.subscribe", surfaceId: "page-1" });
    await expect(
      send({ type: "stream.subscribe", surfaceId: "page-1", frames: false }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "browser-target-control-unsupported",
      message: expect.stringContaining("Update"),
    });
    runtime.sendFrame(browserFrame(1));
    await waitFor(() => peer.binaryFrames.length === 1);
    await send({ type: "stream.unsubscribe" });
    expect(await runtime.nextCommand()).toEqual({
      type: "stream.unsubscribe",
      surfaceId: "page-1",
    });
  });

  it("requires an explicit control target and retains access rechecks without pictures", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = freshService({ keys, runtime, repository, targetControl: true });
    const opened = await service.openAgentSession({
      agentBindingId: "run:access-control",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const peer = new RecordingPeer("access-control");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
      await expect(
        attachment.handle(
          Buffer.from(JSON.stringify({ type: "stream.subscribe", frames: false })),
          false,
        ),
      ).rejects.toMatchObject({ code: "bad_request" });
      const watch = await service.attach(
        ownerId,
        opened.session.id,
        new RecordingPeer("watch-control"),
        { ...consumerOptions(), mode: "watch" },
      );
      await expect(
        watch.handle(
          Buffer.from(
            JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1", frames: false }),
          ),
          false,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      await attachment.handle(
        Buffer.from(
          JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1", frames: false }),
        ),
        false,
      );
      expect(await runtime.nextCommand()).toEqual({
        type: "stream.subscribe",
        surfaceId: "page-1",
        frames: false,
      });
      const access = vi.spyOn(repository, "getBrowserSessionForOwner").mockResolvedValue(null);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(access).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(peer.closed).toMatchObject({ code: 4003 });
      expect(await runtime.nextCommand()).toEqual({
        type: "stream.unsubscribe",
        surfaceId: "page-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes only bounded current-page metadata in the catalog", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = freshService({ keys, repository, runtime });
    const opened = await service.openAgentSession({
      agentBindingId: "run:catalog",
      ownerId,
      workspaceId,
      fresh: true,
    });
    const peer = new RecordingPeer("catalog-metadata");
    await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: Array.from({ length: 64 }, (_, index) => ({
        active: index === 0,
        id: `page-${index}`,
        title: "A".repeat(1000),
        url: `https://example.com/${"x".repeat(10000)}?private=value`,
      })),
    });
    await waitFor(() => peer.text().some((message) => message.type === "browser.surfaces.changed"));
    const catalog = await service.bootstrap(ownerId);
    expect(catalog.sessions[0]?.page).toEqual({
      title: "A".repeat(256),
      url: "https://example.com",
    });
    expect(catalog.sessions[0]).not.toHaveProperty("surfaces");
    expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThan(128 * 1024);
  });

  async function actorAdmissionFixture(options: { readonly holdAnswers?: boolean } = {}) {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const runId = createId("run");
    const threadId = createId("thread");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const backing: BrowserSessionRepository = repository;
    const service = freshService({ keys, repository, runtime, actorMetadataTimeoutMs: 25 });
    const authority = { agentBindingId: `run:${runId}`, ownerId, workspaceId };
    const opened = await service.openAgentSession({ ...authority, fresh: true });
    const cdp = await service.attachCdpForAgent(
      { ...authority, sessionId: opened.session.id },
      () => undefined,
    );
    const audience = [
      {
        agentBindingId: authority.agentBindingId,
        ownerId,
        runId,
        threadId,
        home: false,
        generation: 1,
        lineageThreadIds: [threadId],
        lineageWorkspaceIds: [workspaceId],
      },
    ];
    const forwarded: { actorToken?: string | undefined; requestId: string }[] = [];
    const send = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, ...args) {
      Reflect.apply(send, this, args);
      const [data] = args;
      if (typeof data !== "string") return;
      const parsed = BrowserClientMessageSchema.safeParse(JSON.parse(data));
      if (!parsed.success || parsed.data.type !== "cdp.command") return;
      forwarded.push(parsed.data);
      if (!options.holdAnswers)
        runtime.sendServer({ type: "cdp.result", requestId: parsed.data.requestId, result: {} });
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const answer = (requestId: string, result: Record<string, unknown>) =>
      runtime.sendServer({ type: "cdp.result", requestId, result });
    return {
      answer,
      authority,
      audience,
      backing,
      cdp,
      forwarded,
      service,
      sessionId: opened.session.id,
    };
  }

  it("versions restored holdings and repeated identical catalog reads", async () => {
    const f = await actorAdmissionFixture();
    vi.useRealTimers();
    try {
      const first = await f.service.readTabCatalog(f.authority.ownerId, f.sessionId);
      vi.spyOn(f.backing, "resolvePlaceActors").mockResolvedValue(f.audience);
      vi.spyOn(f.backing, "listBrowserPlaceHoldings").mockResolvedValue([
        {
          agentBindingId: f.authority.agentBindingId,
          ownerId: f.authority.ownerId,
          tabId: first.tabs[0]!.id,
          lastUsedAt: new Date(),
        },
      ]);
      const restored = await f.service.readTabCatalog(f.authority.ownerId, f.sessionId);
      expect(restored.tabs[0]!.occupants).toHaveLength(1);
      expect(restored.revision).toBeGreaterThan(first.revision);
      expect((await f.service.readTabCatalog(f.authority.ownerId, f.sessionId)).revision).toBe(
        restored.revision,
      );
      vi.mocked(f.backing.resolvePlaceActors).mockResolvedValue([]);
      f.service.invalidatePlaceAuthority();
      await f.service.catalogsForViewers(f.sessionId);
      const removed = await f.service.readTabCatalog(f.authority.ownerId, f.sessionId);
      expect(removed.tabs[0]!.occupants).toHaveLength(0);
      expect(removed.revision).toBeGreaterThan(restored.revision);
      await f.service.stop(f.authority.ownerId, f.sessionId);
      const terminal = await f.service.readTabCatalog(f.authority.ownerId, f.sessionId);
      expect(terminal.tabs).toHaveLength(0);
      expect(terminal.revision).toBeGreaterThan(removed.revision);
    } finally {
      await f.service.close();
    }
  });

  it.each(["viewers", "actors"] as const)(
    "bounds a stalled actor metadata lookup on a controlled clock (%s)",
    async (stage) => {
      const f = await actorAdmissionFixture();
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      if (stage === "viewers") {
        vi.spyOn(f.backing, "listBrowserSessionViewers").mockImplementation(async () => {
          entered.resolve();
          await held.promise;
          return null;
        });
      } else {
        vi.spyOn(f.backing, "resolvePlaceActors").mockImplementation(async () => {
          entered.resolve();
          await held.promise;
          return f.audience;
        });
      }
      const request = f.cdp.request({ method: "Browser.getVersion" });
      void request.catch(() => undefined);
      try {
        await entered.promise;
        expect(f.forwarded).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(25);
        expect(f.forwarded).toHaveLength(1);
        expect(f.forwarded[0]?.actorToken).toBeUndefined();
        await request;
      } finally {
        vi.useRealTimers();
        await f.service.close();
        held.resolve();
        await Promise.allSettled([request]);
      }
    },
  );

  it.each([
    ["attachment", "identity"],
    ["service", "identity"],
    ["binding", "identity"],
    ["attachment", "admission"],
    ["service", "admission"],
    ["binding", "admission"],
  ] as const)("refuses forwarding after %s closes during %s", async (ending, stage) => {
    const f = await actorAdmissionFixture();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    if (stage === "identity") {
      vi.spyOn(f.backing, "resolvePlaceActors").mockImplementation(async () => {
        entered.resolve();
        await held.promise;
        return f.audience;
      });
    } else {
      const read = f.backing.getBrowserSessionForOwner.bind(f.backing);
      vi.spyOn(f.backing, "getBrowserSessionForOwner").mockImplementation(async (...args) => {
        entered.resolve();
        await held.promise;
        return read(...args);
      });
    }
    const request = f.cdp.request({ method: "Browser.getVersion" });
    const outcome = request.then(
      () => null,
      (error: unknown) => error,
    );
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      if (ending === "attachment") f.cdp.close();
      else if (ending === "service") closing = f.service.close();
      else await f.service.detachAgentSessionsForBinding(f.authority.agentBindingId);
      held.resolve();
      expect(await outcome).toMatchObject({ name: "BrowserCdpConnectionEnded" });
      expect(f.forwarded).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      held.resolve();
      await closing;
      await f.service.close();
      await outcome;
    }
  });

  it("answers a command already handed to the browser after its Run ends", async () => {
    // Admission fences end at the hand-off; what the browser already has, it answers.
    const f = await actorAdmissionFixture({ holdAnswers: true });
    try {
      const { result } = await f.cdp.dispatch({ method: "Browser.getVersion" });
      expect(f.forwarded).toHaveLength(1);
      await f.service.detachAgentSessionsForBinding(f.authority.agentBindingId);
      f.answer(f.forwarded[0]!.requestId, { product: "answered after the Run" });
      await expect(result).resolves.toEqual({ product: "answered after the Run" });
    } finally {
      vi.useRealTimers();
      await f.service.close();
    }
  });

  it("answers a late command without restoring an ended Run's actor or attachment", async () => {
    const f = await actorAdmissionFixture();
    try {
      await f.service.detachAgentSessionsForBinding(f.authority.agentBindingId);
      const resolveActors = vi.spyOn(f.backing, "resolvePlaceActors");
      await expect(f.cdp.request({ method: "Browser.getVersion" })).resolves.toEqual({});
      expect(f.forwarded).toHaveLength(1);
      expect(f.forwarded[0]?.actorToken).toBeUndefined();
      expect(resolveActors).not.toHaveBeenCalled();
      expect(
        await f.backing.listActiveBrowserSessionsForAgentBinding(f.authority.agentBindingId),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
      await f.service.close();
    }
  });

  it("follows a replacement actor resolution after authority invalidates", async () => {
    const f = await actorAdmissionFixture();
    const first = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    vi.spyOn(f.backing, "resolvePlaceActors")
      .mockImplementationOnce(async () => {
        firstEntered.resolve();
        await first.promise;
        return f.audience;
      })
      .mockImplementationOnce(async () => {
        secondEntered.resolve();
        await second.promise;
        return f.audience.map((identity) => ({ ...identity, generation: 2 }));
      });
    const request = f.cdp.request({ method: "Browser.getVersion" });
    void request.catch(() => undefined);
    try {
      await firstEntered.promise;
      f.service.invalidatePlaceAuthority();
      first.resolve();
      await secondEntered.promise;
      second.resolve();
      await request;
      expect(f.forwarded).toHaveLength(1);
      expect(f.forwarded[0]?.actorToken).toEqual(expect.any(String));
    } finally {
      vi.useRealTimers();
      first.resolve();
      second.resolve();
      await f.service.close();
      await Promise.allSettled([request]);
    }
  });

  it.each(["resolved", "unavailable"] as const)(
    "attributes the first command even when resolving its Run identity is delayed (%s)",
    async (identity) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
      });
      const ownerId = createId("user");
      const workspaceId = createId("workspace");
      const runId = createId("run");
      const threadId = createId("thread");
      const repository = new MemoryBrowserRepository(ownerId, workspaceId);
      const service = freshService({ keys, repository, runtime, targetControl: true });
      const authority = { agentBindingId: `run:${runId}`, ownerId, workspaceId };
      const opened = await service.openAgentSession({ ...authority, fresh: true });
      const cdp = await service.attachCdpForAgent(
        { ...authority, sessionId: opened.session.id },
        () => undefined,
      );
      const resolving = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const backing: BrowserSessionRepository = repository;
      const identities = vi.spyOn(backing, "resolvePlaceActors").mockImplementation(async () => {
        resolving.resolve();
        await release.promise;
        if (identity === "unavailable") throw new Error("Identity store unavailable");
        return [
          {
            agentBindingId: authority.agentBindingId,
            ownerId,
            runId,
            threadId,
            home: false,
            generation: 1,
            lineageThreadIds: [threadId],
            lineageWorkspaceIds: [workspaceId],
          },
        ];
      });
      const request = cdp.request({
        method: "Target.attachToTarget",
        parameters: { targetId: "target-page-1", flatten: true },
      });
      void request.catch(() => undefined);
      try {
        await resolving.promise;
        release.resolve();
        const command = await runtime.nextCommand();
        runtime.sendServer({
          type: "cdp.result",
          requestId: command.requestId,
          result: { sessionId: "cdp-page-1", surfaceId: "page-1" },
        });
        await request;
        expect(command.type).toBe("cdp.command");
        if (identity === "resolved") expect(command.actorToken).toEqual(expect.any(String));
        else expect(command.actorToken).toBeUndefined();
      } finally {
        release.resolve();
        identities.mockRestore();
        cdp.close();
        await service.close();
        await Promise.allSettled([request]);
      }
    },
  );

  it("announces a page a Run first uses as conversation usage, and never as a session change", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const announced: WorkspaceId[] = [];
    const usage: BrowserUsageCredit[] = [];
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({ url: runtime.url }),
      onSessionsChanged: (id) => announced.push(id),
      onUsageChanged: (credits) => usage.push(...credits),
    });
    cleanups.push(async () => service.close());
    const authority = { agentBindingId: "run:revisit", ownerId, workspaceId };
    const opened = await service.openAgentSession({ ...authority, fresh: true });
    const cdp = await service.attachCdpForAgent(
      { ...authority, sessionId: opened.session.id },
      () => undefined,
    );
    announced.length = 0;
    usage.length = 0;
    const attachTo = async (surfaceId: string) => {
      const request = cdp.request({
        method: "Target.attachToTarget",
        parameters: { targetId: `target-${surfaceId}`, flatten: true },
      });
      const command = await runtime.nextCommand();
      runtime.sendServer({
        type: "cdp.result",
        requestId: command.requestId,
        result: { sessionId: `cdp-${surfaceId}`, surfaceId },
      });
      await request;
    };
    await attachTo("page-1");
    await attachTo("page-1");
    // The page is recorded after the agent has its answer.
    await waitFor(() => usage.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(announced).toEqual([]);
    expect(usage).toEqual([{ joined: false, threadId: "thr_run:revisit", workspaceId }]);
    expect(repository.uses.get(`${opened.session.id}|thr_run:revisit|run:revisit|page-1`)).toEqual({
      site: "about:blank",
      title: "Example",
    });
  });

  it("refuses an older runtime that cannot preserve shared tab identity", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = freshService({ keys, repository, runtime, sharedControl: false });
    const authority = { agentBindingId: "run:old-browser", ownerId, workspaceId };
    const opened = await service.openAgentSession({ ...authority, fresh: true });
    await expect(
      service.attachCdpForAgent({ ...authority, sessionId: opened.session.id }, () => undefined),
    ).rejects.toThrow("Update Opensteer");
  });
  it("owns one authenticated Runtime connection and brokers strict UI consumers", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      connectTimeoutMs: 2_000,
      repository,
      signer: new BrowserAttachTicketSigner({
        keyId: "host-primary",
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());

    await service.initialize();
    const workProfile = repository.addHostedProfile("Work");
    const starting = service.start({
      initialUrl: "https://example.com/start",
      ownerId,
      profileId: workProfile.id,
      workspaceId,
    });

    const navigation = await runtime.nextCommand();
    expect(navigation).toMatchObject({
      type: "cdp.command",
      command: {
        method: "Page.navigate",
        parameters: { url: "https://example.com/start" },
      },
    });
    runtime.sendServer({
      type: "cdp.result",
      requestId: navigation.requestId,
      result: { frameId: "frame-first" },
    });
    const started = await starting;
    expect(started.session.state).toBe("ready");
    expect(runtime.connectionCount()).toBe(1);
    expect(runtime.lastClaims()?.identity).toMatchObject({
      kind: "profile-local",
      binding: { profileId: workProfile.id },
    });
    await repository.grant(workProfile.id, "full-control");

    const peer = new RecordingPeer("ui-1");
    const attachment = await service.attach(ownerId, started.session.id, peer, consumerOptions());
    expect(peer.text().map((message) => message.type)).toEqual(["browser.snapshot"]);
    await attachment.handle(Buffer.from(JSON.stringify({ type: "navigation.back" })), false);
    await expect(runtime.nextCommand()).resolves.toMatchObject({ type: "navigation.back" });
    await expect(attachment.handle(Buffer.from([1, 2, 3]), true)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      attachment.handle(
        Buffer.from(
          JSON.stringify({
            devicePixelRatio: 2,
            height: 600,
            type: "stream.resize",
            width: 800,
          }),
        ),
        false,
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      attachment.handle(
        Buffer.from(
          JSON.stringify({
            devicePixelRatio: 2,
            height: 900,
            surfaceId: "page-1",
            type: "viewport.set",
            width: 1_440,
          }),
        ),
        false,
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    await attachment.handle(
      Buffer.from(
        JSON.stringify({ height: 900, surfaceId: "page-1", type: "viewport.set", width: 1_440 }),
      ),
      false,
    );
    await expect(runtime.nextCommand()).resolves.toEqual({
      height: 900,
      surfaceId: "page-1",
      type: "viewport.set",
      width: 1_440,
    });

    runtime.sendFrame(browserFrame(1));
    runtime.sendServer({
      surfaces: [
        {
          active: true,
          id: "page-1",
          title: "Example",
          url: "about:blank",
        },
      ],
      type: "browser.surfaces.changed",
    });
    await waitFor(() => peer.textFrames.length === 2);
    expect(peer.binaryFrames).toHaveLength(0);
    await attachment.handle(Buffer.from(JSON.stringify({ type: "stream.subscribe" })), false);
    await expect(runtime.nextCommand()).resolves.toMatchObject({ type: "stream.subscribe" });

    runtime.sendFrame(browserFrame(2));
    await waitFor(() => peer.binaryFrames.length === 1);
    expect(peer.binaryFrames[0]?.subarray(-4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const authority = { agentBindingId: "run:test", ownerId, workspaceId };
    const agentSession = await service.openAgentSession({
      ...authority,
      profileId: workProfile.id,
    });
    expect(agentSession.session.id).not.toBe(started.session.id);
    const cdp = await service.attachCdpForAgent(authority, () => undefined);
    const agentRequest = cdp.request({
      method: "Browser.getVersion",
    });
    const command = await runtime.nextCommand();
    expect(command).toMatchObject({ type: "cdp.command" });
    if (typeof command.requestId !== "string") throw new Error("Missing CDP request ID");
    runtime.sendServer({
      requestId: command.requestId,
      result: { product: "Chrome/151" },
      type: "cdp.result",
    });
    await expect(agentRequest).resolves.toEqual({ product: "Chrome/151" });
    expect(runtime.connectionCount()).toBe(2);
    const secondAuthority = { agentBindingId: "run:second", ownerId, workspaceId };
    const shared = await service.openAgentSession({
      ...secondAuthority,
      sessionId: agentSession.session.id,
    });
    expect(shared).toMatchObject({
      session: {
        activeAttachmentCount: 2,
        attached: true,
        id: agentSession.session.id,
      },
      wasExisting: true,
    });
    await expect(service.detachAgentSessionsForBinding(authority.agentBindingId)).resolves.toEqual([
      agentSession.session.id,
    ]);
    await expect(attachedSessionIds(service, authority)).resolves.toEqual([]);
    await expect(attachedSessionIds(service, secondAuthority)).resolves.toEqual([
      agentSession.session.id,
    ]);
    expect(repository.session(agentSession.session.id)?.state).toBe("ready");
    await repository.revokeBrowserGrant();
    await expect(
      service.detachAgentSessionsForRevokedProfileGrant({
        ownerId,
        profileId: workProfile.id,
        workspaceId,
      }),
    ).resolves.toBe(1);
    expect(repository.session(agentSession.session.id)?.state).toBe("ready");
    await expect(attachedSessionIds(service, secondAuthority)).resolves.toEqual([]);
    expect(repository.session(started.session.id)?.state).toBe("ready");

    const slowPeer = new SlowFramePeer("ui-slow");
    const slowAttachment = await service.attach(
      ownerId,
      started.session.id,
      slowPeer,
      consumerOptions(),
    );
    // Joining a stream already under way starts from its current picture
    // (frame 2) rather than a blank until the page next paints.
    await slowAttachment.handle(Buffer.from(JSON.stringify({ type: "stream.subscribe" })), false);
    await waitFor(() => slowPeer.binaryFrames.length === 1);
    runtime.sendFrame(browserFrame(3));
    runtime.sendFrame(browserFrame(4));
    runtime.sendFrame(browserFrame(5));
    const textFrameCount = peer.textFrames.length;
    runtime.sendServer({
      surfaces: [
        {
          active: true,
          id: "page-1",
          title: "Example",
          url: "about:blank",
        },
      ],
      type: "browser.surfaces.changed",
    });
    // WebSocket message order makes this server message a deterministic
    // barrier: both binary frames have reached the broker before it is
    // forwarded. Releasing earlier would race the network event loop and could
    // test either one queued frame or two rather than the latest-frame policy.
    await waitFor(() => peer.textFrames.length === textFrameCount + 1);
    slowPeer.releaseFirstFrame();
    const token = decodeBrowserFrameEnvelope(slowPeer.binaryFrames[0]!).header.watchToken;
    await slowAttachment.handle(Buffer.from(JSON.stringify({ type: "stream.ack", token })), false);
    await waitFor(() => slowPeer.binaryFrames.length === 2);
    expect(
      slowPeer.binaryFrames.map((frame) => decodeBrowserFrameEnvelope(frame).header.frameId),
    ).toEqual([2, 5]);

    await slowAttachment.handle(Buffer.from(JSON.stringify({ type: "stream.unsubscribe" })), false);
    await attachment.handle(Buffer.from(JSON.stringify({ type: "stream.unsubscribe" })), false);
    await expect(runtime.nextCommand()).resolves.toMatchObject({ type: "stream.unsubscribe" });
    const peerFrameCount = peer.binaryFrames.length;
    const slowPeerFrameCount = slowPeer.binaryFrames.length;
    runtime.sendFrame(browserFrame(6));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(peer.binaryFrames).toHaveLength(peerFrameCount);
    expect(slowPeer.binaryFrames).toHaveLength(slowPeerFrameCount);

    await service.stop(ownerId, started.session.id);
    expect(repository.session(started.session.id)?.state).toBe("closed");
    expect(peer.closed?.code).toBe(1000);
  });

  it("gives every late viewer one complete materialized snapshot", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      connectTimeoutMs: 2_000,
      repository,
      signer: new BrowserAttachTicketSigner({
        keyId: "host-primary",
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());
    const started = await service.start({ fresh: true, ownerId, workspaceId });
    const firstPeer = new RecordingPeer("ui-first");
    await service.attach(ownerId, started.session.id, firstPeer, consumerOptions());

    runtime.sendServer({
      surfaces: [
        {
          active: false,
          id: "page-1",
          title: "Example",
          url: "https://example.com/",
        },
        {
          active: true,
          id: "page-2",
          title: "Account",
          url: "https://example.com/account",
        },
      ],
      type: "browser.surfaces.changed",
    });
    runtime.sendServer({
      dialog: {
        id: "00000000-0000-4000-8000-0000000000d1",
        message: "Continue?",
        surfaceId: "page-2",
        type: "confirm",
      },
      type: "browser.dialog.changed",
    });
    await waitFor(() => firstPeer.textFrames.length === 3);

    const secondPeer = new RecordingPeer("ui-second");
    await service.attach(ownerId, started.session.id, secondPeer, consumerOptions());
    expect(JSON.parse(secondPeer.textFrames[0] ?? "null")).toMatchObject({
      dialog: {
        id: "00000000-0000-4000-8000-0000000000d1",
        message: "Continue?",
        surfaceId: "page-2",
        type: "confirm",
      },
      sessionId: started.session.id,
      state: "ready",
      surfaces: [
        expect.objectContaining({ active: false, id: "page-1" }),
        expect.objectContaining({ active: true, id: "page-2" }),
      ],
      type: "browser.snapshot",
    });

    runtime.sendServer({ dialog: null, type: "browser.dialog.changed" });
    await waitFor(() => secondPeer.textFrames.length === 2);
    const thirdPeer = new RecordingPeer("ui-third");
    await service.attach(ownerId, started.session.id, thirdPeer, consumerOptions());
    expect(JSON.parse(thirdPeer.textFrames[0] ?? "null")).toMatchObject({
      dialog: null,
      surfaces: [
        expect.objectContaining({ id: "page-1" }),
        expect.objectContaining({ id: "page-2" }),
      ],
      type: "browser.snapshot",
    });
  });

  it("admits a viewer only while its login is signed in, and lets go of one whose access cannot be read", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      connectTimeoutMs: 2_000,
      repository,
      signer: new BrowserAttachTicketSigner({
        keyId: "host-primary",
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());
    const started = await service.start({ fresh: true, ownerId, workspaceId });

    // A login that ended before this viewer could be reached by
    // `closeAuthSession` is caught by the one check made after it could.
    const signedOut = new RecordingPeer("ui-signed-out");
    await expect(
      service.attach(ownerId, started.session.id, signedOut, {
        ...consumerOptions(),
        signedIn: async () => false,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(signedOut.closed?.code).toBe(1008);
    expect(signedOut.textFrames).toEqual([]);

    // A login that cannot be read is not admitted, and is tried again.
    const unreadable = new RecordingPeer("ui-unreadable");
    await expect(
      service.attach(ownerId, started.session.id, unreadable, {
        ...consumerOptions(),
        signedIn: async () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toThrow("database unavailable");
    expect(unreadable.closed?.code).toBe(1013);

    // A login check that never answers is let go at its deadline, not left
    // connecting forever.
    const stalledLogin = new RecordingPeer("ui-login-stalled");
    await expect(
      service.attach(ownerId, started.session.id, stalledLogin, {
        ...consumerOptions(),
        signedIn: () => new Promise<boolean>(() => undefined),
      }),
    ).rejects.toThrow("Browser login check timed out.");
    expect(stalledLogin.closed?.code).toBe(1013);

    // Access that stops answering ends the viewer within one check and its
    // deadline, rather than leaving it streaming unchecked.
    const viewer = new RecordingPeer("ui-stalled");
    await service.attach(ownerId, started.session.id, viewer, consumerOptions());
    repository.hangSessionReads = true;
    await waitFor(() => viewer.closed !== null, 12_000);
    expect(viewer.closed?.code).toBe(1013);
  }, 30_000);

  it("announces the Workspace whenever a Browser Session appears or changes state", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const announced: WorkspaceId[] = [];
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      connectTimeoutMs: 2_000,
      onSessionsChanged: (id) => announced.push(id),
      repository,
      signer: new BrowserAttachTicketSigner({
        keyId: "host-primary",
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());

    const started = await service.start({ fresh: true, ownerId, workspaceId });
    // The row appearing, then the Runtime reporting the session ready.
    expect(announced).toEqual([workspaceId, workspaceId]);

    announced.length = 0;
    await service.stop(ownerId, started.session.id);

    expect(repository.session(started.session.id)?.state).toBe("closed");
    expect(announced).toEqual([workspaceId, workspaceId]);
  });

  it("holds an early viewer until the Runtime publishes its authoritative snapshot", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      deferInitialSnapshot: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      connectTimeoutMs: 2_000,
      repository,
      signer: new BrowserAttachTicketSigner({
        keyId: "host-primary",
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());
    const starting = service.start({ fresh: true, ownerId, workspaceId });
    await waitFor(() => runtime.connectionCount() === 1);
    const record = (await repository.listBrowserSessions(ownerId)).find(
      (session) => session.state === "starting",
    );
    if (!record) throw new Error("Starting browser session was not recorded.");
    const peer = new RecordingPeer("ui-early");
    const attaching = service.attach(ownerId, record.id, peer, consumerOptions());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(peer.textFrames).toEqual([]);

    runtime.releaseInitialSnapshots();
    await expect(starting).resolves.toMatchObject({ session: { id: record.id, state: "ready" } });
    await expect(attaching).resolves.toBeDefined();
    expect(peer.text().map((message) => message.type)).toEqual(["browser.snapshot"]);
  });

  it("rejects a Runtime that emits any event before its initial snapshot", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      beforeInitialSnapshot: [{ state: "closing", type: "browser.status" }],
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      connectTimeoutMs: 2_000,
      repository,
      signer: new BrowserAttachTicketSigner({
        keyId: "host-primary",
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());

    await expect(service.start({ fresh: true, ownerId, workspaceId })).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
    expect(await repository.listBrowserSessions(ownerId)).toEqual([
      expect.objectContaining({ state: "failed" }),
    ]);
  });

  it("rejects a Runtime snapshot whose dialog references an unknown surface", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      initialDialog: { message: "Continue?", surfaceId: "page-missing", type: "confirm" },
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      connectTimeoutMs: 2_000,
      repository,
      signer: new BrowserAttachTicketSigner({
        keyId: "host-primary",
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());

    await expect(service.start({ fresh: true, ownerId, workspaceId })).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
    expect(await repository.listBrowserSessions(ownerId)).toEqual([
      expect.objectContaining({ state: "failed" }),
    ]);
  });

  it("reconciles stale active rows and rejects unsupported navigation schemes", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const profile = repository.addHostedProfile("Client account");
    const target = runnerTarget({ url: runtime.url });
    const stale = await repository.createBrowserSession({
      id: createBrowserSessionId(),
      origin: "workspace",
      placementKey: `runner:${target.runnerId}:runtime-1`,
      profileId: profile.id,
      runnerId: target.runnerId,
      runtimeId: "runtime-1",
      workspaceId,
    });
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({
        keyId: "host-primary",
        privateKey: keys.privateKey,
      }),
      targetResolver: target,
    });
    cleanups.push(async () => service.close());

    await service.initialize();
    expect(repository.session(stale.id)?.state).toBe("failed");
    await expect(
      service.start({ fresh: true, initialUrl: "file:///etc/passwd", ownerId, workspaceId }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("deduplicates browser access only by Run call identity and returns one uniform result", async () => {
    const keys = generateKeyPairSync("ed25519");
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const events: AgentEvent[] = [];
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      onWorkspaceEvent: (event) => {
        events.push(event);
      },
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });
    const request = {
      callId: "browser-access-unit-request",
      originatingWorkspaceId: workspaceId,
      ownerId,
      reason: "Sign in to the client portal",
      runId: createId("run"),
      suggestion: { kind: "new", suggestedName: "Client portal" } as const,
      threadId: createId("thread"),
      workspaceId,
    };

    const requested = await service.requestAccess(request);
    expect(requested).toEqual({
      kind: "browser.access",
      replayed: false,
      requestId: expect.stringMatching(/^req_/),
      status: "pending",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      data: { request: { id: requested.requestId, kind: "browser.access", status: "pending" } },
      type: "request.opened",
    });
    const duplicate = await service.requestAccess({
      ...request,
      reason: "This changed payload is still the same tool call",
      suggestion: { kind: "user_choice" },
    });
    expect(duplicate).toEqual({ ...requested, replayed: true });
    expect(events).toHaveLength(1);

    // There is deliberately no semantic or per-Workspace uniqueness. A new
    // tool call is a new Request even when it asks the same question.
    const distinct = await service.requestAccess({ ...request, callId: "browser-access-second" });
    expect(distinct).toMatchObject({
      kind: "browser.access",
      replayed: false,
      status: "pending",
    });
    expect(distinct.requestId).not.toBe(requested.requestId);
    expect(events).toHaveLength(2);

    const response = {
      kind: "external",
      value: { createProfile: { name: "Client portal" }, decision: "fulfilled" },
    } as const;
    const resolved = await service.resolveRequest({
      requestId: requested.requestId,
      resolvedBy: ownerId,
      response,
    });

    expect(resolved.profile).toMatchObject({ name: "Client portal" });
    expect(resolved.request).toMatchObject({
      id: requested.requestId,
      response,
      status: "fulfilled",
    });
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      data: {
        request: {
          id: requested.requestId,
          response,
          status: "fulfilled",
        },
      },
      type: "request.resolved",
    });
    await expect(service.requestAccess(request)).resolves.toEqual({
      ...requested,
      replayed: true,
      status: "fulfilled",
    });
    await expect(service.listGrantedProfiles(ownerId, workspaceId)).resolves.toEqual([
      {
        access: "full-control",
        grantId: resolved.grant?.id,
        id: resolved.profile?.id,
        name: "Client portal",
      },
    ]);
    await expect(
      service.resolveRequest({
        requestId: requested.requestId,
        resolvedBy: ownerId,
        response: { kind: "external", value: { decision: "declined" } },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("grants an existing profile or declines without granting any browser authority", async () => {
    const keys = generateKeyPairSync("ed25519");
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const existing = repository.addHostedProfile("Client portal");
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });
    const request = {
      callId: "browser-access-decline",
      originatingWorkspaceId: workspaceId,
      ownerId,
      reason: "Sign in to the client portal",
      runId: createId("run"),
      suggestion: { kind: "existing", profileId: existing.id } as const,
      threadId: createId("thread"),
      workspaceId,
    };

    const declinedRequest = await service.requestAccess(request);
    const declineResponse = { kind: "external", value: { decision: "declined" } } as const;
    const declined = await service.resolveRequest({
      requestId: declinedRequest.requestId,
      resolvedBy: ownerId,
      response: declineResponse,
    });
    expect(declined).toMatchObject({
      grant: null,
      profile: null,
      request: { response: declineResponse, status: "declined" },
    });
    await expect(service.listGrantedProfiles(ownerId, workspaceId)).resolves.toEqual([]);

    const grantRequest = { ...request, callId: "browser-existing-profile-grant" };
    const pending = await service.requestAccess(grantRequest);
    const fulfillResponse = {
      kind: "external",
      value: { decision: "fulfilled", profileId: existing.id },
    } as const;
    const granted = await service.resolveRequest({
      requestId: pending.requestId,
      resolvedBy: ownerId,
      response: fulfillResponse,
    });
    expect(granted.request).toMatchObject({
      response: fulfillResponse,
      status: "fulfilled",
    });
    await expect(service.requestAccess(grantRequest)).resolves.toEqual({
      ...pending,
      replayed: true,
      status: "fulfilled",
    });
  });

  it("targets only owned specialized Workspaces and treats profile suggestions as advisory", async () => {
    const keys = generateKeyPairSync("ed25519");
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const signer = new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey });
    const main = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository: new MemoryBrowserRepository(ownerId, workspaceId, "main"),
      signer,
    });
    const specialized = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
      signer,
    });
    const request = {
      callId: "browser-access-main-refusal",
      originatingWorkspaceId: workspaceId,
      ownerId,
      reason: "Sign in to the client portal",
      runId: createId("run"),
      suggestion: { kind: "user_choice" } as const,
      threadId: createId("thread"),
      workspaceId,
    };

    await expect(main.requestAccess(request)).rejects.toMatchObject({
      code: "bad_request",
      message:
        "browser_access_request grants a browser profile only to a specialized Workspace. From Main, pass that Workspace's workspaceId. To browse in Main, open a session with an inherited profile from browser_profile_list, or with fresh: true for signed-out browsing.",
    });
    await expect(
      specialized.requestAccess({ ...request, workspaceId: createId("workspace") }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      specialized.requestAccess({
        ...request,
        callId: "browser-access-advisory-profile",
        suggestion: { kind: "existing", profileId: createId("browserProfile") },
      }),
    ).resolves.toMatchObject({ kind: "browser.access", status: "pending" });
  });

  it("keeps a worst-case maximum browser catalog below the serialized bootstrap ceiling", async () => {
    const keys = generateKeyPairSync("ed25519");
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MaximumBrowserCatalogRepository(ownerId, workspaceId, 100);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });

    const bootstrap = await service.bootstrap(ownerId);
    expect(bootstrap.profileGrants).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(bootstrap), "utf8")).toBeLessThanOrEqual(
      1 * 1_024 * 1_024,
    );
    expect(Buffer.byteLength(JSON.stringify(bootstrap), "utf8")).toBeGreaterThan(10 * 1_024);

    const overflow = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository: new MaximumBrowserCatalogRepository(ownerId, workspaceId, 101),
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });
    await expect(overflow.bootstrap(ownerId)).rejects.toMatchObject({ code: "conflict" });
  });

  it("requires one full-control profile grant before raw CDP reaches a Runtime", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const profile = repository.addHostedProfile("Alex's Mac");
    const environmentId = createId("environment");
    const target = runnerTarget({
      environmentIds: [environmentId],
      label: "Alex's Mac",
      runtimeId: "browser-main",
      url: runtime.url,
    });
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: target,
    });
    cleanups.push(async () => service.close());
    const authority = { agentBindingId: "run:runner-test", ownerId, workspaceId };
    await expect(
      service.openAgentSession({ ...authority, environmentId, profileId: profile.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(runtime.connectionCount()).toBe(0);

    const grant = await service.grantProfileToWorkspace({
      access: "full-control",
      createdBy: ownerId,
      profileId: profile.id,
      workspaceId,
    });
    expect(grant).toMatchObject({ access: "full-control", profileId: profile.id });
    const visible = await service.start({ ownerId, profileId: profile.id, workspaceId });
    expect(visible.session.placement).toEqual({ kind: "runner", runnerId: target.runnerId });
    const opened = await service.openAgentSession({ ...authority, profileId: profile.id });
    expect(opened.session).toMatchObject({
      placement: { kind: "runner", runnerId: target.runnerId },
      profileId: profile.id,
      runtimeId: "browser-main",
    });
    expect(opened.session.id).not.toBe(visible.session.id);
    const cdp = await service.attachCdpForAgent(authority, () => undefined);
    const pending = cdp.request({ method: "Browser.getVersion" });
    const request = await runtime.nextCommand();
    expect(request).toMatchObject({
      command: { method: "Browser.getVersion" },
      type: "cdp.command",
    });
    if (typeof request.requestId !== "string") throw new Error("Missing CDP request ID");
    runtime.sendServer({
      requestId: request.requestId,
      result: { product: "Chrome/151" },
      type: "cdp.result",
    });
    await expect(pending).resolves.toEqual({ product: "Chrome/151" });
    await expect(
      service.closeAgentSession({ ...authority, sessionId: opened.session.id }),
    ).resolves.toBe(opened.session.id);
    await expect(attachedSessionIds(service, authority)).resolves.toEqual([]);
  });

  it("sends a browser session to the computer that runs its work location", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const environmentId = createId("environment");
    const bound = testRunner({ environmentIds: [environmentId] });
    const service = placementService({
      keys,
      ownerId,
      runners: [bound, testRunner({})],
      runtime,
      workspaceId,
    });

    const opened = await service.openAgentSession({
      agentBindingId: "run:bound-environment",
      environmentId,
      fresh: true,
      ownerId,
      workspaceId,
    });

    expect(opened.session.placement).toEqual({ kind: "runner", runnerId: bound.runnerId });
  });

  it("requires an explicit choice when two computers run the same work location", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const environmentId = createId("environment");
    const first = testRunner({ environmentIds: [environmentId] });
    const second = testRunner({ environmentIds: [environmentId] });
    const service = placementService({
      keys,
      ownerId,
      runners: [first, second],
      runtime,
      workspaceId,
    });

    await expect(
      service.openAgentSession({
        agentBindingId: "run:ambiguous-binding",
        environmentId,
        fresh: true,
        ownerId,
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      // The refusal names the candidates, because the agent's only way out of
      // it is to call again with one of these environmentIds.
      message:
        "Choose which connected computer should run this browser session: " +
        `Computer ${first.runnerId} (environmentId ${environmentId}), ` +
        `Computer ${second.runnerId} (environmentId ${environmentId}).`,
    });
    expect(runtime.connectionCount()).toBe(0);
  });

  it("runs a browser session on the machine the agent named", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const runEnvironmentId = createId("environment");
    const chosenEnvironmentId = createId("environment");
    const here = testRunner({ environmentIds: [runEnvironmentId] });
    const there = testRunner({ environmentIds: [chosenEnvironmentId] });
    const service = placementService({
      keys,
      ownerId,
      runners: [here, there],
      runtime,
      workspaceId,
    });

    const opened = await service.openAgentSession({
      agentBindingId: "run:chosen-machine",
      chosenEnvironmentId,
      environmentId: runEnvironmentId,
      fresh: true,
      ownerId,
      workspaceId,
    });
    expect(opened.session.placement).toEqual({ kind: "runner", runnerId: there.runnerId });

    // The same binding asking for the other machine is a different session,
    // not the one already attached.
    const back = await service.openAgentSession({
      agentBindingId: "run:chosen-machine",
      chosenEnvironmentId: runEnvironmentId,
      environmentId: runEnvironmentId,
      fresh: true,
      ownerId,
      workspaceId,
    });
    expect(back.session.placement).toEqual({ kind: "runner", runnerId: here.runnerId });
    expect(back.session.id).not.toBe(opened.session.id);
  });

  it("refuses a named machine that runs no connected browser", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const browserEnvironmentId = createId("environment");
    const withBrowser = testRunner({ environmentIds: [browserEnvironmentId] });
    const service = placementService({
      keys,
      ownerId,
      runners: [withBrowser],
      runtime,
      workspaceId,
    });

    await expect(
      service.openAgentSession({
        agentBindingId: "run:headless-machine",
        chosenEnvironmentId: createId("environment"),
        fresh: true,
        ownerId,
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message:
        "That computer does not run a connected browser. These do: " +
        `Computer ${withBrowser.runnerId} (environmentId ${browserEnvironmentId}).`,
    });
    expect(runtime.connectionCount()).toBe(0);

    await expect(
      service.openAgentSession({
        agentBindingId: "run:headless-machine",
        chosenEnvironmentId: browserEnvironmentId,
        ownerId,
        sessionId: createBrowserSessionId(),
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message:
        "An existing Browser Session already runs on a computer, so attaching to it cannot choose one.",
    });
  });

  it("falls back to the only connected computer and refuses to guess between many", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const only = testRunner({ environmentIds: [createId("environment")] });

    const soleWorkspaceId = createId("workspace");
    const sole = placementService({
      keys,
      ownerId,
      runners: [only],
      runtime,
      workspaceId: soleWorkspaceId,
    });
    await expect(
      sole.start({ fresh: true, ownerId, workspaceId: soleWorkspaceId }),
    ).resolves.toMatchObject({
      session: { placement: { kind: "runner", runnerId: only.runnerId } },
    });
    // An environment nothing is bound to falls through to the same single
    // computer rather than failing: one machine is never ambiguous.
    await expect(
      sole.openAgentSession({
        agentBindingId: "run:unbound-environment",
        environmentId: createId("environment"),
        fresh: true,
        ownerId,
        workspaceId: soleWorkspaceId,
      }),
    ).resolves.toMatchObject({
      session: { placement: { kind: "runner", runnerId: only.runnerId } },
    });

    const conflictWorkspaceId = createId("workspace");
    const conflict = placementService({
      keys,
      ownerId,
      runners: [only, testRunner({})],
      runtime,
      workspaceId: conflictWorkspaceId,
    });
    await expect(
      conflict.start({ fresh: true, ownerId, workspaceId: conflictWorkspaceId }),
    ).rejects.toMatchObject({ code: "conflict" });

    const unavailableWorkspaceId = createId("workspace");
    const unavailable = placementService({
      keys,
      ownerId,
      runners: [],
      runtime,
      workspaceId: unavailableWorkspaceId,
    });
    await expect(
      unavailable.start({ fresh: true, ownerId, workspaceId: unavailableWorkspaceId }),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
  });

  it("does not route a chosen incompatible browser to another computer", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const outdatedEnvironmentId = createId("environment");
    const reason = "Update the Browser Runtime on this computer; snapshot version 2 is required.";
    const outdated = testRunner({
      environmentIds: [outdatedEnvironmentId],
      unavailableReason: reason,
    });
    const current = testRunner({ environmentIds: [createId("environment")] });
    const service = placementService({
      keys,
      ownerId,
      runners: [outdated, current],
      runtime,
      workspaceId,
    });
    await service.initialize();

    expect((await service.bootstrap(ownerId)).placements).toEqual([
      expect.objectContaining({
        available: false,
        runnerId: outdated.runnerId,
        unavailableReason: reason,
      }),
      expect.objectContaining({ available: true, runnerId: current.runnerId }),
    ]);
    await expect(
      service.openAgentSession({
        agentBindingId: "run:outdated",
        environmentId: outdatedEnvironmentId,
        fresh: true,
        ownerId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: "workspace_unavailable", message: reason });
    await expect(
      service.start({
        fresh: true,
        ownerId,
        placement: { kind: "runner", runnerId: outdated.runnerId },
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: "workspace_unavailable", message: reason });
    expect(runtime.connectionCount()).toBe(0);
  });

  it("keeps established session and profile placement ahead of environment defaults", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const environmentId = createId("environment");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const profile = repository.addHostedProfile("Established profile");
    await repository.grant(profile.id, "full-control");
    const established = testRunner({});
    const bound = testRunner({ environmentIds: [environmentId] });
    const service = placementService({
      keys,
      ownerId,
      repository,
      runners: [established, bound],
      runtime,
      workspaceId,
    });

    await service.start({
      ownerId,
      placement: { kind: "runner", runnerId: established.runnerId },
      profileId: profile.id,
      workspaceId,
    });
    const profileOpen = await service.openAgentSession({
      agentBindingId: "run:profile-affinity",
      environmentId,
      ownerId,
      profileId: profile.id,
      workspaceId,
    });
    expect(profileOpen.session.placement).toEqual({
      kind: "runner",
      runnerId: established.runnerId,
    });

    const sessionWorkspaceId = repository.addWorkspace("specialized");
    const existing = await service.start({
      fresh: true,
      ownerId,
      placement: { kind: "runner", runnerId: established.runnerId },
      workspaceId: sessionWorkspaceId,
    });
    const reattached = await service.openAgentSession({
      agentBindingId: "run:session-affinity",
      environmentId,
      ownerId,
      sessionId: existing.session.id,
      workspaceId: sessionWorkspaceId,
    });
    expect(reattached.session).toMatchObject({
      id: existing.session.id,
      placement: { kind: "runner", runnerId: established.runnerId },
    });
  });

  it("never reuses a user session on a profile that was not granted to agents", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const granted = repository.addHostedProfile("Granted");
    const userOnly = repository.addHostedProfile("User only");
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());
    await service.start({ ownerId, profileId: userOnly.id, workspaceId });
    await repository.grant(granted.id, "full-control");
    const agent = await service.openAgentSession({
      agentBindingId: "run:isolation-test",
      ownerId,
      profileId: granted.id,
      workspaceId,
    });
    expect(agent.session).toMatchObject({ profileId: granted.id });
    expect(agent.session.id).not.toBe(
      (await repository.findActiveBrowserSessionForWorkspace(workspaceId))?.id,
    );
    expect(runtime.connectionCount()).toBe(2);
  });

  it("stops a deleted profile's sessions, tells the owner's devices and never starts it again", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const profile = repository.addHostedProfile("Shopping");
    const onProfilesChanged = vi.fn();
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      onProfilesChanged,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());
    const { session } = await service.start({ ownerId, profileId: profile.id, workspaceId });

    await service.deleteProfile({ ownerId, profileId: profile.id });

    expect(repository.session(session.id)?.state).toBe("closed");
    expect(onProfilesChanged).toHaveBeenCalledWith(ownerId, workspaceId);
    await expect(
      service.start({ ownerId, profileId: profile.id, workspaceId }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("opens a fresh agent session with no profile, no grant, and no lease", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = freshService({ keys, repository, runtime });

    const authority = { agentBindingId: "run:fresh", ownerId, workspaceId };
    await expect(service.listGrantedProfiles(ownerId, workspaceId)).resolves.toEqual([]);
    const opened = await service.openAgentSession({ ...authority, fresh: true });
    expect(opened).toMatchObject({
      session: { attached: true, profileId: null, profileName: null },
      wasExisting: false,
    });
    expect(runtime.lastClaims()?.identity).toEqual({ kind: "fresh" });
    expect(JSON.stringify(runtime.lastClaims())).not.toContain("profileLeaseToken");
    expect(repository.session(opened.session.id)).toMatchObject({ profileId: null });

    await expect(service.listAgentSessions(authority)).resolves.toEqual([
      expect.objectContaining({ id: opened.session.id, profileName: null }),
    ]);
    // Opening is always explicit: a second fresh open is a second session, and
    // the Run holds both.
    const second = await service.openAgentSession({ ...authority, fresh: true });
    expect(second).toMatchObject({ session: { attached: true }, wasExisting: false });
    expect(second.session.id).not.toBe(opened.session.id);
    await expect(attachedSessionIds(service, authority)).resolves.toEqual(
      expect.arrayContaining([opened.session.id, second.session.id]),
    );
    expect(runtime.connectionCount()).toBe(2);
    // A profile-backed request never reuses a fresh attachment.
    const profile = repository.addHostedProfile("Client portal");
    await expect(
      service.openAgentSession({ ...authority, profileId: profile.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires exactly one identity when an agent opens a Browser Session", async () => {
    const keys = generateKeyPairSync("ed25519");
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });
    const authority = { agentBindingId: "run:identity", ownerId, workspaceId };
    const profileId = repository.addHostedProfile("Client portal").id;
    for (const identity of [
      {},
      { fresh: true as const, profileId },
      { fresh: true as const, sessionId: createBrowserSessionId() },
      { profileId, sessionId: createBrowserSessionId() },
    ]) {
      await expect(service.openAgentSession({ ...authority, ...identity })).rejects.toMatchObject({
        code: "bad_request",
      });
    }
  });

  it("scopes a fresh session to its Workspace and the owner's Main", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = freshService({ keys, repository, runtime });
    const opened = await service.openAgentSession({
      agentBindingId: "run:owner",
      fresh: true,
      ownerId,
      workspaceId,
    });

    const otherWorkspaceId = repository.addWorkspace("specialized");
    await expect(
      service.openAgentSession({
        agentBindingId: "run:other-workspace",
        ownerId,
        sessionId: opened.session.id,
        workspaceId: otherWorkspaceId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const mainWorkspaceId = repository.addWorkspace("main");
    await expect(
      service.openAgentSession({
        agentBindingId: "run:main",
        ownerId,
        sessionId: opened.session.id,
        workspaceId: mainWorkspaceId,
      }),
    ).resolves.toMatchObject({ session: { id: opened.session.id, profileName: null } });
    await expect(
      service.listAgentSessions({
        agentBindingId: "run:main",
        ownerId,
        workspaceId: mainWorkspaceId,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: opened.session.id, profileName: null })]);
  });

  it("keeps a Workspace session's identity immutable across reuse", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const workspaceId = createId("workspace");
    const repository = new MemoryBrowserRepository(ownerId, workspaceId);
    const service = freshService({ keys, repository, runtime });
    const profile = repository.addHostedProfile("Client portal");

    const fresh = await service.start({ fresh: true, ownerId, workspaceId });
    expect(fresh.session.profileId).toBeNull();
    await expect(
      service.start({ fresh: true, ownerId, workspaceId, reuseExisting: true }),
    ).resolves.toMatchObject({
      session: { id: fresh.session.id },
      wasExisting: true,
    });
    await expect(
      service.start({ ownerId, profileId: profile.id, workspaceId, reuseExisting: true }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This Workspace is using a signed-out browser session.",
    });

    await service.stop(ownerId, fresh.session.id);
    const backed = await service.start({ ownerId, profileId: profile.id, workspaceId });
    expect(backed.session.profileId).toBe(profile.id);
    await expect(
      service.start({ fresh: true, ownerId, workspaceId, reuseExisting: true }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This Workspace is using a browser profile.",
    });
  });
});

function freshService(options: {
  readonly history?: BrowserHistoryStore;
  readonly navigationAttribution?: boolean;
  readonly onHistoryChanged?: (ownerId: UserId, profileId: BrowserProfileId) => void;
  readonly onError?: (error: unknown) => void;
  readonly passkeysEnabled?: boolean;
  readonly passkeys?: boolean;
  readonly sharedControl?: boolean;
  readonly targetControl?: boolean;
  readonly rasterDemand?: boolean;
  readonly editing?: boolean | 1 | 2 | undefined;
  readonly clipboard?: boolean | undefined;
  readonly actorMetadataTimeoutMs?: number;
  readonly keys: { readonly privateKey: KeyObject };
  readonly onWorkspaceEvent?: (event: AgentEvent) => void;
  readonly repository: MemoryBrowserRepository;
  readonly runtime: { readonly url: URL };
}): BrowserService {
  const service = new BrowserService({
    ...nativeProfileOptions(),
    passkeys: options.passkeysEnabled === true,
    ...profileStateOptions,
    ...(options.history ? { history: options.history } : {}),
    ...(options.onHistoryChanged ? { onHistoryChanged: options.onHistoryChanged } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    connectTimeoutMs: 2_000,
    ...(options.actorMetadataTimeoutMs === undefined
      ? {}
      : {
          actorMetadataTimeoutMs: options.actorMetadataTimeoutMs,
        }),
    ...(options.onWorkspaceEvent ? { onWorkspaceEvent: options.onWorkspaceEvent } : {}),
    repository: options.repository,
    signer: new BrowserAttachTicketSigner({
      keyId: "host-primary",
      privateKey: options.keys.privateKey,
    }),
    targetResolver: runnerTarget({
      url: options.runtime.url,
      navigationAttributionVersion: options.navigationAttribution ?? options.history !== undefined,
      sharedControl: options.sharedControl ?? true,
      targetControl: options.targetControl ?? false,
      rasterDemand: options.rasterDemand ?? false,
      passkeys: options.passkeys === true,
      editing: options.editing,
      clipboard: options.clipboard,
    }),
  });
  cleanups.push(async () => service.close());
  return service;
}

interface TestBrowserRunner {
  readonly environmentIds: readonly EnvironmentId[];
  readonly runnerId: RunnerId;
  readonly runtimeId: string;
  readonly unavailableReason?: string;
}

/** One enrolled computer offering a browser, bound to the work locations it runs. */
function testRunner(input: {
  readonly environmentIds?: readonly EnvironmentId[];
  readonly unavailableReason?: string;
}): TestBrowserRunner {
  const runnerId = createId("runner");
  return {
    environmentIds: [...(input.environmentIds ?? [])],
    runnerId,
    runtimeId: `browser-${runnerId}`,
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
  };
}

function placementService(options: {
  readonly keys: { readonly privateKey: KeyObject };
  readonly ownerId: UserId;
  readonly repository?: MemoryBrowserRepository;
  readonly runners: readonly TestBrowserRunner[];
  readonly runtime: { readonly url: URL };
  readonly workspaceId: WorkspaceId;
}): BrowserService {
  // Every Runner here shares one fake runtime socket: placement is what these
  // tests are about, not what happens after the browser answers.
  const relay = runnerTarget({ url: options.runtime.url });
  const targetResolver: BrowserRuntimeTargetResolver = {
    placements: () =>
      options.runners.map((runner) => ({
        available: runner.unavailableReason === undefined,
        environmentIds: [...runner.environmentIds],
        kind: "runner" as const,
        label: `Computer ${runner.runnerId}`,
        runnerId: runner.runnerId,
        runtimeId: runner.runtimeId,
        ...(runner.unavailableReason ? { unavailableReason: runner.unavailableReason } : {}),
      })),
    resolve: (placement) => {
      const runner = options.runners.find((candidate) => candidate.runnerId === placement.runnerId);
      if (!runner) return undefined;
      if (runner.unavailableReason) {
        throw new OpensteerError({
          code: "workspace_unavailable",
          message: runner.unavailableReason,
        });
      }
      return {
        localProfileStorage: fixtureStorage,
        cdpBoundary: true,
        sharedControl: true,
        connect: (ticket) => relayConnection(relay).connect(ticket),
        placementKey: `runner:${runner.runnerId}:${runner.runtimeId}`,
        runtimeId: runner.runtimeId,
      };
    },
  };
  const service = new BrowserService({
    ...nativeProfileOptions(),
    ...profileStateOptions,
    repository:
      options.repository ?? new MemoryBrowserRepository(options.ownerId, options.workspaceId),
    signer: new BrowserAttachTicketSigner({
      keyId: "host-primary",
      privateKey: options.keys.privateKey,
    }),
    targetResolver,
  });
  cleanups.push(async () => service.close());
  return service;
}

function relayConnection(
  relay: BrowserRuntimeTargetResolver & { readonly runnerId: RunnerId },
): BrowserRuntimeTarget {
  const target = relay.resolve({ kind: "runner", runnerId: relay.runnerId });
  if (!target) throw new Error("The test relay must resolve its own placement");
  return target;
}

function consumerOptions() {
  return {
    authSessionId: createId("authSession"),
    mode: "control" as const,
    signedIn: async () => true,
  };
}

class RecordingPeer implements BrowserConsumerPeer {
  readonly binaryFrames: Buffer[] = [];
  readonly id: string;
  readonly textFrames: string[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(id: string) {
    this.id = id;
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  isOpen(): boolean {
    return this.closed === null;
  }

  async send(data: Buffer | string, binary: boolean): Promise<void> {
    if (binary) this.binaryFrames.push(Buffer.from(data));
    else this.textFrames.push(String(data));
  }

  text(): Array<{ type: string }> {
    return this.textFrames.map((frame) => JSON.parse(frame) as { type: string });
  }
}

class SlowFramePeer extends RecordingPeer {
  readonly #firstFrame = deferred<void>();

  override send(data: Buffer | string, binary: boolean): Promise<void> {
    if (!binary) {
      this.textFrames.push(String(data));
      return Promise.resolve();
    }
    this.binaryFrames.push(Buffer.from(data));
    return this.binaryFrames.length === 1 ? this.#firstFrame.promise : Promise.resolve();
  }

  releaseFirstFrame(): void {
    this.#firstFrame.resolve();
  }
}

async function attachedSessionIds(
  service: BrowserService,
  authority: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<readonly BrowserSessionId[]> {
  return (await service.listAgentSessions(authority))
    .filter((session) => session.attached)
    .map((session) => session.id);
}

class MemoryBrowserRepository implements BrowserSessionRepository {
  readonly tabOpens = new Map<string, import("@opensteer/protocol").BrowserTabOpenBinding>();
  async findMainWorkspaceForOwner(ownerId: UserId) {
    return this.getWorkspaceForOwner(this.#workspaceId, ownerId);
  }
  async getBrowserTabOpen(ownerId: UserId, key: string) {
    return this.tabOpens.get(`${ownerId}:${key}`) ?? null;
  }
  async bindBrowserTabOpen(input: {
    binding: import("@opensteer/protocol").BrowserTabOpenBinding;
  }) {
    this.tabOpens.set(
      `${input.binding.callerUserId}:${input.binding.idempotencyKey}`,
      input.binding,
    );
  }
  async settleBrowserTabOpen(binding: import("@opensteer/protocol").BrowserTabOpenBinding) {
    const key = binding.callerUserId + ":" + binding.idempotencyKey;
    const current = this.tabOpens.get(key);
    if (
      current?.outcome.kind === "pending" &&
      current.requestFingerprint === binding.requestFingerprint
    )
      this.tabOpens.set(key, binding);
  }
  async rememberedBrowserPlacement() {
    return null;
  }
  async browserSessionOpenerForBinding() {
    return null;
  }

  async listBrowserSessionViewers() {
    return null;
  }
  async resolvePlaceActors() {
    return [];
  }
  async listBrowserPlaceHoldings() {
    return [];
  }
  /** Durable uses by session, conversation or binding, and page; the value is the page last seen. */
  readonly uses = new Map<string, BrowserUsePage | null>();

  /** Each session's conversations, most recently joined first. */
  readonly #members = new Map<BrowserSessionId, ThreadId[]>();

  async recordBrowserSessionUse(input: {
    readonly sessionId: BrowserSessionId;
    readonly threadId: ThreadId;
    readonly tabId?: string | null;
    readonly page?: BrowserUsePage | null;
  }): Promise<readonly BrowserUsageCredit[]> {
    return this.#credit(input.sessionId, input.threadId, "person", input.tabId ?? null, input.page);
  }

  async recordRunPlace(): Promise<AgentEvent | undefined> {
    return undefined;
  }

  async recordAgentBrowserUse(input: {
    readonly agentBindingId: string;
    readonly sessionId: BrowserSessionId;
    readonly tabId: string | null;
    readonly page: BrowserUsePage | null;
  }): Promise<readonly BrowserUsageCredit[]> {
    // This repository's conversations are named after the binding that used them.
    const threadId = `thr_${input.agentBindingId}` as ThreadId;
    return this.#credit(input.sessionId, threadId, input.agentBindingId, input.tabId, input.page);
  }

  async listBrowserSessionThreads(input: {
    readonly sessionIds: readonly BrowserSessionId[];
  }): Promise<ReadonlyMap<BrowserSessionId, readonly ThreadId[]>> {
    return new Map(
      input.sessionIds.flatMap((sessionId) => {
        const members = this.#members.get(sessionId);
        return members ? [[sessionId, [...members]] as const] : [];
      }),
    );
  }

  #credit(
    sessionId: BrowserSessionId,
    threadId: ThreadId,
    usedBy: string,
    tabId: string | null,
    page: BrowserUsePage | null | undefined,
  ): readonly BrowserUsageCredit[] {
    const members = this.#members.get(sessionId) ?? [];
    const joined = !members.includes(threadId);
    if (joined) this.#members.set(sessionId, [threadId, ...members]);
    const key = `${sessionId}|${threadId}|${usedBy}|${tabId ?? ""}`;
    const created = !this.uses.has(key);
    this.uses.set(key, page ?? this.uses.get(key) ?? null);
    return joined || created ? [{ joined, threadId, workspaceId: this.#workspaceId }] : [];
  }
  readonly #requestCallIds = new Map<string, RequestId>();
  readonly #requests = new Map<RequestId, Request>();
  /** Keyed by binding and session; insertion order is attachment recency. */
  readonly #attachments = new Map<
    string,
    {
      readonly agentBindingId: string;
      readonly ownerId: UserId;
      readonly sessionId: BrowserSessionId;
      readonly workspaceId: WorkspaceId;
    }
  >();
  #grant: {
    access: BrowserProfileAccess;
    createdAt: Date;
    grantId: BrowserProfileGrantId;
    profileId: BrowserProfileId;
    workspaceId: WorkspaceId;
  } | null = null;
  readonly #ownerId: UserId;
  readonly #otherWorkspaces = new Map<WorkspaceId, "main" | "specialized">();
  readonly #profiles = new Map<BrowserProfileId, BrowserProfileRecord>();
  readonly #deletedProfiles = new Set<BrowserProfileId>();
  readonly #sessions = new Map<BrowserSessionId, BrowserSessionRecord>();
  readonly #workspaceId: WorkspaceId;
  readonly #workspaceKind: "main" | "specialized";

  constructor(ownerId: UserId, workspaceId: WorkspaceId, workspaceKind?: "main" | "specialized") {
    this.#ownerId = ownerId;
    this.#workspaceId = workspaceId;
    this.#workspaceKind = workspaceKind ?? "specialized";
  }

  readonly requests: BrowserSessionRepository["requests"] = {
    findByCallIdentity: async (input) => {
      const existingId = this.#requestCallIds.get(`${input.originatingRunId}\0${input.callId}`);
      return existingId ? (this.#requests.get(existingId) ?? null) : null;
    },
    create: async (input) => {
      const callIdentity = `${input.originatingRunId}\0${input.callId}`;
      const existingId = this.#requestCallIds.get(callIdentity);
      if (existingId) {
        return {
          events: [],
          replayed: true,
          request: this.#requests.get(existingId)!,
        };
      }
      const request: Request = {
        callId: input.callId,
        cancellationReason: null,
        createdAt: new Date().toISOString(),
        id: createId("request"),
        kind: input.kind,
        mode: input.mode,
        originatingOccurrenceId: null,
        originatingRunId: input.originatingRunId,
        originatingThreadId: input.originatingThreadId,
        originatingWorkspaceId: input.originatingWorkspaceId,
        payload: input.payload,
        presentation: input.presentation,
        requestedBy: input.requestedBy,
        requiredActor: input.requiredActor,
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        status: "pending",
        targetWorkspaceId: input.targetWorkspaceId,
      };
      this.#requestCallIds.set(callIdentity, request.id);
      this.#requests.set(request.id, request);
      return {
        events: [this.#requestEvent(request)],
        replayed: false,
        request,
      };
    },
    get: async (id) => this.#requests.get(id) ?? null,
    resolveBrowserRequest: async (input) => {
      const pending = this.#requests.get(input.requestId);
      if (
        !pending ||
        pending.status !== "pending" ||
        pending.requestedBy !== input.resolvedBy ||
        input.response.kind !== "external" ||
        pending.kind !== "browser.access"
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Browser Request is no longer pending",
        });
      }
      const value = input.response.value as
        | {
            readonly createProfile?: { readonly name: string };
            readonly decision?: string;
            readonly name?: string;
            readonly profileId?: string;
          }
        | undefined;
      const fulfilled = value?.decision === "fulfilled";
      let profile: BrowserProfileRecord | null = null;
      if (fulfilled && pending.kind === "browser.access") {
        if (value.createProfile) {
          profile = {
            id: createId("browserProfile"),
            name: value.createProfile.name,
            ownerId: input.resolvedBy,
          };
        } else if (value.profileId) {
          profile =
            this.#profiles.get(value.profileId as BrowserProfileId)?.ownerId === input.resolvedBy
              ? (this.#profiles.get(value.profileId as BrowserProfileId) ?? null)
              : null;
        }
        if (!profile) {
          throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
        }
      }
      let grant: ActiveBrowserProfileGrant | null = null;
      const targetKind =
        pending.targetWorkspaceId === this.#workspaceId
          ? this.#workspaceKind
          : this.#otherWorkspaces.get(pending.targetWorkspaceId);
      if (
        fulfilled &&
        profile &&
        (pending.kind === "browser.access" || targetKind === "specialized")
      ) {
        if (
          this.#grant &&
          (this.#grant.profileId !== profile.id ||
            this.#grant.workspaceId !== pending.targetWorkspaceId)
        ) {
          throw new OpensteerError({ code: "conflict", message: "Browser grant conflict" });
        }
        grant =
          this.#grant ??
          ({
            access: "full-control",
            createdAt: new Date(),
            grantId: createId("browserProfileGrant"),
            profileId: profile.id,
            workspaceId: pending.targetWorkspaceId,
          } satisfies ActiveBrowserProfileGrant);
      }
      const request: Request = {
        ...pending,
        cancellationReason: null,
        resolvedAt: new Date().toISOString(),
        resolvedBy: input.resolvedBy,
        response: input.response,
        status: fulfilled ? "fulfilled" : "declined",
      };

      // Everything above is prepared and validated before this synchronous
      // commit boundary, mirroring the production database transaction.
      if (profile && !this.#profiles.has(profile.id)) this.#profiles.set(profile.id, profile);
      if (grant) this.#grant = grant;
      this.#requests.set(request.id, request);
      return {
        events: [this.#requestEvent(request)],
        grant,
        profile,
        request,
      };
    },
  };

  addHostedProfile(name: string): BrowserProfileRecord {
    const profile = {
      id: createId("browserProfile"),
      name,
      ownerId: this.#ownerId,
    };
    this.#profiles.set(profile.id, profile);
    return profile;
  }

  async createBrowserProfileGrant(input: {
    readonly access: BrowserProfileAccess;
    readonly createdBy: UserId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  }) {
    if (this.#grant) throw new Error("conflict");
    this.#grant = {
      access: input.access,
      createdAt: new Date(),
      grantId: createId("browserProfileGrant"),
      profileId: input.profileId,
      workspaceId: input.workspaceId,
    };
    return this.#grant;
  }

  async createBrowserProfile(input: {
    readonly name: string;
    readonly ownerId: UserId;
  }): Promise<BrowserProfileRecord> {
    const profile: BrowserProfileRecord = {
      id: createId("browserProfile"),
      name: input.name,
      ownerId: input.ownerId,
    };
    this.#profiles.set(profile.id, profile);
    return profile;
  }

  #requestEvent(request: Request): AgentEvent {
    const envelope = {
      createdAt: request.createdAt,
      environmentId: createId("environment"),
      eventId: createId("event"),
      runId: request.originatingRunId,
      sequence: SequenceSchema.parse("1"),
      threadId: request.originatingThreadId,
      workspaceId: request.originatingWorkspaceId,
    };
    if (request.status === "pending") {
      return {
        ...envelope,
        data: { request },
        type: "request.opened",
      };
    }
    if (request.status === "cancelled") {
      return {
        ...envelope,
        data: { reason: request.cancellationReason, requestId: request.id },
        type: "request.cancelled",
      };
    }
    return {
      ...envelope,
      data: { request },
      type: "request.resolved",
    };
  }

  grant(profileId: BrowserProfileId, access: BrowserProfileAccess) {
    return this.createBrowserProfileGrant({
      access,
      createdBy: this.#ownerId,
      profileId,
      workspaceId: this.#workspaceId,
    });
  }

  async listActiveBrowserProfileGrants(ownerId: UserId) {
    return ownerId === this.#ownerId && this.#grant ? [this.#grant] : [];
  }

  async listActiveBrowserSessionsForAgent(input: {
    readonly allOwnerWorkspaces: boolean;
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
  }) {
    return [...this.#sessions.values()]
      .filter(
        (session) =>
          input.ownerId === this.#ownerId &&
          (input.allOwnerWorkspaces || session.workspaceId === input.workspaceId) &&
          !terminal(session.state),
      )
      .map((session) => ({
        ...session,
        activeAttachmentCount: [...this.#attachments.values()].filter(
          (attachment) => attachment.sessionId === session.id,
        ).length,
      }));
  }

  async listAttachedRunIdsForBrowserSessions(sessionIds: readonly BrowserSessionId[]) {
    const attached = new Map<BrowserSessionId, RunId[]>();
    for (const attachment of this.#attachments.values()) {
      if (
        !sessionIds.includes(attachment.sessionId) ||
        !attachment.agentBindingId.startsWith("run:")
      )
        continue;
      const runId = RunIdSchema.safeParse(attachment.agentBindingId.slice(4));
      if (!runId.success) continue;
      const ids = attached.get(attachment.sessionId) ?? [];
      if (!ids.includes(runId.data)) ids.push(runId.data);
      attached.set(attachment.sessionId, ids);
    }
    return attached;
  }

  async listActiveBrowserProfileGrantsForWorkspace(workspaceId: WorkspaceId, ownerId: UserId) {
    return workspaceId === this.#workspaceId && ownerId === this.#ownerId && this.#grant
      ? [this.#grant]
      : [];
  }

  async revokeBrowserGrant(): Promise<void> {
    this.#grant = null;
  }

  async createBrowserSession(input: {
    readonly id: BrowserSessionId;
    readonly placementKey: string;
    readonly runnerId: RunnerId;
    readonly origin: "agent" | "trigger" | "workspace";
    readonly profileId: BrowserProfileId | null;
    readonly runtimeId: string;
    readonly workspaceId: WorkspaceId;
  }): Promise<BrowserSessionRecord> {
    const now = new Date();
    const record: BrowserSessionRecord = {
      createdAt: now,
      id: input.id,
      origin: input.origin,
      placementKey: input.placementKey,
      profileId: input.profileId,
      runnerId: input.runnerId,
      runtimeId: input.runtimeId,
      state: "starting",
      updatedAt: now,
      workspaceId: input.workspaceId,
    };
    this.#sessions.set(record.id, record);
    return record;
  }

  async countBrowserSessionAttachments(sessionId: BrowserSessionId): Promise<number> {
    return [...this.#attachments.values()].filter(
      (attachment) => attachment.sessionId === sessionId,
    ).length;
  }

  async attachBrowserSession(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
    readonly workspaceId: WorkspaceId;
  }): Promise<boolean> {
    const key = `${input.agentBindingId}\u0000${input.sessionId}`;
    const created = !this.#attachments.has(key);
    this.#attachments.delete(key);
    this.#attachments.set(key, {
      agentBindingId: input.agentBindingId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    });
    return created;
  }

  async detachBrowserSessionAttachments(
    agentBindingId: string,
  ): Promise<readonly BrowserSessionId[]> {
    const detached: BrowserSessionId[] = [];
    for (const [key, attachment] of this.#attachments) {
      if (attachment.agentBindingId !== agentBindingId) continue;
      this.#attachments.delete(key);
      detached.push(attachment.sessionId);
    }
    return detached;
  }

  async detachBrowserSessionAttachmentsForProfileGrant(input: {
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  }): Promise<number> {
    let count = 0;
    for (const [bindingId, attachment] of this.#attachments) {
      const session = this.#sessions.get(attachment.sessionId);
      if (
        attachment.ownerId === input.ownerId &&
        attachment.workspaceId === input.workspaceId &&
        session?.profileId === input.profileId &&
        input.ownerId === this.#ownerId
      ) {
        this.#attachments.delete(bindingId);
        count += 1;
      }
    }
    return count;
  }

  async failActiveBrowserSessions(placementKey?: string): Promise<{
    readonly events: readonly AgentEvent[];
    readonly failed: number;
  }> {
    let count = 0;
    if (placementKey === undefined)
      for (const [key, binding] of this.tabOpens)
        if (binding.outcome.kind === "pending")
          this.tabOpens.set(key, {
            ...binding,
            outcome: { kind: "failed", reason: "interrupted" },
          });
    const events: AgentEvent[] = [];
    for (const session of this.#sessions.values()) {
      if ((placementKey && session.placementKey !== placementKey) || terminal(session.state))
        continue;
      this.#sessions.set(session.id, { ...session, state: "failed", updatedAt: new Date() });

      for (const [bindingId, attachment] of this.#attachments) {
        if (attachment.sessionId === session.id) this.#attachments.delete(bindingId);
      }
      count += 1;
    }
    return { events, failed: count };
  }

  async findActiveBrowserSessionForWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<BrowserSessionRecord | null> {
    return (
      [...this.#sessions.values()].find(
        (session) =>
          session.origin === "workspace" &&
          session.workspaceId === workspaceId &&
          !terminal(session.state),
      ) ?? null
    );
  }

  async listActiveBrowserSessionsForAgentBinding(
    agentBindingId: string,
  ): Promise<readonly BrowserSessionRecord[]> {
    return [...this.#attachments.values()]
      .filter((attachment) => attachment.agentBindingId === agentBindingId)
      .reverse()
      .flatMap((attachment) => {
        const session = this.#sessions.get(attachment.sessionId);
        return session && !terminal(session.state) ? [session] : [];
      });
  }

  async findBrowserSessionHoldingProfilePlacement(
    profileId: BrowserProfileId,
  ): Promise<BrowserSessionRecord | null> {
    return (
      [...this.#sessions.values()]
        .filter((session) => session.profileId === profileId && !terminal(session.state))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
    );
  }

  async getBrowserProfile(
    profileId: BrowserProfileId,
    ownerId: UserId,
  ): Promise<BrowserProfileRecord | null> {
    const profile = this.#profiles.get(profileId);
    return profile?.ownerId === ownerId && !this.#deletedProfiles.has(profileId) ? profile : null;
  }

  async renameBrowserProfile(input: {
    readonly name: string;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }): Promise<BrowserProfileRecord> {
    const profile = await this.getBrowserProfile(input.profileId, input.ownerId);
    if (!profile)
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
    const renamed = { ...profile, name: input.name };
    this.#profiles.set(renamed.id, renamed);
    return renamed;
  }

  /** The archived row stays, as the database keeps it, so its sessions still name an owner. */
  async deleteBrowserProfile(input: {
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }) {
    if (this.#profiles.get(input.profileId)?.ownerId !== input.ownerId) {
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
    }
    this.#deletedProfiles.add(input.profileId);
    if (this.#grant?.profileId === input.profileId) this.#grant = null;
    return {
      sessionIds: [...this.#sessions.values()]
        .filter((session) => session.profileId === input.profileId && !terminal(session.state))
        .map((session) => session.id),
    };
  }

  /** Session reads that never answer, as a stalled database's would not. */
  hangSessionReads = false;

  async getBrowserSessionForOwner(
    sessionId: BrowserSessionId,
    ownerId: UserId,
  ): Promise<BrowserSessionRecord | null> {
    if (this.hangSessionReads) return await new Promise<never>(() => undefined);
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    return this.#ownsSession(session, ownerId) ? session : null;
  }

  /** A fresh session has no profile owner, so Workspace membership answers. */
  #ownsSession(session: BrowserSessionRecord, ownerId: UserId): boolean {
    if (session.profileId === null) return ownerId === this.#ownerId;
    return this.#profiles.get(session.profileId)?.ownerId === ownerId;
  }

  async getWorkspaceForOwner(
    workspaceId: WorkspaceId,
    ownerId: UserId,
  ): Promise<{ readonly id: WorkspaceId; readonly kind: "main" | "specialized" } | null> {
    if (ownerId !== this.#ownerId) return null;
    if (workspaceId === this.#workspaceId) return { id: workspaceId, kind: this.#workspaceKind };
    const kind = this.#otherWorkspaces.get(workspaceId);
    return kind ? { id: workspaceId, kind } : null;
  }

  addWorkspace(kind: "main" | "specialized"): WorkspaceId {
    const workspaceId = createId("workspace");
    this.#otherWorkspaces.set(workspaceId, kind);
    return workspaceId;
  }

  async listBrowserProfiles(ownerId: UserId): Promise<readonly BrowserProfileRecord[]> {
    return [...this.#profiles.values()].filter(
      (profile) => profile.ownerId === ownerId && !this.#deletedProfiles.has(profile.id),
    );
  }

  async listBrowserSessions(ownerId: UserId): Promise<readonly BrowserSessionRecord[]> {
    return [...this.#sessions.values()].filter((session) => this.#ownsSession(session, ownerId));
  }

  session(sessionId: BrowserSessionId): BrowserSessionRecord | undefined {
    return this.#sessions.get(sessionId);
  }

  async transitionBrowserSession(input: {
    readonly from?: readonly HostedBrowserSessionState[];
    readonly sessionId: BrowserSessionId;
    readonly state: HostedBrowserSessionState;
  }): Promise<{
    readonly events: readonly AgentEvent[];
    readonly session: BrowserSessionRecord;
  }> {
    const current = this.#sessions.get(input.sessionId);
    if (!current) throw new Error("not found");
    if (input.from && !input.from.includes(current.state)) {
      if (current.state === input.state) {
        return {
          events: [],
          session: current,
        };
      }
      throw new Error("invalid transition");
    }
    const next = { ...current, state: input.state, updatedAt: new Date() };
    this.#sessions.set(input.sessionId, next);
    if (terminal(input.state)) {
      for (const [bindingId, attachment] of this.#attachments) {
        if (attachment.sessionId === input.sessionId) this.#attachments.delete(bindingId);
      }
    }
    return {
      events: [],
      session: next,
    };
  }
}

async function startFakeRuntime(
  publicKey: CryptoKeyLike,
  keyId: string,
  options: {
    readonly beforeInitialSnapshot?: readonly Record<string, unknown>[];
    readonly deferInitialSnapshot?: boolean;
    readonly initialDialog?: Record<string, unknown> | null;
    readonly targetedStreaming?: boolean;
    readonly navigationAttribution?: boolean;
    readonly navigation?: boolean;
    readonly editing?: boolean | 1 | 2 | undefined;
    readonly clipboard?: boolean | undefined;
  } = {},
): Promise<{
  connectionCount(): number;
  lastClaims(): ReturnType<typeof BrowserAttachTicketClaimsSchema.parse> | undefined;
  nextCommand(): Promise<Record<string, unknown>>;
  receivedCommands(): readonly Record<string, unknown>[];
  releaseInitialSnapshots(): void;
  sendFrame(frame: Buffer): void;
  sendServer(message: Record<string, unknown>): void;
  url: URL;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected fake Runtime address.");
  const commands: Array<Record<string, unknown>> = [];
  const receivedCommands: Array<Record<string, unknown>> = [];
  const waiters: Array<(command: Record<string, unknown>) => void> = [];
  const sockets = new Set<WebSocket>();
  const pendingInitialSnapshots: Array<() => void> = [];
  let connections = 0;
  let latestClaims: ReturnType<typeof BrowserAttachTicketClaimsSchema.parse> | undefined;
  server.on("connection", (socket, request) => {
    connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      socket.close(1008, "missing ticket");
      return;
    }
    const claims = verifyTicket(authorization.slice(7), publicKey, keyId);
    latestClaims = claims;
    if (claims.initialNavigation?.url) {
      const navigation = {
        type: "cdp.command",
        requestId: randomUUID(),
        ...(claims.initialNavigation.navigationId
          ? { navigationId: claims.initialNavigation.navigationId }
          : {}),
        command: { method: "Page.navigate", parameters: { url: claims.initialNavigation.url } },
      };
      const waiting = waiters.shift();
      if (waiting) waiting(navigation);
      else commands.push(navigation);
    }
    for (const message of options.beforeInitialSnapshot ?? []) {
      socket.send(JSON.stringify(message));
    }
    const sendInitialSnapshot = () =>
      socket.send(
        JSON.stringify({
          access: claims.access,
          dialog: options.initialDialog ?? null,
          sessionId: claims.sessionId,
          state: "ready",
          surfaces: [
            {
              active: true,
              ...(claims.navigationVersion === 1 && options.navigation
                ? { canGoBack: false, canGoForward: false }
                : {}),
              id: "page-1",
              title: "Example",
              url: "about:blank",
            },
          ],
          type: "browser.snapshot",
          ...(claims.navigationAttributionVersion === 1 && options.navigationAttribution !== false
            ? { navigationAttributionVersion: 1 }
            : {}),
          ...(options.targetedStreaming ? { targetedStreamingVersion: 1 } : {}),
          ...(options.editing && claims.editingVersion
            ? {
                editingVersion: claims.editingVersion,
                ...(claims.editingVersion === 2 ? { clipboard: options.clipboard ?? true } : {}),
              }
            : {}),
        }),
      );
    if (options.deferInitialSnapshot) pendingInitialSnapshots.push(sendInitialSnapshot);
    else sendInitialSnapshot();
    if (claims.workspaceTabRestoreVersion === 1)
      socket.send(
        JSON.stringify({
          type: "browser.workspace-tabs",
          tabs: [{ id: "page-1", title: "Example", url: "about:blank", order: 0, openerId: null }],
          closed: [],
        }),
      );
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const command = JSON.parse(raw.toString()) as Record<string, unknown>;
      receivedCommands.push(command);
      const waiter = waiters.shift();
      if (waiter) waiter(command);
      else commands.push(command);
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        server.close(() => resolve());
      }),
  );
  return {
    connectionCount: () => connections,
    lastClaims: () => latestClaims,
    receivedCommands: () => receivedCommands,
    nextCommand: () => {
      const command = commands.shift();
      return command
        ? Promise.resolve(command)
        : new Promise<Record<string, unknown>>((resolve, reject) => {
            const accept = (message: Record<string, unknown>) => {
              clearTimeout(timer);
              resolve(message);
            };
            const timer = setTimeout(() => {
              const index = waiters.indexOf(accept);
              if (index >= 0) waiters.splice(index, 1);
              reject(
                new Error(
                  "The fake browser runtime did not receive the expected command within 3 seconds.",
                ),
              );
            }, 3_000);
            waiters.push(accept);
          });
    },
    releaseInitialSnapshots: () => {
      for (const send of pendingInitialSnapshots.splice(0)) send();
    },
    sendFrame: (frame) => {
      for (const socket of sockets) socket.send(frame, { binary: true });
    },
    sendServer: (message) => {
      for (const socket of sockets) socket.send(JSON.stringify(message));
    },
    url: new URL(`http://127.0.0.1:${address.port}`),
  };
}

type CryptoKeyLike = Parameters<typeof verify>[2];

function verifyTicket(
  token: string,
  publicKey: CryptoKeyLike,
  keyId: string,
): ReturnType<typeof BrowserAttachTicketClaimsSchema.parse> {
  const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
  if (!headerSegment || !payloadSegment || !signatureSegment) throw new Error("invalid ticket");
  const header = JSON.parse(Buffer.from(headerSegment, "base64url").toString()) as {
    kid?: unknown;
  };
  if (header.kid !== keyId) throw new Error("unknown ticket key");
  if (
    !verify(
      null,
      Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii"),
      publicKey,
      Buffer.from(signatureSegment, "base64url"),
    )
  ) {
    throw new Error("invalid ticket signature");
  }
  return BrowserAttachTicketClaimsSchema.parse(
    JSON.parse(Buffer.from(payloadSegment, "base64url").toString()),
  );
}

function browserFrame(frameId: number, surfaceId = "page-1"): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      encoding: "jpeg",
      frameId,
      rasterHeight: 1,
      rasterWidth: 1,
      surfaceId,
      viewportHeight: 720,
      viewportWidth: 1_280,
    }),
  );
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const frame = Buffer.alloc(4 + header.byteLength + image.byteLength);
  frame.writeUInt32BE(header.byteLength, 0);
  header.copy(frame, 4);
  image.copy(frame, 4 + header.byteLength);
  return frame;
}

class MaximumBrowserCatalogRepository extends MemoryBrowserRepository {
  readonly #grantCount: number;
  readonly #ownerId: UserId;
  readonly #profileId: BrowserProfileId;

  constructor(ownerId: UserId, workspaceId: WorkspaceId, grantCount: number) {
    super(ownerId, workspaceId);
    this.#grantCount = grantCount;
    this.#ownerId = ownerId;
    this.#profileId = this.addHostedProfile("Default browser").id;
  }

  override async listActiveBrowserProfileGrants(ownerId: UserId) {
    if (ownerId !== this.#ownerId) return [];
    return Array.from({ length: this.#grantCount }, (_, grantIndex) => {
      return {
        access: "full-control" as const,
        createdAt: new Date(2_000 + grantIndex),
        grantId: createId("browserProfileGrant"),
        profileId: this.#profileId,
        workspaceId: createId("workspace"),
      };
    });
  }

  override async listBrowserProfiles(ownerId: UserId) {
    if (ownerId !== this.#ownerId) return [];
    return Array.from({ length: 128 }, (_, index) => ({
      id: index === 0 ? this.#profileId : createId("browserProfile"),
      name: `Profile ${index}`.padEnd(120, "p"),
      ownerId,
      revision: Number.MAX_SAFE_INTEGER,
    }));
  }

  override async listBrowserSessionThreads(input: {
    readonly sessionIds: readonly BrowserSessionId[];
  }): Promise<ReadonlyMap<BrowserSessionId, readonly ThreadId[]>> {
    return new Map(
      input.sessionIds.map((sessionId) => [
        sessionId,
        Array.from({ length: browserSessionMaxThreads }, () => createId("thread")),
      ]),
    );
  }

  override async listBrowserSessions(ownerId: UserId) {
    if (ownerId !== this.#ownerId) return [];
    return Array.from({ length: 100 }, (_, index) => ({
      createdAt: new Date(10_000 + index),
      id: createBrowserSessionId(),
      origin: "workspace" as const,
      placementKey: `runner:catalog-${index}`,
      profileId: this.#profileId,
      runnerId: createId("runner"),
      runtimeId: `runtime-${index}`.padEnd(255, "r"),
      state: "closed" as const,
      updatedAt: new Date(20_000 + index),
      workspaceId: createId("workspace"),
    }));
  }
}

function terminal(state: HostedBrowserSessionState): boolean {
  return state === "closed" || state === "failed";
}

async function waitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for assertion.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

it.each([
  [undefined, false],
  [undefined, true],
  ["1", false],
  ["1", true],
] as const)(
  "negotiates passkeys only with a capable runtime and enabled Host (flag=%s, advertised=%s)",
  async (flag, advertised) => {
    vi.stubEnv("OPENSTEER_PASSKEYS", flag);
    const enabled = flag === "1" && advertised;
    try {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
      });
      const ownerId = createId("user"),
        workspaceId = createId("workspace");
      const repository = new MemoryBrowserRepository(ownerId, workspaceId, "main");
      const service = freshService({
        keys,
        runtime,
        repository,
        passkeys: advertised,
        passkeysEnabled: flag === "1",
      });
      const opened = await service.openAgentSession({
        ownerId,
        workspaceId,
        agentBindingId: "passkey-compat",
        fresh: true,
      });
      expect(runtime.lastClaims()?.passkeys).toBe(enabled ? 1 : undefined);
      if (!enabled)
        BrowserAttachTicketClaimsSchema.parse(JSON.parse(JSON.stringify(runtime.lastClaims())));
      const old = new RecordingPeer("old-viewer"),
        modern = new RecordingPeer("modern-viewer");
      const baseline = await service.attach(ownerId, opened.session.id, old, consumerOptions());
      const opted = await service.attach(ownerId, opened.session.id, modern, {
        ...consumerOptions(),
        passkeys: "native",
      });
      expect(old.text()[0]).not.toHaveProperty("passkeys");
      await baseline.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1" })),
        false,
      );
      await runtime.nextCommand();
      if (enabled) {
        expect(modern.text()[0]).toMatchObject({ passkeys: "native" });
        await opted.handle(
          Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1" })),
          false,
        );
        const request = {
          type: "passkey.ceremony",
          ceremonyId: randomUUID(),
          surfaceId: "page-1",
          documentId: "document",
          op: "get",
          origin: "https://login.example.test",
          rpId: "example.test",
          options: {
            challenge: "AQID",
            allowCredentials: [],
            userVerification: "preferred",
            extensions: {},
          },
          clientDataJSON: "AQID",
          cause: "unknown",
          deadline: Date.now() + 10_000,
        };
        runtime.sendServer(request);
        await waitFor(() =>
          modern.text().some((message) => message.type === "browser.passkey.offer"),
        );
        expect(
          old
            .text()
            .some(
              (message) =>
                message.type.startsWith("browser.passkey.") || message.type === "passkey.ceremony",
            ),
        ).toBe(false);
        const offer = BrowserPasskeyOfferSchema.parse(
          modern.text().find((message) => message.type === "browser.passkey.offer"),
        );
        if (offer.type !== "browser.passkey.offer") throw new Error("Missing offer");
        await opted.handle(
          Buffer.from(JSON.stringify({ type: "passkey.claim", requestId: offer.requestId })),
          false,
        );
        await waitFor(() =>
          modern.text().some((message) => message.type === "browser.passkey.request"),
        );
        await opted.handle(
          Buffer.from(
            JSON.stringify({
              type: "passkey.respond",
              requestId: offer.requestId,
              outcome: { kind: "refused", error: "NotAllowedError" },
            }),
          ),
          false,
        );
      } else expect(modern.text()[0]).not.toHaveProperty("passkeys");
      opted.close();
      baseline.close();
      for (const frame of old.text()) BrowserServerMessageSchema.parse(frame);
      if (!enabled) {
        expect(runtime.receivedCommands().length).toBeGreaterThan(0);
        for (const frame of runtime.receivedCommands()) BrowserClientMessageSchema.parse(frame);
        for (const frame of modern.text()) BrowserServerMessageSchema.parse(frame);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("runs the next control socket command after a passkey authorization deadline", async () => {
  vi.stubEnv("OPENSTEER_PASSKEYS", "1");
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
    targetedStreaming: true,
  });
  const ownerId = createId("user"),
    workspaceId = createId("workspace");
  const repository = new MemoryBrowserRepository(ownerId, workspaceId, "main");
  const service = freshService({
    keys,
    runtime,
    repository,
    passkeys: true,
    passkeysEnabled: true,
  });
  const opened = await service.openAgentSession({
    ownerId,
    workspaceId,
    agentBindingId: "passkey-deadline",
    fresh: true,
  });
  const peer = new RecordingPeer("passkey-deadline");
  let reads = 0;
  const attachment = await service.attach(ownerId, opened.session.id, peer, {
    ...consumerOptions(),
    passkeys: "native",
    signedIn: async () => (++reads === 1 ? true : new Promise(() => {})),
  });
  try {
    const snapshot = BrowserServerMessageSchema.parse(peer.text()[0]);
    if (snapshot.type !== "browser.snapshot") throw new Error("Missing snapshot");
    await attachment.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1" })),
      false,
    );
    await runtime.nextCommand();
    runtime.sendServer({
      type: "passkey.ceremony",
      ceremonyId: randomUUID(),
      surfaceId: "page-1",
      documentId: "document",
      op: "get",
      origin: "https://login.example.test",
      rpId: "example.test",
      options: {
        challenge: "AQID",
        allowCredentials: [],
        userVerification: "preferred",
        extensions: {},
      },
      clientDataJSON: "AQID",
      cause: { person: snapshot.passkeyConsumerToken },
      deadline: Date.now() + 1000,
    });
    await waitFor(() => peer.text().some((message) => message.type === "browser.passkey.request"));
    const request = BrowserServerMessageSchema.parse(
      peer.text().find((message) => message.type === "browser.passkey.request"),
    );
    if (request.type !== "browser.passkey.request") throw new Error("Missing request");
    // The server awaits each handle call before reading the next socket command.
    const queued = attachment
      .handle(
        Buffer.from(
          JSON.stringify({
            type: "passkey.respond",
            requestId: request.requestId,
            outcome: {
              kind: "asserted",
              credentialId: "AQID",
              clientDataJSON: "BAUG",
              authenticatorData: "BwgJ",
              signature: "CgsM",
              userHandle: null,
              authenticatorAttachment: "platform",
            },
          }),
        ),
        false,
      )
      .then(() =>
        attachment.handle(
          Buffer.from(JSON.stringify({ type: "navigation.reload", surfaceId: "page-1" })),
          false,
        ),
      );
    await queued;
    expect(await runtime.nextCommand()).toMatchObject({
      type: "passkey.result",
      outcome: { kind: "refused", error: "NotAllowedError" },
    });
    expect(await runtime.nextCommand()).toMatchObject({
      type: "navigation.reload",
      surfaceId: "page-1",
    });
  } finally {
    attachment.close();
  }
});

it.each([true, false])(
  "aggregates picture density without resubscribing or sending unsupported runtime commands (capability %s)",
  async (rasterDemand) => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user"),
      workspaceId = createId("workspace");
    const service = freshService({
      keys,
      runtime,
      rasterDemand,
      repository: new MemoryBrowserRepository(ownerId, workspaceId),
    });
    const opened = await service.openAgentSession({
      ownerId,
      workspaceId,
      agentBindingId: "raster-demand",
      fresh: true,
    });
    const phone = await service.attach(ownerId, opened.session.id, new RecordingPeer("phone"), {
      ...consumerOptions(),
      mode: "watch",
    });
    const desktop = await service.attach(
      ownerId,
      opened.session.id,
      new RecordingPeer("desktop"),
      consumerOptions(),
    );
    const send = (viewer: typeof phone, message: object) =>
      viewer.handle(Buffer.from(JSON.stringify(message)), false);
    await send(phone, { type: "stream.subscribe", surfaceId: "page-1" });
    expect(await runtime.nextCommand()).toMatchObject({
      type: "stream.subscribe",
      surfaceId: "page-1",
    });
    await send(desktop, { type: "stream.subscribe", surfaceId: "page-1" });
    await expect(
      send(phone, { type: "stream.demand", surfaceId: "wrong-page", density: 1 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await send(phone, { type: "stream.demand", surfaceId: "page-1", density: 0.75 });
    await send(desktop, { type: "stream.demand", surfaceId: "page-1", density: 1.5 });
    if (rasterDemand) {
      expect(await runtime.nextCommand()).toEqual({
        type: "stream.demand",
        surfaceId: "page-1",
        density: 1.5,
      });
      // The small preview cannot reduce the picture required by the larger pane.
      await send(phone, { type: "stream.demand", surfaceId: "page-1", density: 1 });
      await send(desktop, { type: "stream.demand", surfaceId: "page-1", density: 2 });
      expect(await runtime.nextCommand()).toEqual({
        type: "stream.demand",
        surfaceId: "page-1",
        density: 2,
      });
      // A legacy picture holder stays at the released density.
      const legacy = await service.attach(
        ownerId,
        opened.session.id,
        new RecordingPeer("legacy"),
        consumerOptions(),
      );
      await send(legacy, { type: "stream.subscribe" });
      await send(desktop, { type: "stream.demand", surfaceId: "page-1", density: 1 });
      await send(legacy, { type: "stream.unsubscribe" });
      expect(await runtime.nextCommand()).toEqual({
        type: "stream.demand",
        surfaceId: "page-1",
        density: 1,
      });
      await send(phone, { type: "stream.demand", surfaceId: "page-1", density: 0.75 });
      await send(desktop, { type: "stream.unsubscribe", surfaceId: "page-1" });
      await send(phone, { type: "stream.unsubscribe", surfaceId: "page-1" });
      expect(await runtime.nextCommand()).toMatchObject({ type: "stream.unsubscribe" });
    } else {
      // An ordered command provides the barrier for preceding writes.
      await send(desktop, { type: "navigation.reload", surfaceId: "page-1" });
      expect(await runtime.nextCommand()).toMatchObject({ type: "navigation.reload" });
    }
    expect(
      runtime.receivedCommands().filter((command) => command.type === "stream.subscribe"),
    ).toHaveLength(1);
    expect(runtime.receivedCommands().some((command) => command.type === "input.cancel")).toBe(
      false,
    );
    if (!rasterDemand)
      expect(runtime.receivedCommands().some((command) => command.type === "stream.demand")).toBe(
        false,
      );
    await service.close();
  },
);
