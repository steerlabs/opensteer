import { randomBytes, randomUUID } from "node:crypto";
import { createPublicHttpsFetch } from "@opensteer/access/host";
import type { ControlPlaneAccountId } from "@opensteer/control-plane-protocol";
import {
  hostedTeamOrigin,
  hostedTeamsDomain,
  maximumLiveHostedTeamsPerAccount,
  type DesiredHostedTeam,
  type HostedTeamId,
  type HostedTeamPhase,
  type HostedTeamSlug,
  type HostedTeamState,
  type HostedTeamStatusReport,
} from "@opensteer/control-plane-protocol/hosted-teams";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import { digestSecret } from "@opensteer/shared/secretDigest";
import { z } from "zod";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";

type Database = Kysely<ControlPlaneDatabaseSchema>;
type DatabaseTransaction = Transaction<ControlPlaneDatabaseSchema>;

export interface HostedTeamView {
  readonly id: HostedTeamId;
  readonly slug: HostedTeamSlug;
  readonly origin: string;
  readonly state: Exclude<HostedTeamState, "deleted">;
  readonly phase: HostedTeamPhase;
  /** The served Host is running the latest setup link. */
  readonly ready: boolean;
  /** Someone completed first-owner setup, so a new setup link would open nothing. */
  readonly claimed: boolean;
  readonly statusMessage: string | null;
}

/** The plaintext setup token exists only in this result, on its way to the creator's browser. */
export interface IssuedSetupLink {
  readonly team: HostedTeamView;
  readonly setupToken: string;
}

/**
 * Hosted team servers an Account asked Opensteer to run, and what the provisioner last saw of
 * them. Account decides what should exist; the provisioner makes it so and reports back.
 */
export class HostedTeamStore {
  readonly #database: Database;

  readonly #hostSetupComplete: (origin: string) => Promise<boolean>;

  constructor(
    database: Database,
    options: { readonly hostSetupComplete?: (origin: string) => Promise<boolean> } = {},
  ) {
    this.#database = database;
    this.#hostSetupComplete = options.hostSetupComplete ?? teamHostSetupComplete();
  }

