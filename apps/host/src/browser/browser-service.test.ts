import { BrowserRuntime } from "@opensteer/browser-runtime-core";
import {
  FakeContext,
  FakePage,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakeTicketVerifier,
  FakeSink,
  testSessionFilesRoot,
} from "@opensteer/browser-runtime-core/test-support";
import { browserRows } from "./browser-rows.test-support.js";
import { KeyedStreamPublisher } from "@opensteer/protocol/keyed-stream";
import {
  BrowserTabRecordSchema,
  type BrowserTabRecord,
  type BrowserSurface,
  type BrowserViewerSurface,
} from "@opensteer/protocol/browser";
import {
  createId,
  OpensteerError,
  RunIdSchema,
  SequenceSchema,
  type AgentEvent,
  type BrowserProfileId,
  type EnvironmentId,
  type Request,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { BrowserHistoryStore, PersonalTabStore } from "@opensteer/database";
import {
  BrowserAttachTicketClaimsSchema,
  browserCaptureMaxTargets,
  BrowserClientMessageSchema,
  browserHostMethods,
  BrowserServerMessageSchema,
  browserSessionMaxThreads,
  BrowserSurfaceIdSchema,
  createBrowserSessionId,
  decodeBrowserFrameEnvelope,
  RunnerBrowserModuleSchema,
  type BrowserSessionId,
  type HostedBrowserSessionState,
  type PersonFillVersion,
} from "@opensteer/protocol";
import { BrowserPasskeyOfferSchema } from "@opensteer/protocol/passkeys";
import type { Clock } from "@opensteer/shared/clock";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createHash, generateKeyPairSync, randomUUID, verify, type KeyObject } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { installWebSocketLiveness } from "../server/websocket-liveness.js";
import {
  BrowserLocalProfiles,
  type BrowserLocalProfileRepository,
} from "./browser-local-profiles.js";
import {
  BrowserService,
  BrowserConsumerOutlet,
  HostedBrowserBroker,
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
const eligibleRunners = new Map<RunnerId, string>();

/**
 * One computer's browser, reachable at a test runtime's socket. Every browser
 * belongs to a Runner now, so even the simplest case names a machine.
 */
function runnerTarget(options: {
  readonly surfaceState?: boolean | undefined;
  readonly initialPageMismatch?: boolean;
  readonly navigationVersion?: boolean;
  readonly navigationAttributionVersion?: boolean;
  readonly passkeysEnabled?: boolean;
  readonly passkeys?: boolean;
  readonly personFill?: PersonFillVersion | undefined;
  readonly sharedControl?: boolean;
  readonly targetControl?: boolean;
  readonly rasterDemand?: boolean;
  readonly editing?: boolean | 1 | 2 | undefined;
  readonly clipboard?: boolean | undefined;
  readonly tabRestoreVersion?: boolean;
  readonly environmentIds?: readonly EnvironmentId[];
  readonly label?: string;
  readonly runnerId?: RunnerId;
  readonly runtimeId?: string;
  readonly url: URL;
}): BrowserRuntimeTargetResolver & { readonly runnerId: RunnerId } {
  const runnerId = options.runnerId ?? createId("runner");
  eligibleRunners.set(runnerId, options.label ?? "Test computer");
  const runtimeId = options.runtimeId ?? "runtime-1";
  const url = browserRuntimeSocketUrl(options.url);
  return {
    placements: () => [
      {
        available: true,
        agents: true,
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
            main: true,
            navigationVersion: options.navigationVersion ?? false,
            navigationAttributionVersion: options.navigationAttributionVersion ?? false,
            passkeys: options.passkeys === true,
            personFill: options.personFill,
            cdpBoundary: true,
            surfaceState: options.surfaceState ? 1 : undefined,
            tabRestoreVersion: options.tabRestoreVersion ?? false,
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
  deploymentId: createId("deployment"),
  onSessionsChanged: () => undefined,
  onDeploymentEvent: () => undefined,
  hostOrigin: new URL("https://host.test"),
};

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  eligibleRunners.clear();
  vi.unstubAllEnvs();
});

describe("BrowserService", () => {
  it("bounds queued database admission and fences it when the owner retries after timeout", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
    const entered = Promise.withResolvers<void>(),
      release =
        Promise.withResolvers<Awaited<ReturnType<MemoryBrowserRepository["getBrowserTabOpen"]>>>();
    const original = repository.getBrowserTabOpen.bind(repository);
    const binding = await original(ownerId, "deadline-admission");
    vi.spyOn(repository, "getBrowserTabOpen").mockImplementationOnce(() => {
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
      release.resolve(binding);
      await vi.advanceTimersByTimeAsync(0);
      expect(bind).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(runtime.connectionCount()).toBe(0);
    } finally {
      release.resolve(binding);
      vi.useRealTimers();
    }
  });
  it("orders profile deletion after startup admission so a late browser cannot escape erasure", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
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
    const opening = service.start({ ownerId, profileId: profile.id }).catch((error) => error);
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
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
    const first = repository.addHostedProfile("First"),
      second = repository.addHostedProfile("Second");
    const service = freshService({ keys, repository, runtime });
    const openings: Promise<unknown>[] = [service.start({ ownerId, profileId: first.id })];
    try {
      await vi.waitFor(
        () => expect(runtime.connectionCount(), "first profile did not reach the runtime").toBe(1),
        { timeout: 1_000 },
      );
      openings.push(service.start({ ownerId, profileId: second.id }));
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
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
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
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
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
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
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
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
    const service = freshService({ keys, repository, runtime });
    const opened = await service.start({ ownerId, fresh: true });
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

  it("reuses the person's session at 64 tabs and beyond, including concurrent opens", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
    const service = freshService({ keys, repository, runtime });
    const open = () =>
      service.openTab(ownerId, {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        idempotencyKey: randomUUID(),
      });
    const first = await open();
    for (const count of [64, 129]) {
      runtime.publishTabs({
        surfaces: Array.from({ length: count }, (_, index) => ({
          id: `tab-${index}`,
          active: index === 0,
          title: `Tab ${index}`,
          url: "https://example.test/",
        })),
      });
      await vi.waitFor(() =>
        expect(service.clientStreams.source.ports.live(first.sessionId)?.records.size).toBe(count),
      );
      const results = [open(), open()];
      for (const result of results) void result.catch(() => undefined);
      await vi.waitFor(() => expect(repository.tabOpens.size).toBe(count === 64 ? 3 : 5));
      expect(
        [...repository.tabOpens.values()].every(
          (binding) => binding.chosenSessionId === first.sessionId,
        ),
      ).toBe(true);
      for (let index = 0; index < 2; index++) {
        const request = await runtime.nextCommand();
        runtime.sendServer({
          type: "cdp.result",
          requestId: request.requestId,
          result: { tabId: `opened-${count}-${index}` },
        });
      }
      expect(await Promise.all(results)).toEqual([
        expect.objectContaining({ sessionId: first.sessionId, browserStarted: false }),
        expect.objectContaining({ sessionId: first.sessionId, browserStarted: false }),
      ]);
    }
  });

  it("keeps an unanswered additional tab recoverable by its original key", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
    const service = freshService({ keys, repository, runtime });
    const opened = await service.start({ ownerId, fresh: true });
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
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
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
    await expect(service.start({ ownerId, fresh: true })).rejects.toMatchObject({
      code: "runner_offline",
    });
    expect((await repository.listBrowserSessions(ownerId))[0]?.state).toBe("failed");
  });

  it("keeps native profiles on their computer, refuses old runtimes and omits saved site data", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
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
    await expect(service.start({ ownerId, profileId: profile.id })).rejects.toThrow(
      "This computer's profile storage changed. Restore the original storage instance.",
    );
    await expect(
      service.openTab(ownerId, {
        type: "browser.tab.open",
        idempotencyKey: randomUUID(),
        identity: { kind: "profile", profileId: profile.id },
        placement: { kind: "runner", runnerId: relay.runnerId },
      }),
    ).rejects.toMatchObject({
      reason: "browser-tab-open-failed",
      code: "conflict",
    });
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
    ).rejects.toMatchObject({
      reason: "browser-profile-home-unavailable",
      details: { runnerId: relay.runnerId },
    });
  });

  it.each([false, true])(
    "retains the same icon after an agent-only visit and clear/revisit (already present: %s)",
    async (present) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
      });
      const ownerId = createId("user");
      const repository = new MemoryBrowserRepository(ownerId);
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
      const opened = await service.start({ ownerId, profileId: profile.id });
      const peer = new RecordingPeer("history-icons");
      const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
      const favicon = "data:image/png;base64,AAAA";
      const snapshot = async (documentId: string, withIcon: boolean) => {
        const previous = vi.spyOn(service.clientStreams.source, "markTabs");
        runtime.publishTabs({
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
        await vi.waitFor(
          () => expect(previous).toHaveBeenCalledWith(opened.session.id, expect.any(Array)),
          {
            timeout: 1_000,
          },
        );
        previous.mockRestore();
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
      const retained = retainIcon.mock.calls.length;
      const previous = vi.spyOn(service.clientStreams.source, "markTabs");
      runtime.publishTabs({
        surfaces: [
          {
            id: "page-1",
            active: true,
            title: "",
            documentId: "failed",
            favicon,
            navigationFailed: true,
            url: "https://never-loaded.example/",
          },
        ],
      });
      await vi.waitFor(
        () => expect(previous).toHaveBeenCalledWith(opened.session.id, expect.any(Array)),
        {
          timeout: 1_000,
        },
      );
      await service.readHistory(ownerId, profile.id);
      expect(retainIcon).toHaveBeenCalledTimes(retained);
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
      const ownerId = createId("user");
      const repository = new MemoryBrowserRepository(ownerId);
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
      const opened = await service.start({ ownerId, profileId: profile.id });
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
        const previous = vi.spyOn(service.clientStreams.source, "markTabs");
        runtime.publishTabs({
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
        await vi.waitFor(
          () => expect(previous).toHaveBeenCalledWith(opened.session.id, expect.any(Array)),
          {
            timeout: 1_000,
          },
        );
        previous.mockRestore();
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
      const ownerId = createId("user");
      const repository = new MemoryBrowserRepository(ownerId);
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
      runtime.publishTabs({
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
      expect(runtime.lastClaims()?.creationOrigin).toBe(
        path === "agent-start" ? "agent" : "person",
      );
      const navigate = await runtime.nextCommand();
      expect(navigate).toMatchObject({ type: "cdp.command", command: { method: "Page.navigate" } });
      if (path === "agent-start") expect(navigate).not.toHaveProperty("navigationId");
      else expect(navigate.navigationId).toEqual(expect.any(String));
      runtime.publishTabs({
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
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
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
    const opened = await service.start({ ownerId, profileId: profile.id });
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
      const previous = vi.spyOn(service.clientStreams.source, "markTabs");
      const { navigationId, ...surfaceExtra } = extra;
      runtime.publishTabs({
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
      await vi.waitFor(
        () => expect(previous).toHaveBeenCalledWith(opened.session.id, expect.any(Array)),
        {
          timeout: 1_000,
        },
      );
      previous.mockRestore();
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
      const ownerId = createId("user");
      const repository = new MemoryBrowserRepository(ownerId);
      const profile = await repository.createBrowserProfile({ ownerId, name: "History" });

      const recordVisit = vi.fn().mockResolvedValue(true);
      const history = {
        recordVisit,
        list: async () => ({ entries: [], icons: [] }),
      } as unknown as BrowserHistoryStore;
      const service = freshService({ keys, runtime, repository, history });
      const opened = await service.start({ ownerId, profileId: profile.id });
      const peer = new RecordingPeer("person");
      const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
      const agent = await service.attachCdpForAgent(
        { ownerId, sessionId: opened.session.id, agentBindingId: "history-agent" },
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
        const previous = vi.spyOn(service.clientStreams.source, "markTabs");
        runtime.publishTabs({
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
        await vi.waitFor(
          () => expect(previous).toHaveBeenCalledWith(opened.session.id, expect.any(Array)),
          {
            timeout: 1_000,
          },
        );
        previous.mockRestore();
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
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
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
    const opened = await service.start({ ownerId, profileId: profile.id });
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
      const previous = vi.spyOn(service.clientStreams.source, "markTabs");
      runtime.publishTabs({
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
      await vi.waitFor(
        () => expect(previous).toHaveBeenCalledWith(opened.session.id, expect.any(Array)),
        {
          timeout: 1_000,
        },
      );
      previous.mockRestore();
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
      const ownerId = createId("user");
      const repository = new MemoryBrowserRepository(ownerId);
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
      const previous = vi.spyOn(service.clientStreams.source, "markTabs");
      runtime.publishTabs({
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
      await vi.waitFor(
        () => expect(previous).toHaveBeenCalledWith(opened.session.id, expect.any(Array)),
        {
          timeout: 1_000,
        },
      );
      previous.mockRestore();
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
    const ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId);
    const profile = await repository.createBrowserProfile({ ownerId, name: "History" });
    const recordVisit = vi.fn().mockResolvedValue(true);
    const history = {
      recordVisit,
      clear: async () => false,
      list: async () => ({ entries: [], icons: [] }),
    } as unknown as BrowserHistoryStore;
    const service = freshService({ keys, runtime, repository, history });
    const opened = await service.start({ ownerId, profileId: profile.id });
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
    runtime.publishTabs({
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
    runtime.publishTabs({
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
    const repository = new MemoryBrowserRepository(createId("user"));
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
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      editing: true,
      repository: new MemoryBrowserRepository(ownerId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "legacy-copy",
      ownerId,

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
    await send(baseline, { type: "stream.subscribe", surfaceId: "page-1" });
    expect(await runtime.nextCommand()).toMatchObject({
      type: "stream.subscribe",
      surfaceId: "page-1",
    });
    await send(editing, { type: "stream.subscribe", surfaceId: "page-1" });
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
      await send(baseline, { type: "navigation.reload", surfaceId: "page-1" });
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
      const ownerId = createId("user");
      const service = freshService({
        keys,
        runtime,
        editing: version,
        clipboard,
        repository: new MemoryBrowserRepository(ownerId),
      });
      const opened = await service.openAgentSession({
        agentBindingId: `split-${version}-${clipboard}`,
        ownerId,

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
          await attachment.handle(
            Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1" })),
            false,
          );
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
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      editing: 2,
      clipboard: false,
      repository: new MemoryBrowserRepository(ownerId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "editing-routing",
      ownerId,

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
    runtime.publishTabs({
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
    await attachments[1]!.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-download" })),
      false,
    );
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

  it("drops unaddressed copies even when only one viewer sent copy keys", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "unattributed-copy",
      ownerId,

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
    expect(forwarded).toMatchObject({ consumerToken: expect.any(String), targeted: true });
    runtime.sendServer({ type: "clipboard.data", surfaceId: "page-integration", text: "own" });
    await flush([copier, other]);
    expect(copies(copier)).toEqual([]);
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
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "unattributed-newcomer",
      ownerId,

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

  it("targets editing activation and replaces forged consumer identities", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", { editing: true });
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      editing: true,
      repository: new MemoryBrowserRepository(ownerId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "editing-activation",
      ownerId,

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
      expect(key.targeted).toBe(true);
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
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      editing: true,
      repository: new MemoryBrowserRepository(ownerId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "editing-parts",
      ownerId,

      fresh: true,
    });
    const peer = new RecordingPeer("editing-parts");
    const attachment = await service.attach(ownerId, opened.session.id, peer, {
      ...consumerOptions(),
      editing: 1,
    });
    const send = (message: object) =>
      attachment.handle(Buffer.from(JSON.stringify(message)), false);
    await send({ type: "stream.subscribe", surfaceId: "page-1" });
    expect(await runtime.nextCommand()).toMatchObject({
      type: "stream.subscribe",
      surfaceId: "page-1",
    });
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
    await send({ type: "navigation.reload", surfaceId: "page-1" });
    expect(await runtime.nextCommand()).toMatchObject({ type: "navigation.reload" });
    runtime.sendServer({
      type: "clipboard.result",
      operationId,
      surfaceId: "page-1",
      consumerToken: paste.consumerToken,
      outcome: "stale",
    });
    const dialogsBefore = peer.text().filter((m) => m.type === "browser.dialog.changed").length;
    runtime.sendServer({ type: "browser.dialog.changed", surfaceId: "page-1", dialog: null });
    await waitFor(
      () =>
        peer.text().filter((m) => m.type === "browser.dialog.changed").length === dialogsBefore + 1,
    );
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

    const repository = new MemoryBrowserRepository(ownerId);
    let sessionId: BrowserSessionId;
    const groupId = createBrowserSessionId();
    const tabId = BrowserSurfaceIdSchema.parse("page-1");
    const close = vi.fn(async () => ({ groupId }));
    const onSessionsChanged = vi.fn();
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      onSessionsChanged,
      repository,
      connectTimeoutMs: 2000,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({ url: runtime.url }),
      personalTabs: {
        groupIds: async () => [],
        openTabs: async () => [],
        close,
        session: async () => repository.session(sessionId),
        lineageForSession: async () => groupId,
        read: async (_ownerId: UserId, id: BrowserSessionId | readonly BrowserSessionId[]) =>
          Array.isArray(id) ? [] : { id: groupId, tabs: [] },
        suspend: async () => undefined,
      } as unknown as PersonalTabStore,
    });
    cleanups.push(() => service.close());
    sessionId = (await service.start({ fresh: true, ownerId })).session.id;
    const closing = service.closePersonalTab(ownerId, tabId);
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
      runtime.publishTabs({ inventoryRevision: 2, surfaces: [] });
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
    expect((await browserRows(service, ownerId, sessionId)).tabs).toEqual([]);
    expect(onSessionsChanged.mock.calls.some(([, , source]) => source === "browser.tabs")).toBe(
      false,
    );
  });
  it("publishes a page's own title for the same document while its untitled read is still answering", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository: new MemoryBrowserRepository(ownerId),
      connectTimeoutMs: 2_000,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(() => service.close());
    const sessionId = (await service.start({ fresh: true, ownerId })).session.id;
    const tab = async () => (await browserRows(service, ownerId, sessionId)).tabs[0];
    const page = {
      active: true,
      id: "page-1",
      documentId: "document-pay",
      title: "",
      url: "https://site.test/pay",
    };
    // The page commits; its title is not read yet.
    runtime.publishTabs({ surfaces: [page] });
    await vi.waitFor(async () => expect((await tab())?.title).toBe(""));
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
    runtime.publishTabs({
      surfaces: [{ ...page, title: "Automatic context /pay" }],
    });
    await vi.waitFor(async () => expect((await tab())?.title).toBe("Automatic context /pay"));
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
      const ownerId = createId("user");
      const repository = new MemoryBrowserRepository(ownerId);
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
      const opened = await service.start({ ownerId, profileId: profile.id });
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

      const service = new BrowserService({
        ...nativeProfileOptions(),
        ...profileStateOptions,
        repository: new MemoryBrowserRepository(ownerId),
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
      const opened = await service.start({ fresh: true, ownerId });
      expect(runtime.lastClaims()?.navigationVersion).toBe(capable ? 1 : undefined);
      expect(opened.session.navigationVersion).toBe(capable ? 1 : undefined);
      expect(service.clientStreams.source.ports.live(opened.session.id)?.navigation).toBe(capable);
      expect((await browserRows(service, ownerId, opened.session.id)).tabs[0]).toMatchObject(
        capable ? { canGoBack: false, canGoForward: false } : {},
      );
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
      runtime.publishTabs({ surfaces: [surface] });
      await vi.waitFor(async () =>
        expect((await browserRows(service, ownerId, opened.session.id)).tabs[0]?.title).toBe(
          "Next",
        ),
      );
      for (const peer of [control, watch]) {
        expect(peer.textFrames).toHaveLength(1);
        expect(peer.text()[0]).toMatchObject({ type: "browser.snapshot", surfaces: [] });
      }
      const catalog = await browserRows(service, ownerId, opened.session.id);
      expect(catalog.tabs[0]?.canGoBack).toBe(capable);
      expect(catalog.tabs[0]?.canGoForward).toBe(false);
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

      const repository = new MemoryBrowserRepository(ownerId);
      const onSessionsChanged = vi.fn();
      const service = new BrowserService({
        ...nativeProfileOptions(),
        ...profileStateOptions,
        onSessionsChanged,
        repository,
        connectTimeoutMs: 2000,
        signer: new BrowserAttachTicketSigner({
          keyId: "host-primary",
          privateKey: keys.privateKey,
        }),
        targetResolver: runnerTarget({ url: runtime.url, tabRestoreVersion: capable }),
        personalTabs: {
          read: async () => [],
          openTabs: async () => [],
          list: async () => [],
          groupIds: async () => [],
          recordChanges: async (sessionId: BrowserSessionId) => ({
            groupId: sessionId,
            changed: true,
            rows: [],
            closedIds: [],
          }),
          suspend: async () => undefined,
        } as unknown as PersonalTabStore,
      });
      cleanups.push(() => service.close());
      const opened = await service.start({ fresh: true, ownerId });
      expect(runtime.lastClaims()?.tabRestoreVersion).toBe(capable ? 1 : undefined);
      expect(opened.session.tabRestoreVersion).toBe(capable ? 1 : undefined);
      const bootstrap = await service.bootstrap(ownerId);
      expect(bootstrap.tabRestoreVersion).toBe(1);
      if (capable) {
        runtime.publishTabs({
          surfaces: [
            {
              id: "page-1",
              title: "Saved page",
              url: "https://example.com",
              order: 0,
              openerId: null,
              documentId: "document-1",
            },
          ],
          closed: [],
        });
        await vi.waitFor(async () =>
          expect((await browserRows(service, ownerId, opened.session.id)).tabs[0]?.title).toBe(
            "Saved page",
          ),
        );
        expect(
          onSessionsChanged.mock.calls.some(([, , source]) => source === "browser.catalog-flush"),
        ).toBe(false);
      }
    },
  );
  it.each([64, 500])("delivers only the subscribed viewer surface among %s tabs", async (count) => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
      targetControl: true,
    });
    const opened = await service.openAgentSession({
      agentBindingId: "run:viewer-surface",
      ownerId,

      fresh: true,
    });
    const peer = new RecordingPeer("viewer-surface");
    const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    const updates = () =>
      peer.textFrames
        .map(
          (frame) => JSON.parse(frame) as { type: string; surfaceId?: string; surface?: unknown },
        )
        .filter((message) => message.type === "browser.surface");
    await attachment.handle(
      Buffer.from(
        JSON.stringify({
          type: "stream.subscribe",
          surfaceId: "page-1",
        }),
      ),
      false,
    );
    expect(updates()).toMatchObject([
      {
        surfaceId: "page-1",
        surface: { id: "page-1", title: "Example", url: "about:blank" },
      },
    ]);
    const own = { id: "page-1", title: "Example", url: "about:blank" };
    const neighbors = Array.from({ length: count - 2 }, (_, index) => ({
      id: `neighbor-${index}`,
      title: `Page ${index}`,
      url: `https://sibling.example/private/${index}`,
    }));
    runtime.publishTabs({
      surfaces: [
        own,
        { id: "page-2", title: "Private sibling", url: "https://sibling.example/private" },
        ...neighbors,
      ],
    });
    await vi.waitFor(() =>
      expect(
        service.clientStreams.source.ports.live(opened.session.id)?.records.get("page-2")?.title,
      ).toBe("Private sibling"),
    );
    expect(updates()).toHaveLength(1);
    const sibling = {
      id: "page-2",
      title: "Changed sibling",
      url: "https://sibling.example/private",
    };
    const siblingFrames = peer.textFrames.length;
    const bytesBeforeSibling = peer.textFrames.reduce(
      (sum, frame) => sum + Buffer.byteLength(frame),
      0,
    );
    runtime.publishTabs({ surfaces: [own, sibling, ...neighbors] });
    await vi.waitFor(() =>
      expect(
        service.clientStreams.source.ports.live(opened.session.id)?.records.get("page-2")?.title,
      ).toBe("Changed sibling"),
    );
    expect(peer.textFrames).toHaveLength(siblingFrames);
    expect(updates()).toHaveLength(1);
    const siblingTitleBytes =
      peer.textFrames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0) -
      bytesBeforeSibling;
    const bytesBeforeOwn = peer.textFrames.reduce(
      (sum, frame) => sum + Buffer.byteLength(frame),
      0,
    );
    runtime.publishTabs({ surfaces: [{ ...own, title: "Changed" }, sibling, ...neighbors] });
    await vi.waitFor(() => expect(updates()).toHaveLength(2));
    const ownTitleBytes =
      peer.textFrames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0) - bytesBeforeOwn;
    expect(siblingTitleBytes).toBe(0);
    expect(ownTitleBytes).toBeGreaterThan(0);
    await mkdir(editingEvidenceRoot, { recursive: true });
    await writeFile(
      `${editingEvidenceRoot}/viewer-bytes-${count}.json`,
      JSON.stringify({ tabs: count, siblingTitleBytes, ownTitleBytes }),
    );
    const favicon = `data:image/png;base64,${Buffer.alloc(16 * 1024).toString("base64")}`;
    runtime.publishTabs({
      surfaces: [{ ...own, title: "Changed", favicon }, sibling, ...neighbors],
    });
    await vi.waitFor(() => expect(updates()).toHaveLength(3));
    expect(updates()[2]).toMatchObject({
      surfaceId: "page-1",
      surface: { title: "Changed", favicon: null },
    });
    const iconStart = peer.textFrames.length;
    const changes = [
      { title: "New title" },
      { title: "New title", loading: true },
      { title: "New title", loading: true, geometryRevision: 2 },
    ];
    for (const [index, change] of changes.entries()) {
      runtime.publishTabs({ surfaces: [{ ...own, ...change, favicon }, sibling, ...neighbors] });
      await vi.waitFor(() => expect(updates()).toHaveLength(4 + index));
    }
    expect(peer.textFrames.slice(iconStart).join("")).not.toContain(favicon);
    expect(
      peer.textFrames
        .slice(iconStart)
        .reduce((bytes, frame) => bytes + Buffer.byteLength(frame), 0),
    ).toBeLessThan(3 * 1024);
    expect(
      peer.textFrames
        .map((frame) => JSON.parse(frame))
        .filter((message) => message.type === "browser.tab.icon"),
    ).toEqual([
      {
        type: "browser.tab.icon",
        key: createHash("sha256").update(favicon).digest("base64url"),
        favicon,
      },
    ]);
    const replacementIcon = "data:image/png;base64,aWNvbjI=";
    runtime.publishTabs({
      surfaces: [{ ...own, title: "Changed", favicon: replacementIcon }, sibling, ...neighbors],
    });
    await vi.waitFor(() =>
      expect(updates(), "The viewer did not receive its replacement icon.").toHaveLength(7),
    );
    expect(updates()[6]).toMatchObject({ surface: { title: "Changed", favicon: null } });
    expect(JSON.stringify(updates())).not.toContain("sibling.example");
    runtime.publishTabs({ surfaces: [{ id: "page-2", title: "Sibling" }] });
    await vi.waitFor(() =>
      expect(updates().at(-1)).toEqual({
        type: "browser.surface",
        surfaceId: "page-1",
        surface: null,
      }),
    );
    attachment.close();
  });

  it("keeps a tab's bounded last picture across target switches until its document changes", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
    });
    const opened = await service.openAgentSession({
      ownerId,

      fresh: true,
      agentBindingId: "return-picture",
    });
    const own = { id: "page-1", title: "Own", documentId: "document-1", geometryRevision: 0 };
    const sibling = { id: "page-2", title: "Sibling" };
    runtime.publishTabs({ surfaces: [own, sibling] });
    await vi.waitFor(() =>
      expect(
        service.clientStreams.source.ports.live(opened.session.id)?.records.has("page-2"),
      ).toBe(true),
    );
    const peer = new RecordingPeer("return-picture");
    const viewer = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    const select = async (surfaceId: string, previous?: string) => {
      await viewer.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId })),
        false,
      );
      if (previous)
        expect(await runtime.nextCommand()).toMatchObject({
          type: "stream.unsubscribe",
          surfaceId: previous,
        });
      expect(await runtime.nextCommand()).toMatchObject({ type: "stream.subscribe", surfaceId });
    };
    await select("page-1");
    runtime.sendFrame(browserFrame(1));
    await vi.waitFor(() => expect(peer.binaryFrames).toHaveLength(1));
    await select("page-2", "page-1");
    await select("page-1", "page-2");
    await vi.waitFor(() =>
      expect(peer.binaryFrames, "The same document lost its last picture.").toHaveLength(2),
    );
    await select("page-2", "page-1");
    runtime.publishTabs({ surfaces: [{ ...own, documentId: "document-2" }, sibling] });
    await vi.waitFor(() =>
      expect(
        service.clientStreams.source.ports.live(opened.session.id)?.records.get("page-1")
          ?.documentId,
      ).toBe("document-2"),
    );
    await select("page-1", "page-2");
    expect(peer.binaryFrames).toHaveLength(2);
    viewer.close();
  });

  it("coalesces a slow viewer's surface updates", async () => {
    const pending = deferred<void>();
    const peer = new RecordingPeer("slow-surface");
    const send = peer.send.bind(peer);
    peer.send = async (data, binary) => {
      await send(data, binary);
      if (peer.textFrames.length === 1) await pending.promise;
    };
    const outlet = new BrowserConsumerOutlet(
      peer,
      "control",
      async () => true,
      () => {},
    );
    outlet.surfaceId = "page-1";
    outlet.subscription = "control";
    const surface: BrowserViewerSurface = {
      id: BrowserSurfaceIdSchema.parse("page-1"),
      state: "live",
      title: "First",
      url: "https://example.test/private",
      favicon: null,
      documentId: "document",
      geometryRevision: 1,
      loading: false,
      navigationFailed: false,
      sizedByAgent: false,
    };
    try {
      outlet.sendSurface("page-1", surface);
      outlet.sendSurface("page-1", { ...surface, title: "Intermediate" });
      outlet.sendSurface("page-1", { ...surface, title: "Latest" });
      expect(peer.textFrames).toHaveLength(1);
      pending.resolve();
      await vi.waitFor(() => expect(peer.textFrames).toHaveLength(2));
      expect(JSON.parse(peer.textFrames[1]!)).toMatchObject({ surface: { title: "Latest" } });
      outlet.sendSurface("page-1", { ...surface, title: "Latest" });
      expect(peer.textFrames).toHaveLength(2);
      outlet.subscription = null;
      outlet.resetSubscription();
      outlet.sendSurface("page-1", surface);
      expect(peer.textFrames).toHaveLength(2);
    } finally {
      pending.resolve();
      outlet.close();
    }
  });

  it("keeps control targets outside capture capacity and clears a closed target", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
      targetControl: true,
    });
    const opened = await service.openAgentSession({
      agentBindingId: "run:control-capacity",
      ownerId,

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
    runtime.publishTabs({ surfaces });
    await vi.waitFor(() =>
      expect(
        service.clientStreams.source.ports.live(opened.session.id)?.records.has("page-2"),
      ).toBe(true),
    );
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
    runtime.publishTabs({ surfaces: surfaces.slice(0, -1) });
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

    const repository = new MemoryBrowserRepository(ownerId);
    const service = freshService({ keys, repository, runtime, targetControl: true });
    const opened = await service.openAgentSession({
      agentBindingId: "run:native",
      ownerId,

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
    runtime.publishTabs({ surfaces });
    const dialog = {
      id: "00000000-0000-4000-8000-000000000002",
      surfaceId: "page-2",
      type: "alert",
      message: "Second page",
    };
    runtime.sendServer({ type: "browser.dialog.changed", surfaceId: "page-2", dialog });
    runtime.publishTabs({ surfaces });
    await vi.waitFor(() =>
      expect(
        service.clientStreams.source.ports.live(opened.session.id)?.records.has("page-2"),
      ).toBe(true),
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

  it("tells a popup only to the viewer whose input opened it, if it asked to hear", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
      targetControl: true,
    });
    const opened = await service.openAgentSession({
      agentBindingId: "run:popup",
      ownerId,

      fresh: true,
    });
    const attach = async (
      name: string,
      options: { readonly mode?: "control" | "watch"; readonly popups?: boolean },
    ) => {
      const peer = new RecordingPeer(name);
      await service.attach(ownerId, opened.session.id, peer, {
        ...consumerOptions(),
        ...options,
      });
      const snapshot = BrowserServerMessageSchema.parse(peer.text()[0]);
      if (snapshot.type !== "browser.snapshot") throw new Error("Missing snapshot");
      return { peer, token: snapshot.consumerToken };
    };
    const actor = await attach("popup-actor", { popups: true });
    const bystander = await attach("popup-bystander", { popups: true });
    const old = await attach("popup-old", {});
    const watcher = await attach("popup-watch", { mode: "watch", popups: true });
    expect(old.token).toBeUndefined();
    expect(watcher.token).toBeUndefined();

    runtime.sendServer({
      type: "browser.popup.opened",
      surfaceId: "page-2",
      consumerToken: actor.token!,
    });
    const marker = "popup-routing";
    runtime.sendServer({
      type: "browser.error",
      error: { code: "conflict", message: marker, retryable: false },
    });
    const received = ({ peer }: { peer: RecordingPeer }) =>
      peer.text().map((message) => BrowserServerMessageSchema.parse(message));
    for (const viewer of [actor, bystander, old])
      await waitFor(() =>
        received(viewer).some(
          (message) => message.type === "browser.error" && message.error.message === marker,
        ),
      );
    const popups = (viewer: { peer: RecordingPeer }) =>
      received(viewer).filter((message) => message.type === "browser.popup.opened");
    expect(popups(actor)).toEqual([
      { type: "browser.popup.opened", surfaceId: "page-2", consumerToken: actor.token },
    ]);
    expect(popups(bystander)).toEqual([]);
    expect(popups(old)).toEqual([]);
    expect(popups(watcher)).toEqual([]);
  });

  it("clears picture credit when switching the same consumer to control and back", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
      targetControl: true,
    });
    const opened = await service.openAgentSession({
      agentBindingId: "run:switch",
      ownerId,

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
    expect(peer.binaryFrames).toHaveLength(2);
    const replayed = decodeBrowserFrameEnvelope(peer.binaryFrames[1]!).header;
    expect(replayed.frameId).toBe(1);
    expect(replayed.watchToken).not.toBe(
      decodeBrowserFrameEnvelope(peer.binaryFrames[0]!).header.watchToken,
    );
    await send({ type: "stream.ack", token: replayed.watchToken });
    runtime.sendFrame(browserFrame(3));
    await waitFor(() => peer.binaryFrames.length === 3);
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

    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
    });
    const opened = await service.openAgentSession({
      agentBindingId: "run:old-control",
      ownerId,

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

    const repository = new MemoryBrowserRepository(ownerId);
    const service = freshService({ keys, runtime, repository, targetControl: true });
    const opened = await service.openAgentSession({
      agentBindingId: "run:access-control",
      ownerId,

      fresh: true,
    });
    const peer = new RecordingPeer("access-control");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const attachment = await service.attach(ownerId, opened.session.id, peer, consumerOptions());
      for (const frames of [undefined, true, false])
        await expect(
          attachment.handle(
            Buffer.from(JSON.stringify({ type: "stream.subscribe", frames })),
            false,
          ),
        ).rejects.toMatchObject({ code: "bad_request" });
      const watch = await service.attach(
        ownerId,
        opened.session.id,
        new RecordingPeer("watch-control"),
        { ...consumerOptions(), mode: "watch" },
      );
      for (const frames of [undefined, true, false])
        await expect(
          watch.handle(Buffer.from(JSON.stringify({ type: "stream.subscribe", frames })), false),
        ).rejects.toMatchObject({ code: "bad_request" });
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

    const repository = new MemoryBrowserRepository(ownerId);
    const service = freshService({ keys, repository, runtime });
    const opened = await service.openAgentSession({
      agentBindingId: "run:catalog",
      ownerId,

      fresh: true,
    });
    const peer = new RecordingPeer("catalog-metadata");
    await service.attach(ownerId, opened.session.id, peer, consumerOptions());
    runtime.publishTabs({
      surfaces: Array.from({ length: 64 }, (_, index) => ({
        active: index === 0,
        id: `page-${index}`,
        title: "A".repeat(1000),
        url: `https://example.com/${"x".repeat(10000)}?private=value`,
      })),
    });
    await vi.waitFor(() =>
      expect(service.clientStreams.source.ports.live(opened.session.id)?.records.size).toBe(64),
    );
    const catalog = await service.bootstrap(ownerId);
    expect(service.clientStreams.source.ports.live(opened.session.id)?.page).toEqual({
      title: "A".repeat(256),
      url: "https://example.com",
    });
    expect(catalog).not.toHaveProperty("sessions");
    expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThan(128 * 1024);
  });

  async function actorAdmissionFixture(
    options: {
      readonly holdAnswers?: boolean;
      readonly onError?: (error: unknown) => void;
      readonly activityClock?: Clock;
    } = {},
  ) {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const runId = createId("run");
    const threadId = createId("thread");
    const repository = new MemoryBrowserRepository(ownerId);
    const backing: BrowserSessionRepository = repository;
    const service = freshService({
      keys,
      repository,
      runtime,
      actorMetadataTimeoutMs: 25,
      ...(options.activityClock ? { activityClock: options.activityClock } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
    });
    const authority = { agentBindingId: `run:${runId}`, ownerId };
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
        generation: 1,
        lineageThreadIds: [threadId],
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
      const { command } = parsed.data;
      // An attach names its page, as Chromium's answer does.
      const attached =
        command.method === "Target.attachToTarget" &&
        typeof command.parameters?.targetId === "string"
          ? command.parameters.targetId
          : null;
      if (!options.holdAnswers)
        runtime.sendServer({
          type: "cdp.result",
          requestId: parsed.data.requestId,
          result: attached ? { sessionId: `cdp-${attached}`, surfaceId: attached } : {},
        });
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const answer = (requestId: string, result: Record<string, unknown>) =>
      runtime.sendServer({ type: "cdp.result", requestId, result });
    return {
      runtime,
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

  async function runPlaceFixture(activityClock?: Clock) {
    const onError = vi.fn();
    const f = await actorAdmissionFixture({ onError, ...(activityClock ? { activityClock } : {}) });
    vi.useRealTimers();
    vi.spyOn(f.backing, "resolvePlaceActors").mockResolvedValue(f.audience);
    const acknowledge = () =>
      withTimeout(f.cdp.request({ method: "Browser.getVersion" }), 1_000, {
        timeoutError: () => new Error("Runtime did not acknowledge preceding place activity"),
      });
    await acknowledge();
    const actorToken = f.forwarded[0]?.actorToken;
    expect(actorToken).toEqual(expect.any(String));
    f.runtime.publishTabs({
      surfaces: ["page-1", "page-2", "page-3"].map((id, index) => ({
        id,
        active: index === 0,
        title: id,
        url: "https://example.com",
        geometryRevision: 1,
      })),
    });
    await acknowledge();
    let seq = 0;
    return {
      ...f,
      onError,
      record: vi.spyOn(f.backing, "recordRunPlace"),
      activity: async (surfaceId: string) => {
        f.runtime.sendServer({
          type: "browser.activity",
          actorToken,
          surfaceId,
          seq: ++seq,
          geometryRevision: 1,
          pointer: null,
        });
        await acknowledge();
      },
      drain: () =>
        withTimeout(f.service.drainRunPlaces(f.audience[0]!.runId), 1_000, {
          timeoutError: () => new Error("Pending Run place writes did not drain"),
        }),
    };
  }

  it("bounds interleaved activity writes and converges usage on the final surface", async () => {
    const clock = new ManualClock(0);
    const f = await runPlaceFixture(clock);
    f.record.mockImplementation(
      async (input) => ({ type: "place.entered", ...input }) as unknown as AgentEvent,
    );
    const usage = vi.spyOn(f.backing, "recordAgentBrowserUse");
    for (let index = 0; index < 30; index++) await f.activity(`page-${(index % 3) + 1}`);
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(usage.mock.calls.map(([input]) => input.tabId)).toEqual(["page-1", "page-2", "page-3"]);
    clock.advanceBy(1000);
    await f.drain();
    expect(f.record.mock.calls.map(([input]) => input.data.place)).toEqual([
      expect.objectContaining({ surfaceId: "page-1" }),
      expect.objectContaining({ surfaceId: "page-3" }),
    ]);
    expect(usage.mock.calls.map(([input]) => input.tabId)).toEqual([
      "page-1",
      "page-2",
      "page-3",
      "page-3",
    ]);
    f.runtime.publishTabs({
      surfaces: [1, 2, 3].map((index) => ({
        id: `page-${index}`,
        active: index === 1,
        title: index === 2 ? "New page" : `page-${index}`,
        url: "https://example.com",
        geometryRevision: 1,
      })),
    });
    await f.activity("page-2");
    expect(usage).toHaveBeenCalledTimes(5);
    expect(usage.mock.calls.at(-1)?.[0]).toMatchObject({
      tabId: "page-2",
      page: { title: "New page" },
    });
    await f.drain();
    clock.advanceBy(1000);
    await f.activity("page-1");
    await f.drain();
    expect(usage.mock.calls.at(-1)?.[0].tabId).toBe("page-1");
  });

  it("converges usage when a burst returns to its leading place without another place write", async () => {
    const clock = new ManualClock(0);
    const f = await runPlaceFixture(clock);
    const usage = vi.spyOn(f.backing, "recordAgentBrowserUse");
    await f.activity("page-1");
    await f.activity("page-2");
    await f.activity("page-1");
    clock.advanceBy(1000);
    await f.drain();
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(usage.mock.calls.map(([input]) => input.tabId)).toEqual(["page-1", "page-2", "page-1"]);
  });

  it("records native transitions in the browser's Run place lane and ignores activity-ended notices", async () => {
    const clock = new ManualClock(0);
    const f = await runPlaceFixture(clock);
    const actor = f.audience[0]!;
    const native = {
      ...actor,
      place: { kind: "app" as const, machineId: createId("runner"), appKey: "com.apple.Notes" },
      title: "Notes",
      at: Date.now(),
      ended: false,
    };
    await f.activity("page-1");
    clock.advanceBy(1000);
    f.service.beginRunPlace(
      native.runId,
      native.generation,
    )({ place: native.place, title: native.title, site: null });
    f.service.noteNativeActivity(native);
    clock.advanceBy(1000);
    await f.activity("page-1");
    f.service.noteNativeActivity({ ...native, ended: true });
    await f.drain();
    expect(f.record.mock.calls.map(([input]) => input.data.place.kind)).toEqual([
      "browser",
      "app",
      "browser",
    ]);
  });

  it("records a tab the agent switches back to only when its page changed", async () => {
    const f = await runPlaceFixture();
    const usage = vi.spyOn(f.backing, "recordAgentBrowserUse");
    for (const targetId of ["page-1", "page-2", "page-1", "page-2"])
      await f.cdp.request({
        method: "Target.attachToTarget",
        parameters: { targetId, flatten: true },
      });
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(2), { timeout: 1000 });
    await f.cdp.request({ method: "Browser.getVersion" });
    expect(usage.mock.calls.map(([input]) => input.tabId)).toEqual(["page-1", "page-2"]);
  });

  it("credits the settled tab after Stop ends the Run's actor", async () => {
    const clock = new ManualClock(0);
    const f = await runPlaceFixture(clock);
    f.record.mockImplementation(
      async (input) => ({ type: "place.entered", ...input }) as unknown as AgentEvent,
    );
    const usage = vi.spyOn(f.backing, "recordAgentBrowserUse");
    await f.activity("page-1");
    await f.activity("page-2");
    await f.activity("page-1");
    const actor = f.audience[0]!;
    f.service.endRevokedRunActors([{ runId: actor.runId, bindingGeneration: actor.generation }]);
    await f.drain();
    expect(usage.mock.calls.map(([input]) => input.tabId)).toEqual(["page-1", "page-2", "page-1"]);
  });

  it("records no site for a place whose page failed to load, whatever address it shows", async () => {
    const f = await runPlaceFixture();
    f.runtime.publishTabs({
      surfaces: [
        {
          id: "page-1",
          active: true,
          title: "never-loaded.example",
          url: "https://never-loaded.example/",
          geometryRevision: 1,
          navigationFailed: true,
        },
      ],
    });
    await f.activity("page-1");
    await f.drain();
    expect(f.record.mock.calls.at(-1)?.[0]).toMatchObject({
      data: { place: { surfaceId: "page-1" }, site: null },
    });
  });

  it("drains Run places without ending its browser binding or actor", async () => {
    const f = await runPlaceFixture();
    await f.activity("page-1");
    await f.drain();
    expect(f.record).toHaveBeenCalledTimes(1);
    await f.activity("page-2");
    await f.drain();
    expect(f.record).toHaveBeenCalledTimes(2);
    expect(f.record.mock.calls[1]?.[0]).toMatchObject({
      runId: f.audience[0]!.runId,
      data: { place: { surfaceId: "page-2" } },
    });
    expect(
      await f.backing.listActiveBrowserSessionsForAgentBinding(f.authority.agentBindingId),
    ).toHaveLength(1);
    expect(f.forwarded.at(-1)?.actorToken).toBe(f.forwarded[0]?.actorToken);
  });

  it("ends only a revoked Run's actor, without rereading any other", async () => {
    const f = await runPlaceFixture();
    await f.activity("page-1");
    await f.drain();
    const { runId, generation } = f.audience[0]!;
    const token = f.forwarded.at(-1)?.actorToken;
    const reads = vi.mocked(f.backing.resolvePlaceActors).mock.calls.length;

    f.service.endRevokedRunActors([{ runId, bindingGeneration: generation + 1 }]);
    await f.cdp.request({ method: "Browser.getVersion" });
    expect(f.forwarded.at(-1)?.actorToken).toBe(token);
    expect(vi.mocked(f.backing.resolvePlaceActors).mock.calls).toHaveLength(reads);

    vi.mocked(f.backing.resolvePlaceActors).mockResolvedValue([]);
    f.service.endRevokedRunActors([{ runId, bindingGeneration: generation }]);
    await f.cdp.request({ method: "Browser.getVersion" });
    expect(f.forwarded.at(-1)?.actorToken).toBeUndefined();
  });

  it("replaces the actor token when a Run advances to a new binding generation", async () => {
    const f = await runPlaceFixture();
    const previous = f.forwarded.at(-1)?.actorToken;
    await f.activity("page-1");
    await f.drain();
    vi.mocked(f.backing.resolvePlaceActors).mockResolvedValue(
      f.audience.map((actor) => ({ ...actor, generation: actor.generation + 1 })),
    );
    f.service.invalidatePlaceAuthority();
    await f.cdp.request({ method: "Browser.getVersion" });
    const token = f.forwarded.at(-1)?.actorToken;
    expect(token).toEqual(expect.any(String));
    expect(token).not.toBe(previous);
    f.runtime.sendServer({
      type: "browser.activity",
      actorToken: token,
      surfaceId: "page-2",
      seq: 1,
      geometryRevision: 1,
      pointer: null,
    });
    await f.cdp.request({ method: "Browser.getVersion" });
    await f.drain();
    expect(f.record.mock.calls.at(-1)?.[0]).toMatchObject({ bindingGeneration: 2 });
  });

  it("drains rejected pending Run place writes without throwing", async () => {
    const f = await runPlaceFixture();
    const pending = Promise.withResolvers<AgentEvent | undefined>();
    const failure = new Error("place write refused");
    f.record.mockReturnValueOnce(pending.promise);
    await f.activity("page-1");
    expect(f.record).toHaveBeenCalledTimes(1);
    const drained = f.drain();
    const assertion = expect(drained).resolves.toBeUndefined();
    pending.reject(failure);
    await assertion;
    expect(f.onError).toHaveBeenCalledWith(failure);
  });

  it("retries a failed Run place on the next action and gates repeated successful activity", async () => {
    const f = await runPlaceFixture();
    const failure = new Error("place write refused");
    f.record.mockRejectedValueOnce(failure);
    await f.activity("page-1");
    expect(f.onError).toHaveBeenCalledWith(failure);
    await f.activity("page-1");
    expect(f.record).toHaveBeenCalledTimes(2);
    await f.activity("page-1");
    await f.activity("page-1");
    expect(f.record).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer Run place transition when an older pending write fails", async () => {
    const f = await runPlaceFixture();
    const pending = Promise.withResolvers<AgentEvent | undefined>();
    const failure = new Error("old place write refused");
    f.record.mockReturnValueOnce(pending.promise);
    try {
      await f.activity("page-1");
      await f.activity("page-2");
      expect(f.record).toHaveBeenCalledTimes(1);
      pending.reject(failure);
      await f.activity("page-2");
      expect(f.onError).toHaveBeenCalledWith(failure);
      expect(f.record).toHaveBeenCalledTimes(2);
      expect(f.record.mock.calls[1]?.[0]).toMatchObject({
        data: { place: { surfaceId: "page-2" } },
      });
    } finally {
      pending.resolve(undefined);
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

  it("joins binding detachment before closing and admits no detach after close", async () => {
    const repository = new MemoryBrowserRepository(createId("user"));
    const service = freshService({
      keys: generateKeyPairSync("ed25519"),
      repository,
      runtime: { url: new URL("http://127.0.0.1:1") },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lookup = vi
      .spyOn(repository, "listActiveBrowserSessionsForAgentBinding")
      .mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return [];
      });
    const detaching = service.detachAgentSessionsForBinding("run:ending");
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await withTimeout(entered.promise, 1_000, {
        timeoutError: () => new Error("Binding detachment never reached its session lookup"),
      });
      vi.useFakeTimers();
      closing = service.close().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(false);
      await expect(service.detachAgentSessionsForBinding("run:late")).resolves.toEqual([]);
      expect(lookup).toHaveBeenCalledTimes(1);
      release.resolve();
      vi.useRealTimers();
      await withTimeout(Promise.all([detaching, closing]), 1_000, {
        timeoutError: () => new Error("Browser close did not join released detachment"),
      });
      expect(closed).toBe(true);
    } finally {
      release.resolve();
      vi.useRealTimers();
      await withTimeout(Promise.all([detaching, closing, service.close()]), 1_000, {
        timeoutError: () => new Error("Browser detachment cleanup did not settle"),
      });
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

      const runId = createId("run");
      const threadId = createId("thread");
      const repository = new MemoryBrowserRepository(ownerId);
      const service = freshService({ keys, repository, runtime, targetControl: true });
      const authority = { agentBindingId: `run:${runId}`, ownerId };
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
            generation: 1,
            lineageThreadIds: [threadId],
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

    const repository = new MemoryBrowserRepository(ownerId);
    const announced: BrowserSessionId[][] = [];
    const usage: BrowserUsageCredit[] = [];
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
      targetResolver: runnerTarget({ url: runtime.url }),
      onSessionsChanged: (id) => announced.push([...id]),
      onUsageChanged: (credits) => usage.push(...credits),
    });
    cleanups.push(async () => service.close());
    const authority = { agentBindingId: "run:revisit", ownerId };
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
    expect(usage).toEqual([{ joined: false, threadId: "thr_run:revisit" }]);
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

    const repository = new MemoryBrowserRepository(ownerId);
    const service = freshService({ keys, repository, runtime, sharedControl: false });
    const authority = { agentBindingId: "run:old-browser", ownerId };
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

    const repository = new MemoryBrowserRepository(ownerId);
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
    const recordsBeforePublish = vi.spyOn(service.clientStreams.source, "markTabs");
    runtime.publishTabs({
      surfaces: [
        {
          active: true,
          id: "page-1",
          title: "Example",
          url: "about:blank",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(recordsBeforePublish).toHaveBeenCalledWith(started.session.id, expect.any(Array)),
    );
    recordsBeforePublish.mockRestore();
    expect(peer.binaryFrames).toHaveLength(0);
    await attachment.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1" })),
      false,
    );
    await expect(runtime.nextCommand()).resolves.toMatchObject({ type: "stream.subscribe" });

    runtime.sendFrame(browserFrame(2));
    await waitFor(() => peer.binaryFrames.length === 1);
    expect(peer.binaryFrames[0]?.subarray(-4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const authority = { agentBindingId: "run:test", ownerId };
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
    const secondAuthority = { agentBindingId: "run:second", ownerId };
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
    await service.detachAgentSessionsForBinding(secondAuthority.agentBindingId);
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
    await slowAttachment.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1" })),
      false,
    );
    await waitFor(() => slowPeer.binaryFrames.length === 1);
    runtime.sendFrame(browserFrame(3));
    runtime.sendFrame(browserFrame(4));
    runtime.sendFrame(browserFrame(5));
    const textFrameCount = vi.spyOn(service.clientStreams.source, "markTabs");
    runtime.publishTabs({
      surfaces: [
        {
          active: true,
          id: "page-1",
          title: "Example",
          url: "about:blank",
        },
      ],
    });
    // The tab commit follows the pictures on the same Runtime socket.
    await vi.waitFor(() =>
      expect(textFrameCount).toHaveBeenCalledWith(started.session.id, expect.any(Array)),
    );
    textFrameCount.mockRestore();
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

  it("gives late viewers only their selected page's current metadata", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
      targetControl: true,
    });
    const started = await service.start({ fresh: true, ownerId });
    runtime.publishTabs({
      surfaces: [
        { id: "page-1", title: "Private sibling", url: "https://sibling.example/private" },
        { id: "page-2", active: true, title: "Account", url: "https://account.example/current" },
      ],
    });
    await vi.waitFor(() =>
      expect(service.clientStreams.source.ports.live(started.session.id)?.records.size).toBe(2),
    );
    const dialog = {
      id: "00000000-0000-4000-8000-0000000000d1",
      message: "Continue?",
      surfaceId: "page-2",
      type: "confirm",
    };
    runtime.sendServer({ type: "browser.dialog.changed", surfaceId: "page-2", dialog });
    const peer = new RecordingPeer("late");
    const attachment = await service.attach(ownerId, started.session.id, peer, consumerOptions());
    expect(peer.text()[0]).toMatchObject({ type: "browser.snapshot", surfaces: [] });
    await attachment.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-2", frames: false })),
      false,
    );
    await vi.waitFor(() =>
      expect(peer.text()).toContainEqual({
        type: "browser.dialog.changed",
        surfaceId: "page-2",
        dialog,
      }),
    );
    expect(peer.text()).toContainEqual(
      expect.objectContaining({
        type: "browser.surface",
        surfaceId: "page-2",
        surface: expect.objectContaining({
          title: "Account",
          url: "https://account.example/current",
        }),
      }),
    );
    expect(JSON.stringify(peer.text())).not.toContain("sibling.example");
    runtime.sendServer({ type: "browser.dialog.changed", surfaceId: "page-2", dialog: null });
    await vi.waitFor(() =>
      expect(peer.text().at(-1)).toMatchObject({ type: "browser.dialog.changed", dialog: null }),
    );
    const next = new RecordingPeer("later");
    const later = await service.attach(ownerId, started.session.id, next, consumerOptions());
    await later.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-2", frames: false })),
      false,
    );
    expect(next.text()).toContainEqual({
      type: "browser.dialog.changed",
      surfaceId: "page-2",
      dialog: null,
    });
  });

  it("admits a viewer only while its login is signed in, and lets go of one whose access cannot be read", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
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
    const started = await service.start({ fresh: true, ownerId });

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

  it("announces sessions whenever a Browser Session appears or changes state", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
    const announced: BrowserSessionId[][] = [];
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      connectTimeoutMs: 2_000,
      onSessionsChanged: (id) => announced.push([...id]),
      repository,
      signer: new BrowserAttachTicketSigner({
        keyId: "host-primary",
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerTarget({ url: runtime.url }),
    });
    cleanups.push(async () => service.close());

    const started = await service.start({ fresh: true, ownerId });
    // The row appearing, then the Runtime reporting the session ready.
    expect(announced).toEqual([[started.session.id], [started.session.id]]);

    announced.length = 0;
    await service.stop(ownerId, started.session.id);

    expect(repository.session(started.session.id)?.state).toBe("closed");
    expect(announced).toEqual([[started.session.id], [started.session.id]]);
  });

  it("holds an early viewer until the Runtime publishes its authoritative snapshot", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      deferInitialSnapshot: true,
    });
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
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
    const starting = service.start({ fresh: true, ownerId });
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

  it.each(["event before snapshot", "missing targeted streaming"] as const)(
    "rejects a Runtime with %s",
    async (invalid) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(
        keys.publicKey,
        "host-primary",
        invalid === "event before snapshot"
          ? { beforeInitialSnapshot: [{ state: "closing", type: "browser.status" }] }
          : { targetedStreaming: false },
      );
      const ownerId = createId("user");

      const repository = new MemoryBrowserRepository(ownerId);
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

      await expect(service.start({ fresh: true, ownerId })).rejects.toMatchObject({
        code: "runner_offline",
      });
      expect(await repository.listBrowserSessions(ownerId)).toEqual([
        expect.objectContaining({ state: "failed" }),
      ]);
    },
  );

  it("rejects a Runtime snapshot whose dialog references an unknown surface", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      initialDialog: { message: "Continue?", surfaceId: "page-missing", type: "confirm" },
    });
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
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

    await expect(service.start({ fresh: true, ownerId })).rejects.toMatchObject({
      code: "runner_offline",
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

    const repository = new MemoryBrowserRepository(ownerId);
    const profile = repository.addHostedProfile("Client account");
    const target = runnerTarget({ url: runtime.url });
    const stale = await repository.createBrowserSession({
      id: createBrowserSessionId(),
      origin: "person",
      placementKey: `runner:${target.runnerId}:runtime-1`,
      profileId: profile.id,
      runnerId: target.runnerId,
      runtimeId: "runtime-1",
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
      service.start({ fresh: true, initialUrl: "file:///etc/passwd", ownerId }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("deduplicates browser access only by Run call identity and returns one uniform result", async () => {
    const home = testRunner({});
    const keys = generateKeyPairSync("ed25519");
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
    const events: AgentEvent[] = [];
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      onDeploymentEvent: (event) => {
        events.push(event);
      },
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });
    const request = {
      callId: "browser-access-unit-request",

      ownerId,
      reason: "Sign in to the client portal",
      runId: createId("run"),
      suggestion: { kind: "new", suggestedName: "Client portal" } as const,
      threadId: createId("thread"),
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
      value: {
        createProfile: { name: "Client portal", homeRunnerId: home.runnerId },
        decision: "fulfilled",
      },
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
    await expect(service.listAgentProfiles(ownerId)).resolves.toEqual([
      {
        id: resolved.profile?.id,
        name: "Client portal",
        home: null,
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

  it("declines new-profile consent without creating a profile", async () => {
    const keys = generateKeyPairSync("ed25519"),
      ownerId = createId("user"),
      repository = new MemoryBrowserRepository(ownerId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });
    const request = {
      callId: "browser-access-decline",
      ownerId,
      reason: "Sign in to the client portal",
      runId: createId("run"),
      suggestion: { kind: "new", suggestedName: "Client portal" } as const,
      threadId: createId("thread"),
    };
    const pending = await service.requestAccess(request);
    const response = { kind: "external", value: { decision: "declined" } } as const;
    expect(
      await service.resolveRequest({ requestId: pending.requestId, resolvedBy: ownerId, response }),
    ).toMatchObject({ profile: null, request: { response, status: "declined" } });
    await expect(service.listAgentProfiles(ownerId)).resolves.toEqual([]);
    await expect(service.requestAccess(request)).resolves.toEqual({
      ...pending,
      replayed: true,
      status: "declined",
    });
  });

  it("asks to create a profile and refuses redundant consent for an owned profile", async () => {
    const keys = generateKeyPairSync("ed25519"),
      ownerId = createId("user"),
      repository = new MemoryBrowserRepository(ownerId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });
    const request = {
      callId: "browser-access-new",
      ownerId,
      reason: "Sign in to the client portal",
      runId: createId("run"),
      suggestion: { kind: "new", suggestedName: "Client portal" } as const,
      threadId: createId("thread"),
    };
    await expect(service.requestAccess(request)).resolves.toMatchObject({
      kind: "browser.access",
      status: "pending",
    });
    const owned = repository.addHostedProfile("Personal");
    await expect(
      service.requestAccess({
        ...request,
        callId: "owned",
        suggestion: { kind: "existing", profileId: owned.id },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      service.requestAccess({
        ...request,
        callId: "advisory",
        suggestion: { kind: "existing", profileId: createId("browserProfile") },
      }),
    ).resolves.toMatchObject({ kind: "browser.access", status: "pending" });
  });

  it("keeps a worst-case maximum browser catalog below the serialized bootstrap ceiling", async () => {
    const keys = generateKeyPairSync("ed25519");
    const ownerId = createId("user");

    const repository = new MaximumBrowserCatalogRepository(ownerId, 128);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });

    const bootstrap = await service.bootstrap(ownerId);
    expect(bootstrap.profiles).toHaveLength(128);
    expect(bootstrap).not.toHaveProperty("sessions");
    expect(bootstrap).not.toHaveProperty("personalTabs");
    expect(Buffer.byteLength(JSON.stringify(bootstrap), "utf8")).toBeLessThanOrEqual(
      1 * 1_024 * 1_024,
    );
    expect(Buffer.byteLength(JSON.stringify(bootstrap), "utf8")).toBeGreaterThan(10 * 1_024);

    const overflow = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository: new MaximumBrowserCatalogRepository(ownerId, 129),
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });
    await expect(overflow.bootstrap(ownerId)).rejects.toMatchObject({ code: "conflict" });
  });

  it("requires profile ownership before raw CDP reaches a Runtime", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
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
    const authority = { agentBindingId: "run:runner-test", ownerId };
    await expect(
      service.openAgentSession({
        ...authority,
        ownerId: createId("user"),
        environmentId,
        profileId: profile.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(runtime.connectionCount()).toBe(0);

    const visible = await service.start({ ownerId, profileId: profile.id });
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

    const environmentId = createId("environment");
    const bound = testRunner({ environmentIds: [environmentId] });
    const service = placementService({
      keys,
      ownerId,
      runners: [bound, testRunner({})],
      runtime,
    });

    const opened = await service.openAgentSession({
      agentBindingId: "run:bound-environment",
      environmentId,
      fresh: true,
      ownerId,
    });

    expect(opened.session.placement).toEqual({ kind: "runner", runnerId: bound.runnerId });
  });

  it("requires an explicit choice when two computers run the same work location", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const environmentId = createId("environment");
    const first = testRunner({ environmentIds: [environmentId] });
    const second = testRunner({ environmentIds: [environmentId] });
    const service = placementService({
      keys,
      ownerId,
      runners: [first, second],
      runtime,
    });

    await expect(
      service.openAgentSession({
        agentBindingId: "run:ambiguous-binding",
        environmentId,
        fresh: true,
        ownerId,
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

    const runEnvironmentId = createId("environment");
    const chosenEnvironmentId = createId("environment");
    const here = testRunner({ environmentIds: [runEnvironmentId] });
    const there = testRunner({ environmentIds: [chosenEnvironmentId] });
    const service = placementService({
      keys,
      ownerId,
      runners: [here, there],
      runtime,
    });

    const opened = await service.openAgentSession({
      agentBindingId: "run:chosen-machine",
      chosenEnvironmentId,
      environmentId: runEnvironmentId,
      fresh: true,
      ownerId,
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

    const browserEnvironmentId = createId("environment");
    const withBrowser = testRunner({ environmentIds: [browserEnvironmentId] });
    const service = placementService({
      keys,
      ownerId,
      runners: [withBrowser],
      runtime,
    });

    await expect(
      service.openAgentSession({
        agentBindingId: "run:headless-machine",
        chosenEnvironmentId: createId("environment"),
        fresh: true,
        ownerId,
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
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message:
        "An existing Browser Session already runs on a computer, so attaching to it cannot choose one.",
    });
  });

  it.each(["guest", "legacy"] as const)(
    "refuses an agent %s on the only browser when it runs no agents",
    async (identity) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
      });
      const ownerId = createId("user");

      const runner = testRunner({ agents: false });
      const repository = new MemoryBrowserRepository(ownerId);
      const profile = repository.addHostedProfile("Legacy");

      const service = placementService({
        keys,
        ownerId,

        runtime,
        repository,
        runners: [runner],
      });
      await expect(
        service.openAgentSession({
          agentBindingId: "run:guest",
          ownerId,

          ...(identity === "guest" ? { fresh: true as const } : { profileId: profile.id }),
        }),
      ).rejects.toMatchObject({ code: "runner_offline" });
      expect(runtime.connectionCount()).toBe(0);
    },
  );

  it.each(["person", "agent"] as const)(
    "opens a homed profile on a browser-only device for a %s",
    async (caller) => {
      const keys = generateKeyPairSync("ed25519");
      const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
        targetedStreaming: true,
      });
      const ownerId = createId("user");

      const environmentId = createId("environment");
      const home = testRunner({ agents: false });
      const agent = testRunner({ environmentIds: [environmentId] });
      const repository = new MemoryBrowserRepository(ownerId);
      const profile = repository.addHostedProfile("Work", home.runnerId);

      const service = placementService({
        keys,
        ownerId,

        repository,
        runtime,
        runners: [home, agent],
      });
      const opened =
        caller === "agent"
          ? await service.openAgentSession({
              agentBindingId: "run:home",
              ownerId,

              profileId: profile.id,
              chosenEnvironmentId: environmentId,
            })
          : await service.openTab(ownerId, {
              type: "browser.tab.open",
              identity: { kind: "profile", profileId: profile.id },
              idempotencyKey: "home",
              placement: { kind: "runner", runnerId: agent.runnerId },
            });
      expect(opened.session.placement).toEqual({ kind: "runner", runnerId: home.runnerId });
      if (caller === "agent") {
        const attachment = await service.attachCdpForAgent(
          { agentBindingId: "run:home", ownerId },
          () => undefined,
        );
        for (const method of ["Opensteer.fillLogin", "Opensteer.fillCard"]) {
          await expect(
            withTimeout(
              attachment.request({ method, parameters: { loginRef: "ref", cardRef: "ref" } }),
              1_000,
              { timeoutError: () => new Error("Off-main fill was not refused") },
            ),
          ).resolves.toEqual({ status: "unavailable", reason: "main-browser-required" });
        }
        attachment.close();
      }
    },
  );

  it("names an offline profile home without falling back to a connected browser", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const home = testRunner({});
    const other = testRunner({});
    const repository = new MemoryBrowserRepository(ownerId);
    const profile = repository.addHostedProfile("Work", home.runnerId);

    const service = placementService({
      keys,
      ownerId,

      repository,
      runtime,
      runners: [other],
    });
    const refusal = {
      reason: "browser-profile-home-unavailable",
      message: expect.stringContaining(`Computer ${home.runnerId}`),
      details: { runnerId: home.runnerId, name: `Computer ${home.runnerId}` },
    };
    await expect(
      service.openAgentSession({
        agentBindingId: "run:offline",
        ownerId,

        profileId: profile.id,
      }),
    ).rejects.toMatchObject(refusal);
    await expect(
      service.openTab(ownerId, {
        type: "browser.tab.open",
        identity: { kind: "profile", profileId: profile.id },
        idempotencyKey: "offline",
      }),
    ).rejects.toMatchObject(refusal);
    expect(runtime.connectionCount()).toBe(0);
  });

  it("uses Personal Main for a person's Guest unless they choose an eligible browser device", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const main = testRunner({});
    const phone = testRunner({ agents: false });
    const repository = new MemoryBrowserRepository(ownerId);
    repository.mainRunnerId = main.runnerId;
    const runners = [main, phone];
    const service = placementService({
      keys,
      ownerId,

      runtime,
      repository,
      runners,
      personal: true,
    });
    const open = (idempotencyKey: string, runnerId?: RunnerId) =>
      service.openTab(ownerId, {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        idempotencyKey,
        ...(runnerId ? { placement: { kind: "runner" as const, runnerId } } : {}),
      });
    expect((await open("main-guest")).session.placement).toEqual({
      kind: "runner",
      runnerId: main.runnerId,
    });
    expect((await open("phone-guest", phone.runnerId)).session.placement).toEqual({
      kind: "runner",
      runnerId: phone.runnerId,
    });
    runners.splice(0, 1);
    await expect(open("offline-main")).rejects.toMatchObject({
      reason: "browser-placement-unavailable",
    });
    expect(runtime.connectionCount()).toBe(2);
  });

  it("falls back to the only connected computer and refuses to guess between many", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");
    const only = testRunner({ environmentIds: [createId("environment")] });

    const sole = placementService({
      keys,
      ownerId,
      runners: [only],
      runtime,
    });
    await expect(sole.start({ fresh: true, ownerId })).resolves.toMatchObject({
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
      }),
    ).resolves.toMatchObject({
      session: { placement: { kind: "runner", runnerId: only.runnerId } },
    });

    const conflict = placementService({
      keys,
      ownerId,
      runners: [only, testRunner({})],
      runtime,
    });
    await expect(conflict.start({ fresh: true, ownerId })).rejects.toMatchObject({
      code: "conflict",
    });

    const unavailable = placementService({
      keys,
      ownerId,
      runners: [],
      runtime,
    });
    await expect(unavailable.start({ fresh: true, ownerId })).rejects.toMatchObject({
      code: "runner_offline",
    });
  });

  it("does not route a chosen incompatible browser to another computer", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

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
      }),
    ).rejects.toMatchObject({ code: "runner_offline", message: reason });
    await expect(
      service.start({
        fresh: true,
        ownerId,
        placement: { kind: "runner", runnerId: outdated.runnerId },
      }),
    ).rejects.toMatchObject({ code: "runner_offline", message: reason });
    expect(runtime.connectionCount()).toBe(0);
  });

  it("keeps established session and profile placement ahead of explicit environments", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const environmentId = createId("environment");
    const repository = new MemoryBrowserRepository(ownerId);
    const profile = repository.addHostedProfile("Established profile");

    const established = testRunner({});
    const bound = testRunner({ environmentIds: [environmentId] });
    const service = placementService({
      keys,
      ownerId,
      repository,
      runners: [established, bound],
      runtime,
    });

    const initial = await service.start({
      ownerId,
      placement: { kind: "runner", runnerId: established.runnerId },
      profileId: profile.id,
    });
    const reused = await service.start({
      ownerId,

      profileId: profile.id,
      reuseExisting: true,
      placement: { kind: "runner", runnerId: bound.runnerId },
    });
    expect(reused.session.id).toBe(initial.session.id);
    const profileOpen = await service.openAgentSession({
      agentBindingId: "run:profile-affinity",
      chosenEnvironmentId: environmentId,
      environmentId,
      ownerId,
      profileId: profile.id,
    });
    expect(profileOpen.session.placement).toEqual({
      kind: "runner",
      runnerId: established.runnerId,
    });

    const existing = await service.start({
      fresh: true,
      ownerId,
      placement: { kind: "runner", runnerId: established.runnerId },
    });
    const reattached = await service.openAgentSession({
      agentBindingId: "run:session-affinity",
      environmentId,
      ownerId,
      sessionId: existing.session.id,
    });
    expect(reattached.session).toMatchObject({
      id: existing.session.id,
      placement: { kind: "runner", runnerId: established.runnerId },
    });
  });

  it("never reuses a person session on a different profile", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
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
    await service.start({ ownerId, profileId: userOnly.id });

    const agent = await service.openAgentSession({
      agentBindingId: "run:isolation-test",
      ownerId,
      profileId: granted.id,
    });
    expect(agent.session).toMatchObject({ profileId: granted.id });
    expect(agent.session.id).not.toBe(
      (await repository.findActiveBrowserSessionForPerson(ownerId))?.id,
    );
    expect(runtime.connectionCount()).toBe(2);
  });

  it("stops a deleted profile's sessions, tells the owner's devices and never starts it again", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
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
    const { session } = await service.start({ ownerId, profileId: profile.id });

    await service.deleteProfile({ ownerId, profileId: profile.id });

    expect(repository.session(session.id)?.state).toBe("closed");
    expect(onProfilesChanged).toHaveBeenCalledWith(ownerId);
    await expect(service.start({ ownerId, profileId: profile.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("opens a fresh agent session with no profile, no grant, and no lease", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
    const service = freshService({ keys, repository, runtime });

    const authority = { agentBindingId: "run:fresh", ownerId };
    await expect(service.listAgentProfiles(ownerId)).resolves.toEqual([]);
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
    const profile = repository.addHostedProfile("Client portal");
    const backed = await service.openAgentSession({ ...authority, profileId: profile.id });
    expect(backed.session.id).not.toBe(opened.session.id);
    expect(backed.session.profileId).toBe(profile.id);
  });

  it("requires exactly one identity when an agent opens a Browser Session", async () => {
    const keys = generateKeyPairSync("ed25519");
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
    const service = new BrowserService({
      ...nativeProfileOptions(),
      ...profileStateOptions,
      repository,
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: keys.privateKey }),
    });
    const authority = { agentBindingId: "run:identity", ownerId };
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

  it("shares a personal session across its owner's tasks and refuses another owner", async () => {
    const keys = generateKeyPairSync("ed25519"),
      runtime = await startFakeRuntime(keys.publicKey, "host-primary", { targetedStreaming: true }),
      ownerId = createId("user");
    const repository = new MemoryBrowserRepository(ownerId),
      service = freshService({ keys, repository, runtime });
    const opened = await service.openAgentSession({
      agentBindingId: "run:owner",
      fresh: true,
      ownerId,
    });
    const otherOwner = createId("user");
    await expect(
      service.openAgentSession({
        agentBindingId: "run:foreign",
        ownerId: otherOwner,
        sessionId: opened.session.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.listAgentSessions({ agentBindingId: "run:foreign", ownerId: otherOwner }),
    ).resolves.toEqual([]);
    await expect(
      service.openAgentSession({
        agentBindingId: "run:another-task",
        ownerId,
        sessionId: opened.session.id,
      }),
    ).resolves.toMatchObject({ session: { id: opened.session.id, profileName: null } });
    await expect(
      service.listAgentSessions({ agentBindingId: "run:another-task", ownerId }),
    ).resolves.toEqual([expect.objectContaining({ id: opened.session.id, profileName: null })]);
  });

  it("keeps a person session's identity immutable across reuse", async () => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
      targetedStreaming: true,
    });
    const ownerId = createId("user");

    const repository = new MemoryBrowserRepository(ownerId);
    const service = freshService({ keys, repository, runtime });
    const profile = repository.addHostedProfile("Client portal");

    const fresh = await service.start({ fresh: true, ownerId });
    expect(fresh.session.profileId).toBeNull();
    await expect(
      service.start({ fresh: true, ownerId, reuseExisting: true }),
    ).resolves.toMatchObject({
      session: { id: fresh.session.id },
      wasExisting: true,
    });
    await expect(
      service.start({ ownerId, profileId: profile.id, reuseExisting: true }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This browser is using a signed-out browser session.",
    });

    await service.stop(ownerId, fresh.session.id);
    const backed = await service.start({ ownerId, profileId: profile.id });
    expect(backed.session.profileId).toBe(profile.id);
    await expect(
      service.start({ fresh: true, ownerId, reuseExisting: true }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This browser is using a browser profile.",
    });
  });
});

function freshService(options: {
  readonly surfaceState?: boolean | undefined;
  readonly tabRestoreVersion?: boolean;
  readonly history?: BrowserHistoryStore;
  readonly navigationAttribution?: boolean;
  readonly onHistoryChanged?: (ownerId: UserId, profileId: BrowserProfileId) => void;
  readonly onError?: (error: unknown) => void;
  readonly passkeysEnabled?: boolean;
  readonly passkeys?: boolean;
  readonly personFill?: PersonFillVersion | undefined;
  readonly personal?: boolean;
  readonly sharedControl?: boolean;
  readonly targetControl?: boolean;
  readonly rasterDemand?: boolean;
  readonly editing?: boolean | 1 | 2 | undefined;
  readonly clipboard?: boolean | undefined;
  readonly actorMetadataTimeoutMs?: number;
  readonly activityClock?: Clock;
  readonly keys: { readonly privateKey: KeyObject };
  readonly onDeploymentEvent?: (event: AgentEvent) => void;
  readonly repository: MemoryBrowserRepository;
  readonly runtime: { readonly url: URL };
  readonly personalTabs?: PersonalTabStore;
}): BrowserService {
  const service = new BrowserService({
    ...(options.personalTabs ? { personalTabs: options.personalTabs } : {}),
    ...nativeProfileOptions(),
    passkeys: options.passkeysEnabled === true,
    personal: options.personal === true,
    ...profileStateOptions,
    ...(options.history ? { history: options.history } : {}),
    ...(options.onHistoryChanged ? { onHistoryChanged: options.onHistoryChanged } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    connectTimeoutMs: 2_000,
    ...(options.activityClock ? { activityClock: options.activityClock } : {}),
    ...(options.actorMetadataTimeoutMs === undefined
      ? {}
      : {
          actorMetadataTimeoutMs: options.actorMetadataTimeoutMs,
        }),
    ...(options.onDeploymentEvent ? { onDeploymentEvent: options.onDeploymentEvent } : {}),
    repository: options.repository,
    signer: new BrowserAttachTicketSigner({
      keyId: "host-primary",
      privateKey: options.keys.privateKey,
    }),
    targetResolver: runnerTarget({
      url: options.runtime.url,
      surfaceState: options.surfaceState,
      tabRestoreVersion: options.tabRestoreVersion ?? false,
      navigationAttributionVersion: options.navigationAttribution ?? options.history !== undefined,
      sharedControl: options.sharedControl ?? true,
      targetControl: options.targetControl ?? false,
      rasterDemand: options.rasterDemand ?? false,
      passkeys: options.passkeys === true,
      personFill: options.personFill,
      editing: options.editing,
      clipboard: options.clipboard,
    }),
  });
  cleanups.push(async () => service.close());
  return service;
}

interface TestBrowserRunner {
  readonly agents?: boolean;
  readonly environmentIds: readonly EnvironmentId[];
  readonly runnerId: RunnerId;
  readonly runtimeId: string;
  readonly unavailableReason?: string;
}

/** One enrolled computer offering a browser, bound to the work locations it runs. */
function testRunner(input: {
  readonly agents?: boolean;
  readonly environmentIds?: readonly EnvironmentId[];
  readonly unavailableReason?: string;
}): TestBrowserRunner {
  const runnerId = createId("runner");
  eligibleRunners.set(runnerId, `Computer ${runnerId}`);
  return {
    agents: input.agents ?? true,
    environmentIds: [...(input.environmentIds ?? [])],
    runnerId,
    runtimeId: `browser-${runnerId}`,
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
  };
}

function placementService(options: {
  readonly personal?: boolean;
  readonly keys: { readonly privateKey: KeyObject };
  readonly ownerId: UserId;
  readonly repository?: MemoryBrowserRepository;
  readonly runners: readonly TestBrowserRunner[];
  readonly runtime: { readonly url: URL };
}): BrowserService {
  // Every Runner here shares one fake runtime socket: placement is what these
  // tests are about, not what happens after the browser answers.
  const relay = runnerTarget({ url: options.runtime.url });
  const targetResolver: BrowserRuntimeTargetResolver = {
    placements: () =>
      options.runners.map((runner) => ({
        agents: runner.agents === true,
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
          code: "runner_offline",
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
    personal: options.personal === true,
    repository: options.repository ?? new MemoryBrowserRepository(options.ownerId),
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
  },
): Promise<readonly BrowserSessionId[]> {
  return (await service.listAgentSessions(authority))
    .filter((session) => session.attached)
    .map((session) => session.id);
}

class MemoryBrowserRepository implements BrowserSessionRepository {
  async resolveResourceAccess() {
    return { specialistAllowed: true };
  }
  mainRunnerId: RunnerId | undefined;
  rememberedPlacement: RunnerId | null = null;
  async listEligibleBrowserRunners(): ReturnType<
    BrowserSessionRepository["listEligibleBrowserRunners"]
  > {
    return [...eligibleRunners].map(([id, name]) => ({
      id,
      name,
      kind: id === this.mainRunnerId ? ("main" as const) : ("local" as const),
      ownerKind: "user" as const,
      ownerUserId: null,
      allowedModules: ["browser" as const],
    }));
  }
  readonly tabOpens = new Map<string, import("@opensteer/protocol").BrowserTabOpenBinding>();

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
    return this.rememberedPlacement;
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
    return joined || created ? [{ joined, threadId }] : [];
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
    }
  >();

  readonly #ownerId: UserId;

  readonly #profiles = new Map<BrowserProfileId, BrowserProfileRecord>();
  readonly #deletedProfiles = new Set<BrowserProfileId>();
  readonly #sessions = new Map<BrowserSessionId, BrowserSessionRecord>();

  constructor(ownerId: UserId) {
    this.#ownerId = ownerId;
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

        payload: input.payload,
        presentation: input.presentation,
        requestedBy: input.requestedBy,
        requiredActor: input.requiredActor,
        resolvedAt: null,
        resolvedBy: null,
        response: null,
        status: "pending",
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

      this.#requests.set(request.id, request);
      return {
        events: [this.#requestEvent(request)],
        profile,
        request,
      };
    },
  };

  addHostedProfile(name: string, homeRunnerId?: RunnerId): BrowserProfileRecord {
    const profile = {
      id: createId("browserProfile"),
      name,
      ownerId: this.#ownerId,
      ...(homeRunnerId ? { homeRunnerId } : {}),
    };
    this.#profiles.set(profile.id, profile);
    return profile;
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

  async listActiveBrowserSessionsForAgent(input: { readonly ownerId: UserId }) {
    return [...this.#sessions.values()]
      .filter((session) => input.ownerId === this.#ownerId && !terminal(session.state))
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

  async createBrowserSession(input: {
    readonly id: BrowserSessionId;
    readonly placementKey: string;
    readonly runnerId: RunnerId;
    readonly origin: "agent" | "trigger" | "person";
    readonly opener?: BrowserSessionRecord["opener"];
    readonly profileId: BrowserProfileId | null;
    readonly runtimeId: string;
  }): Promise<BrowserSessionRecord> {
    const now = new Date();
    const record: BrowserSessionRecord = {
      createdAt: now,
      id: input.id,
      opener: input.opener ?? null,
      origin: input.origin,
      placementKey: input.placementKey,
      profileId: input.profileId,
      runnerId: input.runnerId,
      runtimeId: input.runtimeId,
      state: "starting",
      updatedAt: now,
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
  }): Promise<boolean> {
    const key = `${input.agentBindingId}\u0000${input.sessionId}`;
    const created = !this.#attachments.has(key);
    this.#attachments.delete(key);
    this.#attachments.set(key, {
      agentBindingId: input.agentBindingId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
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

  async findActiveBrowserSessionForPerson(ownerId: UserId): Promise<BrowserSessionRecord | null> {
    return ownerId === this.#ownerId
      ? ([...this.#sessions.values()].find(
          (session) => session.origin === "person" && !terminal(session.state),
        ) ?? null)
      : null;
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

  /** Fresh sessions belong to the personal owner. */
  #ownsSession(session: BrowserSessionRecord, ownerId: UserId): boolean {
    if (session.profileId === null) return ownerId === this.#ownerId;
    return this.#profiles.get(session.profileId)?.ownerId === ownerId;
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
    readonly core?: { runtime: BrowserRuntime; verifier: FakeTicketVerifier; sink: FakeSink };
    readonly beforeInitialSnapshot?: readonly Record<string, unknown>[];
    readonly deferInitialSnapshot?: boolean;
    readonly initialTabCount?: number;
    readonly initialDialog?: Record<string, unknown> | null;
    readonly inputLanes?: boolean;
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
  publishTabs(input: {
    surfaces: readonly (Partial<Omit<BrowserSurface, "id" | "openerId">> & {
      id?: string;
      openerId?: string | null;
    })[];
    inventoryRevision?: number;
    closed?: readonly string[];
  }): void;
  url: URL;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected fake Runtime address.");
  const commands: Array<Record<string, unknown>> = [];
  const receivedCommands: Array<Record<string, unknown>> = [];
  const waiters: Array<(command: Record<string, unknown>) => void> = [];
  let initialTabCount = options.initialTabCount;
  const streams = new Map<
    WebSocket,
    {
      publisher: KeyedStreamPublisher<
        BrowserTabRecord,
        {
          activeId: import("@opensteer/protocol").BrowserSurfaceId | null;
          inventoryRevision: number;
        }
      >;
      rows: Map<string, BrowserTabRecord>;
      meta: {
        activeId: import("@opensteer/protocol").BrowserSurfaceId | null;
        inventoryRevision: number;
      };
    }
  >();
  const publishTabs = (
    socket: WebSocket,
    input: {
      surfaces: readonly (Partial<Omit<BrowserSurface, "id" | "openerId">> & {
        id?: string;
        openerId?: string | null;
      })[];
      inventoryRevision?: number;
      closed?: readonly string[];
    },
  ) => {
    let stream = streams.get(socket);
    if (!stream) {
      const rows = new Map<string, BrowserTabRecord>();
      const meta = {
        activeId: null as import("@opensteer/protocol").BrowserSurfaceId | null,
        inventoryRevision: 1,
      };
      stream = {
        rows,
        meta,
        publisher: new KeyedStreamPublisher({
          ids: () => rows.keys(),
          read: (id) => rows.get(id),
          meta: () => ({ ...meta }),
          targetBytes: 64 * 1024,
          envelopeBytes: 64,
        }),
      };
      streams.set(socket, stream);
    }
    for (const id of stream.rows.keys())
      if (!input.surfaces.some((row) => row.id === id)) {
        stream.rows.delete(id);
        stream.publisher.mark(id);
      }
    for (const [order, surface] of input.surfaces.entries()) {
      if (!surface.id) throw new Error("Missing fake tab id.");
      const previous = stream.rows.get(surface.id);
      const icon = surface.favicon
        ? createHash("sha256").update(surface.favicon).digest("base64url")
        : null;
      if (icon)
        socket.send(
          JSON.stringify({ type: "browser.tab.icon", key: icon, favicon: surface.favicon }),
        );
      stream.rows.set(
        surface.id,
        BrowserTabRecordSchema.parse({
          state: "live",
          url: "about:blank",
          openerId: null,
          documentId: "document-1",
          geometryRevision: 0,
          loading: false,
          navigationFailed: false,
          canGoBack: false,
          canGoForward: false,
          sizedByAgent: false,
          ...previous,
          ...Object.fromEntries(
            Object.entries(surface).filter(([key]) => key !== "active" && key !== "favicon"),
          ),
          order: surface.order ?? order,
          title: (surface.title ?? "").slice(0, 256),
          icon: icon ?? (previous && previous.url === surface.url ? previous.icon : null),
        }),
      );
      stream.publisher.mark(surface.id);
    }
    const active = input.surfaces.find((row) => row.active)?.id ?? input.surfaces[0]?.id;
    stream.meta.activeId = active ? BrowserSurfaceIdSchema.parse(active) : null;
    stream.meta.inventoryRevision = input.inventoryRevision ?? stream.meta.inventoryRevision;
    stream.publisher.markMeta();
    let frame = stream.publisher.next();
    if (!frame) {
      stream.publisher.reset();
      frame = stream.publisher.next();
    }
    for (; frame; frame = stream.publisher.next()) {
      socket.send(
        JSON.stringify({
          type: "browser.tabs",
          stream:
            frame.op === "end" && initialTabCount !== undefined
              ? { ...frame, count: initialTabCount }
              : frame,
        }),
      );
      if (frame.op === "end") initialTabCount = undefined;
      stream.publisher.settled(frame, true);
    }
  };
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
    if (options.core) {
      const { runtime, verifier, sink } = options.core;
      verifier.claims = { ...claims, initialSurfaceId: BrowserSurfaceIdSchema.parse("page-1") };
      sink.sendServerImplementation = async (message) => {
        socket.send(JSON.stringify(message));
      };
      const attached = runtime.attach(authorization.slice(7), sink);
      let tail = Promise.resolve();
      socket.on("message", (raw, isBinary) => {
        if (isBinary) return;
        const command = JSON.parse(raw.toString()) as Record<string, unknown>;
        tail = tail.then(async () => {
          await (await attached).handle(raw.toString());
          receivedCommands.push(command);
        });
        void tail.catch(() => socket.close(1011, "Test runtime command failed"));
      });
      socket.once("close", () => {
        void attached.then((a) => a.close());
      });
      void attached.catch(() => socket.close(1011, "Test runtime attach failed"));
      return;
    }
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
    const sendInitialSnapshot = () => {
      socket.send(
        JSON.stringify({
          access: claims.access,
          dialog: options.initialDialog ?? null,
          sessionId: claims.sessionId,
          state: "ready",
          type: "browser.snapshot",
          ...(claims.navigationAttributionVersion === 1 && options.navigationAttribution !== false
            ? { navigationAttributionVersion: 1 }
            : {}),
          ...(claims.surfaceState === 1 ? { surfaceState: 1 } : {}),
          ...(claims.personFillVersion ? { personFillVersion: claims.personFillVersion } : {}),
          ...(options.inputLanes ? { inputLanesVersion: 1 } : {}),
          ...(options.targetedStreaming !== false ? { targetedStreamingVersion: 1 } : {}),
          ...(options.editing && claims.editingVersion
            ? {
                editingVersion: claims.editingVersion,
                ...(claims.editingVersion === 2 ? { clipboard: options.clipboard ?? true } : {}),
              }
            : {}),
        }),
      );
      publishTabs(socket, {
        surfaces: [
          {
            active: true,
            id: BrowserSurfaceIdSchema.parse("page-1"),
            title: "Example",
            url: "about:blank",
          },
        ],
      });
    };
    if (options.deferInitialSnapshot) pendingInitialSnapshots.push(sendInitialSnapshot);
    else sendInitialSnapshot();
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
    publishTabs: (input) => {
      for (const socket of sockets) publishTabs(socket, input);
    },
    sendServer: (message) => {
      if (message.type === "browser.editing") message = { geometryRevision: 0, ...message };
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
      geometryRevision: 0,
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
  readonly #profileCount: number;
  readonly #ownerId: UserId;
  readonly #profileId: BrowserProfileId;

  constructor(ownerId: UserId, profileCount: number) {
    super(ownerId);
    this.#profileCount = profileCount;
    this.#ownerId = ownerId;
    this.#profileId = this.addHostedProfile("Default browser").id;
  }

  override async listBrowserProfiles(ownerId: UserId) {
    if (ownerId !== this.#ownerId) return [];
    return Array.from({ length: this.#profileCount }, (_, index) => ({
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
      origin: "person" as const,
      placementKey: `runner:catalog-${index}`,
      profileId: this.#profileId,
      runnerId: createId("runner"),
      runtimeId: `runtime-${index}`.padEnd(255, "r"),
      state: "closed" as const,
      updatedAt: new Date(20_000 + index),
    }));
  }
}

function terminal(state: HostedBrowserSessionState): boolean {
  return state === "closed" || state === "failed";
}

async function waitFor(assertion: () => boolean, timeoutMs = 2_000): Promise<void> {
  await vi.waitFor(
    () => expect(assertion(), "The expected browser event never arrived.").toBe(true),
    { timeout: timeoutMs },
  );
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
      const ownerId = createId("user");
      const repository = new MemoryBrowserRepository(ownerId);
      const service = freshService({
        keys,
        runtime,
        repository,
        passkeys: advertised,
        passkeysEnabled: flag === "1",
      });
      const opened = await service.openAgentSession({
        ownerId,

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
  const ownerId = createId("user");
  const repository = new MemoryBrowserRepository(ownerId);
  const service = freshService({
    keys,
    runtime,
    repository,
    passkeys: true,
    passkeysEnabled: true,
  });
  const opened = await service.openAgentSession({
    ownerId,

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
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      rasterDemand,
      repository: new MemoryBrowserRepository(ownerId),
    });
    const opened = await service.openAgentSession({
      ownerId,

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
      // A holder without density demand stays at the default density.
      const legacy = await service.attach(
        ownerId,
        opened.session.id,
        new RecordingPeer("default-density"),
        consumerOptions(),
      );
      await send(legacy, { type: "stream.subscribe", surfaceId: "page-1" });
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

it("delivers cursor hints only to their controller and refuses Watch cursor queries", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary", { inputLanes: true });
  const ownerId = createId("user");
  const service = freshService({
    keys,
    runtime,
    repository: new MemoryBrowserRepository(ownerId),
  });
  const opened = await service.openAgentSession({
    ownerId,

    agentBindingId: "cursor-hints",
    fresh: true,
  });
  const first = new RecordingPeer("cursor-first"),
    second = new RecordingPeer("cursor-second"),
    watch = new RecordingPeer("cursor-watch");
  const controller = await service.attach(ownerId, opened.session.id, first, consumerOptions());
  const other = await service.attach(ownerId, opened.session.id, second, consumerOptions());
  const watching = await service.attach(ownerId, opened.session.id, watch, {
    ...consumerOptions(),
    mode: "watch",
  });
  try {
    await controller.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1" })),
      false,
    );
    expect(await runtime.nextCommand()).toMatchObject({
      type: "stream.subscribe",
      surfaceId: "page-1",
    });
    await controller.handle(
      Buffer.from(
        JSON.stringify({
          type: "input.pointer",
          surfaceId: "page-1",
          action: "move",
          button: "none",
          x: 0.5,
          y: 0.5,
          viewportWidth: 1280,
          viewportHeight: 720,
          cursorSequence: 3,
        }),
      ),
      false,
    );
    const command = await runtime.nextCommand();
    runtime.sendServer({
      type: "browser.cursor",
      surfaceId: "page-1",
      consumerToken: command.producerId,
      cursorSequence: 3,
      documentId: "doc",
      geometryRevision: 0,
      captureRevision: 0,
      cursor: "pointer",
    });
    await vi.waitFor(
      () => expect(first.text().some((message) => message.type === "browser.cursor")).toBe(true),
      { timeout: 1000 },
    );
    expect(second.text().some((message) => message.type === "browser.cursor")).toBe(false);
    expect(watch.text().some((message) => message.type === "browser.cursor")).toBe(false);
    const before = runtime.receivedCommands().length;
    await expect(
      watching.handle(
        Buffer.from(
          JSON.stringify({
            type: "cursor.query",
            surfaceId: "page-1",
            cursorSequence: 3,
            pointSequence: 3,
          }),
        ),
        false,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(runtime.receivedCommands()).toHaveLength(before);
  } finally {
    controller.close();
    other.close();
    watching.close();
  }
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const)(
  "negotiates autofill only for Personal with an advertising runtime (personal=%s, advertised=%s)",
  async (personal, personFill) => {
    const keys = generateKeyPairSync("ed25519");
    const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
    const ownerId = createId("user");
    const service = freshService({
      keys,
      runtime,
      repository: new MemoryBrowserRepository(ownerId),
      personal,
      personFill: personFill ? 1 : undefined,
    });
    const opened = await service.openAgentSession({
      ownerId,

      agentBindingId: "autofill",
      fresh: true,
    });
    expect(runtime.lastClaims()?.personFillVersion).toBe(personal && personFill ? 1 : undefined);
    const peer = new RecordingPeer("autofill-negotiation");
    const attachment = await service.attach(ownerId, opened.session.id, peer, {
      ...consumerOptions(),
      autofill: 1,
    });
    expect(peer.text()[0]).toMatchObject(personal && personFill ? { personFillVersion: 1 } : {});
    if (!(personal && personFill)) {
      expect(peer.text()[0]).not.toHaveProperty("personFillVersion");
      await expect(
        attachment.handle(
          Buffer.from(
            JSON.stringify({
              type: "autofill.fill",
              surfaceId: "page-1",
              offerId: randomUUID(),
              loginId: randomUUID(),
              revision: 1,
            }),
          ),
          false,
        ),
      ).rejects.toThrow("autofill was not negotiated");
    }
  },
);

it("routes ephemeral autofill only to its opted-in controlling consumer and stamps choices", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
    targetedStreaming: true,
    inputLanes: true,
  });
  const ownerId = createId("user");
  const service = freshService({
    keys,
    runtime,
    repository: new MemoryBrowserRepository(ownerId),
    personal: true,
    personFill: 2,
  });
  const opened = await service.openAgentSession({
    ownerId,

    agentBindingId: "autofill",
    fresh: true,
  });
  const attach = async (
    id: string,
    autofill: 0 | PersonFillVersion,
    mode: "control" | "watch" = "control",
  ) => {
    const peer = new RecordingPeer(id);
    const attachment = await service.attach(ownerId, opened.session.id, peer, {
      ...consumerOptions(),
      mode,
      ...(autofill ? { autofill } : {}),
      popups: true,
    });
    const snapshot = BrowserServerMessageSchema.parse(peer.text()[0]);
    if (snapshot.type !== "browser.snapshot") throw new Error("Missing snapshot");
    return { peer, attachment, token: snapshot.consumerToken };
  };
  const actor = await attach("actor", 2),
    bystander = await attach("bystander", 2),
    fillOnly = await attach("fill-only", 1),
    old = await attach("old", 0),
    watch = await attach("watch", 2, "watch");
  expect(actor.peer.text()[0]).toMatchObject({ personFillVersion: 2 });
  expect(fillOnly.peer.text()[0]).toMatchObject({ personFillVersion: 1 });
  expect(old.peer.text()[0]).not.toHaveProperty("personFillVersion");
  expect(watch.peer.text()[0]).not.toHaveProperty("personFillVersion");
  const offerId = randomUUID(),
    loginId = randomUUID();
  const offer = {
    type: "browser.autofill.offer",
    surfaceId: "page-1",
    consumerToken: actor.token,
    offerId,
    role: "username",
    geometryRevision: 0,
    anchor: { x: 0.2, y: 0.3, width: 0.1, height: 0.05 },
    accounts: [{ id: loginId, revision: 1, username: "fixture", label: null, ready: false }],
  };
  runtime.sendServer(offer);
  runtime.sendServer({
    type: "browser.autofill.result",
    surfaceId: "page-1",
    consumerToken: actor.token,
    offerId,
    status: "filled",
  });
  runtime.sendServer({
    type: "browser.autofill.withdrawn",
    surfaceId: "page-1",
    consumerToken: actor.token,
    offerId,
  });
  const saveOfferId = randomUUID();
  for (const consumerToken of [actor.token, fillOnly.token]) {
    runtime.sendServer({
      type: "browser.passwordSave.offer",
      surfaceId: "page-1",
      consumerToken,
      offerId: saveOfferId,
      offer: { kind: "save", origin: "https://example.com", username: "fixture" },
    });
    runtime.sendServer({
      type: "browser.passwordSave.ended",
      surfaceId: "page-1",
      consumerToken,
      offerId: saveOfferId,
      status: "saved",
    });
  }
  runtime.sendServer({
    type: "browser.error",
    error: { code: "conflict", message: "autofill-route-marker", retryable: false },
  });
  for (const viewer of [actor, bystander, fillOnly, old, watch]) {
    await vi.waitFor(() =>
      expect(viewer.peer.text(), "Viewer never received the routing barrier").toContainEqual(
        expect.objectContaining({ type: "browser.error" }),
      ),
    );
  }
  const messages = (viewer: typeof actor) =>
    viewer.peer
      .text()
      .filter(
        (message) =>
          message.type.startsWith("browser.autofill.") ||
          message.type.startsWith("browser.passwordSave."),
      );
  expect(messages(actor)).toHaveLength(5);
  // A viewer that predates saving never receives a save offer, even one naming it.
  expect(messages(fillOnly)).toEqual([]);
  expect(messages(bystander)).toEqual([]);
  expect(messages(old)).toEqual([]);
  expect(messages(watch)).toEqual([]);
  const late = await attach("late", 2);
  expect(messages(late)).toEqual([]);
  const fill = {
    type: "autofill.fill",
    surfaceId: "page-1",
    offerId,
    loginId,
    revision: 1,
    producerId: randomUUID(),
  };
  const send = (viewer: typeof actor) =>
    viewer.attachment.handle(Buffer.from(JSON.stringify(fill)), false);
  await expect(send(old)).rejects.toThrow("autofill was not negotiated");
  await expect(send(watch)).rejects.toThrow("autofill was not negotiated");
  await send(actor);
  await vi.waitFor(() =>
    expect(
      runtime.receivedCommands().some((command) => command.type === "autofill.fill"),
      "Runtime never received the chosen account",
    ).toBe(true),
  );
  expect(runtime.receivedCommands().filter((command) => command.type === "autofill.fill")).toEqual([
    expect.objectContaining({ ...fill, producerId: actor.token }),
  ]);
  const answer = {
    type: "passwordSave.answer",
    surfaceId: "page-1",
    offerId: saveOfferId,
    save: true,
    producerId: randomUUID(),
  };
  const answerFrom = (viewer: typeof actor) =>
    viewer.attachment.handle(Buffer.from(JSON.stringify(answer)), false);
  await expect(answerFrom(fillOnly)).rejects.toThrow("autofill was not negotiated");
  await expect(answerFrom(watch)).rejects.toThrow("autofill was not negotiated");
  await answerFrom(actor);
  await vi.waitFor(() =>
    expect(
      runtime.receivedCommands().some((command) => command.type === "passwordSave.answer"),
      "Runtime never received the save answer",
    ).toBe(true),
  );
  expect(
    runtime.receivedCommands().filter((command) => command.type === "passwordSave.answer"),
  ).toEqual([expect.objectContaining({ ...answer, producerId: actor.token })]);
  // A viewer that leaves for good says so, which ends its save offers.
  actor.attachment.close();
  await vi.waitFor(
    () =>
      expect(
        runtime.receivedCommands().filter((command) => command.type === "input.cancel"),
        "Runtime never heard the viewer left",
      ).toContainEqual(expect.objectContaining({ producerId: actor.token, ended: true })),
    { timeout: 2_000 },
  );
});

it("records a retired Guest closed, saves its tabs and closes viewers gracefully", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
  const ownerId = createId("user");
  const repository = new MemoryBrowserRepository(ownerId);
  const saved = new Set(["page-1"]);
  const suspend = vi.fn(async () => undefined);
  const recordChanges = vi.fn(
    async (sessionId: BrowserSessionId, _descriptors: unknown, closed: readonly string[]) => {
      for (const id of closed) saved.delete(id);
      return { groupId: sessionId, changed: false, rows: [], closedIds: [...closed] };
    },
  );
  const service = freshService({
    keys,
    repository,
    runtime,
    personalTabs: new Proxy(
      { suspend, recordChanges },
      {
        get: (store, key) =>
          key === "suspend"
            ? store.suspend
            : key === "recordChanges"
              ? store.recordChanges
              : async () => undefined,
      },
    ) as unknown as PersonalTabStore,
  });
  const opened = await service.start({ fresh: true, ownerId });
  const peer = new RecordingPeer("retired-viewer");
  await service.attach(ownerId, opened.session.id, peer, consumerOptions());
  runtime.sendServer({ type: "browser.status", state: "closed", reason: "retired" });
  await vi.waitFor(
    async () => {
      expect(
        (await repository.getBrowserSessionForOwner(opened.session.id, ownerId))?.state,
        "Retired session never closed",
      ).toBe("closed");
      expect(suspend).toHaveBeenCalledWith(opened.session.id);
    },
    { timeout: 1000 },
  );
  expect(peer.closed?.code).toBe(1000);
  expect(saved).toEqual(new Set(["page-1"]));
});

it("closes durable rows only on a change removal, never an interrupted or committed snapshot", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
  const ownerId = createId("user");
  const repository = new MemoryBrowserRepository(ownerId);
  const recordChanges = vi.fn(async (sessionId: BrowserSessionId) => ({
    groupId: sessionId,
    changed: true,
    rows: [],
    closedIds: [],
  }));
  const service = new BrowserService({
    ...nativeProfileOptions(),
    ...profileStateOptions,
    repository,
    signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
    targetResolver: runnerTarget({ url: runtime.url, tabRestoreVersion: true }),
    personalTabs: {
      groupIds: async () => [],
      read: async () => [],
      openTabs: async () => [],
      recordChanges,
      suspend: async () => undefined,
    } as unknown as PersonalTabStore,
  });
  cleanups.push(() => service.close());
  const opened = await service.start({ fresh: true, ownerId });
  recordChanges.mockClear();
  runtime.sendServer({ type: "browser.tabs", stream: { op: "begin", generation: "resnapshot" } });
  runtime.sendServer({
    type: "browser.tabs",
    stream: { op: "end", revision: 7, count: 0, meta: { activeId: null, inventoryRevision: 1 } },
  });
  await vi.waitFor(
    async () => expect((await browserRows(service, ownerId, opened.session.id)).tabs).toEqual([]),
    { timeout: 1000 },
  );
  await service.flushPendingTabDescriptors();
  expect(recordChanges).not.toHaveBeenCalled();
  const row = BrowserTabRecordSchema.parse({
    id: "page-1",
    state: "live",
    title: "Saved",
    url: "https://example.com",
    icon: null,
    order: 0,
    openerId: null,
    documentId: "document-1",
    geometryRevision: 0,
    loading: false,
    navigationFailed: false,
    canGoBack: false,
    canGoForward: false,
    sizedByAgent: false,
  });
  runtime.sendServer({
    type: "browser.tabs",
    stream: { op: "change", generation: "resnapshot", base: 7, revision: 8, add: [row] },
  });
  await vi.waitFor(
    async () =>
      expect((await browserRows(service, ownerId, opened.session.id)).tabs).toHaveLength(1),
    { timeout: 1000 },
  );
  await service.flushPendingTabDescriptors();
  recordChanges.mockClear();
  runtime.sendServer({ type: "browser.tabs", stream: { op: "begin", generation: "interrupted" } });
  runtime.sendServer({ type: "browser.tabs", stream: { op: "rows", rows: [row] } });
  runtime.sendServer({
    type: "browser.tabs",
    stream: { op: "end", revision: 8, count: 2, meta: { activeId: row.id, inventoryRevision: 1 } },
  });
  expect(await runtime.nextCommand()).toMatchObject({ type: "tabs.resync" });
  expect((await browserRows(service, ownerId, opened.session.id)).tabs).toHaveLength(1);
  expect(recordChanges).not.toHaveBeenCalled();
  runtime.sendServer({ type: "browser.tabs", stream: { op: "begin", generation: "recovered" } });
  runtime.sendServer({ type: "browser.tabs", stream: { op: "rows", rows: [row] } });
  runtime.sendServer({
    type: "browser.tabs",
    stream: { op: "end", revision: 0, count: 1, meta: { activeId: row.id, inventoryRevision: 1 } },
  });
  runtime.sendServer({
    type: "browser.tabs",
    stream: { op: "change", generation: "recovered", base: 0, revision: 1, remove: [row.id] },
  });
  await vi.waitFor(
    async () => expect((await browserRows(service, ownerId, opened.session.id)).tabs).toEqual([]),
    { timeout: 1000 },
  );
  await service.flushPendingTabDescriptors();
  expect(recordChanges).toHaveBeenCalledExactlyOnceWith(opened.session.id, [], [row.id]);
});

it("resynchronizes an initial tab gap before announcing readiness", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary", { initialTabCount: 2 });
  const ownerId = createId("user");
  const service = new BrowserService({
    ...nativeProfileOptions(),
    ...profileStateOptions,
    repository: new MemoryBrowserRepository(ownerId),
    connectTimeoutMs: 2000,
    signer: new BrowserAttachTicketSigner({ keyId: "host-primary", privateKey: keys.privateKey }),
    targetResolver: runnerTarget({ url: runtime.url }),
  });
  cleanups.push(() => service.close());
  const starting = service.start({ fresh: true, ownerId }).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  expect(await runtime.nextCommand()).toMatchObject({ type: "tabs.resync" });
  runtime.publishTabs({
    surfaces: [{ id: "page-1", active: true, title: "Example", url: "about:blank" }],
  });
  expect(await starting).toMatchObject({ result: { session: { state: "ready" } } });
});

it("batches additive person-use marks once per runtime connection and replays only existing tabs", async () => {
  const ids = Array.from({ length: 7_000 }, (_, i) =>
    BrowserSurfaceIdSchema.parse(`srf_${String(i).padStart(40, "0")}`),
  );
  const marks = { tabs: new Set(ids.slice(0, -2)), ended: false };
  async function connect(present: typeof ids, savedTabIds?: typeof ids) {
    const socket = new EventEmitter();
    const sent: Record<string, unknown>[] = [];
    let failNext = false;
    Object.assign(socket, {
      readyState: WebSocket.OPEN,
      send: (data: string, _options: unknown, callback: (error?: Error) => void) => {
        if (failNext) {
          failNext = false;
          callback(new Error("Write failed"));
          return;
        }
        sent.push(JSON.parse(data));
        callback();
      },
      close: () => socket.emit("close", 1000, Buffer.from("closed")),
    });
    const sessionId = createBrowserSessionId();
    const broker = new HostedBrowserBroker({
      socket,
      sessionId,
      groupId: sessionId,

      readSessionState: async () => ({ runs: 0, pinned: [] }),
      personUse: marks,
      savedTabIds,
      profileId: null,
      surfaceState: 1,
      sharedControl: true,
      connectTimeoutMs: 1000,
      passkeys: false,
      onState: async () => ({}),
      onTerminal: () => undefined,
      onTabsChanged: () => undefined,
      onRecordsChanged: () => undefined,
      onPageChanged: () => undefined,
    } as unknown as ConstructorParameters<typeof HostedBrowserBroker>[0]);
    const emit = (message: unknown) =>
      socket.emit("message", Buffer.from(JSON.stringify(message)), false);
    emit({
      type: "browser.snapshot",
      sessionId,
      access: "read-write",
      state: "ready",
      dialog: null,
      surfaceState: 1,
      targetedStreamingVersion: 1,
    });
    const rows = new Map(
      present.map((id, order) => [
        id,
        BrowserTabRecordSchema.parse({
          id,
          order,
          title: "Tab",
          url: "about:blank",
          state: "live",
          icon: null,
          openerId: null,
          documentId: "doc",
          geometryRevision: 1,
          loading: false,
          navigationFailed: false,
          canGoBack: false,
          canGoForward: false,
          sizedByAgent: false,
        }),
      ]),
    );
    const publisher = new KeyedStreamPublisher({
      ids: () => rows.keys(),
      read: (id) => rows.get(BrowserSurfaceIdSchema.parse(id)),
      meta: () => ({ activeId: present[0] ?? null, inventoryRevision: 1 }),
      targetBytes: 64 * 1024,
      envelopeBytes: 256,
    });
    for (let stream = publisher.next(); stream; stream = publisher.next()) {
      emit({ type: "browser.tabs", stream });
      publisher.settled(stream, true);
    }
    await broker.ready();
    cleanups.push(async () => {
      socket.emit("close", 1000, Buffer.from("closed"));
    });
    return {
      broker,
      sent,
      failNext: () => {
        failNext = true;
      },
      add: (id: (typeof ids)[number]) => {
        rows.set(id, { ...rows.values().next().value!, id, order: rows.size });
        publisher.mark(id);
        for (let stream = publisher.next(); stream; stream = publisher.next()) {
          emit({ type: "browser.tabs", stream });
          publisher.settled(stream, true);
        }
      },
    };
  }
  const first = await connect(ids);
  const states = first.sent.filter((message) => message.type === "session.state");
  expect(states.length).toBeGreaterThan(1);
  expect(
    states.every(
      (message) => Buffer.byteLength(JSON.stringify(message)) <= 256 * 1024 && !message.keepAwake,
    ),
  ).toBe(true);
  expect(states.flatMap((message) => message.personUsed)).toEqual(ids.slice(0, -2));
  const before = first.sent.length;
  await first.broker.markPersonUsed(ids[0]!);
  expect(first.sent).toHaveLength(before);
  first.failNext();
  await expect(first.broker.markPersonUsed(ids.at(-2)!)).rejects.toThrow("Write failed");
  await first.broker.markPersonUsed(ids.at(-2)!);
  expect(first.sent.at(-1)).toMatchObject({ personUsed: [ids.at(-2)!] });
  await first.broker.markPersonUsed(ids.at(-1)!);
  expect(first.sent.at(-1)).toMatchObject({ personUsed: [ids.at(-1)!] });
  const delayed = await connect(ids.slice(0, 5), ids.slice(0, 6));
  expect(
    delayed.sent
      .filter((message) => message.type === "session.state")
      .flatMap((message) => message.personUsed),
  ).toEqual(ids.slice(0, 5));
  delayed.add(ids[5]!);
  await vi.waitFor(
    () =>
      expect(
        delayed.sent.filter((message) => message.type === "session.state").at(-1),
      ).toMatchObject({ personUsed: [ids[5]!] }),
    { timeout: 1000 },
  );
  const second = await connect(ids.slice(0, 5));
  expect(
    second.sent
      .filter((message) => message.type === "session.state")
      .flatMap((message) => message.personUsed),
  ).toEqual(ids.slice(0, 5));
  marks.ended = true;
  marks.tabs.clear();
  const ended = await connect(ids.slice(0, 5));
  await ended.broker.markPersonUsed(ids[0]!);
  expect(
    ended.sent
      .filter((message) => message.type === "session.state")
      .flatMap((message) => message.personUsed),
  ).toEqual([]);
});

it("sends authoritative sleep state after commit and keeps two viewers and Watch independent of Run holds", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
    targetedStreaming: true,
  });
  const ownerId = createId("user");
  const repository = new MemoryBrowserRepository(ownerId);
  const service = freshService({
    keys,
    runtime,
    repository,
    surfaceState: true,
    targetControl: true,
  });
  const opened = await service.openAgentSession({
    ownerId,

    agentBindingId: "sleep-run",
    fresh: true,
  });
  const sessionId = opened.session.id;
  const lastState = () => runtime.receivedCommands().findLast((m) => m.type === "session.state");
  await vi.waitFor(() =>
    expect(lastState()).toEqual({
      type: "session.state",
      runs: 1,
      personUsed: [],
      viewed: [],
      pinned: [],
    }),
  );
  const harness = await service.attachCdpForAgent(
    { ownerId, agentBindingId: "sleep-run", sessionId },
    () => undefined,
  );
  harness.close();
  const attach = async (id: string, mode: "control" | "watch", frames = true) => {
    const viewer = await service.attach(ownerId, sessionId, new RecordingPeer(id), {
      ...consumerOptions(),
      mode,
    });
    await viewer.handle(
      Buffer.from(
        JSON.stringify({
          type: "stream.subscribe",
          surfaceId: "page-1",
          ...(frames ? {} : { frames: false }),
        }),
      ),
      false,
    );
    return viewer;
  };
  const one = await attach("one", "control", false);
  const two = await attach("two", "control");
  const watch = await attach("watch", "watch");
  await vi.waitFor(() =>
    expect(lastState()).toMatchObject({
      runs: 1,
      personUsed: [],
      viewed: ["page-1"],
      pinned: ["page-1"],
    }),
  );
  await service.detachAgentSessionsForBinding("sleep-run");
  await vi.waitFor(() =>
    expect(lastState()).toMatchObject({
      runs: 0,
      personUsed: [],
      viewed: ["page-1"],
      pinned: ["page-1"],
    }),
  );
  one.close();
  await two.handle(
    Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1", frames: false })),
    false,
  );
  await vi.waitFor(() => expect(lastState()).toMatchObject({ personUsed: [], viewed: ["page-1"] }));
  await two.handle(Buffer.from(JSON.stringify({ type: "stream.unsubscribe" })), false);
  await vi.waitFor(() =>
    expect(lastState()).toMatchObject({ runs: 0, personUsed: [], viewed: [], pinned: ["page-1"] }),
  );
  watch.close();
  await vi.waitFor(() =>
    expect(lastState()).toMatchObject({ runs: 0, personUsed: [], viewed: [], pinned: [] }),
  );
  two.close();
});

it("admits paged listing and exact resume only inside an agent's own session", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
    targetedStreaming: true,
  });
  const ownerId = createId("user");
  const repository = new MemoryBrowserRepository(ownerId);
  const service = freshService({ keys, runtime, repository, surfaceState: true });
  const opened = await service.openAgentSession({
    ownerId,

    agentBindingId: "sleep-run",
    fresh: true,
  });
  const cdp = await service.attachCdpForAgent(
    { ownerId, agentBindingId: "sleep-run", sessionId: opened.session.id },
    () => undefined,
  );
  await service.openAgentSession({
    ownerId,

    agentBindingId: "other-holding-run",
    sessionId: opened.session.id,
  });
  runtime.publishTabs({
    surfaces: [{ id: "page-1", active: true, state: "suspended", title: "Sleeping" }],
  });
  await vi.waitFor(() =>
    expect(service.tabStateOf(opened.session.id, BrowserSurfaceIdSchema.parse("page-1"))).toBe(
      "suspended",
    ),
  );
  const forward = async (method: string, parameters: Record<string, unknown>) => {
    const before = runtime.receivedCommands().length;
    const { result } = await cdp.dispatch({ method, parameters });
    await vi.waitFor(() =>
      expect(
        runtime
          .receivedCommands()
          .slice(before)
          .find((m) => m.type === "cdp.command"),
      ).toBeDefined(),
    );
    const sent = runtime
      .receivedCommands()
      .slice(before)
      .find((m) => m.type === "cdp.command")!;
    expect(sent.command).toMatchObject({ method, parameters });
    runtime.sendServer({ type: "cdp.result", requestId: sent.requestId, result: { ok: true } });
    expect(await result).toEqual({ ok: true });
  };
  await forward("Opensteer.listTabs", { cursor: "42" });
  await forward("Opensteer.resumeTab", { surfaceId: "page-1" });
  expect(await repository.countBrowserSessionAttachments(opened.session.id)).toBe(2);
  await expect(
    cdp.request({ method: "Opensteer.resumeTab", parameters: { surfaceId: "other-session-tab" } }),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(cdp.request({ method: "Opensteer.openTab", parameters: {} })).rejects.toMatchObject({
    code: "forbidden",
  });
  cdp.close();
});

it("lets the runtime sleep an unviewed leftover only after its Run's durable hold ends", async () => {
  const context = new FakeContext([new FakePage()]);
  const verifier = new FakeTicketVerifier();
  const engine = new BrowserRuntime({
    launcher: new FakeLauncher(new FakeLaunchedBrowser(context)),
    runtimeId: "runtime-1",
    ticketVerifier: verifier,
    sessionFilesRoot: testSessionFilesRoot(),
  });
  cleanups.push(() => engine.shutdown());
  const sink = new FakeSink();
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
    core: { runtime: engine, verifier, sink },
  });
  const ownerId = createId("user");
  const repository = new MemoryBrowserRepository(ownerId);
  const service = freshService({
    keys,
    runtime,
    repository,
    surfaceState: true,
    tabRestoreVersion: true,
  });
  const opened = await service.openAgentSession({
    ownerId,

    agentBindingId: "leftover-run",
    fresh: true,
  });
  const cdp = await service.attachCdpForAgent(
    { ownerId, agentBindingId: "leftover-run", sessionId: opened.session.id },
    () => undefined,
  );
  await cdp.request({
    method: "Target.createTarget",
    parameters: { url: "https://leftover.test/" },
  });
  const tab = [...sink.tabs.rows.values()].find((tab) => tab.order === 1)!;
  expect(tab).toBeDefined();
  await vi.waitFor(() =>
    expect(runtime.receivedCommands().findLast((m) => m.type === "session.state")).toMatchObject({
      runs: 1,
    }),
  );
  vi.useFakeTimers();
  try {
    cdp.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sink.tabs.rows.get(tab.id)?.state).toBe("live");
    await service.detachAgentSessionsForBinding("leftover-run");
    await vi.waitFor(() =>
      expect(runtime.receivedCommands().findLast((m) => m.type === "session.state")).toMatchObject({
        runs: 0,
      }),
    );
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sink.tabs.rows.get(tab.id)?.state).toBe("live");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sink.tabs.rows.get(tab.id)?.state).toBe("suspended");
  } finally {
    await engine.shutdown();
    vi.useRealTimers();
  }
});

it("retains the requesting tab's pin after its actor ends and keeps unknown Host facts awake", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
    targetedStreaming: true,
  });
  const ownerId = createId("user"),
    runId = createId("run"),
    threadId = createId("thread");
  const repository = new MemoryBrowserRepository(ownerId);
  vi.spyOn(repository as BrowserSessionRepository, "resolvePlaceActors").mockImplementation(
    async () => [
      {
        agentBindingId: `run:${runId}`,
        ownerId,
        runId,
        threadId,
        generation: 1,
        lineageThreadIds: [threadId],
      },
    ],
  );
  const service = freshService({ keys, runtime, repository, surfaceState: true });
  const authority = { ownerId, agentBindingId: `run:${runId}` };
  const { session } = await service.openAgentSession({ ...authority, fresh: true });
  const cdp = await service.attachCdpForAgent(
    { ...authority, sessionId: session.id },
    () => undefined,
  );
  const attached = await cdp.dispatch({
    method: "Target.attachToTarget",
    parameters: { targetId: "target-1", flatten: true },
  });
  await vi.waitFor(() =>
    expect(runtime.receivedCommands().findLast((m) => m.type === "cdp.command")).toBeDefined(),
  );
  const command = runtime.receivedCommands().findLast((m) => m.type === "cdp.command")!;
  runtime.sendServer({
    type: "cdp.result",
    requestId: command.requestId,
    result: { surfaceId: "page-1", sessionId: "attached" },
  });
  await attached.result;
  const pins = [{ sessionId: session.id, runId }];
  service.setRequestPins("sign-in", pins);
  service.setRequestPins("card", pins);
  const last = () => runtime.receivedCommands().findLast((m) => m.type === "session.state");
  await vi.waitFor(() => expect(last()).toMatchObject({ pinned: ["page-1"] }));
  await service.detachAgentSessionsForBinding(authority.agentBindingId);
  service.setRequestPins("sign-in", []);
  await vi.waitFor(() => expect(last()).toMatchObject({ runs: 0, pinned: ["page-1"] }));
  service.setRequestPins("card", []);
  await vi.waitFor(() => expect(last()).toMatchObject({ runs: 0, pinned: [] }));
  const count = vi
    .spyOn(repository, "countBrowserSessionAttachments")
    .mockRejectedValue(new Error("store unavailable"));
  service.setRequestPins("unknown", pins);
  await vi.waitFor(() => expect(last()).toMatchObject({ keepAwake: true }));
  count.mockRestore();
  service.setRequestPins("unknown", []);
  await vi.waitFor(() =>
    expect(last()).toEqual({
      type: "session.state",
      runs: 0,
      personUsed: [],
      viewed: [],
      pinned: [],
    }),
  );
  cdp.close();
});

it("publishes a passkey offer as a pin until the ceremony is cancelled", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary", {
    targetedStreaming: true,
  });
  const ownerId = createId("user");
  const repository = new MemoryBrowserRepository(ownerId);
  const service = freshService({
    keys,
    runtime,
    repository,
    surfaceState: true,
    targetControl: true,
    passkeys: true,
    passkeysEnabled: true,
  });
  const { session } = await service.start({ ownerId, fresh: true });
  const peer = new RecordingPeer("passkey-pin");
  const viewer = await service.attach(ownerId, session.id, peer, {
    ...consumerOptions(),
    passkeys: "native",
  });
  await viewer.handle(
    Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: "page-1", frames: false })),
    false,
  );
  const ceremonyId = randomUUID();
  runtime.sendServer({
    type: "passkey.ceremony",
    ceremonyId,
    surfaceId: "page-1",
    documentId: "document-1",
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
    cause: "agent",
    deadline: Date.now() + 10_000,
  });
  const last = () => runtime.receivedCommands().findLast((m) => m.type === "session.state");
  await vi.waitFor(() =>
    expect(last()).toMatchObject({ personUsed: [], viewed: ["page-1"], pinned: ["page-1"] }),
  );
  runtime.sendServer({ type: "passkey.cancel", ceremonyId });
  await vi.waitFor(() =>
    expect(last()).toMatchObject({ personUsed: [], viewed: ["page-1"], pinned: [] }),
  );
  viewer.close();
});

it("agent restore resumes its exact suspended tab in the existing session", async () => {
  const keys = generateKeyPairSync("ed25519");
  const runtime = await startFakeRuntime(keys.publicKey, "host-primary");
  const ownerId = createId("user");
  const repository = new MemoryBrowserRepository(ownerId);
  const tabId = BrowserSurfaceIdSchema.parse("page-1");
  let sessionId: BrowserSessionId;
  const personalTabs = {
    get: async () => ({ id: tabId, groupId: sessionId, url: "about:blank", favicon: null }),
    session: async () => repository.session(sessionId),
    read: async (_owner: UserId, id: BrowserSessionId | readonly BrowserSessionId[]) =>
      Array.isArray(id) ? [] : { id: sessionId, latestSessionId: sessionId, tabs: [] },
    recordChanges: async (id: BrowserSessionId) => ({
      groupId: id,
      changed: false,
      rows: [],
      closedIds: [],
    }),
    groupIds: async () => [],
    openTabs: async () => [],
    lineageForSession: async (id: BrowserSessionId) => id,
    suspend: async () => undefined,
  } as unknown as PersonalTabStore;
  const service = freshService({
    keys,
    runtime,
    repository,
    surfaceState: true,
    tabRestoreVersion: true,
    personalTabs,
  });
  sessionId = (await service.start({ ownerId, fresh: true })).session.id;
  runtime.publishTabs({
    surfaces: [{ id: tabId, state: "suspended", active: true, title: "Sleeping" }],
  });
  await vi.waitFor(() => expect(service.tabStateOf(sessionId, tabId)).toBe("suspended"));
  const before = runtime.receivedCommands().length;
  const restored = service.restoreAgentPersonalTab(
    { ownerId, agentBindingId: "restoring-run" },
    tabId,
  );
  await vi.waitFor(() =>
    expect(
      runtime
        .receivedCommands()
        .slice(before)
        .find((m) => m.type === "cdp.command"),
    ).toBeDefined(),
  );
  const command = runtime
    .receivedCommands()
    .slice(before)
    .find((m) => m.type === "cdp.command")!;
  expect(command.command).toEqual({
    method: "Opensteer.resumeTab",
    parameters: { surfaceId: tabId },
  });
  runtime.sendServer({ type: "cdp.result", requestId: command.requestId, result: {} });
  expect(await restored).toEqual({ tabId, sessionId });
  expect(await repository.countBrowserSessionAttachments(sessionId)).toBe(1);
  const lastState = () =>
    runtime.receivedCommands().findLast((message) => message.type === "session.state");
  expect(lastState()).toMatchObject({ personUsed: [] });
  runtime.publishTabs({ surfaces: [{ id: tabId, state: "live", active: true, title: "Awake" }] });
  await vi.waitFor(() => expect(service.tabStateOf(sessionId, tabId)).toBe("live"));
  await service.activatePersonalTab(ownerId, tabId);
  await vi.waitFor(() => expect(lastState()).toMatchObject({ personUsed: [tabId] }), {
    timeout: 1000,
  });
  runtime.publishTabs({ surfaces: [] });
  await vi.waitFor(() => expect(service.tabStateOf(sessionId, tabId)).toBeUndefined(), {
    timeout: 1000,
  });
});
