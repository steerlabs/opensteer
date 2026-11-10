import { effectiveMembershipPredicate } from "./effective-membership.js";
import { requestSettlementActor } from "./request-settlement.js";
import { withDatabaseTransaction } from "./connection.js";
import { OpensteerError, type RunnerId, type UserId } from "@opensteer/core";
import {
  IntegrationServerTransportSchema,
  localMcpLaunchSecrets,
  type IntegrationInstallationId,
  type IntegrationServerId,
  type IntegrationToolMaterial,
  type LocalMcpLaunch,
} from "@opensteer/integration-core";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";
import type { Kysely, Transaction } from "kysely";
import {
  computerAppSetupRequestFromRow,
  insertComputerAppSetupRequestInTransaction,
} from "./computer-app-setup.js";
import { replaceServerToolsInTransaction } from "./integration-platform-stores.js";
import { machineOwnershipIn } from "./machine-ownership.js";
import type { DatabaseSchema } from "./schema.js";

/** An installed MCP server that one computer runs, as the Host tracks it. */
export interface LocalMcpServerRecord {
  /** The launch this server's computer approved, or null until it has. */
  readonly approvedLaunchDigest: string | null;
  readonly id: IntegrationServerId;
  readonly installationId: IntegrationInstallationId;
  readonly installationTitle: string;
  readonly launch: LocalMcpLaunch;
  readonly launchDigest: string;
  readonly name: string;
  readonly runnerId: RunnerId | null;
  /** What the computer is called, or null when none runs it or it was removed. */
  readonly runnerName: string | null;
  readonly status: "active" | "disabled" | "needs-attention";
}

/**
 * Replaces one server's sealed secrets given what is stored, or null when
 * nothing is: the caller opens, merges and seals while the server stays
 * locked. Null removes them.
 */
export type LocalMcpSecretsUpdate = (current: Buffer | null) => Promise<Buffer | null>;

const waitingSentence = "Waiting for approval on the computer that runs it.";
const startingSentence = "Starting on the computer that runs it.";
const declinedSentence =
  "The computer's owner declined running it there. Install the plugin again to ask again.";
const noOwnerSentence =
  "Nobody can approve it on that computer: it has no owner to ask. Install the plugin again, choosing a Mac of yours.";
const removedSentence =
  "The computer that ran it was removed. Install the plugin again, choosing another computer.";

/**
 * The MCP servers a computer runs for its Deployment, and the approval each
 * waits on (`docs/computers.md`, "MCP servers on a computer").
 *
 * A server runs only once its computer's owner approved its exact launch on
 * that computer: the owner answers the same exact setup requests every
 * other approval on a Mac does, as `kind: "server"`, and pins the launch by
 * digest. The Host rechecks the current server, target Runner and approved
 * digest inside admission before relaying a launch to the Runner.
 */
export class LocalMcpServerStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  async list(): Promise<readonly LocalMcpServerRecord[]> {
    return records(this.#database, await serverRows(this.#database));
  }

  /** Where a plugin's servers run when its installer names no computer: the Main one. */
  async mainComputer(): Promise<RunnerId | null> {
    const main = await this.#database
      .selectFrom("runners")
      .select("id")
      .where("kind", "=", "main")
      .where("revokedAt", "is", null)
      .orderBy("enrolledAt", "asc")
      .executeTakeFirst();
    return main?.id ?? null;
  }

