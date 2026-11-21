/**
 * A person's keys on a pooled target reached through the Runner (the path a pool guest uses):
 * the Home's browser service, the Runner browser hub, the Runner's browser relay and bridge, and
 * a pooled runtime with real Chromium on this machine. The loopback journeys reach their
 * runtime without the Runner. The guest proof's viewer lost every key here: it never gave frame
 * credit back (so no new frame came), and resubscribing for one cancelled its unapplied input.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { TabStore } from "../packages/database/src/index.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "../packages/database/src/store.integration.test-support.js";
import {
  BrowserSessionIdSchema,
  decodeBrowserFrameEnvelope,
} from "../packages/protocol/src/browser.js";
import { RunnerAuxiliaryFrameFenceSchema } from "../packages/protocol/src/index.js";
import { createId } from "../packages/core/src/index.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
} from "../packages/browser-runtime-core/src/index.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import { BrowserModuleRelay } from "../packages/runner-client/src/browser-relay.js";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { BrowserPoolCoordinator } from "../apps/host/src/browser/browser-pool-coordinator.js";
import { FakeBrowserPoolController } from "../apps/host/src/browser/browser-pool-controller.test-support.js";
import { BrowserService } from "../apps/host/src/browser/browser-service.js";
import { BrowserLocalProfiles } from "../apps/host/src/browser/browser-local-profiles.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { RunnerBrowserHub } from "../apps/host/src/browser/runner-browser-hub.js";
import {
  BrowserRuntimeRelayToHostMessageSchema,
  RunnerBrowserRuntimeRouter,
} from "../apps/host/src/browser/runner-browser-runtime.js";
import { greenAt } from "./browser-pool-journey.test-support.js";

const page = `<!doctype html><title>Form</title>
<body style="margin:0;min-height:100vh;background:#ffffff">
<input id="draft" autofocus style="font-size:32px;width:90%">
<script>
const input = document.getElementById("draft");
input.focus();
input.addEventListener("input", () => {
  document.body.style.backgroundColor = input.value === "abx" ? "#147443" : "#ffffff";
});
</script>`;

async function typeThroughRunner(options: { readonly profile: boolean }) {
  const site: Server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(page);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const fixture = await createStoreFixture();
  const root = await mkdtemp(join(tmpdir(), "opensteer-pool-runner-input-"));
  const task = await fixture.startRunFixture(`pool-runner-input-${options.profile}`);
  const { database, store } = fixture;
  await database
    .updateTable("runners")
    .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
    .where("id", "=", task.runnerId)
    .execute();
  const tickets = generateKeyPairSync("ed25519");
  const controller = new FakeBrowserPoolController({ slotId: "slot-input", term: 1 });
  const runtime = new BrowserRuntime({
    runtimeId: "pool-runtime",
    launcher: new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath: chromium.executablePath(),
      headless: true,
    }),
    sessionFilesRoot: join(root, "sessions"),
    ticketVerifier: await Ed25519AttachTicketVerifier.create({
      pooled: true,
      replayLedgerPath: join(root, "private", "tickets.json"),
      resolvePublicKey: (id) => (id === "host-v1" ? tickets.publicKey : null),
    }),
    pool: { controllerKey: controller.publicKey, probePage: async () => [] },
    ...(options.profile ? { localProfiles: { root: join(root, "profiles") } } : {}),
  });
  const bridgeToken = randomUUID() + randomUUID();
  const runtimeServer = new BrowserRuntimeServer({
    runtime,
    port: 0,
    relayBridge: { token: bridgeToken, updateAttachKeys: () => {} },
  });
  const address = await runtimeServer.start();
  const bridge = new LocalBrowserRuntimeBridge({
    bridgeToken,
    runtimeId: "pool-runtime",
    url: new URL(`http://${address.host}:${address.port}`),
  });
  const coordinator = new BrowserPoolCoordinator({
    database,
    runnerId: task.runnerId,
    runtimeId: "pool-runtime",
    slotId: "slot-input",
    term: 1,
    runtime,
    controller,
    retryMs: 20,
  });
  const { localProfileStorage, ...rest } = await bridge.capabilities();
  // A guest identity needs no profile inventory; a local profile does, and is offered.
  const capabilities = options.profile ? { ...rest, localProfileStorage } : rest;
  const localProfiles = options.profile
    ? new BrowserLocalProfiles({
        deploymentId: task.deploymentId,
        repository: store,
        baseUrl: new URL("http://127.0.0.1"),
      })
    : undefined;
  const runner = new BrowserModuleRelay(bridge);
  const fence = RunnerAuxiliaryFrameFenceSchema.parse({
    runnerId: task.runnerId,
    bootId: `rbt_${randomUUID()}`,
    connectionId: `rcn_${randomUUID()}`,
    connectionLeaseId: `rls_${randomUUID()}`,
    connectionGeneration: 1,
    auxiliaryStreamId: `rax_${randomUUID()}`,
    module: "browser",
  });
  const { auxiliaryStreamId, module: _module, ...primaryFence } = fence;
  const hub = new RunnerBrowserHub();
  const runnerPeer = {
    id: "pool-runner",
    close: () => runner.detach(),
    send: (message: unknown) => {
      const text = JSON.stringify(message);
      return runner.handleFrame(Buffer.from(text), false);
    },
  };
  hub.attach(runnerPeer, {
    auxiliaryStreamId,
    fence,
    streamLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    identity: {
      ...primaryFence,
      fence: primaryFence,
      allowedModules: ["agents", "browser"],
      capabilities: [],
      environmentIds: [task.environmentId],
      personalRemoteAccessGeneration: null,
      runnerKind: "main",
      name: "Pool guest",
      runtimeVersion: "test",
      modules: {
        browser: {
          runtimeId: "pool-runtime",
          ...capabilities,
          cdpBoundary: 1,
          sharedControl: 1,
          targetControl: 1,
          navigationVersion: 1,
          navigationAttributionVersion: 1,
          tabRestoreVersion: 1,
          surfaceState: 1,
          popupFollowVersion: 1,
          captureRegion: 1,
          rasterDemand: 1,
        },
      },
    },
  } as never);
  // The router listens before the Runner reports its profile inventory.
  const router = new RunnerBrowserRuntimeRouter({
    registry: hub,
    ...(localProfiles ? { localProfiles } : {}),
  } as never);
  await runner.attach({
    fence,
    browserWireVersion: 2,
    browserAttachPublicKeys: [
      {
        keyId: "host-v1",
        publicKeyPem: tickets.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
    send: async (frame: Buffer | string, binary: boolean) => {
      if (binary) await hub.handleBinary(runnerPeer, Buffer.from(frame));
      else {
        const message = BrowserRuntimeRelayToHostMessageSchema.parse(JSON.parse(String(frame)));
        if (message.type !== "runner.auxiliary.heartbeat")
          await hub.handleMessage(runnerPeer, message);
      }
    },
  } as never);
  const service = new BrowserService({
    deploymentId: task.deploymentId,
    hostOrigin: new URL("http://127.0.0.1"),
    personal: true,
    pools: new Map([[task.runnerId, coordinator]]),
    ...(localProfiles ? { localProfiles } : {}),
    tabs: new TabStore(database),
    tabPlaces: { write: async () => false, notice: () => {} },
    repository: personalBrowserRepository(store),
    signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: tickets.privateKey }),
    onError: () => {},
    onSessionsChanged: () => {},
    targetResolver: {
      placements: (ids?: never) => router.placements(ids),
      resolve: (placement: never) => {
        const target = router.resolve(placement);
        return target ? Object.assign(Object.create(target), { main: true }) : target;
      },
    } as never,
  });
  try {
    await service.initialize();
    // The Home admits a Runner's local profiles once it reconciled their inventory.
    await vi.waitFor(
      () => {
        expect(service.isPlacementReady(task.runnerId, "pool-runtime")).toBe(true);
      },
      {
        timeout: 30_000,
      },
    );
    const profile = options.profile
      ? await store.createBrowserProfile({
          name: "Saved browser",
          ownerId: task.userId,
          homeRunnerId: task.runnerId,
          idempotencyKey: "runner-input-profile",
        })
      : null;
    const opened = await service.openTab(task.userId, {
      type: "browser.tab.open",
      identity: profile ? { kind: "profile", profileId: profile.id } : { kind: "guest" },
      placement: { kind: "runner", runnerId: task.runnerId },
      url: `http://127.0.0.1:${(site.address() as AddressInfo).port}/`,
      idempotencyKey: "runner-input",
    } as never);
    await vi.waitFor(
      () =>
        expect(
          JSON.stringify(
            service
              .pageInventory(BrowserSessionIdSchema.parse(opened.sessionId))
              ?.records.get(opened.tabId as never),
          ),
        ).toContain('"title":"Form"'),
      { timeout: 30_000 },
    );
    let open = true;
    const frames: Buffer[] = [];
    let send: (message: Record<string, unknown>) => Promise<void> = async () => {};
    const attached = await service.attach(
      task.userId,
      BrowserSessionIdSchema.parse(opened.sessionId),
      {
        id: `viewer-${randomUUID()}`,
        isOpen: () => open,
        close: () => {
          open = false;
        },
        send: async (data, binary) => {
          if (!binary || !Buffer.isBuffer(data)) return;
          frames.push(data);
          // Each frame's credit is given back, so the stream keeps sending as the page changes.
          const token = decodeBrowserFrameEnvelope(data).header.watchToken;
          if (token) queueMicrotask(() => void send({ type: "stream.ack", token }).catch(() => {}));
        },
      },
      { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
    );
    send = (message) => attached.handle(Buffer.from(JSON.stringify(message)), false);
    await send({ type: "stream.subscribe", surfaceId: opened.tabId });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 30_000 });
    for (const character of "abx")
      for (const action of ["down", "up"])
        await send({
          type: "input.key",
          surfaceId: opened.tabId,
          key: character,
          code: `Key${character.toUpperCase()}`,
          modifiers: [],
          text: character,
          action,
        });
    // The keys are applied before the viewer leaves: leaving cancels a producer's input that
    // the runtime has not applied yet, so the page's own change is awaited on the open stream.
    await vi.waitFor(
      async () => {
        let green = false;
        for (const frame of frames.slice(-3))
          green ||= (await greenAt(frame, opened.tabId)) ?? false;
        expect(green).toBe(true);
      },
      { timeout: 20_000, interval: 250 },
    );
    attached.close();
    open = false;
  } finally {
    await service.close().catch(() => undefined);
    coordinator.close();
    runner.detach();
    await runtimeServer.close();
    await runtime.shutdown().catch(() => undefined);
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await fixture.close();
  }
}

it("delivers a person's keys to the page of a pooled target reached through the Runner", () =>
  typeThroughRunner({ profile: false }));

it("does the same for a person's tab from a local profile on the pooled target", () =>
  typeThroughRunner({ profile: true }));
