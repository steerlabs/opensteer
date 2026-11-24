import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import {
  BrowserPoolHostDesiredSchema,
  BrowserPoolHostIdSchema,
  BrowserPoolHostSlotEgressRequestSchema,
  BrowserPoolSlotIdSchema,
  ManagedBrowserPoolTargetResponseSchema,
  browserPoolHostSlotEgressSigningBytes,
  browserPoolHostSlotEgressWindowMs,
  managedBrowserPoolRegistrationSigningBytes,
  managedBrowserPoolRegistrationWindowMs,
  type BrowserPoolHostBootCompleteRequest,
  type BrowserPoolHostBootRequest,
  type BrowserPoolHostBootResponse,
  type BrowserPoolHostCheck,
  type BrowserPoolHostDesiredResponse,
  type BrowserPoolHostId,
  type BrowserPoolHostReplaceUnreadyRequest,
  type BrowserPoolHostReplaceUnreadyResponse,
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
import type { CloudComputerSecretCipher } from "./secret-cipher.js";
import { ControlPlaneError } from "../server/errors.js";
import type { CloudComputerConfig } from "./config.js";
import { normalizeEgressEndpoint } from "./egress-validation.js";
import type { BrowserPoolHostTable, BrowserPoolSlotTable } from "./pool-tables.js";
import type { CloudComputerEgressEndpointTable } from "./tables.js";
import {
  beginJournalWrite,
  finishJournalWrite,
  sendOrRecoverJournalWrite,
} from "./write-journal.js";

type Database = Kysely<ControlPlaneDatabaseSchema>;
type TransactionDb = Transaction<ControlPlaneDatabaseSchema>;
type PoolHost = Selectable<BrowserPoolHostTable>;
type PoolSlot = Selectable<BrowserPoolSlotTable>;

const bootstrapLifetimeMs = 20 * 60_000;
export const maxUnenrolledHostAutoReplacements = 2;

export class PoolSlotEgressRateLimitedError extends Error {
  override readonly name = "PoolSlotEgressRateLimitedError";
}
const emptyDigest = "0".repeat(64);
const clearBootToken = {
  bootstrapDigest: null,
  sealedBootstrapToken: null,
  bootstrapExpiresAt: null,
};

interface BrowserPoolStoreDeps {
  readonly db: Database;
  readonly config: CloudComputerConfig;
  readonly cipher: CloudComputerSecretCipher;
  readonly now: () => Date;
  readonly assignEgress: (
    tx: TransactionDb,
    computerId: CloudComputerId,
  ) => Promise<Selectable<CloudComputerEgressEndpointTable> | undefined>;
  readonly egressCredentials: (endpoint: Selectable<CloudComputerEgressEndpointTable>) =>
    | {
        url: string;
        username: string;
        password: string;
      }
    | undefined;
}

export class BrowserPoolStore {
  readonly #db: Database;
  readonly #config: CloudComputerConfig;
  readonly #cipher: CloudComputerSecretCipher;
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
        phase: "preparing",
        homeKey: null,
        relayKey: null,
        ticketKeyId: null,
        ticketKeySpki: null,
        keysRegisteredAt: null,
        keysIssuedAt: null,
        controlKey: null,
        guestVcpus: pool.guestVcpus,
        guestMemoryMib: pool.guestMemoryMib,
        profileMib: pool.profileMib,
        pendingAgentWrites: "[]",
        slotErasedAt: null,
        profileErasedAt: null,
        credentialsErasedAt: null,
        failedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        tombstonedAt: null,
      })
      .executeTakeFirstOrThrow();
  }

  /**
   * The one settlement of a deleted Cloud Computer's browser: nothing of it is left to erase
   * (its slot erased, never placed, or never given). Records it once, and completes the
   * deletion when the VM and the backup key are gone too. Caller holds the `cloudComputers` lock.
   */
  async #settleBrowserSlotErasure(tx: TransactionDb, computerId: CloudComputerId, now: Date) {
    const computer = await tx
      .selectFrom("cloudComputers")
      .select(["vmDestroyedAt", "backupsUnreadableAt", "browserSlotErasedAt", "tombstonedAt"])
      .where("id", "=", computerId)
      .executeTakeFirst();
    if (!computer || computer.browserSlotErasedAt) return;
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

  /**
   * A fresh Home replaces this Cloud Computer's (a new deployment, without the old one's
   * profiles): its slot is erased as a deletion erases one, profile included, and the computer
   * gets a new slot once that one is gone. Its own profiles' bindings would otherwise make the
   * pool host refuse the fresh Home's whole inventory. Caller holds the `cloudComputers` lock.
   */
  async retireSlotForFreshHome(
    tx: TransactionDb,
    computerId: CloudComputerId,
    now: Date,
  ): Promise<void> {
    const slot = await tx
      .selectFrom("browserPoolSlots")
      .select([
        "slotId",
        "hostId",
        "state",
        "slotErasedAt",
        "profileErasedAt",
        "credentialsErasedAt",
      ])
      .where("computerId", "=", computerId)
      .where("tombstonedAt", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (slot?.hostId === null) {
      // Never placed on a host: nothing to erase there.
      await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slot.slotId)
        .set({
          state: "deleted",
          phase: "deleted",
          controlKey: null,
          slotErasedAt: slot.slotErasedAt ?? now,
          profileErasedAt: slot.profileErasedAt ?? now,
          credentialsErasedAt: slot.credentialsErasedAt ?? now,
          failedAt: null,
          tombstonedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
    } else if (slot?.state === "active") {
      await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slot.slotId)
        .set({
          state: "deleting",
          phase: "deleting",
          failedAt: null,
          lastError: null,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      return;
    } else if (slot) return;
    await this.createSlotForComputer(tx, computerId, now);
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
    if (!slot) {
      // Review A2: no live slot (deleted before this account gave it one, or a row moved by
      // 0040). Nothing is left to erase once every slot it ever had confirmed its erasure; one
      // whose erasure is unconfirmed still holds the deletion.
      const unconfirmed = await tx
        .selectFrom("browserPoolSlots")
        .select("slotId")
        .where("computerId", "=", computerId)
        .where((eb) =>
          eb.or([
            eb("slotErasedAt", "is", null),
            eb("profileErasedAt", "is", null),
            eb("credentialsErasedAt", "is", null),
          ]),
        )
        .executeTakeFirst();
      if (!unconfirmed) await this.#settleBrowserSlotErasure(tx, computerId, now);
      return;
    }
    if (slot.hostId === null) {
      await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slot.slotId)
        .set({
          state: "deleted",
          phase: "deleted",
          controlKey: null,
          slotErasedAt: slot.slotErasedAt ?? now,
          profileErasedAt: slot.profileErasedAt ?? now,
          credentialsErasedAt: slot.credentialsErasedAt ?? now,
          failedAt: null,
          tombstonedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      await this.#settleBrowserSlotErasure(tx, computerId, now);
      return;
    }
    if (slot.state === "active") {
      await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slot.slotId)
        .set({
          state: "deleting",
          phase: "deleting",
          failedAt: null,
          lastError: null,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
    }
  }

  /**
   * W2 + T7: Syncs externally deleted Cloud Computers in a separate transaction
   * (`cloud_computers -> browser_pool_slots`), then reconciles capacity and placement in declared
   * lock order (`advisory:browser-pool-capacity -> browser_pool_hosts -> browser_pool_slots`).
   */
  async #reconcileCapacity(): Promise<void> {
    const pool = this.#config.browserPool;

    // 0. Every live Cloud Computer has a slot (one moved forward by 0040_browser_always_pooled
    // has none yet), at the size this account is configured with now: a migration cannot know
    // it. Lock order cloud_computers -> browser_pool_slots, as everywhere.
    await this.#db.transaction().execute(async (tx) => {
      const missing = await tx
        .selectFrom("cloudComputers")
        .select("id")
        .where("state", "in", ["active", "suspended"])
        .where("deletionRequestedAt", "is", null)
        .where("tombstonedAt", "is", null)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("browserPoolSlots")
                .select("slotId")
                .whereRef("browserPoolSlots.computerId", "=", "cloudComputers.id")
                .where("browserPoolSlots.tombstonedAt", "is", null),
            ),
          ),
        )
        .orderBy("id")
        .forNoKeyUpdate()
        .skipLocked()
        .execute();
      const now = this.#now();
      for (const { id } of missing) {
        const live = await tx
          .selectFrom("browserPoolSlots")
          .select("slotId")
          .where("computerId", "=", id)
          .where("tombstonedAt", "is", null)
          .executeTakeFirst();
        if (!live) await this.createSlotForComputer(tx, id, now);
      }
    });

    // 1. Separate transaction so slot locks are never held before host locks (T7).
    await this.#db.transaction().execute(async (tx) => {
      const now = this.#now();
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
      if (deletedComputerIds.length === 0) return;
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
    });

    // 2. Capacity sizing and placement in declared lock order (advisory -> hosts -> slots).
    await this.#db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('browser-pool-capacity', 0))`.execute(
        tx,
      );
      const now = this.#now();

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
            everEnrolled: false,
            autoReplaceCount: 0,
            hostPublicKey: null,
            relayPublicKey: null,
            pendingProviderWrites: "[]",
            readinessStartedAt: now,
            lastError: null,
            createdAt: now,
            updatedAt: now,
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
            phase: "preparing",
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
    // Z8: Count every non-tombstoned slot referencing each host (active or deleting, regardless of host phase).
    const pageIds = page.map(({ id }) => id);
    const liveSlotCounts = new Map<BrowserPoolHostId, number>();
    if (pageIds.length > 0) {
      const counts = await this.#db
        .selectFrom("browserPoolSlots")
        .select(["hostId", sql<string>`count(*)`.as("count")])
        .where("tombstonedAt", "is", null)
        .where("hostId", "in", pageIds)
        .groupBy("hostId")
        .execute();
      for (const entry of counts) {
        if (entry.hostId) liveSlotCounts.set(entry.hostId, Number(entry.count));
      }
    }
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
          machineType: row.machineType,
          profileDiskName: row.profileDiskName,
          profileDiskSizeGb: row.profileDiskSizeGb,
          ...(row.profileDiskRef ? { profileDiskRef: row.profileDiskRef } : {}),
          agentPort: this.#config.browserPool.agentPort,
          relayPort: this.#config.browserPool.relayPort,
          release: row.release,
          ...(row.providerServerRef ? { providerServerRef: row.providerServerRef } : {}),
          ...(row.previousProviderServerRef
            ? { previousProviderServerRef: row.previousProviderServerRef }
            : {}),
          ...(row.internalIp ? { internalIp: row.internalIp } : {}),
          enrolled: row.enrolledAt !== null,
          everEnrolled: row.everEnrolled,
          autoReplaceCount: row.autoReplaceCount,
          ...(token ? { bootstrapToken: token } : {}),
          ...(row.hostPublicKey ? { hostKey: row.hostPublicKey } : {}),
          ...(row.pendingProviderWrites.length
            ? { pendingProviderWrites: row.pendingProviderWrites }
            : {}),
          ...(row.readinessStartedAt
            ? { readinessStartedAt: row.readinessStartedAt.toISOString() }
            : {}),
          liveSlotCount: liveSlotCounts.get(row.id) ?? 0,
        });
      }),
    );
    return {
      hosts,
      ...(rows.length > limit ? { next: page.at(-1)!.id } : {}),
    };
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
              finishJournalWrite(row.pendingProviderWrites, check.token),
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
        const result = sendOrRecoverJournalWrite(
          row.pendingProviderWrites,
          check.operation === "send-provider-write" ? "send" : "recover",
          check.token,
          this.#now(),
          () => row.state !== "deleted",
        );
        if (!result.allowed) return false;
        if (result.nextWrites) {
          await tx
            .updateTable("browserPoolHosts")
            .where("id", "=", id)
            .set({ pendingProviderWrites: JSON.stringify(result.nextWrites) })
            .executeTakeFirstOrThrow();
        }
        return true;
      }
      if (check.operation === "create") return needsPoolHostVm(row) && Boolean(row.bootstrapDigest);
      if (check.operation === "begin-provider-write") {
        const { write } = check;
        if (
          row.state === "deleted" ||
          write.generation !== row.generation ||
          (write.kind === "create-disk" &&
            (Boolean(row.profileDiskRef) || write.diskName !== row.profileDiskName)) ||
          (write.kind === "create" && (!needsPoolHostVm(row) || !row.bootstrapDigest)) ||
          (write.kind === "power-on" && write.serverRef !== row.providerServerRef)
        ) {
          return false;
        }
        const result = beginJournalWrite(row.pendingProviderWrites, write, this.#now());
        if (!result.allowed || !result.nextWrites) return false;
        await tx
          .updateTable("browserPoolHosts")
          .where("id", "=", id)
          .set({ pendingProviderWrites: JSON.stringify(result.nextWrites) })
          .executeTakeFirst();
      }
      return true;
    });
  }

  /**
   * T8: Auto-replaces an unenrolled host that missed its readiness window, at most twice.
   * Never replaces a host that has ever enrolled (that requires an operator decision).
   */
  async replaceUnenrolledHost(
    id: BrowserPoolHostId,
    input: BrowserPoolHostReplaceUnreadyRequest,
  ): Promise<BrowserPoolHostReplaceUnreadyResponse> {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("browserPoolHosts")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !row ||
        row.tombstonedAt !== null ||
        row.state !== "active" ||
        row.revision !== input.revision ||
        row.generation !== input.generation ||
        row.everEnrolled ||
        row.enrolledAt !== null ||
        row.autoReplaceCount >= maxUnenrolledHostAutoReplacements ||
        row.pendingProviderWrites.length !== 0
      ) {
        return { replaced: false };
      }
      const liveSlot = await tx
        .selectFrom("browserPoolSlots")
        .select("slotId")
        .where("hostId", "=", id)
        .where("tombstonedAt", "is", null)
        .limit(1)
        .forShare()
        .executeTakeFirst();
      if (liveSlot) return { replaced: false };

      const now = this.#now();
      const updated = await tx
        .updateTable("browserPoolHosts")
        .where("id", "=", id)
        .set({
          ...clearBootToken,
          generation: row.generation + 1,
          autoReplaceCount: row.autoReplaceCount + 1,
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
          updatedAt: now,
        })
        .returning(["generation", "revision"])
        .executeTakeFirstOrThrow();
      return { replaced: true, generation: updated.generation, revision: updated.revision };
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
          everEnrolled: true,
          hostPublicKey: input.hostKey,
          relayPublicKey: input.relayKey,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * S4: Pool host pulls one slot's exclusive egress credentials over HTTPS, signed by its current
   * enrolled host key. Note: assigns a free egress endpoint as an intentional S4 side effect when
   * the Cloud Computer does not yet hold one. Every failure returns one uniform refusal.
   */
  async egressForPoolHost(
    hostIdParam: string,
    rawBody: unknown,
    checkVerifiedSlotRateLimit?: (hostId: BrowserPoolHostId, slotId: BrowserPoolSlotId) => boolean,
  ) {
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
    if (checkVerifiedSlotRateLimit && !checkVerifiedSlotRateLimit(host.id, body.slotId)) {
      throw new PoolSlotEgressRateLimitedError("Too many pool host egress requests");
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
      if (!endpoint) return {};
      const credentials = this.#egressCredentials(endpoint);
      if (!credentials) return {};
      // Y6: enforce the strict egress upstream rule (https://host:port) before serving to a pool host.
      const normalized = normalizeEgressEndpoint(credentials);
      return normalized.ok ? { egress: normalized.value } : {};
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
        "slot.failedAt",
        "slot.updatedAt",
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
        ...(row.phase === "failed"
          ? { failedAt: (row.failedAt ?? row.updatedAt).toISOString() }
          : {}),
        ...(row.pendingAgentWrites.length
          ? { pendingAgentWrites: [...row.pendingAgentWrites] }
          : {}),
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
              finishJournalWrite(row.pendingAgentWrites, check.token),
            ),
          })
          .executeTakeFirst();
        return true;
      }
      if (!row || row.revision !== check.revision || row.tombstonedAt !== null) return false;
      if (check.operation === "recover-agent-write" || check.operation === "send-agent-write") {
        const result = sendOrRecoverJournalWrite(
          row.pendingAgentWrites,
          check.operation === "send-agent-write" ? "send" : "recover",
          check.token,
          this.#now(),
          (write) => (write.kind === "delete" ? row.state === "deleting" : row.state === "active"),
        );
        if (!result.allowed) return false;
        if (result.nextWrites) {
          await tx
            .updateTable("browserPoolSlots")
            .where("slotId", "=", slotId)
            .set({ pendingAgentWrites: JSON.stringify(result.nextWrites) })
            .executeTakeFirstOrThrow();
        }
        return true;
      }
      if (check.operation !== "begin-agent-write") return false;
      const { write } = check;
      const validState =
        write.kind === "delete"
          ? row.state === "deleting"
          : row.state === "active" && row.keysRegisteredAt !== null;
      if (!validState || write.hostId !== row.hostId || write.term !== row.term) {
        return false;
      }
      const result = beginJournalWrite(row.pendingAgentWrites, write, this.#now());
      if (!result.allowed || !result.nextWrites) return false;
      await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slotId)
        .set({ pendingAgentWrites: JSON.stringify(result.nextWrites) })
        .executeTakeFirst();
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
          phase: "preparing",
          failedAt: null,
          lastError: null,
          updatedAt: this.#now(),
        })
        .returning(["term", "revision"])
        .executeTakeFirstOrThrow();
      return { bumped: true, term: updated.term, revision: updated.revision };
    });
  }

  /** T1 + T5: Settles deletion on accumulated `*_erased_at` columns and checks `hostGeneration`. */
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
                "state",
                "deletionRequestedAt",
                "vmDestroyedAt",
                "backupsUnreadableAt",
                "browserSlotErasedAt",
                "tombstonedAt",
              ])
              .where("id", "=", peek.computerId)
              .forNoKeyUpdate()
              .executeTakeFirst()
          : undefined;

      const host = peek.hostId
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
        !host ||
        host.generation !== report.hostGeneration ||
        (report.phase === "ready" && (host.phase !== "ready" || !host.enrolledAt))
      ) {
        return { recorded: false };
      }

      const now = this.#now();
      // X5: Erasure evidence is accepted only while the slot is deleting.
      const deletingSlot = row.state === "deleting";
      const nextSlotErasedAt =
        deletingSlot && report.slotErased ? (row.slotErasedAt ?? now) : row.slotErasedAt;
      const nextProfileErasedAt =
        deletingSlot && report.profileErased ? (row.profileErasedAt ?? now) : row.profileErasedAt;
      const nextCredentialsErasedAt =
        deletingSlot && report.credentialsErased
          ? (row.credentialsErasedAt ?? now)
          : row.credentialsErasedAt;
      const allErased =
        nextSlotErasedAt !== null &&
        nextProfileErasedAt !== null &&
        nextCredentialsErasedAt !== null;

      if (report.phase === "deleted" && (row.pendingAgentWrites.length !== 0 || !allErased)) {
        return { recorded: false };
      }

      const deleted = report.phase === "deleted";
      await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", row.slotId)
        .set({
          state: deleted ? "deleted" : row.state,
          phase: report.phase,
          appliedTerm: report.phase === "ready" ? report.term : row.appliedTerm,
          appliedHostGeneration:
            report.phase === "ready" ? report.hostGeneration : row.appliedHostGeneration,
          controlKey: deleted ? null : (report.controlKey ?? row.controlKey),
          slotErasedAt: nextSlotErasedAt,
          profileErasedAt: nextProfileErasedAt,
          credentialsErasedAt: nextCredentialsErasedAt,
          failedAt: report.phase === "failed" ? now : null,
          lastError: report.lastError,
          updatedAt: now,
          ...(deleted ? { tombstonedAt: now } : {}),
        })
        .executeTakeFirstOrThrow();

      if (
        deleted &&
        computer &&
        computer.state !== "deleted" &&
        computer.deletionRequestedAt === null &&
        computer.tombstonedAt === null
      ) {
        // The slot of a Home a fresh one replaced (retireSlotForFreshHome): the computer lives on
        // and its new Home gets a slot of its own.
        await this.createSlotForComputer(tx, computer.id, now);
      } else if (deleted && computer) {
        await this.#settleBrowserSlotErasure(tx, computer.id, now);
      }
      return { recorded: true };
    });
  }

  /**
   * W4 + S5 + T4: Pooled Home registers its three public keys, authenticated by both its Host
   * bearer credential and an Ed25519 signature verified against `deployments.authorityEnvelope`.
   * Keeps the accepted `issuedAt` and refuses any non-newer registration unless identical.
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
        .where("tombstonedAt", "is", null)
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
        .where("tombstonedAt", "is", null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!slot || slot.state !== "active" || slot.tombstonedAt !== null) {
        throw new ControlPlaneError("conflict", "Browser slot is not active");
      }

      const { homeKey, relayKey, ticketKey } = input.document.keys;
      const sameKeys =
        slot.keysRegisteredAt !== null &&
        slot.homeKey === homeKey &&
        slot.relayKey === relayKey &&
        slot.ticketKeyId === ticketKey.keyId &&
        slot.ticketKeySpki === ticketKey.spki;

      // T4: Identical document replay is idempotent; any non-newer non-identical document is refused.
      if (sameKeys && slot.keysIssuedAt !== null && slot.keysIssuedAt.getTime() === issuedAtMs) {
        return this.#targetResponse(slot, host);
      }
      if (slot.keysIssuedAt !== null && issuedAtMs <= slot.keysIssuedAt.getTime()) {
        throw new ControlPlaneError(
          "unauthorized",
          "Browser pool key registration timestamp must be newer than the accepted registration",
        );
      }

      const now = this.#now();
      const issuedAt = new Date(issuedAtMs);
      if (sameKeys) {
        const updated = await tx
          .updateTable("browserPoolSlots")
          .where("slotId", "=", slot.slotId)
          .set({ keysIssuedAt: issuedAt, updatedAt: now })
          .returningAll()
          .executeTakeFirstOrThrow();
        return this.#targetResponse(updated, host);
      }

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
          keysIssuedAt: issuedAt,
          term: rotation ? slot.term + 1 : slot.term,
          phase: "preparing",
          failedAt: null,
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
      .where("tombstonedAt", "is", null)
      .executeTakeFirst();
    // The previous Home's slot is being erased; this Home's own comes once it is gone.
    if (slot?.state === "deleting") return { status: "preparing" };
    if (!slot || slot.state !== "active") {
      return { status: "failed" };
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
    if (slot.keysRegisteredAt === null) return { status: "unregistered" };
    if (slot.phase === "failed") return { status: "failed" };
    const hostReady =
      host !== undefined &&
      host.tombstonedAt === null &&
      host.state !== "deleted" &&
      host.phase === "ready" &&
      host.enrolledAt !== null &&
      host.internalIp !== null &&
      host.hostPublicKey !== null &&
      host.relayPublicKey !== null;
    const slotReady =
      slot.state === "active" &&
      slot.phase === "ready" &&
      slot.controlKey !== null &&
      slot.appliedTerm === slot.term &&
      slot.appliedHostGeneration === host?.generation;
    if (!hostReady || !slotReady) return { status: "preparing" };

    const { agentPort, relayPort } = this.#config.browserPool;
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

  async operatorListHosts() {
    const rows = await this.#db
      .selectFrom("browserPoolHosts")
      .selectAll()
      .orderBy("createdAt", "desc")
      .execute();
    return { hosts: rows.map(poolHostOperatorView) };
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
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // X2 + E3: A replaced host resets active slots (both ready and failed) to `preparing` so
      // neither Home target lookup nor `pool-slot-show` reads `ready` on a gone generation; keep
      // `appliedHostGeneration` intact so the provisioner bumps term and re-creates on the new
      // generation, and keep `lastError` visible until ready.
      await tx
        .updateTable("browserPoolSlots")
        .where("hostId", "=", id)
        .where("state", "=", "active")
        .where("phase", "in", ["ready", "failed"])
        .where("tombstonedAt", "is", null)
        .set({ phase: "preparing", failedAt: null, updatedAt: now })
        .execute();
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
    return { slots: rows.map(poolSlotOperatorView) };
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

  /** X2: Operator retries a failed active slot immediately while keeping lastError visible until ready. */
  async operatorRetrySlot(slotId: BrowserPoolSlotId) {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("slotId", "=", slotId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row) throw new ControlPlaneError("not_found", "Browser pool slot was not found");
      if (row.tombstonedAt !== null || row.state !== "active" || row.phase !== "failed") {
        throw new ControlPlaneError(
          "conflict",
          "Only an active failed browser pool slot can be retried",
        );
      }
      const now = this.#now();
      const updated = await tx
        .updateTable("browserPoolSlots")
        .where("slotId", "=", slotId)
        .set({ phase: "preparing", failedAt: null, updatedAt: now })
        .returningAll()
        .executeTakeFirstOrThrow();
      return poolSlotOperatorView(updated);
    });
  }
}

function poolHostOperatorView(row: PoolHost) {
  return {
    id: row.id,
    generation: row.generation,
    revision: row.revision,
    state: row.state,
    phase: row.phase,
    machineType: row.machineType,
    slotsCapacity: row.slotsCapacity,
    profileDiskName: row.profileDiskName,
    profileDiskSizeGb: row.profileDiskSizeGb,
    profileDiskRef: row.profileDiskRef,
    providerServerRef: row.providerServerRef,
    previousProviderServerRef: row.previousProviderServerRef,
    internalIp: row.internalIp,
    enrolledAt: row.enrolledAt,
    everEnrolled: row.everEnrolled,
    autoReplaceCount: row.autoReplaceCount,
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
    keysIssuedAt: row.keysIssuedAt,
    slotErasedAt: row.slotErasedAt,
    profileErasedAt: row.profileErasedAt,
    credentialsErasedAt: row.credentialsErasedAt,
    failedAt: row.failedAt,
    lastError: row.lastError,
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
  if (state === "active") return phase === "preparing" || phase === "ready" || phase === "failed";
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