  /** A computer of this Deployment by name, or null when it is not one (any longer). */
  async computerName(runnerId: RunnerId): Promise<string | null> {
    const runner = await this.#database
      .selectFrom("runners")
      .select("name")
      .where("id", "=", runnerId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return runner?.name ?? null;
  }

  async get(serverId: IntegrationServerId): Promise<LocalMcpServerRecord | null> {
    return (await records(this.#database, await serverRows(this.#database, serverId)))[0] ?? null;
  }

  /**
   * Asks each computer about every server pinned to it that it has not
   * approved as it now launches, unless its owner declined it: one waiting
   * approval per server, replaced when what it would show changed. Answers
   * with the computers whose approvals changed, which are sent them again.
   */
  async requestApprovals(now = new Date()): Promise<readonly RunnerId[]> {
    const changed = new Set<RunnerId>();
    for (const server of await this.list()) {
      if (server.runnerId === null || server.status === "disabled") continue;
      if (server.approvedLaunchDigest === server.launchDigest) continue;
      const runnerId = server.runnerId;
      const asked = await withDatabaseTransaction(this.#database, async (transaction) => {
        // The computer, then the server, then the request: the order every
        // server approval takes them in, and the one computer apps use.
        await lockComputer(transaction, runnerId);
        await lockServer(transaction, server.id);
        const locked = (await records(transaction, await serverRows(transaction, server.id)))[0];
        if (
          !locked ||
          locked.runnerId !== runnerId ||
          locked.status === "disabled" ||
          locked.approvedLaunchDigest === locked.launchDigest
        ) {
          return false;
        }
        const ownership = await machineOwnershipIn(transaction, runnerId);
        const owner = ownership?.effectiveOwner ?? null;
        const setup = await transaction
          .selectFrom("integrationInstallations")
          .innerJoin("plugins", "plugins.id", "integrationInstallations.pluginId")
          .innerJoin("threads", "threads.id", "plugins.setupThreadId")
          .innerJoin(
            "workspaceMemberships",
            "workspaceMemberships.workspaceId",
            "threads.workspaceId",
          )
          .where("workspaceMemberships.userId", "=", owner)
          .where(effectiveMembershipPredicate())
          .select(["threads.id as threadId", "threads.title as threadTitle", "threads.workspaceId"])
          .where("integrationInstallations.id", "=", locked.installationId)
          .executeTakeFirst();
        const waiting = await transaction
          .selectFrom("computerAppSetupRequests")
          .selectAll()
          .where("kind", "=", "server")
          .where("runnerId", "=", runnerId)
          .where("definitionId", "=", locked.id)
          // FOR UPDATE: Delete an expired or superseded server setup request.
          .forUpdate()
          .executeTakeFirst();
        if (
          waiting &&
          waiting.definitionDigest === locked.launchDigest &&
          waiting.ownerUserId === owner &&
          // A task's generated title replaces its first line soon after it starts; a
          // retitle must not replace an approval someone may be reviewing.
          waiting.threadId === (setup?.threadId ?? null) &&
          waiting.workspaceId === (setup?.workspaceId ?? null) &&
          waiting.expiresAt > now
        ) {
          return false;
        }
        if (waiting) {
          await transaction
            .deleteFrom("computerAppSetupRequests")
            .where("id", "=", waiting.id)
            .execute();
        }
        if (owner === null) {
          await setStatus(
            transaction,
            locked.id,
            "needs-attention",
            locked.runnerName === null ? removedSentence : noOwnerSentence,
            now,
          );
          return waiting !== undefined;
        }
        await insertComputerAppSetupRequestInTransaction(transaction, {
          access: "read-write",
          app: null,
          definitionDigest: locked.launchDigest,
          definitionId: locked.id,
          kind: "server",
          ...setup,
          now,
          ownerUserId: owner,
          runnerId,
          server: {
            installationTitle: locked.installationTitle,
            launch: locked.launch,
            name: locked.name,
            serverId: locked.id,
          },
        });
        await setStatus(transaction, locked.id, "needs-attention", waitingSentence, now);
        return true;
      });
      if (asked) changed.add(runnerId);
    }
    return [...changed];
  }

  /**
   * The computer's owner allowed one server there. The answer counts only
   * for the current authenticated owner, over this exact request, and while the server still launches
   * as the request showed. Answers with what now may run.
   */
  async approve(input: {
    readonly actorUserId: UserId;
    readonly settlementSessionId?: string | undefined;
    readonly now?: Date;
    readonly runnerId: RunnerId;
    /** The secrets its launch declares, as the owner answered them. */
    readonly secrets: LocalMcpSecretsUpdate;
    readonly setupRequestId: string;
  }): Promise<{ readonly launchDigest: string; readonly serverId: IntegrationServerId }> {
    const now = input.now ?? new Date();
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const { request, server } = await answeredRequest(transaction, { ...input, now });
      await transaction
        .deleteFrom("computerAppSetupRequests")
        .where("id", "=", request.id)
        .execute();
      await transaction
        .updateTable("integrationServers")
        .set({
          approvedLaunchDigest: server.launchDigest,
          status: "needs-attention",
          statusDetail: startingSentence,
          updatedAt: now,
        })
        .where("id", "=", server.id)
        .execute();
      await replaceSecrets(transaction, server.id, input.runnerId, input.secrets, now);
      await requestSettlementActor(transaction, input.actorUserId, input.settlementSessionId);
      return { launchDigest: server.launchDigest, serverId: server.id };
    });
  }