  async create(accountId: ControlPlaneAccountId, slug: HostedTeamSlug): Promise<IssuedSetupLink> {
    const setupToken = newSetupToken();
    const id = randomUUID();
    await this.#database.transaction().execute(async (transaction) => {
      // The creator's row serializes concurrent creates so the cap holds.
      const account = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", accountId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!account) throw new ControlPlaneError("unauthorized", "Account sign-in required");
      const live = await transaction
        .selectFrom("hostedTeams")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("creatorAccountId", "=", accountId)
        .where("state", "!=", "deleted")
        .executeTakeFirstOrThrow();
      if (Number(live.count) >= maximumLiveHostedTeamsPerAccount) {
        throw new ControlPlaneError(
          "conflict",
          `You can have ${maximumLiveHostedTeamsPerAccount} hosted teams. Delete one to create another.`,
        );
      }
      const inserted = await transaction
        .insertInto("hostedTeams")
        .values({
          id,
          slug,
          creatorAccountId: accountId,
          state: "active",
          setupTokenDigest: digestSecret(setupToken),
          setupGeneration: 1,
          phase: "provisioning",
          hostImage: null,
          statusMessage: null,
          statusReportedAt: null,
          suspendedReason: null,
          deletedAt: null,
        })
        .onConflict((conflict) => conflict.column("slug").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) {
        throw new ControlPlaneError("conflict", "That address is taken. Try another.");
      }
    });
    const team = await this.forAccount(accountId, id);
    if (!team) throw new Error("Created hosted team was not found");
    return { setupToken, team };
  }

  async listForAccount(accountId: ControlPlaneAccountId): Promise<readonly HostedTeamView[]> {
    const rows = await this.#viewQuery()
      .where("hostedTeams.creatorAccountId", "=", accountId)
      .orderBy("hostedTeams.createdAt", "asc")
      .execute();
    return rows.map(toView);
  }

  async forAccount(
    accountId: ControlPlaneAccountId,
    id: HostedTeamId,
  ): Promise<HostedTeamView | null> {
    const row = await this.#viewQuery()
      .where("hostedTeams.creatorAccountId", "=", accountId)
      .where("hostedTeams.id", "=", id)
      .executeTakeFirst();
    return row ? toView(row) : null;
  }

  /**
   * Replaces the setup token, restarting the Host with the new digest, unless the Host says an
   * owner already finished setup: then a new link could do nothing, so the team just opens.
   */
  async newSetupLink(
    accountId: ControlPlaneAccountId,
    id: HostedTeamId,
  ): Promise<IssuedSetupLink | { readonly setupComplete: true; readonly origin: string }> {
    const current = await this.forAccount(accountId, id);
    if (!current) throw new ControlPlaneError("not_found", "Hosted team was not found");
    if (current.state !== "active") {
      throw new ControlPlaneError("conflict", "This team is suspended.");
    }
    if (await this.#hostSetupComplete(current.origin)) {
      return { setupComplete: true, origin: current.origin };
    }
    const setupToken = newSetupToken();
    const updated = await this.#database
      .updateTable("hostedTeams")
      .set((expression) => ({
        setupTokenDigest: digestSecret(setupToken),
        setupGeneration: expression("setupGeneration", "+", 1),
        updatedAt: new Date(),
      }))
      .where("id", "=", id)
      .where("creatorAccountId", "=", accountId)
      .where("state", "=", "active")
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new ControlPlaneError("conflict", "This team changed. Reload and try again.");
    }
    const team = await this.forAccount(accountId, id);
    if (!team) throw new ControlPlaneError("not_found", "Hosted team was not found");
    return { setupToken, team };
  }

  async deleteForAccount(accountId: ControlPlaneAccountId, id: HostedTeamId): Promise<void> {
    const deleted = await this.#database
      .transaction()
      .execute((transaction) =>
        deleteHostedTeams(transaction, { creatorAccountId: accountId, id }),
      );
    if (deleted === 0) throw new ControlPlaneError("not_found", "Hosted team was not found");
  }

  /* ---- Operator ---- */

  async suspend(slug: HostedTeamSlug, reason: string): Promise<void> {
    const updated = await this.#database
      .updateTable("hostedTeams")
      .set({ state: "suspended", suspendedReason: reason, updatedAt: new Date() })
      .where("slug", "=", slug)
      .where("state", "!=", "deleted")
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) throw new Error(`No live hosted team ${slug}`);
  }

  async unsuspend(slug: HostedTeamSlug): Promise<void> {
    const updated = await this.#database
      .updateTable("hostedTeams")
      .set({ state: "active", suspendedReason: null, updatedAt: new Date() })
      .where("slug", "=", slug)
      .where("state", "=", "suspended")
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) throw new Error(`No suspended hosted team ${slug}`);
  }

  async deleteBySlug(slug: HostedTeamSlug): Promise<void> {
    const deleted = await this.#database
      .transaction()
      .execute((transaction) => deleteHostedTeams(transaction, { slug }));
    if (deleted === 0) throw new Error(`No live hosted team ${slug}`);
  }

  /* ---- Provisioner ---- */

  /** Every team the provisioner still has work for: live ones, and deletions it hasn't confirmed. */
  async desired(): Promise<readonly DesiredHostedTeam[]> {
    const rows = await this.#database
      .selectFrom("hostedTeams")
      .select(["id", "slug", "state", "setupTokenDigest", "setupGeneration"])
      .where((expression) =>
        expression.or([expression("state", "!=", "deleted"), expression("phase", "!=", "deleted")]),
      )
      .orderBy("createdAt", "asc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      state: row.state,
      setupTokenDigest: row.setupTokenDigest,
      setupGeneration: row.setupGeneration,
    }));
  }

  async reportStatus(id: HostedTeamId, report: HostedTeamStatusReport): Promise<void> {
    const updated = await this.#database
      .updateTable("hostedTeams")
      .set({
        phase: report.phase,
        hostImage: report.hostImage,
        observedSetupGeneration: report.observedSetupGeneration,
        statusMessage: report.message ?? null,
        statusReportedAt: new Date(),
      })
      .where("id", "=", id)
      .where("setupGeneration", ">=", report.observedSetupGeneration)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new ControlPlaneError("not_found", "Hosted team was not found at that generation");
    }
  }

  #viewQuery() {
    return this.#database
      .selectFrom("hostedTeams")
      .select([
        "hostedTeams.id as id",
        "hostedTeams.slug as slug",
        "hostedTeams.state as state",
        "hostedTeams.phase as phase",
        "hostedTeams.setupGeneration as setupGeneration",
        "hostedTeams.observedSetupGeneration as observedSetupGeneration",
        "hostedTeams.statusMessage as statusMessage",
        sql<boolean>`exists (
          select 1 from deployments
          where canonical_origin = 'https://' || hosted_teams.slug || ${`.${hostedTeamsDomain}`}
        )`.as("claimed"),
      ])
      .where("hostedTeams.state", "!=", "deleted");
  }
}

