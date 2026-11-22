import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import {
  BrowserPoolHostDesiredSchema,
  BrowserPoolHostIdSchema,
  BrowserPoolHostSlotEgressRequestSchema,
  BrowserPoolSlotIdSchema,
  ManagedBrowserPoolTargetResponseSchema,
  browserPoolHostSlotEgressSigningBytes,
  browserPoolHostSlotEgressWindowMs,
  defaultBrowserPoolAgentPort,
  defaultBrowserPoolRelayPort,
  managedBrowserPoolRegistrationSigningBytes,
  managedBrowserPoolRegistrationWindowMs,
  type BrowserPoolHostBootCompleteRequest,
  type BrowserPoolHostBootRequest,
  type BrowserPoolHostBootResponse,
  type BrowserPoolHostCheck,
  type BrowserPoolHostDesiredResponse,
  type BrowserPoolHostId,
  type BrowserPoolHostReport,
  type BrowserPoolSlotBumpTermRequest,
  type BrowserPoolSlotBumpTermResponse,
  type BrowserPoolSlotCheck,
  type BrowserPoolSlotDesiredResponse,
  type BrowserPoolSlotId,
  type BrowserPoolSlotReport,
  type CloudComputerId,
  type ManagedBrowserPoolRegistrationRequest,
  type ManagedBrowserPoolTargetResponse,
} from "@opensteer/control-plane-protocol";
import type { DeploymentId } from "@opensteer/core";
import { HostDiscoveryEnvelopeSchema, hostKeyFingerprint } from "@opensteer/deployment-authority";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import type { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { ControlPlaneError } from "../server/errors.js";
import type { CloudComputerConfig } from "./config.js";
import type { BrowserPoolHostTable, BrowserPoolSlotTable } from "./pool-tables.js";
import type { CloudComputerEgressEndpointTable } from "./tables.js";

type Database = Kysely<ControlPlaneDatabaseSchema>;
type TransactionDb = Transaction<ControlPlaneDatabaseSchema>;
type PoolHost = Selectable<BrowserPoolHostTable>;
type PoolSlot = Selectable<BrowserPoolSlotTable>;

const bootstrapLifetimeMs = 20 * 60_000;
const writeGraceMs = 3 * 60_000;
const dispatchedWriteGraceMs = 15 * 60_000;
const emptyDigest = "0".repeat(64);
const clearBootToken = {
  bootstrapDigest: null,
  sealedBootstrapToken: null,
  bootstrapExpiresAt: null,
};

interface BrowserPoolStoreDeps {
  readonly db: Database;
  readonly config: CloudComputerConfig;
  readonly cipher: HostedTeamSetupTokenCipher;
  readonly now: () => Date;
  readonly assignEgress: (
    tx: TransactionDb,
    computerId: CloudComputerId,
  ) => Promise<Selectable<CloudComputerEgressEndpointTable> | undefined>;
  readonly egressCredentials: (endpoint: Selectable<CloudComputerEgressEndpointTable>) => {
    url: string;
    username: string;
    password: string;
  };
}

export class BrowserPoolStore {
  readonly #db: Database;
  readonly #config: CloudComputerConfig;
  readonly #cipher: HostedTeamSetupTokenCipher;
  readonly #now: () => Date;
  readonly #assignEgress: BrowserPoolStoreDeps["assignEgress"];
  readonly #egressCredentials: BrowserPoolStoreDeps["egressCredentials"];

  constructor(deps: BrowserPoolStoreDeps) {
    this.#db = deps.db;
    this.#config = deps.config;
    this.#cipher = deps.cipher;
    this.#now = deps.now;
    this.#assignEgress = deps.assignEgress;
    this.#egressCredentials = deps.egressCredentials;
  }

  /** Creates the one durable slot row for a newly provisioned pooled Cloud Computer (S1). */
  async createSlotForComputer(
    tx: TransactionDb,
    computerId: CloudComputerId,
    now: Date,
  ): Promise<void> {
    const pool = this.#config.browserPool;
    if (!pool) return;
    const slotId = BrowserPoolSlotIdSchema.parse(`bps_${randomUUID()}`);
    await tx
      .insertInto("browserPoolSlots")
      .values({
        slotId,
        computerId,
        hostId: null,
        term: 1,
        appliedTerm: null,
        appliedHostGeneration: null,
        state: "active",
        phase: "waiting_keys",
        homeKey: null,
        relayKey: null,
        ticketKeyId: null,
        ticketKeySpki: null,
        keysRegisteredAt: null,
        controlKey: null,
        guestVcpus: pool.guestVcpus,
        guestMemoryMib: pool.guestMemoryMib,
        profileMib: pool.profileMib,
        pendingAgentWrites: "[]",
        deletionRequestedAt: null,
        slotErasedAt: null,
        profileErasedAt: null,
        credentialsErasedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        tombstonedAt: null,
      })
      .executeTakeFirstOrThrow();
  }

  /**
   * Transitions a deleted Cloud Computer's browser slot to `deleting` (or tombstones it immediately
   * when it was never placed on any pool host). Caller must already hold `cloudComputers` lock.
   */
  async markComputerDeleted(
    tx: TransactionDb,
    computerId: CloudComputerId,
    now: Date,
  ): Promise<void> {
    const slot = await tx
      .selectFrom("browserPoolSlots")
      .selectAll()
      .where("computerId", "=", computerId)
      .where("tombstonedAt", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!slot) return;
    if (slot.hostId === null) {
      await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slot.slotId)
        .set({
          state: "deleted",
          phase: "deleted",
          controlKey: null,
          deletionRequestedAt: slot.deletionRequestedAt ?? now,
          slotErasedAt: slot.slotErasedAt ?? now,
          profileErasedAt: slot.profileErasedAt ?? now,
          credentialsErasedAt: slot.credentialsErasedAt ?? now,
          deletedAt: slot.deletedAt ?? now,
          tombstonedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      const computer = await tx
        .selectFrom("cloudComputers")
        .select(["vmDestroyedAt", "backupsUnreadableAt", "browserSlotErasedAt", "tombstonedAt"])
        .where("id", "=", computerId)
        .executeTakeFirst();
      if (computer && !computer.browserSlotErasedAt) {
        const settled =
          computer.vmDestroyedAt !== null &&
          computer.backupsUnreadableAt !== null &&
          computer.tombstonedAt === null;
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", computerId)
          .set({
            browserSlotErasedAt: now,
            ...(settled ? { phase: "deleted", tombstonedAt: now, updatedAt: now } : {}),
          })
          .executeTakeFirstOrThrow();
      }
      return;
    }
    if (slot.state === "active") {
      await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slot.slotId)
        .set({
          state: "deleting",
          phase: "deleting",
          deletionRequestedAt: slot.deletionRequestedAt ?? now,
          lastError: null,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
    }
  }

  /**
   * W2: Reconciles pool host count and places unplaced slots onto the ready host with the most
   * free slots. Also catches any Cloud Computer deleted outside the direct path (e.g. org offboard).
   */
  async #reconcileCapacity(): Promise<void> {
    const pool = this.#config.browserPool;
    await this.#db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('browser-pool-capacity', 0))`.execute(
        tx,
      );
      const now = this.#now();

      // 1. Sync deleted Cloud Computers -> deleting/tombstoned slots in lock order (cloud_computers -> browser_pool_slots).
      const deletedComputerIds = (
        await tx
          .selectFrom("browserPoolSlots")
          .innerJoin("cloudComputers", "cloudComputers.id", "browserPoolSlots.computerId")
          .select("cloudComputers.id")
          .where("browserPoolSlots.tombstonedAt", "is", null)
          .where("browserPoolSlots.state", "=", "active")
          .where("cloudComputers.state", "=", "deleted")
          .orderBy("cloudComputers.id")
          .execute()
      ).map(({ id }) => id);
      if (deletedComputerIds.length > 0) {
        await tx
          .selectFrom("cloudComputers")
          .select("id")
          .where("id", "in", deletedComputerIds)
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        for (const computerId of deletedComputerIds) {
          await this.markComputerDeleted(tx, computerId, now);
        }
      }

      if (!pool) return;

      // 2. Lock live hosts (ordered by id), then read/lock live slots (ordered by slotId).
      const hosts = await tx
        .selectFrom("browserPoolHosts")
        .selectAll()
        .where("tombstonedAt", "is", null)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      const slots = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("tombstonedAt", "is", null)
        .orderBy("slotId")
        .forNoKeyUpdate()
        .execute();

      const activeHostIds = new Set(
        hosts.filter((host) => host.state === "active").map((host) => host.id),
      );
      let activeCapacity = hosts
        .filter((host) => host.state === "active")
        .reduce((sum, host) => sum + host.slotsCapacity, 0);
      const neededOnActive = slots.filter(
        (slot) => slot.state === "active" && (!slot.hostId || activeHostIds.has(slot.hostId)),
      ).length;

      while (activeCapacity < neededOnActive) {
        const id = BrowserPoolHostIdSchema.parse(`ph_${randomUUID()}`);
        const profileDiskName = `osp-disk-${id.slice("ph_".length)}`;
        await tx
          .insertInto("browserPoolHosts")
          .values({
            id,
            generation: 1,
            state: "active",
            phase: "provisioning",
            region: pool.region,
            machineType: pool.machineType,
            slotsCapacity: pool.slotsPerHost,
            profileDiskName,
            profileDiskSizeGb: pool.profileDiskSizeGb,
            profileDiskRef: null,
            release: JSON.stringify(pool.release),
            providerServerRef: null,
            previousProviderServerRef: null,
            internalIp: null,
            bootstrapDigest: null,
            sealedBootstrapToken: null,
            bootstrapExpiresAt: null,
            completedBootDigest: null,
            enrolledAt: null,
            hostPublicKey: null,
            relayPublicKey: null,
            pendingProviderWrites: "[]",
            readinessStartedAt: now,
            lastError: null,
            createdAt: now,
            updatedAt: now,
            reportedAt: null,
            deletedAt: null,
            tombstonedAt: null,
          })
          .executeTakeFirstOrThrow();
        activeCapacity += pool.slotsPerHost;
      }

      // 3. Place unplaced active slots onto the ready active host with the most free slots (W2).
      const readyHosts = hosts.filter(
        (host) =>
          host.state === "active" &&
          host.phase === "ready" &&
          host.enrolledAt !== null &&
          host.hostPublicKey !== null &&
          host.internalIp !== null,
      );
      if (readyHosts.length === 0) return;

      const occupied = new Map<BrowserPoolHostId, number>();
      for (const host of readyHosts) occupied.set(host.id, 0);
      for (const slot of slots) {
        if (slot.hostId && occupied.has(slot.hostId)) {
          occupied.set(slot.hostId, occupied.get(slot.hostId)! + 1);
        }
      }

      const unplaced = slots.filter((slot) => slot.state === "active" && slot.hostId === null);
      for (const slot of unplaced) {
        let chosen: PoolHost | undefined;
        let maxFree = 0;
        for (const host of readyHosts) {
          const free = host.slotsCapacity - (occupied.get(host.id) ?? 0);
          if (free > maxFree) {
            maxFree = free;
            chosen = host;
          }
        }
        if (!chosen) break;
        occupied.set(chosen.id, (occupied.get(chosen.id) ?? 0) + 1);
        await tx
          .updateTable("browserPoolSlots")
          .where("slotId", "=", slot.slotId)
          .set({
            hostId: chosen.id,
            phase: slot.keysRegisteredAt ? "provisioning" : "waiting_keys",
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
      }
    });
  }

  async desiredHosts(
    after?: BrowserPoolHostId,
    limit = 100,
  ): Promise<BrowserPoolHostDesiredResponse> {
    await this.#reconcileCapacity();
    let query = this.#db
      .selectFrom("browserPoolHosts")
      .selectAll()
      .where("tombstonedAt", "is", null)
      .orderBy("id")
      .limit(limit + 1);
    if (after) query = query.where("id", ">", after);
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const hosts = await Promise.all(
      page.map(async (snapshot) => {
        let row = snapshot;
        if (needsPoolHostVm(row) && !row.bootstrapDigest) {
          row = await this.#db.transaction().execute(async (tx) => {
            const current = await lockedPoolHost(tx, snapshot.id);
            if (!needsPoolHostVm(current) || current.bootstrapDigest) return current;
            const token = newSecret();
            return tx
              .updateTable("browserPoolHosts")
              .where("id", "=", current.id)
              .set({
                bootstrapDigest: poolBootDigest(current, token),
                sealedBootstrapToken: this.#cipher.seal(
                  `pool-boot:${current.id}`,
                  current.generation,
                  token,
                ),
                bootstrapExpiresAt: null,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
          });
        }
        const token =
          needsPoolHostVm(row) &&
          row.sealedBootstrapToken &&
          (!row.bootstrapExpiresAt || row.bootstrapExpiresAt > this.#now())
            ? this.#cipher.open(`pool-boot:${row.id}`, row.generation, row.sealedBootstrapToken)
            : undefined;
        return BrowserPoolHostDesiredSchema.parse({
          id: row.id,
          generation: row.generation,
          revision: row.revision,
          state: row.state,
          region: row.region,
          machineType: row.machineType,
          slotsCapacity: row.slotsCapacity,
          profileDiskName: row.profileDiskName,
          profileDiskSizeGb: row.profileDiskSizeGb,
          ...(row.profileDiskRef ? { profileDiskRef: row.profileDiskRef } : {}),
          release: row.release,
          ...(row.providerServerRef ? { providerServerRef: row.providerServerRef } : {}),
          ...(row.previousProviderServerRef
            ? { previousProviderServerRef: row.previousProviderServerRef }
            : {}),
          ...(row.internalIp ? { internalIp: row.internalIp } : {}),
          enrolled: row.enrolledAt !== null,
          ...(token ? { bootstrapToken: token } : {}),
          ...(row.hostPublicKey ? { hostKey: row.hostPublicKey } : {}),
          ...(row.relayPublicKey ? { relayKey: row.relayPublicKey } : {}),
          ...(row.pendingProviderWrites.length
            ? { pendingProviderWrites: row.pendingProviderWrites }
            : {}),
          readinessStartedAt: row.readinessStartedAt.toISOString(),
        });
      }),
    );
    return { hosts, ...(rows.length > limit ? { next: page.at(-1)!.id } : {}) };
  }

  async checkPoolHost(id: BrowserPoolHostId, check: BrowserPoolHostCheck): Promise<boolean> {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("browserPoolHosts")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (check.operation === "orphan") return !row || row.tombstonedAt !== null;
      if (check.operation === "finish-provider-write") {
        if (!row || row.tombstonedAt) return false;
        await tx
          .updateTable("browserPoolHosts")
          .where("id", "=", id)
          .set({
            pendingProviderWrites: JSON.stringify(
              row.pendingProviderWrites.filter(({ token }) => token !== check.token),
            ),
          })
          .executeTakeFirst();
        return true;
      }
      if (!row || row.revision !== check.revision || row.tombstonedAt !== null) return false;
      if (
        check.operation === "recover-provider-write" ||
        check.operation === "send-provider-write"
      ) {
        const write = row.pendingProviderWrites.find(({ token }) => token === check.token);
        if (!write) return check.operation === "recover-provider-write";
        const expired =
          !!write.recoverAfter && Date.parse(write.recoverAfter) <= this.#now().getTime();
        if (check.operation === "send-provider-write") {
          if (row.state === "deleted" || expired) return false;
          if (!write.dispatched) {
            await tx
              .updateTable("browserPoolHosts")
              .where("id", "=", id)
              .set({
                pendingProviderWrites: JSON.stringify(
                  row.pendingProviderWrites.map((entry) =>
                    entry.token === write.token
                      ? {
                          ...entry,
                          dispatched: true,
                          recoverAfter: new Date(
                            this.#now().getTime() + dispatchedWriteGraceMs,
                          ).toISOString(),
                        }
                      : entry,
                  ),
                ),
              })
              .executeTakeFirstOrThrow();
          }
          return true;
        }
        if (!expired) return false;
        await tx
          .updateTable("browserPoolHosts")
          .where("id", "=", id)
          .set({
            pendingProviderWrites: JSON.stringify(
              row.pendingProviderWrites.filter(({ token }) => token !== check.token),
            ),
          })
          .executeTakeFirstOrThrow();
        return true;
      }
      if (check.operation === "create") return needsPoolHostVm(row) && Boolean(row.bootstrapDigest);
      if (check.operation === "begin-provider-write") {
        const { write } = check;
        if (
          row.state === "deleted" ||
          write.generation !== row.generation ||
          row.pendingProviderWrites.some(({ kind }) => kind === write.kind) ||
          (write.kind === "create-disk" &&
            (Boolean(row.profileDiskRef) || write.diskName !== row.profileDiskName)) ||
          (write.kind === "create" && (!needsPoolHostVm(row) || !row.bootstrapDigest)) ||
          (write.kind === "power-on" && write.serverRef !== row.providerServerRef)
        ) {
          return false;
        }
        await tx
          .updateTable("browserPoolHosts")
          .where("id", "=", id)
          .set({
            pendingProviderWrites: JSON.stringify([
              ...row.pendingProviderWrites,
              {
                ...write,
                dispatched: false,
                recoverAfter: new Date(this.#now().getTime() + writeGraceMs).toISOString(),
              },
            ]),
          })
          .executeTakeFirst();
      }
      return true;
    });
  }

  async reportPoolHost(report: BrowserPoolHostReport): Promise<{ recorded: boolean }> {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("browserPoolHosts")
        .selectAll()
        .where("id", "=", report.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !row ||
        row.revision !== report.revision ||
        row.generation !== report.generation ||
        row.tombstonedAt !== null ||
        !poolHostPhaseMatchesState(row.state, report.phase) ||
        (report.phase === "deleted" && row.pendingProviderWrites.length !== 0) ||
        (report.phase === "ready" &&
          (row.enrolledAt === null || row.hostPublicKey === null || row.relayPublicKey === null))
      ) {
        return { recorded: false };
      }
      if (report.phase === "deleted") {
        const liveSlot = await tx
          .selectFrom("browserPoolSlots")
          .select("slotId")
          .where("hostId", "=", row.id)
          .where("tombstonedAt", "is", null)
          .limit(1)
          .executeTakeFirst();
        if (liveSlot) return { recorded: false };
      }
      const now = this.#now();
      const deleted = report.phase === "deleted";
      await tx
        .updateTable("browserPoolHosts")
        .where("id", "=", row.id)
        .set({
          phase: report.phase,
          providerServerRef: deleted ? null : (report.providerServerRef ?? row.providerServerRef),
          profileDiskRef: deleted ? null : (report.profileDiskRef ?? row.profileDiskRef),
          internalIp: deleted ? null : report.internalIp,
          lastError: report.lastError,
          reportedAt: now,
          updatedAt: now,
          ...(deleted
            ? { ...clearBootToken, deletedAt: row.deletedAt ?? now, tombstonedAt: now }
            : {}),
          ...(row.bootstrapDigest && !row.bootstrapExpiresAt && report.providerServerRef
            ? {
                bootstrapExpiresAt: new Date(now.getTime() + bootstrapLifetimeMs),
                readinessStartedAt: now,
              }
            : {}),
          ...((report.phase === "booting" || report.phase === "failed") && row.phase === "ready"
            ? { readinessStartedAt: now }
            : {}),
        })
        .executeTakeFirstOrThrow();
      return { recorded: true };
    });
  }

  /** W3: Pool host boot fetches release metadata using its single-use bootstrap token. */
  async bootPoolHost(
    id: BrowserPoolHostId,
    input: BrowserPoolHostBootRequest,
  ): Promise<BrowserPoolHostBootResponse> {
    const row = await this.#db
      .selectFrom("browserPoolHosts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!validPoolHostBoot(row, id, input, this.#now())) throw invalidPoolBoot();
    return {
      hostId: row.id,
      generation: row.generation,
      profileDiskName: row.profileDiskName,
      release: row.release,
    };
  }

  /** W3: Single-use pool host enrolment pinning generated Ed25519 hostKey and relayKey. */
  async bootCompletePoolHost(
    id: BrowserPoolHostId,
    input: BrowserPoolHostBootCompleteRequest,
  ): Promise<void> {
    assertEd25519SpkiBase64(input.hostKey, "Invalid pool host public key");
    assertEd25519SpkiBase64(input.relayKey, "Invalid pool relay public key");
    if (input.hostKey === input.relayKey) {
      throw new ControlPlaneError(
        "bad_request",
        "Pool host key and relay key must be distinct keypairs",
      );
    }
    await this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("browserPoolHosts")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const replay = equalSecretDigests(
        poolBootDigest(row ?? { id, generation: 0 }, input.bootstrapToken),
        row?.completedBootDigest ?? emptyDigest,
      );
      if (
        row?.enrolledAt &&
        replay &&
        row.generation === input.generation &&
        row.state !== "deleted" &&
        row.hostPublicKey === input.hostKey &&
        row.relayPublicKey === input.relayKey
      ) {
        return;
      }
      if (!validPoolHostBoot(row, id, input, this.#now())) throw invalidPoolBoot();
      const now = this.#now();
      await tx
        .updateTable("browserPoolHosts")
        .where("id", "=", id)
        .set({
          ...clearBootToken,
          completedBootDigest: row.bootstrapDigest,
          enrolledAt: now,
          hostPublicKey: input.hostKey,
          relayPublicKey: input.relayKey,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * S4: Pool host pulls one slot's exclusive egress credentials over HTTPS, signed by its current
   * enrolled host key. Every failure returns one uniform refusal revealing nothing about which
   * check failed.
   */
  async egressForPoolHost(hostIdParam: string, rawBody: unknown) {
    const refuse = () =>
      new ControlPlaneError("unauthorized", "Browser pool slot egress request was refused");

    const hostIdParsed = BrowserPoolHostIdSchema.safeParse(hostIdParam);
    const parsed = BrowserPoolHostSlotEgressRequestSchema.safeParse(rawBody);
    if (!hostIdParsed.success || !parsed.success) throw refuse();

    const body = parsed.data;
    const hostId = hostIdParsed.data;
    if (body.hostId !== hostId) throw refuse();
    if (Buffer.from(body.nonce, "base64url").byteLength !== 16) throw refuse();

    const issuedAtMs = Date.parse(body.issuedAt);
    if (
      !Number.isFinite(issuedAtMs) ||
      Math.abs(this.#now().getTime() - issuedAtMs) > browserPoolHostSlotEgressWindowMs
    ) {
      throw refuse();
    }

    const signature = Buffer.from(body.signature, "base64");
    if (signature.byteLength !== 64) throw refuse();

    const host = await this.#db
      .selectFrom("browserPoolHosts")
      .select(["id", "state", "enrolledAt", "hostPublicKey", "tombstonedAt"])
      .where("id", "=", hostId)
      .executeTakeFirst();
    if (
      !host ||
      host.tombstonedAt !== null ||
      host.state === "deleted" ||
      host.enrolledAt === null ||
      host.hostPublicKey === null
    ) {
      throw refuse();
    }
    const publicKey = importEd25519Spki(Buffer.from(host.hostPublicKey, "base64"));
    if (
      !publicKey ||
      !verify(null, browserPoolHostSlotEgressSigningBytes(body), publicKey, signature)
    ) {
      throw refuse();
    }

    return this.#db.transaction().execute(async (tx) => {
      const peek = await tx
        .selectFrom("browserPoolSlots")
        .select(["computerId", "hostId", "state", "tombstonedAt"])
        .where("slotId", "=", body.slotId)
        .executeTakeFirst();
      if (
        !peek ||
        peek.tombstonedAt !== null ||
        peek.hostId !== hostId ||
        peek.state !== "active"
      ) {
        throw refuse();
      }
      // Lock in declared order: cloud_computers -> browser_pool_slots -> cloud_computer_egress_endpoints.
      const computer = await tx
        .selectFrom("cloudComputers")
        .select(["id", "state", "browserMode", "deletionRequestedAt", "tombstonedAt"])
        .where("id", "=", peek.computerId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !computer ||
        computer.browserMode !== "pool" ||
        computer.state !== "active" ||
        computer.deletionRequestedAt !== null ||
        computer.tombstonedAt !== null
      ) {
        throw refuse();
      }
      const slot = await tx
        .selectFrom("browserPoolSlots")
        .select(["hostId", "state", "tombstonedAt"])
        .where("slotId", "=", body.slotId)
        .forShare()
        .executeTakeFirst();
      if (
        !slot ||
        slot.tombstonedAt !== null ||
        slot.hostId !== hostId ||
        slot.state !== "active"
      ) {
        throw refuse();
      }
      const endpoint = await this.#assignEgress(tx, computer.id);
      return endpoint ? { egress: this.#egressCredentials(endpoint) } : {};
    });
  }

  async desiredSlots(
    after?: BrowserPoolSlotId,
    limit = 100,
  ): Promise<BrowserPoolSlotDesiredResponse> {
    await this.#reconcileCapacity();
    let query = this.#db
      .selectFrom("browserPoolSlots as slot")
      .innerJoin("browserPoolHosts as host", "host.id", "slot.hostId")
      .select([
        "slot.slotId",
        "slot.computerId",
        "slot.hostId",
        "slot.term",
        "slot.appliedTerm",
        "slot.appliedHostGeneration",
        "slot.revision",
        "slot.state",
        "slot.phase",
        "slot.homeKey",
        "slot.relayKey",
        "slot.ticketKeyId",
        "slot.ticketKeySpki",
        "slot.keysRegisteredAt",
        "slot.controlKey",
        "slot.guestVcpus",
        "slot.guestMemoryMib",
        "slot.profileMib",
        "slot.slotErasedAt",
        "slot.profileErasedAt",
        "slot.credentialsErasedAt",
        "slot.pendingAgentWrites",
        "host.generation as hostGeneration",
        "host.internalIp as hostInternalIp",
        "host.hostPublicKey as hostKey",
      ])
      .where("slot.tombstonedAt", "is", null)
      .where("host.tombstonedAt", "is", null)
      .where("host.phase", "=", "ready")
      .where("host.enrolledAt", "is not", null)
      .where("host.internalIp", "is not", null)
      .where("host.hostPublicKey", "is not", null)
      .where((eb) =>
        eb.or([
          eb("slot.state", "=", "deleting"),
          eb.and([eb("slot.state", "=", "active"), eb("slot.keysRegisteredAt", "is not", null)]),
        ]),
      )
      .orderBy("slot.slotId")
      .limit(limit + 1);
    if (after) query = query.where("slot.slotId", ">", after);
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    return {
      slots: page.map((row) => ({
        slotId: row.slotId,
        computerId: row.computerId,
        hostId: row.hostId!,
        hostGeneration: row.hostGeneration,
        hostInternalIp: row.hostInternalIp!,
        hostKey: row.hostKey!,
        term: row.term,
        ...(row.appliedTerm !== null ? { appliedTerm: row.appliedTerm } : {}),
        ...(row.appliedHostGeneration !== null
          ? { appliedHostGeneration: row.appliedHostGeneration }
          : {}),
        revision: row.revision,
        state: row.state,
        phase: row.phase,
        ...(row.homeKey && row.relayKey && row.ticketKeyId && row.ticketKeySpki
          ? {
              keys: {
                homeKey: row.homeKey,
                relayKey: row.relayKey,
                ticketKey: { keyId: row.ticketKeyId, spki: row.ticketKeySpki },
              },
            }
          : {}),
        guest: {
          vcpus: row.guestVcpus,
          memoryMib: row.guestMemoryMib,
          profileMib: row.profileMib,
        },
        ...(row.controlKey ? { controlKey: row.controlKey } : {}),
        slotErased: row.slotErasedAt !== null,
        profileErased: row.profileErasedAt !== null,
        credentialsErased: row.credentialsErasedAt !== null,
        ...(row.pendingAgentWrites.length ? { pendingAgentWrites: row.pendingAgentWrites } : {}),
      })),
      ...(rows.length > limit ? { next: page.at(-1)!.slotId } : {}),
    };
  }

  async checkPoolSlot(slotId: BrowserPoolSlotId, check: BrowserPoolSlotCheck): Promise<boolean> {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("slotId", "=", slotId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (check.operation === "finish-agent-write") {
        if (!row || row.tombstonedAt) return false;
        await tx
          .updateTable("browserPoolSlots")
          .where("slotId", "=", slotId)
          .set({
            pendingAgentWrites: JSON.stringify(
              row.pendingAgentWrites.filter(({ token }) => token !== check.token),
            ),
          })
          .executeTakeFirst();
        return true;
      }
      if (!row || row.revision !== check.revision || row.tombstonedAt !== null) return false;
      if (check.operation === "recover-agent-write" || check.operation === "send-agent-write") {
        const write = row.pendingAgentWrites.find(({ token }) => token === check.token);
        if (!write) return check.operation === "recover-agent-write";
        const expired =
          !!write.recoverAfter && Date.parse(write.recoverAfter) <= this.#now().getTime();
        if (check.operation === "send-agent-write") {
          const validState =
            write.kind === "delete" ? row.state === "deleting" : row.state === "active";
          if (!validState || expired) return false;
          if (!write.dispatched) {
            await tx
              .updateTable("browserPoolSlots")
              .where("slotId", "=", slotId)
              .set({
                pendingAgentWrites: JSON.stringify(
                  row.pendingAgentWrites.map((entry) =>
                    entry.token === write.token
                      ? {
                          ...entry,
                          dispatched: true,
                          recoverAfter: new Date(
                            this.#now().getTime() + dispatchedWriteGraceMs,
                          ).toISOString(),
                        }
                      : entry,
                  ),
                ),
              })
              .executeTakeFirstOrThrow();
          }
          return true;
        }
        if (!expired) return false;
        await tx
          .updateTable("browserPoolSlots")
          .where("slotId", "=", slotId)
          .set({
            pendingAgentWrites: JSON.stringify(
              row.pendingAgentWrites.filter(({ token }) => token !== check.token),
            ),
          })
          .executeTakeFirstOrThrow();
        return true;
      }
      if (check.operation === "begin-agent-write") {
        const { write } = check;
        const validState =
          write.kind === "delete"
            ? row.state === "deleting"
            : row.state === "active" && row.keysRegisteredAt !== null;
        if (
          !validState ||
          write.hostId !== row.hostId ||
          write.term !== row.term ||
          row.pendingAgentWrites.some(({ kind }) => kind === write.kind)
        ) {
          return false;
        }
        await tx
          .updateTable("browserPoolSlots")
          .where("slotId", "=", slotId)
          .set({
            pendingAgentWrites: JSON.stringify([
              ...row.pendingAgentWrites,
              {
                ...write,
                dispatched: false,
                recoverAfter: new Date(this.#now().getTime() + writeGraceMs).toISOString(),
              },
            ]),
          })
          .executeTakeFirst();
      }
      return true;
    });
  }

  /** S6 + W5: Monotonically raises a slot's term when a replacement host does not have the slot. */
  async bumpPoolSlotTerm(
    slotId: BrowserPoolSlotId,
    input: BrowserPoolSlotBumpTermRequest,
  ): Promise<BrowserPoolSlotBumpTermResponse> {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("slotId", "=", slotId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !row ||
        row.tombstonedAt !== null ||
        row.state !== "active" ||
        row.revision !== input.revision ||
        row.term !== input.expectedTerm ||
        row.pendingAgentWrites.length !== 0
      ) {
        return { bumped: false };
      }
      const updated = await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slotId)
        .set({
          term: row.term + 1,
          appliedTerm: null,
          appliedHostGeneration: null,
          controlKey: null,
          phase: "provisioning",
          lastError: null,
          updatedAt: this.#now(),
        })
        .returning(["term", "revision"])
        .executeTakeFirstOrThrow();
      return { bumped: true, term: updated.term, revision: updated.revision };
    });
  }

  async reportPoolSlot(report: BrowserPoolSlotReport): Promise<{ recorded: boolean }> {
    return this.#db.transaction().execute(async (tx) => {
      const peek = await tx
        .selectFrom("browserPoolSlots")
        .select(["computerId", "hostId"])
        .where("slotId", "=", report.slotId)
        .executeTakeFirst();
      if (!peek) return { recorded: false };

      // Lock in declared order: cloud_computers -> browser_pool_hosts -> browser_pool_slots.
      const computer =
        report.phase === "deleted"
          ? await tx
              .selectFrom("cloudComputers")
              .select([
                "id",
                "vmDestroyedAt",
                "backupsUnreadableAt",
                "browserSlotErasedAt",
                "tombstonedAt",
              ])
              .where("id", "=", peek.computerId)
              .forNoKeyUpdate()
              .executeTakeFirst()
          : undefined;

      const host =
        report.phase === "ready" && peek.hostId
          ? await tx
              .selectFrom("browserPoolHosts")
              .select(["id", "generation", "phase", "enrolledAt"])
              .where("id", "=", peek.hostId)
              .forShare()
              .executeTakeFirst()
          : undefined;

      const row = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("slotId", "=", report.slotId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !row ||
        row.computerId !== peek.computerId ||
        row.hostId !== peek.hostId ||
        row.revision !== report.revision ||
        row.term !== report.term ||
        row.tombstonedAt !== null ||
        !poolSlotPhaseMatchesState(row.state, report.phase) ||
        (report.phase === "ready" && (!host || host.phase !== "ready" || !host.enrolledAt)) ||
        (report.phase === "deleted" &&
          (row.pendingAgentWrites.length !== 0 ||
            !report.slotErased ||
            !report.profileErased ||
            !report.credentialsErased))
      ) {
        return { recorded: false };
      }

      const now = this.#now();
      const deleted = report.phase === "deleted";
      await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", row.slotId)
        .set({
          state: deleted ? "deleted" : row.state,
          phase: report.phase,
          appliedTerm: report.phase === "ready" ? report.term : row.appliedTerm,
          appliedHostGeneration:
            report.phase === "ready" && host ? host.generation : row.appliedHostGeneration,
          controlKey: deleted ? null : (report.controlKey ?? row.controlKey),
          slotErasedAt: report.slotErased ? (row.slotErasedAt ?? now) : row.slotErasedAt,
          profileErasedAt: report.profileErased
            ? (row.profileErasedAt ?? now)
            : row.profileErasedAt,
          credentialsErasedAt: report.credentialsErased
            ? (row.credentialsErasedAt ?? now)
            : row.credentialsErasedAt,
          lastError: report.lastError,
          updatedAt: now,
          ...(deleted ? { deletedAt: row.deletedAt ?? now, tombstonedAt: now } : {}),
        })
        .executeTakeFirstOrThrow();

      if (deleted && computer) {
        const settled =
          computer.vmDestroyedAt !== null &&
          computer.backupsUnreadableAt !== null &&
          computer.tombstonedAt === null;
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", computer.id)
          .set({
            browserSlotErasedAt: computer.browserSlotErasedAt ?? now,
            ...(settled ? { phase: "deleted", tombstonedAt: now, updatedAt: now } : {}),
          })
          .executeTakeFirstOrThrow();
      }
      return { recorded: true };
    });
  }

  /**
   * W4 + S5: Pooled Home registers its three public keys, authenticated by both its Host bearer
   * credential and an Ed25519 signature verified against the pinned key in `deployments.authorityEnvelope`.
   */
  async registerHomeBrowserPoolKeys(
    deploymentId: DeploymentId,
    input: ManagedBrowserPoolRegistrationRequest,
  ): Promise<ManagedBrowserPoolTargetResponse> {
    assertEd25519SpkiBase64(input.document.keys.homeKey, "Invalid Home slot key");
    assertEd25519SpkiBase64(input.document.keys.relayKey, "Invalid Home relay key");
    assertEd25519SpkiBase64(input.document.keys.ticketKey.spki, "Invalid Home ticket key");
    const issuedAtMs = Date.parse(input.document.issuedAt);
    if (
      !Number.isFinite(issuedAtMs) ||
      Math.abs(this.#now().getTime() - issuedAtMs) > managedBrowserPoolRegistrationWindowMs
    ) {
      throw new ControlPlaneError(
        "unauthorized",
        "Browser pool key registration timestamp is outside the allowed window",
      );
    }

    return this.#db.transaction().execute(async (tx) => {
      // Declared order: deployments -> cloud_computers -> browser_pool_hosts -> browser_pool_slots.
      const deployment = await tx
        .selectFrom("deployments")
        .select(["id", "lifecycle", "hostKeyFingerprint", "authorityEnvelope"])
        .where("id", "=", deploymentId)
        .forShare()
        .executeTakeFirst();
      if (!deployment || deployment.lifecycle !== "active") {
        throw new ControlPlaneError("unauthorized", "Deployment is not active");
      }

      const computer = await tx
        .selectFrom("cloudComputers")
        .select([
          "id",
          "state",
          "browserMode",
          "hostKeyFingerprint",
          "deletionRequestedAt",
          "tombstonedAt",
        ])
        .where("deploymentId", "=", deploymentId)
        .where("tombstonedAt", "is", null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!computer || computer.browserMode !== "pool") {
        throw new ControlPlaneError(
          "not_found",
          "Browser pool is not enabled for this Cloud Computer",
        );
      }
      if (computer.state !== "active" || computer.deletionRequestedAt !== null) {
        throw new ControlPlaneError("conflict", "Cloud Computer is not active");
      }
      if (input.document.cloudComputerId !== computer.id) {
        throw new ControlPlaneError(
          "unauthorized",
          "Registration document does not match this Cloud Computer",
        );
      }

      // S5: verify registration signature against the Home's pinned Ed25519 public key.
      const envelope = HostDiscoveryEnvelopeSchema.safeParse(deployment.authorityEnvelope);
      if (
        !envelope.success ||
        hostKeyFingerprint(envelope.data.publicKey.spki) !== deployment.hostKeyFingerprint ||
        computer.hostKeyFingerprint !== deployment.hostKeyFingerprint
      ) {
        throw new ControlPlaneError("unauthorized", "Pinned Home identity key is unavailable");
      }
      const pinnedKey = importEd25519Spki(Buffer.from(envelope.data.publicKey.spki, "base64url"));
      const sigBytes = Buffer.from(input.signature, "base64url");
      if (
        !pinnedKey ||
        sigBytes.byteLength !== 64 ||
        !verify(
          null,
          managedBrowserPoolRegistrationSigningBytes(input.document),
          pinnedKey,
          sigBytes,
        )
      ) {
        throw new ControlPlaneError("unauthorized", "Invalid Home registration signature");
      }

      const slotPeek = await tx
        .selectFrom("browserPoolSlots")
        .select("hostId")
        .where("computerId", "=", computer.id)
        .executeTakeFirst();
      const host = slotPeek?.hostId
        ? await tx
            .selectFrom("browserPoolHosts")
            .selectAll()
            .where("id", "=", slotPeek.hostId)
            .forShare()
            .executeTakeFirst()
        : undefined;

      const slot = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("computerId", "=", computer.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!slot || slot.state !== "active" || slot.tombstonedAt !== null) {
        throw new ControlPlaneError("conflict", "Browser slot is not active");
      }

      const { homeKey, relayKey, ticketKey } = input.document.keys;
      const unchanged =
        slot.keysRegisteredAt !== null &&
        slot.homeKey === homeKey &&
        slot.relayKey === relayKey &&
        slot.ticketKeyId === ticketKey.keyId &&
        slot.ticketKeySpki === ticketKey.spki;
      if (unchanged) {
        return this.#targetResponse(slot, host);
      }

      const now = this.#now();
      const rotation = slot.keysRegisteredAt !== null;
      const updated = await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slot.slotId)
        .set({
          homeKey,
          relayKey,
          ticketKeyId: ticketKey.keyId,
          ticketKeySpki: ticketKey.spki,
          keysRegisteredAt: now,
          term: rotation ? slot.term + 1 : slot.term,
          phase: slot.hostId ? (rotation ? "updating_keys" : "provisioning") : "waiting_host",
          lastError: null,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.#targetResponse(updated, host);
    });
  }

  /** W4 + S7: Returns the current browser pool target (or status) for an authenticated pooled Home. */
  async browserPoolTargetForHome(
    deploymentId: DeploymentId,
  ): Promise<ManagedBrowserPoolTargetResponse> {
    const computer = await this.#db
      .selectFrom("cloudComputers")
      .select(["id", "browserMode", "state", "deletionRequestedAt"])
      .where("deploymentId", "=", deploymentId)
      .where("tombstonedAt", "is", null)
      .executeTakeFirst();
    if (!computer || computer.browserMode !== "pool") {
      throw new ControlPlaneError(
        "not_found",
        "Browser pool is not enabled for this Cloud Computer",
      );
    }
    const slot = await this.#db
      .selectFrom("browserPoolSlots")
      .selectAll()
      .where("computerId", "=", computer.id)
      .executeTakeFirst();
    if (!slot) {
      throw new ControlPlaneError("not_found", "Browser slot was not found");
    }
    const host = slot.hostId
      ? await this.#db
          .selectFrom("browserPoolHosts")
          .selectAll()
          .where("id", "=", slot.hostId)
          .executeTakeFirst()
      : undefined;
    return this.#targetResponse(slot, host);
  }

  #targetResponse(slot: PoolSlot, host: PoolHost | undefined): ManagedBrowserPoolTargetResponse {
    if (slot.keysRegisteredAt === null) {
      return ManagedBrowserPoolTargetResponseSchema.parse({ status: "unregistered" });
    }
    if (slot.phase === "failed" || slot.state !== "active") {
      return ManagedBrowserPoolTargetResponseSchema.parse({ status: "failed" });
    }
    if (
      slot.phase === "ready" &&
      slot.appliedTerm === slot.term &&
      slot.controlKey !== null &&
      host &&
      slot.appliedHostGeneration === host.generation &&
      host.tombstonedAt === null &&
      host.state !== "deleted" &&
      host.phase === "ready" &&
      host.enrolledAt !== null &&
      host.internalIp !== null &&
      host.hostPublicKey !== null &&
      host.relayPublicKey !== null
    ) {
      const agentPort = this.#config.browserPool?.agentPort ?? defaultBrowserPoolAgentPort;
      const relayPort = this.#config.browserPool?.relayPort ?? defaultBrowserPoolRelayPort;
      return ManagedBrowserPoolTargetResponseSchema.parse({
        status: "ready",
        target: {
          kind: "managed-pool",
          agentUrl: `http://${host.internalIp}:${agentPort}`,
          slotId: slot.slotId,
          term: slot.term,
          agentKey: slot.controlKey,
          hostKey: host.hostPublicKey,
          relay: {
            host: host.internalIp,
            port: relayPort,
            relayHostKey: host.relayPublicKey,
          },
        },
      });
    }
    return ManagedBrowserPoolTargetResponseSchema.parse({ status: "preparing" });
  }

  async operatorListHosts() {
    const rows = await this.#db
      .selectFrom("browserPoolHosts")
      .selectAll()
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map(poolHostOperatorView);
  }

  async operatorShowHost(id: BrowserPoolHostId) {
    const row = await this.#db
      .selectFrom("browserPoolHosts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw new ControlPlaneError("not_found", "Browser pool host was not found");
    return poolHostOperatorView(row);
  }

  async operatorDrainHost(id: BrowserPoolHostId) {
    return this.#db.transaction().execute(async (tx) => {
      const row = await lockedPoolHost(tx, id);
      if (row.state === "deleted" || row.tombstonedAt !== null) {
        throw new ControlPlaneError("conflict", "Browser pool host is already deleted");
      }
      const updated = await tx
        .updateTable("browserPoolHosts")
        .where("id", "=", id)
        .set({ state: "draining", updatedAt: this.#now() })
        .returningAll()
        .executeTakeFirstOrThrow();
      return poolHostOperatorView(updated);
    });
  }

  /** W1 + S6/S7: Bumps host generation while preserving its durable profile disk. */
  async operatorReplaceHost(id: BrowserPoolHostId) {
    return this.#db.transaction().execute(async (tx) => {
      const row = await lockedPoolHost(tx, id);
      if (row.state === "deleted" || row.tombstonedAt !== null) {
        throw new ControlPlaneError("conflict", "Cannot replace a deleted browser pool host");
      }
      const now = this.#now();
      const updated = await tx
        .updateTable("browserPoolHosts")
        .where("id", "=", id)
        .set({
          ...clearBootToken,
          generation: row.generation + 1,
          previousProviderServerRef: row.providerServerRef ?? row.previousProviderServerRef,
          providerServerRef: null,
          internalIp: null,
          completedBootDigest: null,
          enrolledAt: null,
          hostPublicKey: null,
          relayPublicKey: null,
          phase: "provisioning",
          lastError: null,
          readinessStartedAt: now,
          reportedAt: null,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return poolHostOperatorView(updated);
    });
  }

  /** W10: Refuses deletion with 409 conflict while any non-tombstoned slot references the host. */
  async operatorDeleteHost(id: BrowserPoolHostId) {
    return this.#db.transaction().execute(async (tx) => {
      const row = await lockedPoolHost(tx, id);
      if (row.tombstonedAt !== null) return poolHostOperatorView(row);
      const liveSlot = await tx
        .selectFrom("browserPoolSlots")
        .select("slotId")
        .where("hostId", "=", id)
        .where("tombstonedAt", "is", null)
        .limit(1)
        .forShare()
        .executeTakeFirst();
      if (liveSlot) {
        throw new ControlPlaneError(
          "conflict",
          "Browser pool host still holds active or deleting browser slots",
        );
      }
      const now = this.#now();
      const updated = await tx
        .updateTable("browserPoolHosts")
        .where("id", "=", id)
        .set({
          ...clearBootToken,
          state: "deleted",
          phase: "deleting",
          lastError: null,
          deletedAt: row.deletedAt ?? now,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return poolHostOperatorView(updated);
    });
  }

  async operatorListSlots() {
    const rows = await this.#db
      .selectFrom("browserPoolSlots")
      .selectAll()
      .orderBy("createdAt", "desc")
      .execute();
    return rows.map(poolSlotOperatorView);
  }

  async operatorShowSlot(slotId: BrowserPoolSlotId) {
    const row = await this.#db
      .selectFrom("browserPoolSlots")
      .selectAll()
      .where("slotId", "=", slotId)
      .executeTakeFirst();
    if (!row) throw new ControlPlaneError("not_found", "Browser pool slot was not found");
    return poolSlotOperatorView(row);
  }
}