  /**
   * The owner of the computer that runs an approved server changed what it
   * was given for its secrets. Only while it still launches as approved: a
   * new launch takes its secrets with its approval.
   */
  async setSecrets(input: {
    readonly actorUserId: UserId;
    /** The launch `secrets` was checked against. */
    readonly launchDigest: string;
    readonly now?: Date;
    readonly secrets: LocalMcpSecretsUpdate;
    readonly serverId: IntegrationServerId;
  }): Promise<{ readonly runnerId: RunnerId }> {
    const now = input.now ?? new Date();
    const named = await this.get(input.serverId);
    if (!named?.runnerId) {
      throw new OpensteerError({ code: "not_found", message: "That server isn't installed." });
    }
    const runnerId = named.runnerId;
    return withDatabaseTransaction(this.#database, async (transaction) => {
      await lockComputer(transaction, runnerId);
      await lockServer(transaction, input.serverId);
      const server = (await records(transaction, await serverRows(transaction, input.serverId)))[0];
      if (!server || server.runnerId !== runnerId || server.status === "disabled") {
        throw new OpensteerError({ code: "not_found", message: "That server isn't installed." });
      }
      const ownership = await machineOwnershipIn(transaction, runnerId);
      if (ownership?.effectiveOwner !== input.actorUserId) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Only the owner of the computer that runs it can change its secrets.",
        });
      }
      if (server.approvedLaunchDigest !== server.launchDigest) {
        throw new OpensteerError({
          code: "conflict",
          message: "It's waiting for approval. Enter its secrets when you approve it.",
        });
      }
      if (server.launchDigest !== input.launchDigest) {
        throw new OpensteerError({
          code: "conflict",
          message: "Its plugin changed just now. Try again.",
        });
      }
      await replaceSecrets(transaction, server.id, runnerId, input.secrets, now);
      return { runnerId };
    });
  }

  /** The approved servers that take secrets on computers this person owns, whose secrets they set. */
  async withSecretsOwnedBy(ownerUserId: UserId): Promise<readonly LocalMcpServerRecord[]> {
    const owned: LocalMcpServerRecord[] = [];
    for (const server of await this.list()) {
      if (
        server.runnerId === null ||
        server.status === "disabled" ||
        server.approvedLaunchDigest !== server.launchDigest ||
        localMcpLaunchSecrets(server.launch).length === 0
      )
        continue;
      const ownership = await machineOwnershipIn(this.#database, server.runnerId);
      if (ownership?.effectiveOwner === ownerUserId) owned.push(server);
    }
    return owned;
  }

  /** One server's sealed secrets for the computer that runs it, or null when it has none there. */
  async secrets(serverId: IntegrationServerId, runnerId: RunnerId): Promise<Buffer | null> {
    const row = await this.#database
      .selectFrom("integrationServerSecrets")
      .select("encryptedPayload")
      .where("serverId", "=", serverId)
      .where("runnerId", "=", runnerId)
      .executeTakeFirst();
    return row?.encryptedPayload ?? null;
  }

  /** The computer's owner declined one server there; it is not asked about again. */
  async decline(input: {
    readonly actorUserId: UserId;
    readonly settlementSessionId?: string | undefined;
    readonly now?: Date;
    readonly runnerId: RunnerId;
    readonly setupRequestId: string;
  }): Promise<void> {
    const now = input.now ?? new Date();
    await withDatabaseTransaction(this.#database, async (transaction) => {
      const { request, server } = await answeredRequest(transaction, { ...input, now });
      await transaction
        .deleteFrom("computerAppSetupRequests")
        .where("id", "=", request.id)
        .execute();
      await setStatus(transaction, server.id, "disabled", declinedSentence, now);
      await requestSettlementActor(transaction, input.actorUserId, input.settlementSessionId);
    });
  }

  /**
   * What the server listed once its computer started it. False when the
   * approval it ran under is no longer the one on record, so nothing changed.
   */
  async recordTools(input: {
    readonly launchDigest: string;
    readonly now?: Date;
    readonly serverId: IntegrationServerId;
    readonly tools: readonly IntegrationToolMaterial[];
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const server = await lockedApproved(transaction, input.serverId, input.launchDigest);
      if (!server) return false;
      await replaceServerToolsInTransaction(transaction, {
        now,
        serverId: input.serverId,
        catalog: { definitions: {}, tools: input.tools },
      });
      await transaction
        .updateTable("integrationServers")
        .set({
          status: "active",
          statusDetail: null,
          toolGeneration: server.toolGeneration + 1,
          updatedAt: now,
        })
        .where("id", "=", input.serverId)
        .execute();
      return true;
    });
  }

  /** Why the approved server could not be listed on its computer. */
  async recordFailure(input: {
    readonly detail: string;
    readonly launchDigest: string;
    readonly now?: Date;
    readonly serverId: IntegrationServerId;
  }): Promise<void> {
    await withDatabaseTransaction(this.#database, async (transaction) => {
      if (!(await lockedApproved(transaction, input.serverId, input.launchDigest))) return;
      await setStatus(
        transaction,
        input.serverId,
        "needs-attention",
        input.detail.slice(0, 1_000),
        input.now ?? new Date(),
      );
    });
  }
}

