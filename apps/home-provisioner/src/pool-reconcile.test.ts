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
  type BrowserPoolHostReplaceUnreadyRequest,
  type BrowserPoolHostReport,
  type BrowserPoolSlotBumpTermRequest,
  type BrowserPoolSlotCheck,
  type BrowserPoolSlotDesired,
  type BrowserPoolSlotId,
  type BrowserPoolSlotReport,
} from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import type { PoolAccountApi } from "./account.js";
import { ComputeFake, zonePath } from "./google-compute.test-support.js";
import { ProviderRateLimited, provisionerFailure, RemoteRequestError } from "./http.js";
import { isMainModule, runMainWithFatalHandling, runProvisionerTick } from "./main.js";
import { httpPoolAgentClient } from "./pool-agent-client.js";
import { PoolReconciler } from "./pool-reconcile.js";

const sha = "a".repeat(64);
const hostId = BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111");
const secondHostId = BrowserPoolHostIdSchema.parse("ph_44444444-4444-4444-8444-444444444444");
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

type FakeAgentFaultMode =
  | "lost-after-apply"
  | "lost-before-apply"
  | "signed-unavailable-after-apply"
  | "signed-conflict"
  | "profile-disk-full"
  | "unsigned-bad-request"
  | "forged-signature"
  | "partial-erase-no-erased"
  | "partial-erase-no-profile"
  | "partial-erase-no-credentials";

/**
 * Signed fake pool agent modeled directly on `apps/pool-agent/src/agent.ts` at head `c351478fb`
 * (a pulling host with `driver.requireEgressUpstream: true`):
 * - `create`: refuses `guest.profilePath` or `guest.egress`, enforces `guest.profileMib`,
 *   enforces profile filesystem capacity (`ProfilesFull` -> signed `conflict` with
 *   "A <N> MiB profile would make this host's profiles exceed their filesystem."),
 *   and reuses an existing profile for the slot id without reformatting.
 * - `replace-key`: requires strictly higher term (otherwise signed `conflict`), returns `unknown-slot`
 *   if absent.
 * - `delete`: checks term match if slot is known, erases slot + derived credential paths + profile
 *   when `eraseProfile` is set, and returns `credentialsErased: true` whenever the slot's derived
 *   credential paths are seen gone (including slots that never pulled egress, repeated deletes,
 *   and unknown slots on a pulling host).
 */
class FakePoolAgent {
  readonly slots = new Map<
    string,
    {
      slotId: string;
      term: number;
      homeKey: string;
      relayKey?: string;
      ticketKey?: { readonly keyId: string; readonly spki: string };
      controlKey: string;
      profileMib: number;
    }
  >();
  readonly tombstones = new Map<string, number>();
  readonly profiles = new Map<string, number>();
  readonly calls: string[] = [];
  nextReply:
    | {
        readonly op: "create" | "replace-key" | "delete" | "list";
        readonly mode: FakeAgentFaultMode;
      }
    | undefined;
  readonly hostKeysById = new Map<string, KeyObject>();
  readonly provisionerPublicKey: KeyObject;
  readonly onOp?: ((op: string) => void) | undefined;
  profileFilesystemMib = 450_000;
  requireEgressUpstream = true;

  constructor(options: {
    hostId: string;
    hostPrivateKey: KeyObject;
    provisionerPublicKey: KeyObject;
    onOp?: (op: string) => void;
    requireEgressUpstream?: boolean;
  }) {
    this.hostKeysById.set(options.hostId, options.hostPrivateKey);
    this.provisionerPublicKey = options.provisionerPublicKey;
    this.onOp = options.onOp;
    if (options.requireEgressUpstream !== undefined) {
      this.requireEgressUpstream = options.requireEgressUpstream;
    }
  }

  setHostKey(id: string, key: KeyObject) {
    this.hostKeysById.set(id, key);
  }