function poolHostOperatorView(row: PoolHost) {
  return {
    id: row.id,
    generation: row.generation,
    revision: row.revision,
    state: row.state,
    phase: row.phase,
    region: row.region,
    machineType: row.machineType,
    slotsCapacity: row.slotsCapacity,
    profileDiskName: row.profileDiskName,
    profileDiskSizeGb: row.profileDiskSizeGb,
    profileDiskRef: row.profileDiskRef,
    providerServerRef: row.providerServerRef,
    previousProviderServerRef: row.previousProviderServerRef,
    internalIp: row.internalIp,
    enrolledAt: row.enrolledAt,
    lastError: row.lastError,
    deletedAt: row.deletedAt,
    tombstonedAt: row.tombstonedAt,
    updatedAt: row.updatedAt,
  };
}

function poolSlotOperatorView(row: PoolSlot) {
  return {
    slotId: row.slotId,
    computerId: row.computerId,
    hostId: row.hostId,
    term: row.term,
    appliedTerm: row.appliedTerm,
    appliedHostGeneration: row.appliedHostGeneration,
    revision: row.revision,
    state: row.state,
    phase: row.phase,
    keysRegisteredAt: row.keysRegisteredAt,
    slotErasedAt: row.slotErasedAt,
    profileErasedAt: row.profileErasedAt,
    credentialsErasedAt: row.credentialsErasedAt,
    lastError: row.lastError,
    deletedAt: row.deletedAt,
    tombstonedAt: row.tombstonedAt,
    updatedAt: row.updatedAt,
  };
}