type ServerRow = Awaited<ReturnType<typeof serverRows>>[number];

async function serverRows(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  serverId?: IntegrationServerId,
) {
  let query = database
    .selectFrom("integrationServers")
    .innerJoin(
      "integrationInstallations",
      "integrationInstallations.id",
      "integrationServers.installationId",
    )
    .select([
      "integrationInstallations.title as installationTitle",
      "integrationServers.approvedLaunchDigest",
      "integrationServers.id",
      "integrationServers.installationId",
      "integrationServers.name",
      "integrationServers.status",
      "integrationServers.toolGeneration",
      "integrationServers.transport",
    ])
    .where(({ ref }) => ref("integrationServers.transport", "->>").key("type"), "=", "runner")
    .orderBy("integrationServers.id", "asc");
  if (serverId !== undefined) query = query.where("integrationServers.id", "=", serverId);
  return query.execute();
}

async function records(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  rows: readonly ServerRow[],
): Promise<readonly LocalMcpServerRecord[]> {
  const servers = rows.flatMap((row) => {
    const transport = IntegrationServerTransportSchema.parse(row.transport);
    return transport.type === "runner" ? [{ row, transport }] : [];
  });
  const runnerIds = [
    ...new Set(
      servers.flatMap(({ transport }) => (transport.runnerId ? [transport.runnerId] : [])),
    ),
  ];
  const names = new Map(
    runnerIds.length === 0
      ? []
      : (
          await database
            .selectFrom("runners")
            .select(["id", "name"])
            .where("id", "in", runnerIds)
            .where("revokedAt", "is", null)
            .execute()
        ).map(({ id, name }) => [id, name] as const),
  );
  return servers.map(({ row, transport }) => ({
    approvedLaunchDigest: row.approvedLaunchDigest,
    id: row.id,
    installationId: row.installationId,
    installationTitle: row.installationTitle,
    launch: transport.launch,
    launchDigest: localMcpLaunchDigest(transport.launch),
    name: row.name,
    runnerId: transport.runnerId,
    runnerName: transport.runnerId ? (names.get(transport.runnerId) ?? null) : null,
    status: row.status,
  }));
}

