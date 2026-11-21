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
import {
  BrowserSessionIdSchema,
  decodeBrowserFrameEnvelope,
} from "../packages/protocol/src/browser.js";
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
import {
  BrowserRuntimeRelayToHostMessageSchema,
  RunnerBrowserRuntimeRouter,
} from "../apps/host/src/browser/runner-browser-runtime.js";
import { createRequire } from "node:module";

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

/** Decodes a frame with the Host's own image library. */
const sharp = createRequire(new URL("../apps/host/package.json", import.meta.url))("sharp") as (
  input: Buffer,
) => {
  raw(): {
    toBuffer(options: { resolveWithObject: true }): Promise<{
      data: Buffer;
      info: { width: number; height: number; channels: number };
    }>;
  };
};

/** The page's colour at three quarters of its height, for this tab's frames only. */
async function colourAt(frame: Buffer, tabId: string): Promise<string | undefined> {
  const decoded = decodeBrowserFrameEnvelope(frame);
  if (decoded.header.surfaceId !== tabId) return undefined;
  const { data, info } = await sharp(Buffer.from(decoded.data))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(info.height * 0.75) * info.width + (info.width >> 1)) * info.channels;
  const [red, green, blue] = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
  if (green > 90 && red < 70 && blue < 110) return "green";
  if (blue > 150 && red < 80 && green < 120) return "blue";
  if (red > 230 && green > 230 && blue > 230) return "white";
  return "other";
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
  (key.type === "public" ? key : createPublicKey(key))
    .export({ format: "der", type: "spki" })
    .toString("base64");

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
    const report = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      process.stderr.write(`POOLPROOF ${message}\n`);
    };
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
      onError: (error) => report(error),
    });
    // The guest starts (our runtime and Chromium boot) and the Home installs its fence.
    let mark = performance.now();
    // The coordinator reads the runtime's state at once; the agent's status says what it is.
    await parts.runtime.observeGuest(await parts.controller.status(slotId, term));
    process.stderr.write("POOLPROOF recover\n");
    await coordinator.recover();
    process.stderr.write("POOLPROOF recovered\n");
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
    // The proof uses guest identities: the Runner does not offer local profiles, so the Home
    // has no profile inventory to reconcile first (profiles in a pooled guest are not proven here).
    const { localProfileStorage: _profiles, ...capabilities } = await bridge.capabilities();
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
      send: (message: unknown) => runner.handleFrame(Buffer.from(JSON.stringify(message)), false),
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
        runtimeVersion: "proof",
        modules: {
          browser: {
            runtimeId: "browser-main",
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
    await runner.attach({
      fence,
      browserWireVersion: 2,
      // The pooled runtime trusts only its boot's ticket key; this is the same key.
      browserAttachPublicKeys: [
        {
          keyId: "host-v1",
          publicKeyPem: createPublicKey(tickets.privateKey)
            .export({ type: "spki", format: "pem" })
            .toString(),
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
    const router = new RunnerBrowserRuntimeRouter({ registry: hub } as never);
    // The pooled target is the Runner's, with this Home's coordinator for its pool.
    const targetResolver = {
      placements: (ids?: never) => router.placements(ids),
      resolve: (placement: never) => {
        const target = router.resolve(placement);
        return target ? Object.assign(Object.create(target), { main: true }) : target;
      },
    };
    const service = new BrowserService({
      deploymentId: task.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      pools: new Map([[task.runnerId, coordinator]]),
      tabs: new TabStore(database),
      tabPlaces: { write: async () => false, notice: () => {} },
      repository: personalBrowserRepository(store),
      signer: new BrowserAttachTicketSigner({ keyId: "host-v1", privateKey: tickets.privateKey }),
      onError: (error) => report(error),
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
      const recordOf = (sessionId: string, tabId: string) =>
        JSON.stringify(
          service
            .pageInventory(BrowserSessionIdSchema.parse(sessionId))
            ?.records.get(tabId as never) ?? null,
        );
      // Each tab is on its own page (not the blank document before it) before anything is kept.
      await vi.waitFor(
        () => expect(recordOf(person.sessionId, person.tabId)).toContain("Pool proof form"),
        {
          timeout: 60_000,
        },
      );
      await vi.waitFor(
        () => expect(recordOf(agent.sessionId, agent.tabId)).toContain("Example Domain"),
        {
          timeout: 60_000,
        },
      );
      emit({ kind: "proof-pages", person: recordOf(person.sessionId, person.tabId).slice(0, 300) });
      const before = {
        person: documentOf(person.sessionId, person.tabId),
        agent: documentOf(agent.sessionId, agent.tabId),
      };
      // A viewer that gives each frame's credit back, so frames follow the page's changes, and
      // that never leaves a stream with keys in flight (leaving cancels unapplied input).
      const watch = () => {
        let open = true;
        const frames: Buffer[] = [];
        let handle: ((message: Record<string, unknown>) => Promise<void>) | undefined;
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
              if (!binary || !Buffer.isBuffer(data)) return;
              frames.push(data);
              const token = decodeBrowserFrameEnvelope(data).header.watchToken;
              if (token)
                queueMicrotask(() => void handle?.({ type: "stream.ack", token }).catch(() => {}));
            },
          },
          { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
        );
        void attaching.then(
          (attached) => {
            handle = (message) => attached.handle(Buffer.from(JSON.stringify(message)), false);
          },
          () => {},
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
      // The page is blue for exactly "unsent draft" and green for exactly "unsent draftx".
      const latestColour = async (frames: Buffer[]) => {
        for (const frame of frames.toReversed()) {
          const colour = await colourAt(frame, person.tabId);
          if (colour) return colour;
        }
        return undefined;
      };
      const first = watch();
      const viewing = await first.attaching;
      await viewing.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: person.tabId })),
        false,
      );
      await vi.waitFor(() => expect(first.frames.length).toBeGreaterThan(0), { timeout: 30_000 });
      await type(viewing, "unsent draft");
      // The draft is on the page before anything is parked.
      await vi.waitFor(async () => expect(await latestColour(first.frames)).toBe("blue"), {
        timeout: 30_000,
        interval: 250,
      });
      viewing.close();
      first.close();
      // The agent's Run lets go of its page (the ordinary way), then the browser idles, parks,
      // and is saved to disk.
      await service.detachAgentSessionsForBinding(agentRun.agentBindingId);
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
      // The draft came back as it was: the woken page is blue.
      await vi.waitFor(async () => expect(await latestColour(second.frames)).toBe("blue"), {
        timeout: 30_000,
        interval: 250,
      });
      // A new key reaches the page it was meant for: with the draft it makes "unsent draftx".
      await type(woken, "x");
      await vi.waitFor(async () => expect(await latestColour(second.frames)).toBe("green"), {
        timeout: 30_000,
        interval: 250,
      });
      const edited = performance.now() - mark;
      const slot = await readBrowserPoolSlot(database, task.runnerId);
      emit({
        kind: "proof-wake",
        from: "disk",
        attach_ms: Math.round(wakeMs),
        first_frame_ms: Math.round(firstFrameMs),
        edited_frame_ms: Math.round(edited),
        same_documents: true,
        draft_before_park: true,
        draft_after_wake: true,
        new_key_after_wake: true,
        outcome: slot?.outcome ?? null,
      });
      expect(slot).toMatchObject({ phase: "running", epoch: 2 });
      // An HTTPS request from a page after the wake.
      // (The agent's Run let go before the park, so this page is a person's.)
      const https = await service.openTab(task.userId, {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        placement: { kind: "runner", runnerId: task.runnerId },
        url: "https://example.com/?after-wake",
        idempotencyKey: "proof-https",
      } as never);
      await vi.waitFor(
        () => expect(recordOf(https.sessionId, https.tabId)).toContain("Example Domain"),
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
