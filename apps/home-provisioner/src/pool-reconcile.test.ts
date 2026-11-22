import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  browserPoolAgentAdminBytes,
  browserPoolAgentAdminReplyBytes,
  browserPoolAgentSignatureHeader,
  BrowserPoolAgentUnavailable,
  signBrowserPoolAgentBytes,
  verifyBrowserPoolAgentBytes,
  type BrowserPoolAgentAdminEnvelope,
  type BrowserPoolAgentAdminReply,
  type BrowserPoolAgentSlotSummary,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import {
  BrowserPoolHostDesiredSchema,
  BrowserPoolHostIdSchema,
  BrowserPoolSlotDesiredSchema,
  BrowserPoolSlotIdSchema,
  CloudComputerIdSchema,
  type BrowserPoolHostCheck,
  type BrowserPoolHostDesired,
  type BrowserPoolHostId,
  type BrowserPoolHostReport,
  type BrowserPoolSlotBumpTermRequest,
  type BrowserPoolSlotCheck,
  type BrowserPoolSlotDesired,
  type BrowserPoolSlotId,
  type BrowserPoolSlotReport,
} from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import type { PoolAccountApi } from "./account.js";
import { ComputeFake } from "./google-compute.test-support.js";
import { ProviderRateLimited, RemoteRequestError } from "./http.js";
import { httpPoolAgentClient } from "./pool-agent-client.js";
import { PoolReconciler } from "./pool-reconcile.js";

const sha = "a".repeat(64);
const hostId = BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111");
const slotId = BrowserPoolSlotIdSchema.parse("bps_22222222-2222-4222-8222-222222222222");
const computerId = CloudComputerIdSchema.parse("cc_33333333-3333-4333-8333-333333333333");

const release = {
  version: "1.0.0",
  installerUrl: "https://releases.example.test/pool-host.sh",
  installerSha256: sha,
  artifacts: {
    agentUrl: "https://releases.example.test/pool-agent.mjs",
    agentSha256: sha,
    relayUrl: "https://releases.example.test/pool-relay.mjs",
    relaySha256: sha,
    rootfsUrl: "https://releases.example.test/rootfs.ext4",
    rootfsSha256: sha,
    kernelUrl: "https://releases.example.test/vmlinux",
    kernelSha256: sha,
    egressUrl: "https://releases.example.test/egress.tar.gz",
    egressSha256: sha,
  },
};

function ed25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    privateKey,
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/**
 * Signed fake pool agent that speaks the exact `browser-pool-agent-wire` protocol,
 * including `guest.profileMib`, `eraseProfile`, `profileErased`, `credentialsErased`,
 * signed refusals (`conflict`, `unknown-slot`, `unavailable`), forged signatures, and lost replies.
 */
class FakePoolAgent {
  readonly slots = new Map<
    string,
    {
      slotId: string;
      term: number;
      homeKey: string;
      controlKey: string;
      profileMib: number;
      profileExists: boolean;
      credentialsExist: boolean;
    }
  >();
  readonly calls: string[] = [];
  nextReply:
    | {
        readonly op: "create" | "replace-key" | "delete" | "list";
        readonly mode:
          | "lost-after-apply"
          | "lost-before-apply"
          | "signed-unavailable-after-apply"
          | "signed-conflict"
          | "unsigned-bad-request"
          | "forged-signature"
          | "partial-erase-no-credentials";
      }
    | undefined;
  hostPrivateKey: KeyObject;
  readonly provisionerPublicKey: KeyObject;
  readonly expectedHostId: string;

  constructor(options: {
    hostId: string;
    hostPrivateKey: KeyObject;
    provisionerPublicKey: KeyObject;
  }) {
    this.expectedHostId = options.hostId;
    this.hostPrivateKey = options.hostPrivateKey;
    this.provisionerPublicKey = options.provisionerPublicKey;
  }