/** The answered request, verified as that Mac's owner's, and the server it names. */
async function answeredRequest(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorUserId: UserId;
    readonly settlementSessionId?: string | undefined;
    readonly now: Date;
    readonly runnerId: RunnerId;
    readonly setupRequestId: string;
  },
) {
  const named = await transaction
    .selectFrom("computerAppSetupRequests")
    .select("definitionId")
    .where("id", "=", input.setupRequestId)
    .where("kind", "=", "server")
    .executeTakeFirst();
  if (!named) {
    throw new OpensteerError({ code: "conflict", message: "This approval is no longer waiting." });
  }
  // The computer, then the server, then the request: the order every server
  // approval takes them in, and the one computer apps use.
  await lockComputer(transaction, input.runnerId);
  await lockServer(transaction, named.definitionId as IntegrationServerId);
  const row = await transaction
    .selectFrom("computerAppSetupRequests")
    .selectAll()
    .where("id", "=", input.setupRequestId)
    .where("runnerId", "=", input.runnerId)
    .where("kind", "=", "server")
    // FOR UPDATE: Approval and denial delete this server setup request.
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.expiresAt <= input.now) {
    throw new OpensteerError({ code: "conflict", message: "This approval is no longer waiting." });
  }
  const ownership = await machineOwnershipIn(transaction, input.runnerId);
  if (ownership?.effectiveOwner !== input.actorUserId || row.ownerUserId !== input.actorUserId) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Only this computer’s owner can approve its servers.",
    });
  }
  const request = computerAppSetupRequestFromRow(row);
  const server = (
    await records(
      transaction,
      await serverRows(transaction, request.definitionId as IntegrationServerId),
    )
  ).at(0);
  if (
    !server ||
    server.runnerId !== input.runnerId ||
    server.launchDigest !== request.definitionDigest
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "This server changed since the computer was asked about it; it will be asked again.",
    });
  }
  return { request, server };
}

/**
 * The computer's own row only. A server approval settles no task's Request,
 * so it takes none of the Runs and Workspaces a computer app approval does.
 */
async function lockComputer(
  transaction: Transaction<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<void> {
  await transaction
    .selectFrom("runners")
    .select("id")
    .where("id", "=", runnerId)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

async function lockServer(
  transaction: Transaction<DatabaseSchema>,
  serverId: IntegrationServerId,
): Promise<void> {
  await transaction
    .selectFrom("integrationServers")
    .select("id")
    .where("id", "=", serverId)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

/**
 * The server, locked, while it is still enabled, launched as `launchDigest`
 * says and approved so; null once a reinstall, a decline or a new approval
 * moved on from what its computer ran.
 */
async function lockedApproved(
  transaction: Transaction<DatabaseSchema>,
  serverId: IntegrationServerId,
  launchDigest: string,
): Promise<{ readonly toolGeneration: number } | null> {
  const server = await transaction
    .selectFrom("integrationServers")
    .select(["approvedLaunchDigest", "status", "toolGeneration", "transport"])
    .where("id", "=", serverId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!server || server.status === "disabled" || server.approvedLaunchDigest !== launchDigest) {
    return null;
  }
  const transport = IntegrationServerTransportSchema.parse(server.transport);
  return transport.type === "runner" && localMcpLaunchDigest(transport.launch) === launchDigest
    ? server
    : null;
}

/** What was entered for another computer is not kept for this one. */
export async function replaceSecrets(
  transaction: Transaction<DatabaseSchema>,
  serverId: IntegrationServerId,
  runnerId: RunnerId,
  update: LocalMcpSecretsUpdate,
  now: Date,
): Promise<void> {
  const current = await transaction
    .selectFrom("integrationServerSecrets")
    .select(["encryptedPayload", "runnerId"])
    .where("serverId", "=", serverId)
    .executeTakeFirst();
  const next = await update(current?.runnerId === runnerId ? current.encryptedPayload : null);
  if (next === null) {
    if (current) {
      await transaction
        .deleteFrom("integrationServerSecrets")
        .where("serverId", "=", serverId)
        .execute();
    }
    return;
  }
  await transaction
    .insertInto("integrationServerSecrets")
    .values({ encryptedPayload: next, runnerId, serverId, updatedAt: now })
    .onConflict((conflict) =>
      conflict.column("serverId").doUpdateSet({ encryptedPayload: next, runnerId, updatedAt: now }),
    )
    .execute();
}

async function setStatus(
  transaction: Transaction<DatabaseSchema>,
  serverId: IntegrationServerId,
  status: "disabled" | "needs-attention",
  detail: string,
  now: Date,
): Promise<void> {
  await transaction
    .updateTable("integrationServers")
    .set({ status, statusDetail: detail, updatedAt: now })
    .where("id", "=", serverId)
    .execute();
}