async function lockedPoolHost(tx: TransactionDb, id: BrowserPoolHostId) {
  const row = await tx
    .selectFrom("browserPoolHosts")
    .selectAll()
    .where("id", "=", id)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!row) throw new ControlPlaneError("not_found", "Browser pool host was not found");
  return row;
}

function needsPoolHostVm(row: PoolHost) {
  return row.state !== "deleted" && !row.providerServerRef && !row.enrolledAt;
}

function newSecret() {
  return randomBytes(32).toString("base64url");
}

function poolBootDigest(row: Pick<PoolHost, "id" | "generation">, token: string) {
  return digestSecret(`pool-host\0${row.id}\0${row.generation}\0${token}`);
}

function validPoolHostBoot(
  row: PoolHost | undefined,
  id: BrowserPoolHostId,
  input: BrowserPoolHostBootRequest,
  now: Date,
): row is PoolHost {
  const valid = equalSecretDigests(
    poolBootDigest(row ?? { id, generation: 0 }, input.bootstrapToken),
    row?.bootstrapDigest ?? emptyDigest,
  );
  return Boolean(
    row &&
    valid &&
    row.generation === input.generation &&
    row.state !== "deleted" &&
    row.bootstrapExpiresAt &&
    row.bootstrapExpiresAt > now &&
    !row.enrolledAt,
  );
}

function invalidPoolBoot() {
  return new ControlPlaneError(
    "unauthorized",
    "Invalid or expired browser pool host bootstrap token",
  );
}

function poolHostPhaseMatchesState(
  state: PoolHost["state"],
  phase: BrowserPoolHostReport["phase"],
) {
  if (phase === "failed" || phase === "provisioning")
    return state !== "deleted" || phase === "failed";
  if (state === "deleted") return phase === "deleted" || phase === "deleting";
  return phase === "booting" || phase === "ready";
}

function poolSlotPhaseMatchesState(
  state: PoolSlot["state"],
  phase: BrowserPoolSlotReport["phase"],
) {
  if (state === "deleting")
    return phase === "deleting" || phase === "deleted" || phase === "failed";
  if (state === "active")
    return (
      phase === "provisioning" ||
      phase === "ready" ||
      phase === "updating_keys" ||
      phase === "failed"
    );
  return false;
}

function importEd25519Spki(der: Buffer) {
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

function assertEd25519SpkiBase64(spki: string, message: string) {
  if (!importEd25519Spki(Buffer.from(spki, "base64"))) {
    throw new ControlPlaneError("bad_request", message);
  }
}