  readonly fetch: typeof fetch = async (_input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const envelope = JSON.parse(rawBody) as BrowserPoolAgentAdminEnvelope;
    const reqBytes = browserPoolAgentAdminBytes(envelope);
    const sig = new Headers(init?.headers).get(browserPoolAgentSignatureHeader) ?? "";
    expect(verifyBrowserPoolAgentBytes(reqBytes, this.provisionerPublicKey, sig)).toBe(true);
    expect(envelope.host).toBe(this.expectedHostId);

    const op = envelope.request.op;
    this.calls.push(op);

    const fault = this.nextReply?.op === op ? this.nextReply : undefined;
    if (fault) this.nextReply = undefined;

    if (fault?.mode === "lost-before-apply") {
      throw new Error("socket hang up before agent handled request");
    }
    if (fault?.mode === "unsigned-bad-request") {
      const reply: BrowserPoolAgentAdminReply = {
        op: "refused",
        code: "bad-request",
        message: "unsigned bad request",
      };
      return Response.json({ reply }, { status: 400 });
    }
    if (fault?.mode === "signed-conflict") {
      const reply: BrowserPoolAgentAdminReply = {
        op: "refused",
        code: "conflict",
        message: "slot conflict",
      };
      return this.#signed(reqBytes, reply, 409);
    }

    let reply: BrowserPoolAgentAdminReply;
    if (envelope.request.op === "list") {
      reply = {
        op: "list",
        slots: [...this.slots.values()].map(toSummary),
      };
    } else if (envelope.request.op === "create") {
      const req = envelope.request;
      expect(req.guest.profilePath).toBeUndefined();
      expect(req.guest.profileMib).toBeGreaterThanOrEqual(64);
      const existing = this.slots.get(req.slotId);
      if (existing && (existing.term !== req.term || existing.homeKey !== req.homeKey)) {
        return this.#signed(
          reqBytes,
          { op: "refused", code: "conflict", message: "slot exists at different term or key" },
          409,
        );
      }
      const created = existing ?? {
        slotId: req.slotId,
        term: req.term,
        homeKey: req.homeKey,
        controlKey: ed25519Pair().spki,
        profileMib: req.guest.profileMib!,
        profileExists: true,
        credentialsExist: true,
      };
      this.slots.set(req.slotId, created);
      reply = { op: "create", slot: toSummary(created) };
    } else if (envelope.request.op === "replace-key") {
      const req = envelope.request;
      const existing = this.slots.get(req.slotId);
      if (!existing) {
        return this.#signed(
          reqBytes,
          { op: "refused", code: "unknown-slot", message: "slot not found" },
          404,
        );
      }
      if (req.term < existing.term) {
        return this.#signed(
          reqBytes,
          { op: "refused", code: "conflict", message: "stale term" },
          409,
        );
      }
      existing.term = req.term;
      existing.homeKey = req.homeKey;
      reply = { op: "replace-key", slot: toSummary(existing) };
    } else {
      const req = envelope.request;
      const existing = this.slots.get(req.slotId);
      if (existing && existing.term !== req.term) {
        return this.#signed(
          reqBytes,
          { op: "refused", code: "conflict", message: "term mismatch on delete" },
          409,
        );
      }
      this.slots.delete(req.slotId);
      if (fault?.mode === "partial-erase-no-credentials") {
        reply = {
          op: "delete",
          slotId: req.slotId,
          erased: true,
          ...(req.eraseProfile ? { profileErased: true as const } : {}),
        };
      } else {
        reply = {
          op: "delete",
          slotId: req.slotId,
          erased: true,
          ...(req.eraseProfile ? { profileErased: true as const } : {}),
          credentialsErased: true as const,
        };
      }
    }

    if (fault?.mode === "lost-after-apply") {
      throw new Error("socket hang up after agent applied request");
    }
    if (fault?.mode === "signed-unavailable-after-apply") {
      return this.#signed(
        reqBytes,
        { op: "refused", code: "unavailable", message: "host busy after partial apply" },
        503,
      );
    }
    if (fault?.mode === "forged-signature") {
      const wrongKey = ed25519Pair().privateKey;
      const forgedSig = signBrowserPoolAgentBytes(
        browserPoolAgentAdminReplyBytes(reqBytes, reply),
        wrongKey,
      );
      return Response.json({ reply, signature: forgedSig }, { status: 200 });
    }
    return this.#signed(reqBytes, reply, 200);
  };

  #signed(reqBytes: Uint8Array, reply: BrowserPoolAgentAdminReply, status: number) {
    const signature = signBrowserPoolAgentBytes(
      browserPoolAgentAdminReplyBytes(reqBytes, reply),
      this.hostPrivateKey,
    );
    return Response.json({ reply, signature }, { status });
  }
}