  static #sameKeys(
    existing: {
      homeKey: string;
      relayKey?: string;
      ticketKey?: { readonly keyId: string; readonly spki: string };
    },
    incoming: {
      homeKey: string;
      relayKey?: string;
      ticketKey?: { readonly keyId: string; readonly spki: string };
    },
  ): boolean {
    return (
      existing.homeKey === incoming.homeKey &&
      existing.relayKey === incoming.relayKey &&
      existing.ticketKey?.keyId === incoming.ticketKey?.keyId &&
      existing.ticketKey?.spki === incoming.ticketKey?.spki
    );
  }

  readonly fetch: typeof fetch = async (_input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const envelope = JSON.parse(rawBody) as BrowserPoolAgentAdminEnvelope;
    const reqBytes = browserPoolAgentAdminBytes(envelope);
    const sig = new Headers(init?.headers).get(browserPoolAgentSignatureHeader) ?? "";
    expect(verifyBrowserPoolAgentBytes(reqBytes, this.provisionerPublicKey, sig)).toBe(true);
    const hostPrivateKey = this.hostKeysById.get(envelope.host);
    expect(hostPrivateKey).toBeDefined();

    const op = envelope.request.op;
    this.calls.push(op);
    this.onOp?.(`agent:${op}`);

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
      return this.#signed(hostPrivateKey!, reqBytes, reply, 409);
    }

    let reply: BrowserPoolAgentAdminReply;
    if (envelope.request.op === "list") {
      reply = {
        op: "list",
        slots: [...this.slots.values()].map(toSummary),
      };
    } else if (envelope.request.op === "create") {
      const req = envelope.request;
      if (req.guest.profilePath !== undefined) {
        return this.#signed(
          hostPrivateKey!,
          reqBytes,
          {
            op: "refused",
            code: "conflict",
            message: "A slot's profile is its own: its path is derived from the slot id.",
          },
          409,
        );
      }
      if (this.requireEgressUpstream && req.guest.egress !== undefined) {
        return this.#signed(
          hostPrivateKey!,
          reqBytes,
          {
            op: "refused",
            code: "conflict",
            message: "A pulling host does not accept guest.egress on create.",
          },
          409,
        );
      }
      const sizeMib = req.guest.profileMib;
      if (sizeMib === undefined || sizeMib < 64) {
        return this.#signed(
          hostPrivateKey!,
          reqBytes,
          {
            op: "refused",
            code: "conflict",
            message: "A create names the size of the slot's profile (profileMib).",
          },
          409,
        );
      }
      const tombstonedTerm = this.tombstones.get(req.slotId);
      if (tombstonedTerm !== undefined && req.term <= tombstonedTerm) {
        return this.#signed(
          hostPrivateKey!,
          reqBytes,
          {
            op: "refused",
            code: "conflict",
            message: "The slot was deleted at this term or a later one.",
          },
          409,
        );
      }
      const existing = this.slots.get(req.slotId);
      if (existing && (existing.term !== req.term || !FakePoolAgent.#sameKeys(existing, req))) {
        return this.#signed(
          hostPrivateKey!,
          reqBytes,
          { op: "refused", code: "conflict", message: "slot exists at different term or key" },
          409,
        );
      }
      if (!this.profiles.has(req.slotId)) {
        const usedMib = [...this.profiles.values()].reduce((sum, mib) => sum + mib, 0);
        if (fault?.mode === "profile-disk-full" || usedMib + sizeMib > this.profileFilesystemMib) {
          return this.#signed(
            hostPrivateKey!,
            reqBytes,
            {
              op: "refused",
              code: "conflict",
              message: `A ${sizeMib} MiB profile would leave this host's profiles without room to fill in.`,
            },
            409,
          );
        }
        this.profiles.set(req.slotId, sizeMib);
      }
      const created = existing ?? {
        slotId: req.slotId,
        term: req.term,
        homeKey: req.homeKey,
        ...(req.relayKey ? { relayKey: req.relayKey } : {}),
        ...(req.ticketKey ? { ticketKey: req.ticketKey } : {}),
        controlKey: ed25519Pair().spki,
        profileMib: sizeMib,
      };
      this.slots.set(req.slotId, created);
      reply = { op: "create", slot: toSummary(created) };
    } else if (envelope.request.op === "replace-key") {
      const req = envelope.request;
      const existing = this.slots.get(req.slotId);
      if (!existing) {
        return this.#signed(
          hostPrivateKey!,
          reqBytes,
          { op: "refused", code: "unknown-slot", message: "slot not found" },
          404,
        );
      }
      if (req.term === existing.term && FakePoolAgent.#sameKeys(existing, req)) {
        reply = { op: "replace-key", slot: toSummary(existing) };
      } else if (req.term <= existing.term) {
        return this.#signed(
          hostPrivateKey!,
          reqBytes,
          { op: "refused", code: "conflict", message: "A replaced key needs a higher term." },
          409,
        );
      } else {
        existing.term = req.term;
        existing.homeKey = req.homeKey;
        existing.relayKey = req.relayKey;
        existing.ticketKey = req.ticketKey;
        reply = { op: "replace-key", slot: toSummary(existing) };
      }
    } else {
      const req = envelope.request;
      const existing = this.slots.get(req.slotId);
      if (existing && req.term !== undefined && existing.term !== req.term) {
        return this.#signed(
          hostPrivateKey!,
          reqBytes,
          {
            op: "refused",
            code: "conflict",
            message: "The slot is at another term than this delete names.",
          },
          409,
        );
      }
      if (fault?.mode === "partial-erase-no-erased") {
        reply = {
          op: "delete",
          slotId: req.slotId,
          erased: false,
          ...(req.eraseProfile ? { profileErased: true as const } : {}),
          ...(this.requireEgressUpstream || existing ? { credentialsErased: true as const } : {}),
        };
      } else if (fault?.mode === "partial-erase-no-profile") {
        const deletedTerm = existing?.term ?? req.term ?? 0;
        if (deletedTerm > (this.tombstones.get(req.slotId) ?? 0)) {
          this.tombstones.set(req.slotId, deletedTerm);
        }
        this.slots.delete(req.slotId);
        reply = {
          op: "delete",
          slotId: req.slotId,
          erased: true,
          ...(this.requireEgressUpstream || existing ? { credentialsErased: true as const } : {}),
        };
      } else if (fault?.mode === "partial-erase-no-credentials") {
        const deletedTerm = existing?.term ?? req.term ?? 0;
        if (deletedTerm > (this.tombstones.get(req.slotId) ?? 0)) {
          this.tombstones.set(req.slotId, deletedTerm);
        }
        this.slots.delete(req.slotId);
        if (req.eraseProfile) this.profiles.delete(req.slotId);
        reply = {
          op: "delete",
          slotId: req.slotId,
          erased: true,
          ...(req.eraseProfile ? { profileErased: true as const } : {}),
        };
      } else {
        const deletedTerm = existing?.term ?? req.term ?? 0;
        if (deletedTerm > (this.tombstones.get(req.slotId) ?? 0)) {
          this.tombstones.set(req.slotId, deletedTerm);
        }
        this.slots.delete(req.slotId);
        if (req.eraseProfile) this.profiles.delete(req.slotId);
        // Matches c351478fb pulling-host deleteSlotWithEvidence: reports credentialsErased:true
        // whenever the derived credential paths are seen gone (including slots with none,
        // repeated deletes, and unknown slots on a pulling host; on a non-pulling host an
        // unknown slot omits credentialsErased).
        reply = {
          op: "delete",
          slotId: req.slotId,
          erased: true,
          ...(req.eraseProfile ? { profileErased: true as const } : {}),
          ...(this.requireEgressUpstream || existing ? { credentialsErased: true as const } : {}),
        };
      }
    }

    if (fault?.mode === "lost-after-apply") {
      throw new Error("socket hang up after agent applied request");
    }
    if (fault?.mode === "signed-unavailable-after-apply") {
      return this.#signed(
        hostPrivateKey!,
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
    return this.#signed(hostPrivateKey!, reqBytes, reply, 200);
  };

  #signed(
    hostPrivateKey: KeyObject,
    reqBytes: Uint8Array,
    reply: BrowserPoolAgentAdminReply,
    status: number,
  ) {
    const signature = signBrowserPoolAgentBytes(
      browserPoolAgentAdminReplyBytes(reqBytes, reply),
      hostPrivateKey,
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

function createHarness(options: { concurrency?: number } = {}) {
  const compute = new ComputeFake();
  const provider = compute.adapter();
  const provisionerKeys = ed25519Pair();
  const hostKeys1 = ed25519Pair();
  const events: string[] = [];
  const agent = new FakePoolAgent({
    hostId,
    hostPrivateKey: hostKeys1.privateKey,
    provisionerPublicKey: provisionerKeys.publicKey,
    onOp: (event) => events.push(event),
  });

  let nowMs = 1_000_000;
  const hostReports: BrowserPoolHostReport[] = [];
  const slotReports: BrowserPoolSlotReport[] = [];
  const onError = vi.fn();

  const hosts = new Map<BrowserPoolHostId, BrowserPoolHostDesired>();
  const slots = new Map<BrowserPoolSlotId, BrowserPoolSlotDesired>();

  const defaultHost = (id: BrowserPoolHostId = hostId): BrowserPoolHostDesired =>
    BrowserPoolHostDesiredSchema.parse({
      id,
      generation: 1,
      revision: 1,
      state: "active",
      machineType: "n2-standard-8",
      profileDiskName: `osp-disk-${id.slice("ph_".length)}`,
      profileDiskSizeGb: 500,
      agentPort: 7310,
      relayPort: 7312,
      release,
      enrolled: false,
      everEnrolled: false,
      autoReplaceCount: 0,
      bootstrapToken: "b".repeat(43),
      readinessStartedAt: new Date(nowMs).toISOString(),
    });

  const defaultSlot = (host: BrowserPoolHostDesired): BrowserPoolSlotDesired =>
    BrowserPoolSlotDesiredSchema.parse({
      slotId,
      hostId: host.id,
      hostGeneration: host.generation,
      hostInternalIp: host.internalIp!,
      hostKey: host.hostKey!,
      term: 1,
      revision: 1,
      state: "active",
      phase: "preparing",
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

  let checkHostOverride:
    | ((id: BrowserPoolHostId, check: BrowserPoolHostCheck) => Promise<boolean> | boolean)
    | undefined;
  let checkSlotOverride:
    | ((id: BrowserPoolSlotId, check: BrowserPoolSlotCheck) => Promise<boolean> | boolean)
    | undefined;

  const account: PoolAccountApi = {
    desiredHosts: vi.fn(async () => [...hosts.values()]),
    checkHost: vi.fn(async (id: BrowserPoolHostId, check: BrowserPoolHostCheck) => {
      events.push(`checkHost:${check.operation}`);
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
          {
            ...check.write,
            dispatched: false,
            recoverAfter: new Date(nowMs + 180_000).toISOString(),
          },
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
    replaceUnenrolledHost: vi.fn(
      async (id: BrowserPoolHostId, input: BrowserPoolHostReplaceUnreadyRequest) => {
        const row = hosts.get(id);
        if (
          !row ||
          row.revision !== input.revision ||
          row.generation !== input.generation ||
          row.enrolled ||
          row.everEnrolled ||
          row.autoReplaceCount >= 2 ||
          (row.pendingProviderWrites?.length ?? 0) > 0
        ) {
          return { replaced: false };
        }
        const nextGen = row.generation + 1;
        const nextRev = row.revision + 1;
        hosts.set(id, {
          ...row,
          generation: nextGen,
          revision: nextRev,
          autoReplaceCount: row.autoReplaceCount + 1,
          previousProviderServerRef: row.providerServerRef ?? row.previousProviderServerRef,
          providerServerRef: undefined,
          internalIp: undefined,
          bootstrapToken: "r".repeat(43),
          readinessStartedAt: new Date(nowMs).toISOString(),
        });
        return { replaced: true, generation: nextGen, revision: nextRev };
      },
    ),
    desiredSlots: vi.fn(async () => [...slots.values()]),
    checkSlot: vi.fn(async (id: BrowserPoolSlotId, check: BrowserPoolSlotCheck) => {
      events.push(`checkSlot:${check.operation}`);
      if (checkSlotOverride) return checkSlotOverride(id, check);
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
          {
            ...check.write,
            dispatched: false,
            recoverAfter: new Date(nowMs + 180_000).toISOString(),
          },
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
      events.push(`bumpSlotTerm:${input.expectedTerm}->${input.expectedTerm + 1}`);
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
        phase: "preparing",
      });
      return { bumped: true, term: nextTerm, revision: nextRev };
    }),
    reportSlot: vi.fn(async (report: BrowserPoolSlotReport) => {
      slotReports.push(report);
      const row = slots.get(report.slotId);
      if (
        !row ||
        row.revision !== report.revision ||
        row.term !== report.term ||
        row.hostGeneration !== report.hostGeneration
      ) {
        return false;
      }
      if (report.phase === "deleted") {
        slots.delete(report.slotId);
        return true;
      }
      slots.set(report.slotId, {
        ...row,
        phase: report.phase,
        failedAt: report.phase === "failed" ? new Date(nowMs).toISOString() : undefined,
        ...(report.phase === "ready"
          ? { appliedTerm: report.term, appliedHostGeneration: report.hostGeneration }
          : {}),
        ...(report.controlKey ? { controlKey: report.controlKey } : {}),
        slotErased: row.slotErased || report.slotErased,
        profileErased: row.profileErased || report.profileErased,
        credentialsErased: row.credentialsErased || report.credentialsErased,
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

  const makeReconciler = (overrideAccount: PoolAccountApi = account, overrideProvider = provider) =>
    new PoolReconciler({
      account: overrideAccount,
      provider: overrideProvider,
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
        adminPort: 7311,
      },
      readinessTimeoutMs: 600_000,
      orphanGraceMs: 300_000,
      concurrency: options.concurrency ?? 2,
      onError,
      now: () => nowMs,
    });

  const reconciler = makeReconciler();
  const signal = new AbortController().signal;

  async function bringHostReady(
    id: BrowserPoolHostId = hostId,
    keys = id === hostId ? hostKeys1 : ed25519Pair(),
  ) {
    if (id !== hostId) agent.setHostKey(id, keys.privateKey);
    hosts.set(id, defaultHost(id));
    await reconciler.pass(signal);
    const current = hosts.get(id)!;
    hosts.set(id, {
      ...current,
      revision: current.revision + 1,
      enrolled: true,
      everEnrolled: true,
      bootstrapToken: undefined,
      hostKey: keys.spki,
    });
    await reconciler.pass(signal);
    return { host: hosts.get(id)!, keys };
  }

  return {
    compute,
    provider,
    agent,
    account,
    reconciler,
    makeReconciler,
    signal,
    hosts,
    slots,
    hostReports,
    slotReports,
    events,
    hostKeys1,
    onError,
    defaultHost,
    defaultSlot,
    bringHostReady,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setCheckHostOverride: (fn: typeof checkHostOverride) => {
      checkHostOverride = fn;
    },
    setCheckSlotOverride: (fn: typeof checkSlotOverride) => {
      checkSlotOverride = fn;
    },
  };
}

describe("PoolReconciler — hosts", () => {
  it("creates the durable profile disk once before creating the pool host instance with everEnrolled=false (X1)", async () => {
    const h = createHarness();
    h.hosts.set(hostId, h.defaultHost());

    await h.reconciler.pass(h.signal);

    const diskInsertIndex = h.compute.requests.findIndex(
      (r) => r.method === "POST" && r.path === `${zonePath}/disks`,
    );
    const vmInsertIndex = h.compute.requests.findIndex(
      (r) => r.method === "POST" && r.path === `${zonePath}/instances`,
    );
    expect(diskInsertIndex).toBeGreaterThanOrEqual(0);
    expect(vmInsertIndex).toBeGreaterThan(diskInsertIndex);
    expect(h.compute.disks.size).toBe(1);
    expect(h.compute.instances.size).toBe(1);
    const vm = [...h.compute.instances.values()][0]!;
    expect(vm.disks?.some((d) => d.autoDelete === false && d.mode === "READ_WRITE")).toBe(true);
    const userData = vm.metadata.items.find((item) => item.key === "user-data")?.value ?? "";
    expect(userData).toContain('\\"everEnrolled\\":false');

    await h.reconciler.pass(h.signal);
    expect(
      h.compute.requests.filter((r) => r.method === "POST" && r.path === `${zonePath}/disks`),
    ).toHaveLength(1);
  });

  it("recovers a lost disk-create answer without issuing a second disk creation", async () => {
    const h = createHarness();
    h.hosts.set(hostId, h.defaultHost());
    h.compute.nextDiskInsert = "lost";

    await h.reconciler.pass(h.signal);
    expect(h.compute.disks.size).toBe(1);
    expect(h.compute.instances.size).toBe(0);
    expect(h.hosts.get(hostId)?.pendingProviderWrites?.some((w) => w.kind === "create-disk")).toBe(
      true,
    );
    expect(h.hostReports.at(-1)?.phase).toBe("provisioning");

    await h.reconciler.pass(h.signal);
    expect(
      h.compute.requests.filter((r) => r.method === "POST" && r.path === `${zonePath}/disks`),
    ).toHaveLength(1);
    expect(h.hosts.get(hostId)?.pendingProviderWrites).toEqual([]);
    expect(h.compute.instances.size).toBe(1);
  });

  it("recovers a lost instance-create answer without creating a second instance", async () => {
    const h = createHarness();
    h.hosts.set(hostId, h.defaultHost());
    h.compute.nextInsert = "lost";

    await h.reconciler.pass(h.signal);
    expect(h.compute.instances.size).toBe(1);
    expect(h.hosts.get(hostId)?.pendingProviderWrites?.some((w) => w.kind === "create")).toBe(true);
    expect(h.hostReports.at(-1)?.phase).toBe("provisioning");

    await h.reconciler.pass(h.signal);
    expect(
      h.compute.requests.filter((r) => r.method === "POST" && r.path === `${zonePath}/instances`),
    ).toHaveLength(1);
    expect(h.hosts.get(hostId)?.pendingProviderWrites).toEqual([]);
    expect(h.compute.instances.size).toBe(1);
  });

  it("keeps an unknown create provisioning and fails once the readiness deadline passes", async () => {
    const h = createHarness();
    h.hosts.set(hostId, h.defaultHost());
    h.compute.nextInsert = "late";

    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)).toMatchObject({ phase: "provisioning", lastError: null });

    h.advance(300_000);
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("provisioning");

    h.advance(300_000);
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)).toMatchObject({
      phase: "failed",
      lastError: "The pool host did not become ready before its deadline.",
    });
  });

  it("opens the bootstrap metadata gate before enrolment and scrubs bootstrap metadata after enrolment", async () => {
    const h = createHarness();
    h.hosts.set(hostId, h.defaultHost());

    await h.reconciler.pass(h.signal);
    const vm = [...h.compute.instances.values()][0]!;
    expect(vm.metadata.items.some((item) => item.key === "opensteer-bootstrap-ready")).toBe(true);
    expect(vm.metadata.items.some((item) => item.key === "user-data")).toBe(true);
    expect(h.hostReports.at(-1)?.phase).toBe("booting");

    const current = h.hosts.get(hostId)!;
    h.hosts.set(hostId, {
      ...current,
      revision: current.revision + 1,
      enrolled: true,
      everEnrolled: true,
      bootstrapToken: undefined,
      hostKey: h.hostKeys1.spki,
    });
    await h.reconciler.pass(h.signal);
    expect(vm.metadata.items.some((item) => item.key === "user-data")).toBe(false);
    expect(vm.metadata.items.some((item) => item.key === "opensteer-bootstrap-ready")).toBe(false);
    expect(h.hostReports.at(-1)?.phase).toBe("ready");
  });

  it("keeps the durable profile disk across an instance replacement, deletes the old VM first so the disk is never attached to two instances, and sets everEnrolled=true (X1)", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    const gen1VmName = [...h.compute.instances.keys()][0]!;
    const diskId = [...h.compute.disks.values()][0]!.id;
    const reqStart = h.compute.requests.length;

    const hostKeys2 = ed25519Pair();
    h.hosts.set(hostId, {
      ...host,
      generation: 2,
      revision: host.revision + 1,
      previousProviderServerRef: host.providerServerRef,
      providerServerRef: undefined,
      internalIp: undefined,
      enrolled: false,
      hostKey: undefined,
      bootstrapToken: "c".repeat(43),
    });

    // Hold old VM deletion -> replacement VM must NOT be created while old VM still attaches the disk.
    h.compute.holdMatch = (method, path) =>
      method === "DELETE" && path === `${zonePath}/instances/${gen1VmName}`;
    await h.reconciler.pass(h.signal);
    expect(h.compute.instances.size).toBe(1);
    expect(h.compute.instances.has(gen1VmName)).toBe(true);

    // Complete old VM deletion: now gen 2 VM is created with everEnrolled:true and same disk.
    h.compute.holdMatch = undefined;
    for (const [opPath, entry] of h.compute.operations) {
      if (entry.operation.operationType === "delete" && entry.operation.status !== "DONE") {
        h.compute.complete(opPath);
      }
    }
    await h.reconciler.pass(h.signal);

    const replacementRequests = h.compute.requests.slice(reqStart);
    const deleteOldIdx = replacementRequests.findIndex(
      (r) => r.method === "DELETE" && r.path === `${zonePath}/instances/${gen1VmName}`,
    );
    const createNewIdx = replacementRequests.findIndex(
      (r) => r.method === "POST" && r.path === `${zonePath}/instances`,
    );
    expect(deleteOldIdx).toBeGreaterThanOrEqual(0);
    expect(createNewIdx).toBeGreaterThan(deleteOldIdx);
    expect(
      replacementRequests.filter(
        (r) =>
          r.path.startsWith(`${zonePath}/disks`) && (r.method === "DELETE" || r.method === "POST"),
      ),
    ).toEqual([]);
    expect(h.compute.disks.size).toBe(1);
    expect([...h.compute.disks.values()][0]!.id).toBe(diskId);
    expect(h.compute.instances.has(gen1VmName)).toBe(false);
    expect(h.compute.instances.size).toBe(1);
    const gen2Vm = [...h.compute.instances.values()][0]!;
    const gen2UserData =
      gen2Vm.metadata.items.find((item) => item.key === "user-data")?.value ?? "";
    expect(gen2UserData).toContain('\\"everEnrolled\\":true');

    h.agent.setHostKey(hostId, hostKeys2.privateKey);
    const gen2 = h.hosts.get(hostId)!;
    h.hosts.set(hostId, {
      ...gen2,
      revision: gen2.revision + 1,
      enrolled: true,
      bootstrapToken: undefined,
      hostKey: hostKeys2.spki,
    });
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)).toMatchObject({ generation: 2, phase: "ready" });
  });

  it("auto-replaces an unenrolled host that misses its readiness deadline up to twice, then stays failed, and never auto-replaces an enrolled host (T8)", async () => {
    const h = createHarness();
    h.hosts.set(hostId, h.defaultHost());

    // Generation 1 boots VM, never enrols, hits readiness deadline -> auto-replaced to generation 2.
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("booting");
    h.advance(600_000);
    await h.reconciler.pass(h.signal);
    expect(h.hosts.get(hostId)).toMatchObject({ generation: 2, autoReplaceCount: 1 });

    // Generation 2 boots VM (still everEnrolled:false per X1), never enrols, hits readiness deadline -> auto-replaced to generation 3.
    await h.reconciler.pass(h.signal);
    const gen2Vm = [...h.compute.instances.values()][0]!;
    const gen2UserData =
      gen2Vm.metadata.items.find((item) => item.key === "user-data")?.value ?? "";
    expect(gen2UserData).toContain('\\"everEnrolled\\":false');
    h.advance(600_000);
    await h.reconciler.pass(h.signal);
    expect(h.hosts.get(hostId)).toMatchObject({ generation: 3, autoReplaceCount: 2 });

    // Generation 3 boots VM, never enrols, hits readiness deadline -> stays failed (cap of 2 reached).
    await h.reconciler.pass(h.signal);
    h.advance(600_000);
    await h.reconciler.pass(h.signal);
    expect(h.hosts.get(hostId)).toMatchObject({ generation: 3, autoReplaceCount: 2 });
    expect(h.hostReports.at(-1)).toMatchObject({
      generation: 3,
      phase: "failed",
      lastError:
        "The pool host did not enrol before its deadline after automatic replacement retries.",
    });

    // Enrolled host that later loses admin reachability past deadline is NEVER auto-replaced.
    const h2 = createHarness();
    const { host } = await h2.bringHostReady();
    h2.hosts.set(hostId, { ...host, readinessStartedAt: new Date(1_000_000).toISOString() });
    h2.agent.nextReply = { op: "list", mode: "lost-before-apply" };
    h2.advance(700_000);
    await h2.reconciler.pass(h2.signal);
    expect(h2.account.replaceUnenrolledHost).not.toHaveBeenCalled();
    expect(h2.hostReports.at(-1)).toMatchObject({
      generation: 1,
      phase: "failed",
      lastError: "The pool host did not become ready before its deadline.",
    });
  });

  it("aborts a pass on Compute rate limit without marking the host failed", async () => {
    const h = createHarness();
    h.hosts.set(hostId, h.defaultHost());
    h.compute.rateLimitRequests = 1;

    await expect(h.reconciler.pass(h.signal)).rejects.toBeInstanceOf(ProviderRateLimited);
    expect(h.hostReports.some((r) => r.phase === "failed")).toBe(false);
  });

  it("leaves a stray pool host VM in another zone to an operator and reconciles the rest", async () => {
    const h = createHarness();
    await h.bringHostReady(hostId);
    const host2Keys = ed25519Pair();
    h.agent.setHostKey(secondHostId, host2Keys.privateKey);
    h.hosts.set(secondHostId, h.defaultHost(secondHostId));

    const stray = [...h.compute.instances.values()].find(
      ({ labels }) => labels["opensteer-pool-host"] === hostId,
    )!;
    h.compute.instances.delete(stray.name);
    h.compute.otherZones.set("zones/us-east1-b", [stray]);
    h.compute.unreachable = ["zones/asia-east1-a"];
    h.compute.pageSize = 1;

    const reqStart = h.compute.requests.length;
    await h.reconciler.pass(h.signal);
    const requests = h.compute.requests.slice(reqStart);

    expect(
      requests.filter(
        ({ method, path }) => method !== "GET" && path.includes(hostId.slice("ph_".length)),
      ),
    ).toEqual([]);
    expect(
      [...h.compute.instances.values()].some(
        ({ labels }) => labels["opensteer-pool-host"] === secondHostId,
      ),
    ).toBe(true);

    const host1Report = [...h.hostReports].reverse().find((r) => r.id === hostId);
    expect(host1Report).toMatchObject({
      phase: "failed",
      lastError: "The pool host provider operation failed.",
    });
    const placement = h.onError.mock.calls
      .map(([error]) => provisionerFailure(error))
      .find(({ event }) => event === "home-provisioner.provider.wrong-zone");
    expect(placement).toEqual({
      event: "home-provisioner.provider.wrong-zone",
      message:
        `Managed Compute pool host ${stray.name} of ${hostId} is in zones/us-east1-b, outside ` +
        "the configured zone us-central1-a. Nothing is done to this pool host until an " +
        "operator deletes or relabels that instance or sets the zone back.",
    });
    expect(h.compute.logs).toContainEqual({
      event: "home-provisioner.provider.zones-unreachable",
      scopes: ["zones/asia-east1-a"],
    });
  });

  it("deletes a pool host only after both its instance and durable profile disk are observed absent", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    const vmName = [...h.compute.instances.keys()][0]!;
    const diskName = host.profileDiskName;

    h.hosts.set(hostId, { ...host, state: "deleted", revision: host.revision + 1 });
    h.compute.holdMatch = (method, path) =>
      method === "DELETE" && path === `${zonePath}/instances/${vmName}`;
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleting");
    expect(h.hosts.has(hostId)).toBe(true);
    expect(h.compute.disks.has(diskName)).toBe(true);

    h.compute.instances.delete(vmName);
    h.compute.holdMatch = (method, path) =>
      method === "DELETE" && path === `${zonePath}/disks/${diskName}`;
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleting");
    expect(h.hosts.has(hostId)).toBe(true);
    expect(h.compute.disks.has(diskName)).toBe(true);

    h.compute.holdMatch = undefined;
    for (const [opPath, entry] of h.compute.operations) {
      if (entry.operation.operationType === "delete" && entry.operation.status !== "DONE") {
        h.compute.complete(opPath);
      }
    }
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleted");
    expect(h.hosts.has(hostId)).toBe(false);
    expect(h.compute.instances.size).toBe(0);
    expect(h.compute.disks.size).toBe(0);
  });

  it("deletes a pool host cleanly when the VM is off and Account has zero slots", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    const vm = [...h.compute.instances.values()][0]!;
    vm.status = "TERMINATED";
    h.agent.nextReply = { op: "list", mode: "lost-before-apply" };

    h.hosts.set(hostId, { ...host, state: "deleted", revision: host.revision + 1 });
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleted");
    expect(h.compute.instances.size).toBe(0);
    expect(h.compute.disks.size).toBe(0);
  });

  it("waits instead of deleting a running enrolled pool host when agent list is unreachable (X3)", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    const reqStart = h.compute.requests.length;

    h.hosts.set(hostId, { ...host, state: "deleted", revision: host.revision + 1 });
    h.agent.nextReply = { op: "list", mode: "lost-before-apply" };

    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleting");
    expect(h.compute.instances.size).toBe(1);
    expect(h.compute.disks.size).toBe(1);
    expect(h.compute.requests.slice(reqStart).filter((r) => r.method === "DELETE")).toEqual([]);
    expect(h.onError).toHaveBeenCalled();

    // Once agent list becomes reachable and confirms zero slots, deletion proceeds cleanly.
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleted");
    expect(h.compute.instances.size).toBe(0);
    expect(h.compute.disks.size).toBe(0);
  });

  it("never deletes a pool host while Account or the host agent list still reports a live slot", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    const slot = h.defaultSlot(host);
    h.slots.set(slotId, slot);
    await h.reconciler.pass(h.signal);
    expect(h.agent.slots.has(slotId)).toBe(true);

    h.hosts.set(hostId, { ...host, state: "deleted", revision: host.revision + 1 });
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleting");
    expect(h.compute.instances.size).toBe(1);
    expect(h.compute.disks.size).toBe(1);

    h.slots.clear();
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleting");
    expect(h.compute.instances.size).toBe(1);
    expect(h.compute.disks.size).toBe(1);

    h.agent.slots.clear();
    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleted");
    expect(h.compute.instances.size).toBe(0);
    expect(h.compute.disks.size).toBe(0);
  });

  it("sweeps orphaned pool VMs after the grace period and a fresh check, NEVER deletes durable profile disks (T2), and never touches a Home VM", async () => {
    const h = createHarness();
    const orphanHostId = BrowserPoolHostIdSchema.parse("ph_99999999-9999-4999-8999-999999999999");
    const orphanDisk = `osp-disk-${orphanHostId.slice("ph_".length)}`;
    const homeVmName = "os-cc-11111111-1111-4111-8111-111111111111-1";
    h.compute.instances.set(homeVmName, {
      name: homeVmName,
      id: "44444",
      status: "RUNNING",
      labels: {
        "opensteer-cloud-computer": computerId,
        "opensteer-managed-by": "home-provisioner",
        "opensteer-generation": "1",
      },
      tags: { fingerprint: "t0", items: ["opensteer-cloud-computers"] },
      metadata: { fingerprint: "m0", items: [] },
      networkInterfaces: [{ name: "nic0", networkIP: "10.40.0.5", accessConfigs: [] }],
    });
    h.compute.disks.set(orphanDisk, {
      id: "9999",
      name: orphanDisk,
      sizeGb: "500",
      type: `${zonePath}/diskTypes/pd-ssd`,
      labels: {
        "opensteer-pool-host": orphanHostId,
        "opensteer-managed-by": "home-provisioner",
      },
    });
    h.compute.instances.set(`osp-${orphanHostId.slice("ph_".length)}-1`, {
      name: `osp-${orphanHostId.slice("ph_".length)}-1`,
      id: "88888",
      status: "RUNNING",
      labels: {
        "opensteer-pool-host": orphanHostId,
        "opensteer-managed-by": "home-provisioner",
        "opensteer-generation": "1",
      },
      tags: { fingerprint: "t1", items: ["opensteer-pool-hosts"] },
      metadata: { fingerprint: "m1", items: [] },
      networkInterfaces: [{ name: "nic0", networkIP: "10.40.0.99", accessConfigs: [] }],
    });

    // Pass 1 (t=0): records VM first-seen; deletes nothing; reports untracked durable disk.
    await h.reconciler.pass(h.signal);
    expect(h.compute.instances.size).toBe(2);
    expect(h.compute.disks.has(orphanDisk)).toBe(true);

    // Before the 5-minute grace period: still deletes nothing.
    h.advance(299_000);
    await h.reconciler.pass(h.signal);
    expect(h.compute.instances.size).toBe(2);
    expect(h.compute.disks.has(orphanDisk)).toBe(true);

    // Past the grace period, but fresh Account orphan check returns false: VM is NOT deleted.
    h.advance(60_000);
    h.setCheckHostOverride((_id, check) => (check.operation === "orphan" ? false : true));
    await h.reconciler.pass(h.signal);
    expect(h.compute.instances.size).toBe(2);
    expect(h.compute.disks.has(orphanDisk)).toBe(true);

    // Fresh Account orphan check allows deletion: sweeps ONLY the orphan pool VM.
    // The Home VM AND the durable profile disk are KEPT, even well past grace period (T2).
    h.setCheckHostOverride(undefined);
    h.advance(3_600_000);
    await h.reconciler.pass(h.signal);
    expect(h.compute.instances.has(homeVmName)).toBe(true);
    expect(h.compute.instances.size).toBe(1);
    expect(h.compute.disks.has(orphanDisk)).toBe(true);
    const diskAlert = h.onError.mock.calls
      .map(([error]) => provisionerFailure(error))
      .find(({ event }) => event === "home-provisioner.pool.untracked-profile-disk");
    expect(diskAlert).toMatchObject({
      event: "home-provisioner.pool.untracked-profile-disk",
      diskName: orphanDisk,
      hostId: orphanHostId,
    });
  });

  it("refuses a second reconciler and stops a stale blocked pass before creating a disk or VM", async () => {
    const h = createHarness({ concurrency: 1 });
    h.hosts.set(hostId, h.defaultHost());

    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const origFind = h.provider.findPoolHost.bind(h.provider);
    vi.spyOn(h.provider, "findPoolHost").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await proceed.promise;
      return origFind(...args);
    });

    const stalePass = h.reconciler.pass(h.signal);
    await entered.promise;

    const secondAccount: PoolAccountApi = {
      ...h.account,
      desiredHosts: vi.fn(async () => {
        throw new RemoteRequestError("Account", 403);
      }),
    };
    const secondReconciler = h.makeReconciler(secondAccount);
    await expect(secondReconciler.pass(h.signal)).rejects.toMatchObject({ status: 403 });

    h.hosts.set(hostId, {
      ...h.hosts.get(hostId)!,
      revision: 2,
      state: "deleted",
      bootstrapToken: undefined,
    });
    proceed.resolve();
    await stalePass;
    expect(h.compute.disks.size).toBe(0);
    expect(h.compute.instances.size).toBe(0);

    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("deleted");
  });

  it("deduplicates acknowledged host reports and re-sends discarded or new-revision reports", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    const countAfterReady = vi.mocked(h.account.reportHost).mock.calls.length;

    await h.reconciler.pass(h.signal);
    expect(vi.mocked(h.account.reportHost)).toHaveBeenCalledTimes(countAfterReady);

    h.hosts.set(hostId, { ...host, revision: host.revision + 1 });
    vi.mocked(h.account.reportHost).mockResolvedValueOnce(false);
    await h.reconciler.pass(h.signal);
    expect(vi.mocked(h.account.reportHost)).toHaveBeenCalledTimes(countAfterReady + 1);

    await h.reconciler.pass(h.signal);
    expect(vi.mocked(h.account.reportHost)).toHaveBeenCalledTimes(countAfterReady + 2);
    expect(h.hostReports.at(-1)?.revision).toBe(host.revision + 1);

    await h.reconciler.pass(h.signal);
    expect(vi.mocked(h.account.reportHost)).toHaveBeenCalledTimes(countAfterReady + 2);
  });

  it("runs the pool pass even when the Home pass fails and vice versa (T3)", async () => {
    const signal = new AbortController().signal;
    const onError = vi.fn();
    const poolPass = vi.fn(async () => {});
    const homePass = vi.fn(async () => {
      throw new Error("one Home failed");
    });

    await runProvisionerTick({
      reconciler: { pass: homePass },
      poolReconciler: { pass: poolPass },
      intervalMs: 1000,
      signal,
      onError,
    });
    expect(homePass).toHaveBeenCalledOnce();
    expect(poolPass).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();

    // Reverse: failing pool pass does not prevent the next Home pass.
    const homePass2 = vi.fn(async () => {});
    const poolPass2 = vi.fn(async () => {
      throw new Error("one pool host failed");
    });
    const onError2 = vi.fn();
    await runProvisionerTick({
      reconciler: { pass: homePass2 },
      poolReconciler: { pass: poolPass2 },
      intervalMs: 1000,
      signal,
      onError: onError2,
    });
    expect(homePass2).toHaveBeenCalledOnce();
    expect(poolPass2).toHaveBeenCalledOnce();
    expect(onError2).toHaveBeenCalledOnce();
  });

  it("reports home-provisioner.pool.misconfigured every pass when Account pooling is on without OPENSTEER_POOL_PROVISIONER_KEY (T9)", async () => {
    const signal = new AbortController().signal;
    const onError = vi.fn();
    const reconciler = { pass: vi.fn(async () => {}) };
    const poolProbe = { isPoolEnabled: vi.fn(async () => true) };

    await runProvisionerTick({ reconciler, poolProbe, intervalMs: 1000, signal, onError });
    await runProvisionerTick({ reconciler, poolProbe, intervalMs: 1000, signal, onError });

    const events = onError.mock.calls.map(([err]) => provisionerFailure(err));
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("home-provisioner.pool.misconfigured");
    expect(events[1]?.event).toBe("home-provisioner.pool.misconfigured");
  });
});

