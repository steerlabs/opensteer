/**
 * The proof of pool-runtime-in-guest.md on a real pool host: one Home (the product's browser
 * service and pool coordinator, the agent client, and the Runner's browser relay and bridge, in
 * this process) drives one real guest running our runtime, through the agent and the relay.
 *
 * Runs only when OPENSTEER_POOL_REAL_HOST names the run's endpoints (see bench/RESULTS-3.md):
 * the agent, its administration interface and the relay, reached through an IAP SSH forward.
 */
import { execFileSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { readBrowserPoolSlot, TabStore } from "../packages/database/src/index.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "../packages/database/src/store.integration.test-support.js";
import { BrowserSessionIdSchema } from "../packages/protocol/src/browser.js";
import { RunnerAuxiliaryFrameFenceSchema } from "../packages/protocol/src/index.js";
import { createId } from "../packages/core/src/index.js";
import { callBrowserPoolAgentAdmin } from "../packages/browser-runtime-core/src/browser-pool-agent-wire.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import { BrowserModuleRelay } from "../packages/runner-client/src/browser-relay.js";
import { openPoolRelay, PoolRelayRefused } from "../packages/shared/src/poolRelay.js";
import { BrowserPoolCoordinator } from "../apps/host/src/browser/browser-pool-coordinator.js";
import {
  managedBrowserPool,
  RelayBrowserPoolRuntimeChannel,
} from "../apps/host/src/browser/managed-pool.js";
import { BrowserService } from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { RunnerBrowserHub } from "../apps/host/src/browser/runner-browser-hub.js";
import { RunnerBrowserRuntimeRouter } from "../apps/host/src/browser/runner-browser-runtime.js";
import { greenAt } from "./browser-pool-journey.test-support.js";

interface RealHost {
  readonly agentUrl: string;
  readonly adminUrl: string;
  readonly relay: { readonly host: string; readonly port: number };
  readonly hostId: string;
  /** PEM paths copied from the run host. */
  readonly hostKeyFile: string;
  readonly provisionerKeyFile: string;
  readonly profilePath: string;
  readonly egress: Record<string, string>;
  /** The page the proof types into: served by the run's own upstream proxy. */
  readonly formUrl: string;
  readonly saveAfterSeconds: number;
  readonly results: string;
}

const configFile = process.env.OPENSTEER_POOL_REAL_HOST;
const real = configFile ? (JSON.parse(readFileSync(configFile, "utf8")) as RealHost) : undefined;

function emit(row: Record<string, unknown>) {
  appendFileSync(real!.results, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

/** An Ed25519 key and a self-signed certificate, as the provisioner hands a Home its relay key. */
function relayIdentity(directory: string, name: string) {
  const key = join(directory, `${name}.pem`);
  const cert = join(directory, `${name}.crt`);
  execFileSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", key]);
  execFileSync("openssl", [
    "req",
    "-x509",
    "-new",
    "-key",
    key,
    "-subj",
    "/CN=home",
    "-days",
    "2",
    "-out",
    cert,
  ]);
  const pem = readFileSync(key, "utf8");
  return {
    key: pem,
    certificate: readFileSync(cert, "utf8"),
    spki: createPublicKey(createPrivateKey(pem))
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

const spkiOf = (key: KeyObject) =>
  createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");

describe.skipIf(!real)("our runtime in a real pool guest", () => {
  it("adopts a person's draft and an agent's page after a wake from disk, and refuses what it must", async () => {
    const r = real!;
    const directory = mkdtempSync(join(tmpdir(), "opensteer-pool-proof-"));
    const provisionerKey = createPrivateKey(readFileSync(r.provisionerKeyFile, "utf8"));
    const hostKey = createPublicKey(readFileSync(r.hostKeyFile, "utf8"));
    const admin = (request: Parameters<typeof callBrowserPoolAgentAdmin>[1]) =>
      callBrowserPoolAgentAdmin(
        { url: r.adminUrl, provisionerKey, host: r.hostId, hostKey, timeoutMs: 120_000 },
        request,
      );
    // The provisioner's part: the Home's keys, then the slot.
    const home = generateKeyPairSync("ed25519");
    const tickets = generateKeyPairSync("ed25519");
    const relayKey = relayIdentity(directory, "home-relay");
    const otherHome = relayIdentity(directory, "other-relay");
    const slotId = `proof-${Date.now()}`;
    const term = Math.floor(Date.now() / 1000);
    const created = await admin({
      op: "create",
      slotId,
      term,
      homeKey: spkiOf(home.privateKey),
      relayKey: relayKey.spki,
      ticketKey: { keyId: "host-v1", spki: spkiOf(tickets.privateKey) },
      guest: { vcpus: 2, memoryMib: 2048, profilePath: r.profilePath, egress: r.egress as never },
    });
    if (created.op !== "create")
      throw new Error(`The slot was not created: ${JSON.stringify(created)}`);
    const parts = managedBrowserPool({
      kind: "managed-pool",
      agentUrl: r.agentUrl,
      slotId,
      term,
      homeKey: home.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      agentKey: created.slot.controlKey,
      hostKey: spkiOf(hostKey),
      relay: { ...r.relay, relayKey: relayKey.key, relayCertificate: relayKey.certificate },
    });
    const endpoint = (overrides: Partial<Parameters<typeof openPoolRelay>[0]> = {}) => ({
      host: r.relay.host,
      port: r.relay.port,
      hostKey,
      controlKey: createPublicKey({
        key: Buffer.from(created.slot.controlKey, "base64"),
        format: "der",
        type: "spki",
      }),
      relayKey: relayKey.key,
      relayCertificate: relayKey.certificate,
      slot: slotId,
      term,
      ...overrides,
    });
    const refusal = (opening: Promise<{ socket: { destroy(): void } }>) =>
      opening.then(
        (tunnel) => {
          tunnel.socket.destroy();
          return "opened";
        },
        (error: unknown) => (error instanceof PoolRelayRefused ? error.code : String(error)),
      );
    // Every start's install, kept for the replay check at the end.
    const installs: { control: unknown; signature: string }[] = [];
    const apply = parts.controller.apply.bind(parts.controller);
    parts.controller.apply = async (call) => {
      const result = await apply(call);
      if (call.kind === "start" && result.control && result.signature)
        installs.push({ control: result.control, signature: result.signature });
      return result;
    };
    const fixture = await createStoreFixture();
    const task = await fixture.startRunFixture("pool-proof");
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", task.runnerId)
      .execute();
    const errors: string[] = [];
    const coordinator = new BrowserPoolCoordinator({
      database,
      runnerId: task.runnerId,
      runtimeId: "browser-main",
      slotId,
      term,
      runtime: parts.runtime,
      controller: parts.controller,
      retryMs: 500,
      callTimeoutMs: 60_000,
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    });
    // The guest starts (our runtime and Chromium boot) and the Home installs its fence.
    let mark = performance.now();
    await coordinator.recover();
    emit({
      kind: "proof-start",
      ms: Math.round(performance.now() - mark),
      state: parts.runtime.poolState()?.phase,
    });
    expect(parts.runtime.poolState()).toMatchObject({ phase: "running" });
    // The Runner's side: its browser relay over the bridge, which reaches the guest by tunnels.
    const bridge = new LocalBrowserRuntimeBridge({
      transport: parts.transport,
      runtimeId: "browser-main",
    });
    const capabilities = await bridge.capabilities();
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
    hub.attach(
      {
        id: "pool-runner",
        close: () => runner.detach(),
        send: (message: unknown) => runner.handleFrame(Buffer.from(JSON.stringify(message)), false),
      },
      {
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
          runtimeVersion: "proof",
          modules: {
            browser: {
              runtimeId: "browser-main",
              ...capabilities,
              cdpBoundary: 1,
              editing: 2,
              clipboard: true,
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
      } as never,
    );
    const router = new RunnerBrowserRuntimeRouter({ registry: hub } as never);
    // The pooled target is the Runner's, with this Home's coordinator for its pool.
    const targetResolver = {
      placements: (ids?: never) => router.placements(ids),
      resolve: (placement: never) => {
        const target = router.resolve(placement);
        return target
          ? Object.assign(Object.create(target), { loopbackPool: coordinator, main: true })
          : target;
      },
    };
    const service = new BrowserService({
      deploymentId: task.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      managedPoolTestRunner: task.runnerId,
      tabs: new TabStore(database),
      tabPlaces: { write: async () => false, notice: () => {} },
      repository: personalBrowserRepository(store),
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: tickets.privateKey }),
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      onSessionsChanged: () => {},
      targetResolver: targetResolver as never,
    });
    try {
      await service.initialize();
      // A person's tab with a form, typed into and not sent.
      const person = await service.openTab(task.userId, {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        placement: { kind: "runner", runnerId: task.runnerId },
        url: r.formUrl,
        idempotencyKey: "proof-person",
      } as never);
      const agentRun = {
        agentBindingId: `run:${task.runId}`,
        ownerId: task.userId,
        environmentId: task.environmentId,
        threadId: task.threadId,
      };
      const agent = await service.openAgentTab(agentRun, {
        identity: { kind: "guest", computer: task.runnerId },
        url: "https://example.com/",
        operationKey: "proof-agent",
      });
      const documentOf = (sessionId: string, tabId: string) =>
        service.pageInventory(BrowserSessionIdSchema.parse(sessionId))?.records.get(tabId as never)
          ?.documentId;
      await vi.waitFor(
        () => expect(documentOf(person.sessionId, person.tabId)).toEqual(expect.any(String)),
        { timeout: 60_000 },
      );
      await vi.waitFor(
        () => expect(documentOf(agent.sessionId, agent.tabId)).toEqual(expect.any(String)),
        { timeout: 60_000 },
      );
      const before = {
        person: documentOf(person.sessionId, person.tabId),
        agent: documentOf(agent.sessionId, agent.tabId),
      };
      const watch = () => {
        let open = true;
        const frames: Buffer[] = [];
        const attaching = service.attach(
          task.userId,
          BrowserSessionIdSchema.parse(person.sessionId),
          {
            id: `viewer-${randomUUID()}`,
            isOpen: () => open,
            close: () => {
              open = false;
            },
            send: async (data, binary) => {
              if (binary && Buffer.isBuffer(data)) frames.push(data);
            },
          },
          { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
        );
        return { attaching, frames, close: () => (open = false) };
      };
      const type = async (attached: Awaited<ReturnType<typeof service.attach>>, text: string) => {
        for (const character of text) {
          const key = {
            type: "input.key",
            surfaceId: person.tabId,
            key: character,
            code: character === " " ? "Space" : `Key${character.toUpperCase()}`,
            modifiers: [],
            text: character,
          };
          await attached.handle(Buffer.from(JSON.stringify({ ...key, action: "down" })), false);
          await attached.handle(Buffer.from(JSON.stringify({ ...key, action: "up" })), false);
        }
      };
      const greenFrame = async (frames: Buffer[]) => {
        for (const frame of frames.slice(-3)) if (await greenAt(frame, person.tabId)) return true;
        return false;
      };
      const first = watch();
      const viewing = await first.attaching;
      await viewing.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: person.tabId })),
        false,
      );
      await vi.waitFor(() => expect(first.frames.length).toBeGreaterThan(0), { timeout: 30_000 });
      await type(viewing, "unsent draft");
      // The page turns green only for exactly "unsent draftx": not yet.
      expect(await greenFrame(first.frames)).toBe(false);
      viewing.close();
      first.close();
      // The browser idles, parks, and is saved to disk.
      await vi.waitFor(() => expect(coordinator.gate.held).toBe(0), { timeout: 30_000 });
      mark = performance.now();
      expect(await coordinator.tryPark()).toBe("parked");
      emit({ kind: "proof-park", ms: Math.round(performance.now() - mark) });
      expect(await refusal(openPoolRelay(endpoint()))).toBe("parked");
      await vi.waitFor(
        async () => {
          const listed = await admin({ op: "list" });
          const summary =
            listed.op === "list" ? listed.slots.find((slot) => slot.slotId === slotId) : undefined;
          expect(JSON.stringify(summary)).toContain('"disk"');
        },
        { timeout: (r.saveAfterSeconds + 60) * 1000, interval: 1_000 },
      );
      // A second Home's key cannot open the relay to this slot, parked or not.
      expect(
        await refusal(
          openPoolRelay(
            endpoint({ relayKey: otherHome.key, relayCertificate: otherHome.certificate }),
          ),
        ),
      ).toBe("refused");
      // The wake: a viewer of the person's tab.
      mark = performance.now();
      const second = watch();
      const woken = await second.attaching;
      const wakeMs = performance.now() - mark;
      await woken.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: person.tabId })),
        false,
      );
      await vi.waitFor(() => expect(second.frames.length).toBeGreaterThan(0), { timeout: 30_000 });
      const firstFrameMs = performance.now() - mark;
      // The same documents were adopted.
      expect(documentOf(person.sessionId, person.tabId)).toBe(before.person);
      expect(documentOf(agent.sessionId, agent.tabId)).toBe(before.agent);
      // A new command reaches the page it was meant for, and the draft was there.
      await type(woken, "x");
      await vi.waitFor(
        async () => {
          await woken.handle(
            Buffer.from(JSON.stringify({ type: "stream.unsubscribe", surfaceId: person.tabId })),
            false,
          );
          await woken.handle(
            Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: person.tabId })),
            false,
          );
          expect(await greenFrame(second.frames)).toBe(true);
        },
        { timeout: 30_000, interval: 1_000 },
      );
      const edited = performance.now() - mark;
      const slot = await readBrowserPoolSlot(database, task.runnerId);
      emit({
        kind: "proof-wake",
        from: "disk",
        attach_ms: Math.round(wakeMs),
        first_frame_ms: Math.round(firstFrameMs),
        edited_frame_ms: Math.round(edited),
        same_documents: true,
        outcome: slot?.outcome ?? null,
      });
      expect(slot).toMatchObject({ phase: "running", epoch: 2 });
      // An HTTPS request from a page after the wake.
      const https = await service.openAgentTab(agentRun, {
        identity: { kind: "guest", computer: task.runnerId },
        url: "https://example.com/?after-wake",
        operationKey: "proof-https",
      });
      await vi.waitFor(
        () => expect(documentOf(https.sessionId, https.tabId)).toEqual(expect.any(String)),
        { timeout: 60_000 },
      );
      const record = service
        .pageInventory(BrowserSessionIdSchema.parse(https.sessionId))
        ?.records.get(https.tabId as never);
      emit({ kind: "proof-https", page: JSON.stringify(record).slice(0, 400) });
      woken.close();
      second.close();
    } finally {
      await service.close().catch(() => undefined);
      coordinator.close();
      runner.detach();
    }
    // An install replayed from an earlier start is refused by a fresh guest.
    const status = await parts.controller.status(slotId, term);
    const restarted = await parts.controller.apply({
      id: randomUUID(),
      slotId,
      term,
      kind: "stop",
      expect: {
        instance: status.instance,
        epoch: status.epoch,
        phase: status.phase,
        savedStateId: status.savedState?.id ?? null,
      },
    });
    const fresh = await parts.controller.apply({
      id: randomUUID(),
      slotId,
      term,
      kind: "start",
      expect: {
        instance: restarted.status.instance,
        epoch: restarted.status.epoch,
        phase: restarted.status.phase,
        savedStateId: null,
      },
    });
    expect(fresh.applied).toBe(true);
    const channel = new RelayBrowserPoolRuntimeChannel(parts.transport);
    const replay = await channel
      .controlPool(installs[0]!.control as never, Buffer.from(installs[0]!.signature, "base64"))
      .then(
        () => "applied",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    emit({ kind: "proof-replay", replay, state: channel.poolState()?.phase ?? null });
    expect(replay).toMatch(/superseded/u);
    expect(channel.poolState()?.phase).toBe("uninstalled");
    emit({ kind: "proof-errors", errors: [...new Set(errors)].slice(0, 20) });
    await admin({ op: "delete", slotId, term });
    await fixture.close();
  }, 900_000);
});