function toSummary(entry: {
  slotId: string;
  term: number;
  controlKey: string;
}): BrowserPoolAgentSlotSummary {
  return {
    slotId: entry.slotId,
    term: entry.term,
    controlKey: entry.controlKey,
    status: {
      slotId: entry.slotId,
      term: entry.term,
      instance: null,
      epoch: null,
      phase: "stopped",
      savedState: null,
    },
  };
}

function createHarness() {
  const compute = new ComputeFake();
  const provider = compute.adapter();
  const provisionerKeys = ed25519Pair();
  const hostKeys1 = ed25519Pair();
  const relayKeys1 = ed25519Pair();
  const agent = new FakePoolAgent({
    hostId,
    hostPrivateKey: hostKeys1.privateKey,
    provisionerPublicKey: provisionerKeys.publicKey,
  });

  let nowMs = 1_000_000;
  const hostReports: BrowserPoolHostReport[] = [];
  const slotReports: BrowserPoolSlotReport[] = [];
  const onError = vi.fn();

  const hosts = new Map<BrowserPoolHostId, BrowserPoolHostDesired>();
  const slots = new Map<BrowserPoolSlotId, BrowserPoolSlotDesired>();

  const defaultHost = (): BrowserPoolHostDesired =>
    BrowserPoolHostDesiredSchema.parse({
      id: hostId,
      generation: 1,
      revision: 1,
      state: "active",
      region: "us-central1-a",
      machineType: "n2-standard-8",
      slotsCapacity: 4,
      profileDiskName: `osp-disk-${hostId.slice("ph_".length)}`,
      profileDiskSizeGb: 500,
      release,
      enrolled: false,
      bootstrapToken: "b".repeat(43),
      readinessStartedAt: new Date(nowMs).toISOString(),
    });

  const defaultSlot = (host: BrowserPoolHostDesired): BrowserPoolSlotDesired =>
    BrowserPoolSlotDesiredSchema.parse({
      slotId,
      computerId,
      hostId: host.id,
      hostGeneration: host.generation,
      hostInternalIp: host.internalIp!,
      hostKey: host.hostKey!,
      term: 1,
      revision: 1,
      state: "active",
      phase: "provisioning",
      keys: {
        homeKey: ed25519Pair().spki,
        relayKey: ed25519Pair().spki,
        ticketKey: { keyId: "tk-1", spki: ed25519Pair().spki },
      },
      guest: { vcpus: 2, memoryMib: 2048, profileMib: 2048 },
      slotErased: false,
      profileErased: false,
      credentialsErased: false,
    });

  let checkHostOverride: ((id: BrowserPoolHostId, check: BrowserPoolHostCheck) => Promise<boolean> | boolean) | undefined;

  const account: PoolAccountApi = {
    desiredHosts: vi.fn(async () => [...hosts.values()]),
    checkHost: vi.fn(async (id: BrowserPoolHostId, check: BrowserPoolHostCheck) => {
      if (checkHostOverride) return checkHostOverride(id, check);
      const row = hosts.get(id);
      if (check.operation === "orphan") return !row;
      if (!row) return false;
      if (check.operation === "finish-provider-write") {
        row.pendingProviderWrites = (row.pendingProviderWrites ?? []).filter(
          (w) => w.token !== check.token,
        );
        return true;
      }
      if (row.revision !== check.revision) return false;
      if (check.operation === "begin-provider-write") {
        const list = row.pendingProviderWrites ?? [];
        if (list.some((w) => w.kind === check.write.kind)) return false;
        row.pendingProviderWrites = [
          ...list,
          { ...check.write, dispatched: false, recoverAfter: new Date(nowMs + 180_000).toISOString() },
        ];
        return true;
      }
      if (check.operation === "send-provider-write") {
        row.pendingProviderWrites = (row.pendingProviderWrites ?? []).map((w) =>
          w.token === check.token
            ? { ...w, dispatched: true, recoverAfter: new Date(nowMs + 900_000).toISOString() }
            : w,
        );
        return true;
      }
      if (check.operation === "recover-provider-write") {
        const entry = (row.pendingProviderWrites ?? []).find((w) => w.token === check.token);
        if (!entry) return true;
        if (!entry.recoverAfter || Date.parse(entry.recoverAfter) > nowMs) return false;
        row.pendingProviderWrites = (row.pendingProviderWrites ?? []).filter(
          (w) => w.token !== check.token,
        );
        return true;
      }
      return true;
    }),
    reportHost: vi.fn(async (report: BrowserPoolHostReport) => {
      hostReports.push(report);
      const row = hosts.get(report.id);
      if (!row || row.revision !== report.revision || row.generation !== report.generation) {
        return false;
      }
      if (report.phase === "deleted") {
        hosts.delete(report.id);
        return true;
      }
      hosts.set(report.id, {
        ...row,
        ...(report.providerServerRef ? { providerServerRef: report.providerServerRef } : {}),
        ...(report.profileDiskRef ? { profileDiskRef: report.profileDiskRef } : {}),
        ...(report.internalIp ? { internalIp: report.internalIp } : {}),
      });
      return true;
    }),
    desiredSlots: vi.fn(async () => [...slots.values()]),
    checkSlot: vi.fn(async (id: BrowserPoolSlotId, check: BrowserPoolSlotCheck) => {
      const row = slots.get(id);
      if (!row) return false;
      if (check.operation === "finish-agent-write") {
        row.pendingAgentWrites = (row.pendingAgentWrites ?? []).filter(
          (w) => w.token !== check.token,
        );
        return true;
      }
      if (row.revision !== check.revision) return false;
      if (check.operation === "begin-agent-write") {
        const list = row.pendingAgentWrites ?? [];
        if (list.some((w) => w.kind === check.write.kind)) return false;
        row.pendingAgentWrites = [
          ...list,
          { ...check.write, dispatched: false, recoverAfter: new Date(nowMs + 180_000).toISOString() },
        ];
        return true;
      }
      if (check.operation === "send-agent-write") {
        row.pendingAgentWrites = (row.pendingAgentWrites ?? []).map((w) =>
          w.token === check.token
            ? { ...w, dispatched: true, recoverAfter: new Date(nowMs + 900_000).toISOString() }
            : w,
        );
        return true;
      }
      if (check.operation === "recover-agent-write") {
        const entry = (row.pendingAgentWrites ?? []).find((w) => w.token === check.token);
        if (!entry) return true;
        if (!entry.recoverAfter || Date.parse(entry.recoverAfter) > nowMs) return false;
        row.pendingAgentWrites = (row.pendingAgentWrites ?? []).filter(
          (w) => w.token !== check.token,
        );
        return true;
      }
      return true;
    }),
    bumpSlotTerm: vi.fn(async (id: BrowserPoolSlotId, input: BrowserPoolSlotBumpTermRequest) => {
      const row = slots.get(id);
      if (!row || row.revision !== input.revision || row.term !== input.expectedTerm) {
        return { bumped: false };
      }
      const nextTerm = row.term + 1;
      const nextRev = row.revision + 1;
      slots.set(id, {
        ...row,
        term: nextTerm,
        revision: nextRev,
        appliedTerm: undefined,
        appliedHostGeneration: undefined,
        controlKey: undefined,
        phase: "provisioning",
      });
      return { bumped: true, term: nextTerm, revision: nextRev };
    }),
    reportSlot: vi.fn(async (report: BrowserPoolSlotReport) => {
      slotReports.push(report);
      const row = slots.get(report.slotId);
      if (!row || row.revision !== report.revision || row.term !== report.term) return false;
      if (report.phase === "deleted") {
        slots.delete(report.slotId);
        return true;
      }
      slots.set(report.slotId, {
        ...row,
        phase: report.phase,
        ...(report.phase === "ready"
          ? { appliedTerm: report.term, appliedHostGeneration: row.hostGeneration }
          : {}),
        ...(report.controlKey ? { controlKey: report.controlKey } : {}),
        slotErased: report.slotErased,
        profileErased: report.profileErased,
        credentialsErased: report.credentialsErased,
      });
      return true;
    }),
  };

  const agentClient = httpPoolAgentClient({
    provisionerKey: provisionerKeys.privateKey,
    fetch: agent.fetch,
    timeoutMs: 2_000,
    now: () => nowMs,
  });

  const reconciler = new PoolReconciler({
    account,
    provider,
    agent: agentClient,
    accountOrigin: new URL("https://account.example.test"),
    image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
    pool: {
      provisionerPrivateKey: provisionerKeys.privateKey,
      provisionerPublicKeySpki: provisionerKeys.spki,
      homeCidr: "10.40.0.0/20",
      provisionerCidr: "10.50.0.0/24",
      localSsdCount: 1,
      bootDiskSizeGb: 40,
      profileDiskType: "pd-ssd",
      agentPort: 7310,
      adminPort: 7311,
      relayPort: 7312,
    },
    readinessTimeoutMs: 600_000,
    orphanGraceMs: 300_000,
    concurrency: 2,
    onError,
    now: () => nowMs,
  });

  return {
    compute,
    provider,
    agent,
    account,
    reconciler,
    hosts,
    slots,
    hostReports,
    slotReports,
    hostKeys1,
    relayKeys1,
    onError,
    defaultHost,
    defaultSlot,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setCheckHostOverride: (fn: typeof checkHostOverride) => {
      checkHostOverride = fn;
    },
  };
}