/**
 * Marks matching live teams deleted and removes the Account Deployment that first-owner setup
 * adopted at each one's address, since no Host will ever answer there again.
 */
export async function deleteHostedTeams(
  transaction: DatabaseTransaction,
  match:
    | { readonly creatorAccountId: ControlPlaneAccountId; readonly id?: HostedTeamId }
    | { readonly slug: HostedTeamSlug },
): Promise<number> {
  let query = transaction.selectFrom("hostedTeams").select("slug").where("state", "!=", "deleted");
  if ("slug" in match) query = query.where("slug", "=", match.slug);
  else {
    query = query.where("creatorAccountId", "=", match.creatorAccountId);
    if (match.id) query = query.where("id", "=", match.id);
  }
  const teams = await query.orderBy("slug", "asc").execute();
  if (teams.length === 0) return 0;
  const origins = teams.map((team) => hostedTeamOrigin(team.slug));
  const deployments = await transaction
    .selectFrom("deployments")
    .select("id")
    .where("canonicalOrigin", "in", origins)
    .orderBy("id", "asc")
    // FOR UPDATE: Deleting a hosted team deletes the Deployment adopted at its address.
    .forUpdate()
    .execute();
  if (deployments.length > 0) {
    await transaction
      .deleteFrom("deployments")
      .where(
        "id",
        "in",
        deployments.map((deployment) => deployment.id),
      )
      .execute();
  }
  const now = new Date();
  const deleted = await transaction
    .updateTable("hostedTeams")
    .set({ state: "deleted", setupTokenDigest: null, deletedAt: now, updatedAt: now })
    .where(
      "slug",
      "in",
      teams.map((team) => team.slug),
    )
    .where("state", "!=", "deleted")
    .executeTakeFirst();
  return Number(deleted.numUpdatedRows);
}

function newSetupToken(): string {
  return randomBytes(32).toString("base64url");
}

function toView(row: {
  readonly id: HostedTeamId;
  readonly slug: string;
  readonly state: HostedTeamState;
  readonly phase: HostedTeamPhase;
  readonly setupGeneration: number;
  readonly observedSetupGeneration: number;
  readonly statusMessage: string | null;
  readonly claimed: boolean;
}): HostedTeamView {
  if (row.state === "deleted") throw new Error("Deleted hosted teams have no view");
  return {
    id: row.id,
    slug: row.slug,
    origin: hostedTeamOrigin(row.slug),
    state: row.state,
    phase: row.phase,
    ready:
      row.state === "active" &&
      row.phase === "ready" &&
      row.observedSetupGeneration >= row.setupGeneration,
    claimed: row.claimed,
    statusMessage: row.statusMessage,
  };
}

/**
 * Whether the team's own Host reports first-owner setup finished. Account's record only shows
 * adoption, which comes before the owner signs in. An unreachable Host counts as unfinished: it
 * still refuses any setup token once an owner exists.
 */
export function teamHostSetupComplete(
  fetch: typeof globalThis.fetch = createPublicHttpsFetch({
    maxResponseBytes: 4 * 1024,
    timeoutMs: 5_000,
  }),
): (origin: string) => Promise<boolean> {
  return async (origin) => {
    try {
      const response = await fetch(`${origin}/v1/team/setup/state`, {
        headers: { [teamApiVersionHeader]: String(teamApiVersion) },
        redirect: "error",
      });
      if (!response.ok) return false;
      return z.object({ complete: z.boolean() }).parse(await response.json()).complete;
    } catch {
      return false;
    }
  };
}