describe("PoolReconciler — slots", () => {
  it("waits without calling the pool agent while no host is ready", async () => {
    const h = createHarness();
    h.hosts.set(hostId, h.defaultHost());

    await h.reconciler.pass(h.signal);
    expect(h.hostReports.at(-1)?.phase).toBe("booting");
    expect(h.agent.calls).toEqual([]);
    expect(h.slotReports).toEqual([]);
  });

  it("records the slot attempt with Account before calling agent create", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    h.events.length = 0;

    await h.reconciler.pass(h.signal);
    const beginIdx = h.events.indexOf("checkSlot:begin-agent-write");
    const sendIdx = h.events.indexOf("checkSlot:send-agent-write");
    const createIdx = h.events.indexOf("agent:create");
    const finishIdx = h.events.indexOf("checkSlot:finish-agent-write");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThan(beginIdx);
    expect(createIdx).toBeGreaterThan(sendIdx);
    expect(finishIdx).toBeGreaterThan(createIdx);
    expect(h.slotReports.at(-1)?.hostGeneration).toBe(1);

    const h2 = createHarness();
    const { host: host2 } = await h2.bringHostReady();
    h2.slots.set(slotId, h2.defaultSlot(host2));
    h2.agent.calls.length = 0;
    h2.setCheckSlotOverride((_id, check) => check.operation !== "begin-agent-write");
    await h2.reconciler.pass(h2.signal);
    expect(h2.agent.calls.filter((op) => op === "create")).toEqual([]);
  });

  it("recovers a lost create answer via list without issuing a second create", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    h.agent.calls.length = 0;
    h.agent.nextReply = { op: "create", mode: "lost-after-apply" };

    await h.reconciler.pass(h.signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toHaveLength(1);
    expect(h.slotReports).toEqual([]);

    await h.reconciler.pass(h.signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toEqual([]);
    expect(h.agent.calls.filter((op) => op === "create")).toHaveLength(1);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 1,
      term: 1,
      phase: "ready",
      controlKey: h.agent.slots.get(slotId)?.controlKey,
    });
  });

  it("treats a signed conflict refusal as definite and clears the pending write", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    h.agent.nextReply = { op: "create", mode: "signed-conflict" };

    await h.reconciler.pass(h.signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toEqual([]);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 1,
      phase: "failed",
      lastError: "The pool host rejected the slot administration request.",
    });
  });

  it('treats a profile-disk-full signed conflict as definite, reports "This host\'s profile disk is full.", and does not retry create forever', async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    h.agent.calls.length = 0;
    h.agent.nextReply = { op: "create", mode: "profile-disk-full" };

    await h.reconciler.pass(h.signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toEqual([]);
    expect(h.agent.slots.has(slotId)).toBe(false);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 1,
      phase: "failed",
      lastError: "This host's profile disk is full.",
    });

    // Subsequent passes must NOT retry `create` before the 10-minute X2 backoff elapses...
    await h.reconciler.pass(h.signal);
    h.advance(9 * 60_000 + 59_000);
    await h.reconciler.pass(h.signal);
    expect(h.agent.calls.filter((op) => op === "create")).toHaveLength(1);

    // ...and after 10 minutes (X2), a failed active slot retries automatically and recovers once space frees up!
    h.advance(1_000);
    await h.reconciler.pass(h.signal);
    expect(h.agent.calls.filter((op) => op === "create")).toHaveLength(2);
    expect(h.agent.slots.has(slotId)).toBe(true);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 1,
      term: 1,
      phase: "ready",
      lastError: null,
    });
  });

  it("keeps a signed unavailable refusal unknown and recovers via list", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    h.agent.calls.length = 0;
    h.agent.nextReply = { op: "create", mode: "signed-unavailable-after-apply" };

    await h.reconciler.pass(h.signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toHaveLength(1);
    expect(h.slotReports).toEqual([]);

    await h.reconciler.pass(h.signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toEqual([]);
    expect(h.agent.calls.filter((op) => op === "create")).toHaveLength(1);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 1,
      term: 1,
      phase: "ready",
    });
  });

  it("treats an unsigned or wrongly signed agent reply as no answer (unknown)", async () => {
    const h1 = createHarness();
    const { host: host1 } = await h1.bringHostReady();
    h1.slots.set(slotId, h1.defaultSlot(host1));
    h1.agent.nextReply = { op: "create", mode: "unsigned-bad-request" };
    await h1.reconciler.pass(h1.signal);
    expect(h1.slots.get(slotId)?.pendingAgentWrites).toHaveLength(1);
    expect(h1.slotReports).toEqual([]);

    const h2 = createHarness();
    const { host: host2 } = await h2.bringHostReady();
    h2.slots.set(slotId, h2.defaultSlot(host2));
    h2.agent.calls.length = 0;
    h2.agent.nextReply = { op: "create", mode: "forged-signature" };
    await h2.reconciler.pass(h2.signal);
    expect(h2.slots.get(slotId)?.pendingAgentWrites).toHaveLength(1);
    expect(h2.slotReports).toEqual([]);

    await h2.reconciler.pass(h2.signal);
    expect(h2.slots.get(slotId)?.pendingAgentWrites).toEqual([]);
    expect(h2.agent.calls.filter((op) => op === "create")).toHaveLength(1);
    expect(h2.slotReports.at(-1)?.phase).toBe("ready");
  });

  it("rotates slot keys with replace-key at a higher term and recovers a lost replace-key answer", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    await h.reconciler.pass(h.signal);
    expect(h.slotReports.at(-1)?.phase).toBe("ready");

    const rotatedKeys2 = {
      homeKey: ed25519Pair().spki,
      relayKey: ed25519Pair().spki,
      ticketKey: { keyId: "tk-2", spki: ed25519Pair().spki },
    };
    h.slots.set(slotId, {
      ...h.slots.get(slotId)!,
      term: 2,
      revision: 2,
      phase: "preparing",
      keys: rotatedKeys2,
    });
    h.agent.calls.length = 0;
    h.agent.nextReply = { op: "replace-key", mode: "lost-after-apply" };
    await h.reconciler.pass(h.signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toHaveLength(1);
    expect(h.slotReports.at(-1)?.term).toBe(1);

    await h.reconciler.pass(h.signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toEqual([]);
    expect(h.agent.calls.filter((op) => op === "replace-key")).toHaveLength(1);
    expect(h.slotReports.at(-1)).toMatchObject({ term: 2, phase: "ready" });

    const rotatedKeys3 = {
      homeKey: ed25519Pair().spki,
      relayKey: ed25519Pair().spki,
      ticketKey: { keyId: "tk-3", spki: ed25519Pair().spki },
    };
    h.slots.set(slotId, {
      ...h.slots.get(slotId)!,
      term: 3,
      revision: 3,
      phase: "preparing",
      keys: rotatedKeys3,
    });
    h.agent.calls.length = 0;
    h.agent.nextReply = { op: "replace-key", mode: "lost-before-apply" };
    await h.reconciler.pass(h.signal);
    expect(h.slots.get(slotId)?.pendingAgentWrites).toHaveLength(1);
    expect(h.agent.slots.get(slotId)?.term).toBe(2);

    await h.reconciler.pass(h.signal);
    expect(h.agent.calls.filter((op) => op === "replace-key")).toHaveLength(1);

    h.advance(901_000);
    await h.reconciler.pass(h.signal);
    expect(h.agent.slots.get(slotId)?.term).toBe(3);
    expect(h.slotReports.at(-1)).toMatchObject({ term: 3, phase: "ready" });
  });

  it("re-creates a missing slot on a replaced host after Account raises its term", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    await h.reconciler.pass(h.signal);
    const originalControlKey = h.agent.slots.get(slotId)!.controlKey;

    const hostKeys2 = ed25519Pair();
    h.agent.setHostKey(hostId, hostKeys2.privateKey);
    h.agent.slots.clear();
    // Durable profile remains on the durable disk across host replacement!
    expect(h.agent.profiles.has(slotId)).toBe(true);
    h.hosts.set(hostId, {
      ...host,
      generation: 2,
      revision: host.revision + 1,
      hostKey: hostKeys2.spki,
    });
    h.slots.set(slotId, {
      ...h.slots.get(slotId)!,
      hostGeneration: 2,
      hostKey: hostKeys2.spki,
    });
    h.events.length = 0;

    await h.reconciler.pass(h.signal);
    expect(h.account.bumpSlotTerm).toHaveBeenCalledWith(
      slotId,
      { revision: 1, expectedTerm: 1 },
      expect.any(AbortSignal),
    );
    const bumpIdx = h.events.indexOf("bumpSlotTerm:1->2");
    const createIdx = h.events.indexOf("agent:create");
    expect(bumpIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(bumpIdx);
    expect(h.agent.slots.get(slotId)?.term).toBe(2);
    expect(h.agent.slots.get(slotId)?.controlKey).not.toBe(originalControlKey);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 2,
      term: 2,
      phase: "ready",
      controlKey: h.agent.slots.get(slotId)!.controlKey,
    });
  });

  it("leaves slot deletion unsettled when erased is false", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    await h.reconciler.pass(h.signal);

    h.slots.set(slotId, {
      ...h.slots.get(slotId)!,
      state: "deleting",
      phase: "deleting",
      revision: 2,
    });
    h.agent.nextReply = { op: "delete", mode: "partial-erase-no-erased" };

    await h.reconciler.pass(h.signal);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 1,
      phase: "deleting",
      slotErased: false,
      profileErased: true,
      credentialsErased: true,
    });
    expect(h.slots.has(slotId)).toBe(true);
  });

  it("leaves slot deletion unsettled when profileErased is missing", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    await h.reconciler.pass(h.signal);

    h.slots.set(slotId, {
      ...h.slots.get(slotId)!,
      state: "deleting",
      phase: "deleting",
      revision: 2,
    });
    h.agent.nextReply = { op: "delete", mode: "partial-erase-no-profile" };

    await h.reconciler.pass(h.signal);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 1,
      phase: "deleting",
      slotErased: true,
      profileErased: false,
      credentialsErased: true,
    });
    expect(h.slots.has(slotId)).toBe(true);
  });

  it("leaves slot deletion unsettled when credentialsErased is missing and settles once accumulated evidence is complete (T1)", async () => {
    const h = createHarness();
    const { host } = await h.bringHostReady();
    h.slots.set(slotId, h.defaultSlot(host));
    await h.reconciler.pass(h.signal);

    h.slots.set(slotId, {
      ...h.slots.get(slotId)!,
      state: "deleting",
      phase: "deleting",
      revision: 2,
    });
    h.agent.nextReply = { op: "delete", mode: "partial-erase-no-credentials" };

    await h.reconciler.pass(h.signal);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 1,
      phase: "deleting",
      slotErased: true,
      profileErased: true,
      credentialsErased: false,
    });
    expect(h.slots.has(slotId)).toBe(true);

    // Second pass on pulling host (slot already absent): agent sees derived credentials gone -> settles!
    await h.reconciler.pass(h.signal);
    expect(h.slotReports.at(-1)).toMatchObject({
      slotId,
      hostGeneration: 1,
      phase: "deleted",
      slotErased: true,
      profileErased: true,
      credentialsErased: true,
    });
    expect(h.slots.has(slotId)).toBe(false);
  });

  it("exposes BrowserPoolAgentUnavailable refusal code only for verified signed refusals", async () => {
    const provisioner = ed25519Pair();
    const host = ed25519Pair();
    const fake = new FakePoolAgent({
      hostId,
      hostPrivateKey: host.privateKey,
      provisionerPublicKey: provisioner.publicKey,
    });
    const client = httpPoolAgentClient({
      provisionerKey: provisioner.privateKey,
      fetch: fake.fetch,
    });
    const target = { hostId, internalIp: "10.40.0.10", adminPort: 7311, hostKeySpki: host.spki };
    const signal = new AbortController().signal;

    fake.nextReply = { op: "list", mode: "signed-conflict" };
    await expect(client.list(target, signal)).rejects.toSatisfy(
      (err: unknown) => err instanceof BrowserPoolAgentUnavailable && err.refusal === "conflict",
    );

    fake.nextReply = { op: "list", mode: "signed-unavailable-after-apply" };
    await expect(client.list(target, signal)).rejects.toSatisfy(
      (err: unknown) => err instanceof BrowserPoolAgentUnavailable && err.refusal === "unavailable",
    );

    fake.nextReply = { op: "list", mode: "unsigned-bad-request" };
    await expect(client.list(target, signal)).rejects.toSatisfy(
      (err: unknown) => err instanceof BrowserPoolAgentUnavailable && err.refusal === undefined,
    );

    fake.nextReply = { op: "list", mode: "forged-signature" };
    await expect(client.list(target, signal)).rejects.toSatisfy(
      (err: unknown) => err instanceof BrowserPoolAgentUnavailable && err.refusal === undefined,
    );
  });

  it("enforces tombstones, 3-key replace-key equality, and configurable requireEgressUpstream in FakePoolAgent (X6)", async () => {
    const provisioner = ed25519Pair();
    const host = ed25519Pair();
    const fake = new FakePoolAgent({
      hostId,
      hostPrivateKey: host.privateKey,
      provisionerPublicKey: provisioner.publicKey,
    });
    const client = httpPoolAgentClient({
      provisionerKey: provisioner.privateKey,
      fetch: fake.fetch,
    });
    const target = { hostId, internalIp: "10.40.0.10", adminPort: 7311, hostKeySpki: host.spki };
    const signal = new AbortController().signal;

    const homeKey = ed25519Pair().spki;
    const relayKey1 = ed25519Pair().spki;
    const relayKey2 = ed25519Pair().spki;
    const ticketKey1 = { keyId: "tk-1", spki: ed25519Pair().spki };
    const ticketKey2 = { keyId: "tk-2", spki: ed25519Pair().spki };

    await client.create(
      target,
      {
        slotId,
        term: 2,
        keys: { homeKey, relayKey: relayKey1, ticketKey: ticketKey1 },
        guest: { vcpus: 2, memoryMib: 2048, profileMib: 2048 },
      },
      signal,
    );

    // Same term with identical all 3 keys is idempotent...
    await expect(
      client.replaceKey(
        target,
        { slotId, term: 2, keys: { homeKey, relayKey: relayKey1, ticketKey: ticketKey1 } },
        signal,
      ),
    ).resolves.toMatchObject({ term: 2 });

    // ...but same term with a changed relayKey or ticketKey is refused with signed conflict!
    await expect(
      client.replaceKey(
        target,
        { slotId, term: 2, keys: { homeKey, relayKey: relayKey2, ticketKey: ticketKey1 } },
        signal,
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BrowserPoolAgentUnavailable && err.refusal === "conflict",
    );
    await expect(
      client.replaceKey(
        target,
        { slotId, term: 2, keys: { homeKey, relayKey: relayKey1, ticketKey: ticketKey2 } },
        signal,
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BrowserPoolAgentUnavailable && err.refusal === "conflict",
    );

    // Delete tombstones term 2; recreating at <= 2 is refused with signed conflict, term 3 succeeds.
    await client.delete(target, { slotId, term: 2, eraseProfile: true }, signal);
    await expect(
      client.create(
        target,
        {
          slotId,
          term: 2,
          keys: { homeKey, relayKey: relayKey1, ticketKey: ticketKey1 },
          guest: { vcpus: 2, memoryMib: 2048, profileMib: 2048 },
        },
        signal,
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof BrowserPoolAgentUnavailable && err.refusal === "conflict",
    );

    // Non-pulling host omits credentialsErased when deleting an unknown slot.
    fake.requireEgressUpstream = false;
    const unknownDelete = await client.delete(
      target,
      { slotId: "bps_99999999-9999-4999-8999-999999999999", eraseProfile: true },
      signal,
    );
    expect(unknownDelete.erased).toBe(true);
    expect(unknownDelete.credentialsErased).toBe(false);
  });

  it("logs structured fatal errors, sets exitCode=1, and resolves main module paths portably (X5)", async () => {
    const previousExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runMainWithFatalHandling(async () => {
        throw new Error("boom");
      });
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(String(errorSpy.mock.calls[0]![0])) as Record<string, unknown>;
      expect(parsed).toEqual({ event: "home-provisioner.pass.failed" });
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
    }

    expect(isMainModule(undefined, import.meta.url)).toBe(false);
    expect(isMainModule("/tmp/definitely-not-this-file.ts", import.meta.url)).toBe(false);
  });
});