describe("PoolReconciler (hosts and slots)", () => {
  it("provisions durable disk + VM, opens bootstrap metadata gate, scrubs metadata on enrolment, creates slot, rotates keys (W5), converges on host replacement (S6+S7), and settles deletion only with full W10 evidence", async () => {
    const h = createHarness();
    const signal = new AbortController().signal;
    const host = h.defaultHost();
    h.hosts.set(hostId, host);

    // Pass 1: creates disk + VM, reports provisioning, enables metadata gate, stays booting until enrolled.
    await h.reconciler.pass(signal);
    expect(h.compute.disks.size).toBe(1);
    expect(h.compute.instances.size).toBe(1);
    const vm = [...h.compute.instances.values()][0]!;
    expect(vm.metadata.items.some((i) => i.key === "opensteer-bootstrap-ready")).toBe(true);
    expect(h.hostReports.at(-1)?.phase).toBe("booting");

    // Simulate host completing enrolment with Account (W3).
    const enrolledHost = h.hosts.get(hostId)!;
    h.hosts.set(hostId, {
      ...enrolledHost,
      revision: enrolledHost.revision + 1,
      enrolled: true,
      bootstrapToken: undefined,
      hostKey: h.hostKeys1.spki,
      relayKey: h.relayKeys1.spki,
    });

    // Pass 2: scrubs user-data metadata, verifies agent list with hostKey, reports host ready.
    await h.reconciler.pass(signal);
    expect(vm.metadata.items.some((i) => i.key === "user-data")).toBe(false);
    expect(h.hostReports.at(-1)).toMatchObject({ id: hostId, phase: "ready" });

    // Place slot 1 on ready host -> Pass 3 creates slot at term 1 (using profileMib, no profilePath).
    const slot = h.defaultSlot(h.hosts.get(hostId)!);
    h.slots.set(slotId, slot);
    await h.reconciler.pass(signal);
    expect(h.agent.slots.get(slotId)?.term).toBe(1);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      term: 1,
      phase: "ready",
      controlKey: h.agent.slots.get(slotId)!.controlKey,
    });

    // W5: Home rotates keys (term 1 -> 2) -> Pass 4 sends replace-key.
    const curSlot = h.slots.get(slotId)!;
    h.slots.set(slotId, {
      ...curSlot,
      term: 2,
      revision: curSlot.revision + 1,
      phase: "updating_keys",
      keys: {
        homeKey: ed25519Pair().spki,
        relayKey: ed25519Pair().spki,
        ticketKey: { keyId: "tk-2", spki: ed25519Pair().spki },
      },
    });
    await h.reconciler.pass(signal);
    expect(h.agent.slots.get(slotId)?.term).toBe(2);
    expect(h.slotReports.at(-1)).toMatchObject({ slotId, term: 2, phase: "ready" });

    // S6 + S7 + W1: Replace host (generation 1 -> 2). Old VM deleted, durable disk kept, new VM created.
    const hostKeys2 = ed25519Pair();
    const relayKeys2 = ed25519Pair();
    const preReplace = h.hosts.get(hostId)!;
    h.hosts.set(hostId, {
      ...preReplace,
      generation: 2,
      revision: preReplace.revision + 1,
      previousProviderServerRef: preReplace.providerServerRef,
      providerServerRef: undefined,
      internalIp: undefined,
      enrolled: false,
      hostKey: undefined,
      relayKey: undefined,
      bootstrapToken: "c".repeat(43),
    });
    // Replacement VM comes up fresh with NO slots (settled S6) and new host key.
    h.agent.slots.clear();
    h.agent.hostPrivateKey = hostKeys2.privateKey;

    await h.reconciler.pass(signal);
    expect(h.compute.disks.size).toBe(1); // durable disk kept!
    expect(h.compute.instances.size).toBe(1);
    expect([...h.compute.instances.keys()][0]).toMatch(/-2$/u);

    // Enrol replacement host gen 2.
    const gen2 = h.hosts.get(hostId)!;
    h.hosts.set(hostId, {
      ...gen2,
      revision: gen2.revision + 1,
      enrolled: true,
      bootstrapToken: undefined,
      hostKey: hostKeys2.spki,
      relayKey: relayKeys2.spki,
    });
    // Update slot's host view to gen 2.
    const slotGen2 = h.slots.get(slotId)!;
    h.slots.set(slotId, {
      ...slotGen2,
      hostGeneration: 2,
      hostInternalIp: gen2.internalIp!,
      hostKey: hostKeys2.spki,
    });

    // Pass: host gen 2 becomes ready, reconciler sees slot absent in agent list -> calls bumpSlotTerm (2 -> 3) -> creates at term 3!
    await h.reconciler.pass(signal);
    expect(h.account.bumpSlotTerm).toHaveBeenCalledTimes(1);
    expect(h.agent.slots.get(slotId)?.term).toBe(3);
    expect(h.slotReports.at(-1)).toMatchObject({ slotId, term: 3, phase: "ready" });

    // W10: Delete slot -> partial erasure (credentialsErased missing) MUST NOT settle deletion.
    const delSlot = h.slots.get(slotId)!;
    h.slots.set(slotId, {
      ...delSlot,
      state: "deleting",
      phase: "deleting",
      revision: delSlot.revision + 1,
    });
    h.agent.nextReply = { op: "delete", mode: "partial-erase-no-credentials" };
    await h.reconciler.pass(signal);
    expect(h.slots.has(slotId)).toBe(true);
    expect(h.slotReports.at(-1)).toMatchObject({
      phase: "deleting",
      slotErased: true,
      profileErased: true,
      credentialsErased: false,
    });

    // Next pass: agent confirms all 3 (erased + profileErased + credentialsErased) -> settles to deleted!
    await h.reconciler.pass(signal);
    expect(h.slots.has(slotId)).toBe(false);
    expect(h.slotReports.at(-1)).toMatchObject({
      phase: "deleted",
      controlKey: null,
      slotErased: true,
      profileErased: true,
      credentialsErased: true,
    });

    // Delete host -> removes both VM and durable disk, settles deleted only when both are gone.
    const delHost = h.hosts.get(hostId)!;
    h.hosts.set(hostId, {
      ...delHost,
      state: "deleted",
      revision: delHost.revision + 1,
      bootstrapToken: undefined,
    });
    await h.reconciler.pass(signal);
    expect(h.compute.instances.size).toBe(0);
    expect(h.compute.disks.size).toBe(0);
    expect(h.hosts.has(hostId)).toBe(false);
    expect(h.hostReports.at(-1)).toMatchObject({
      phase: "deleted",
      providerServerRef: null,
      profileDiskRef: null,
      internalIp: null,
    });
  });

  it("keeps unknown agent outcomes unknown (lost reply, signed unavailable, forged signature) and recovers via list without failing or duplicating", async () => {
    const h = createHarness();
    const signal = new AbortController().signal;
    const readyHost = BrowserPoolHostDesiredSchema.parse({
      ...h.defaultHost(),
      enrolled: true,
      bootstrapToken: undefined,
      providerServerRef: `osp-${hostId.replace("_", "-")}-1/1001`,
      profileDiskRef: `osp-disk-${hostId.slice("ph_".length)}/9001`,
      internalIp: "10.40.0.10",
      hostKey: h.hostKeys1.spki,
      relayKey: h.relayKeys1.spki,
    });
    h.slots.set(slotId, h.defaultSlot(readyHost));

    // 1. Lost create reply after agent applied -> stays unknown, journal stays pending, NO failed report.
    h.agent.nextReply = { op: "create", mode: "lost-after-apply" };
    await h.reconciler.pass(signal);
    expect(h.slotReports).toEqual([]);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toHaveLength(1);

    // Next pass: agent list shows slot at term 1 -> finishes journal and reports ready without re-creating!
    await h.reconciler.pass(signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toEqual([]);
    expect(h.slotReports.at(-1)).toMatchObject({ slotId, term: 1, phase: "ready" });

    // 2. Signed `unavailable` on replace-key does NOT prove nothing happened -> stays unknown, recovered via list!
    const s = h.slots.get(slotId)!;
    h.slots.set(slotId, { ...s, term: 2, revision: s.revision + 1, phase: "updating_keys" });
    h.agent.nextReply = { op: "replace-key", mode: "signed-unavailable-after-apply" };
    await h.reconciler.pass(signal);
    expect(h.slotReports.at(-1)?.phase).toBe("ready"); // still from term 1; NO failed report!
    expect(h.slots.get(slotId)?.pendingAgentWrites).toHaveLength(1);

    await h.reconciler.pass(signal);
    expect(h.slotReports.at(-1)).toMatchObject({ slotId, term: 2, phase: "ready" });

    // 3. Forged signature on list -> rejected as unavailable (unknown), leaves slot untouched.
    const countBefore = h.slotReports.length;
    h.agent.nextReply = { op: "list", mode: "forged-signature" };
    await h.reconciler.pass(signal);
    expect(h.slotReports).toHaveLength(countBefore);
    expect(h.onError).toHaveBeenCalled();

    // 4. Definite signed `conflict` refusal records "did not happen" (clears journal & reports failed).
    const s3 = h.slots.get(slotId)!;
    h.slots.set(slotId, { ...s3, term: 3, revision: s3.revision + 1, phase: "updating_keys" });
    h.agent.nextReply = { op: "replace-key", mode: "signed-conflict" };
    await h.reconciler.pass(signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toEqual([]);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      term: 3,
      phase: "failed",
      lastError: "The pool host rejected the slot administration request.",
    });
  });

  it("handles lost VM create response without duplicating, respects rate-limit backoff, enforces readiness deadline, and sweeps orphaned VMs and disks after grace period", async () => {
    const h = createHarness();
    const signal = new AbortController().signal;
    const host = h.defaultHost();
    h.hosts.set(hostId, host);

    // 1. Lost Compute create reply -> stays provisioning (unknown), never duplicates VM.
    h.compute.nextInsert = "lost";
    await h.reconciler.pass(signal);
    expect(h.compute.instances.size).toBe(1);
    expect(h.hostReports.at(-1)?.phase).toBe("provisioning");

    // Next pass observes the already-created VM and clears the pending create write.
    await h.reconciler.pass(signal);
    expect(h.compute.instances.size).toBe(1);
    expect(h.hosts.get(hostId)?.pendingProviderWrites).toEqual([]);
    expect(h.hostReports.at(-1)?.phase).toBe("booting");

    // 2. Readiness deadline exceeded while unenrolled -> reports failed with deadline error.
    h.advance(601_000);
    await h.reconciler.pass(signal);
    expect(h.hostReports.at(-1)).toMatchObject({
      id: hostId,
      phase: "failed",
      lastError: "The pool host did not become ready before its deadline.",
    });

    // 3. Orphan sweep: remove host from Account desired state; stays untouched before grace, swept after grace + fresh orphan check.
    h.hosts.delete(hostId);
    h.advance(61_000); // trigger sweep (first sighting)
    await h.reconciler.pass(signal);
    expect(h.compute.instances.size).toBe(1);
    expect(h.compute.disks.size).toBe(1);

    h.advance(301_000); // past orphanGraceMs
    await h.reconciler.pass(signal);
    expect(h.compute.instances.size).toBe(0);
    expect(h.compute.disks.size).toBe(0);
  });

  it("aborts pass with ProviderRateLimited on Compute 403/429 without marking host failed", async () => {
    const h = createHarness();
    const signal = new AbortController().signal;
    h.hosts.set(hostId, h.defaultHost());
    h.compute.rateLimitRequests = 1;
    await expect(h.reconciler.pass(signal)).rejects.toBeInstanceOf(ProviderRateLimited);
    expect(h.hostReports.some((r) => r.phase === "failed")).toBe(false);
  });

  it("aborts pass on Account 401/403 lease refusal and never deletes a host while Account or agent still has a live slot", async () => {
    const h = createHarness();
    const signal = new AbortController().signal;
    const host = h.defaultHost();
    h.hosts.set(hostId, host);

    // Account 403 aborts immediately.
    h.setCheckHostOverride(() => {
      throw new RemoteRequestError("Account", 403);
    });
    await expect(h.reconciler.pass(signal)).rejects.toMatchObject({ service: "Account", status: 403 });
    h.setCheckHostOverride(undefined);

    // Host marked deleted while a live slot is still in Account desiredSlots -> VM/disk NOT deleted!
    await h.reconciler.pass(signal);
    const createdHost = h.hosts.get(hostId)!;
    h.hosts.set(hostId, {
      ...createdHost,
      state: "deleted",
      revision: createdHost.revision + 1,
      enrolled: true,
      bootstrapToken: undefined,
      hostKey: h.hostKeys1.spki,
      relayKey: h.relayKeys1.spki,
    });
    h.slots.set(slotId, {
      ...h.defaultSlot({ ...createdHost, hostKey: h.hostKeys1.spki }),
      state: "deleting",
      phase: "deleting",
    });
    h.agent.nextReply = { op: "delete", mode: "lost-before-apply" };
    await h.reconciler.pass(signal);
    expect(h.compute.instances.size).toBe(1);
    expect(h.compute.disks.size).toBe(1);
    expect(h.hostReports.at(-1)?.phase).toBe("deleting");
  });

  it("exposes BrowserPoolAgentUnavailable refusal code only for verified signed refusals", async () => {
    const provisioner = ed25519Pair();
    const hostKeys = ed25519Pair();
    const agent = new FakePoolAgent({
      hostId,
      hostPrivateKey: hostKeys.privateKey,
      provisionerPublicKey: provisioner.publicKey,
    });
    const client = httpPoolAgentClient({
      provisionerKey: provisioner.privateKey,
      fetch: agent.fetch,
      timeoutMs: 2_000,
    });
    const target = {
      hostId,
      internalIp: "10.40.0.10",
      adminPort: 7311,
      hostKeySpki: hostKeys.spki,
    };

    agent.nextReply = { op: "list", mode: "unsigned-bad-request" };
    await expect(client.list(target, new AbortController().signal)).rejects.toSatisfy(
      (err: unknown) => err instanceof BrowserPoolAgentUnavailable && err.refusal === undefined,
    );

    agent.nextReply = { op: "list", mode: "signed-conflict" };
    await expect(client.list(target, new AbortController().signal)).rejects.toSatisfy(
      (err: unknown) => err instanceof BrowserPoolAgentUnavailable && err.refusal === "conflict",
    );
  });
});
