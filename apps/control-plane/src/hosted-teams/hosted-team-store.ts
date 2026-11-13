import { randomBytes, randomUUID } from "node:crypto";
import {
  HostedTeamBootstrapReceiptSchema,
  VerifiedDeploymentOwnerProfileSchema,
  type ControlPlaneAccountId,
  type HostAccountAdoptionAuthority,
  type HostedTeamBootstrapReceipt,
  type HostedTeamOwnerCheckResponse,
  type VerifiedDeploymentOwnerProfile,
} from "@opensteer/control-plane-protocol";
import {
  HostedTeamSlugSchema,
  hostedTeamOrigin,
  maximumLiveHostedTeamsPerAccount,
  reservedHostedTeamSlugs,
  type CreateHostedTeamRequest,
  type DesiredHostedTeam,
  type HostedTeamAvailability,
  type HostedTeamId,
  type HostedTeamOwner,
  type HostedTeamSlug,
  type HostedTeamStatusReport,
  type HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import { createId, type DeploymentId, type TeamChannelId } from "@opensteer/core";
import { digestSecret } from "@opensteer/shared/secretDigest";
import {
  sql,
  type ExpressionBuilder,
  type Kysely,
  type Selectable,
  type Transaction,
} from "kysely";
import { lockDeploymentOrigin } from "../database/advisory-locks.js";
import type {
  ControlPlaneDatabaseSchema,
  HostedTeamStoredStage,
  HostedTeamTable,
} from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";
import type { HostedTeamSetupTokenCipher } from "./setup-token-cipher.js";

type Database = Kysely<ControlPlaneDatabaseSchema>;
type DatabaseTransaction = Transaction<ControlPlaneDatabaseSchema>;
type HostedTeamRow = Selectable<HostedTeamTable>;

/** How long one bootstrap attempt may hold a team before another Account replica may take over. */
const bootstrapLeaseMilliseconds = 2 * 60_000;
/**
 * How long a deletion fence lasts unless its attempt renews it, which it does before each step,
 * so only an attempt that died, say in a crash, lets go.
 */
const accountDeletionFenceMilliseconds = 10 * 60_000;
const unfinishedMessage = "Setup didn’t finish. Try again.";

/** A team Account is setting up, claimed by one bootstrap attempt. */
export interface HostedTeamBootstrapClaim {
  readonly id: HostedTeamId;
  readonly slug: HostedTeamSlug;
  readonly origin: string;
  readonly name: string;
  readonly creator: ControlPlaneAccountId;
  /** Null when the creator's Account can't own a team (an unverified email). */
  readonly owner: VerifiedDeploymentOwnerProfile | null;
  readonly generation: number;
  /** Fences every write of this attempt; a later claim bumps it. */
  readonly attempt: number;
  readonly sealedSetupToken: string | null;
  readonly configuringSince: Date;
  readonly bootstrapped: boolean;
}

/** Asks a bootstrapped team's Host whether an Account owns it; undefined when the Host can't say. */
export type HostedTeamOwnerCheck = (input: {
  readonly accountId: ControlPlaneAccountId;
  readonly authority: HostAccountAdoptionAuthority;
}) => Promise<HostedTeamOwnerCheckResponse | undefined>;

/**
 * Hosted team servers an Account asked Opensteer to run, how far their setup got, and what the
 * provisioner last saw of them. Account decides what should exist and finishes each team's
 * setup itself; the provisioner makes the cluster match and reports back.
 */
export class HostedTeamStore {
  readonly #database: Database;
  readonly #cipher: HostedTeamSetupTokenCipher;
  readonly #ownerCheck: HostedTeamOwnerCheck;

  constructor(
    database: Database,
    options: {
      readonly cipher: HostedTeamSetupTokenCipher;
      readonly ownerCheck?: HostedTeamOwnerCheck;
    },
  ) {
    this.#database = database;
    this.#cipher = options.cipher;
    this.#ownerCheck = options.ownerCheck ?? (async () => undefined);
  }

  /** Whether an address could be created now. Deleted teams keep their address forever. */
  async availability(input: string): Promise<HostedTeamAvailability> {
    const parsed = HostedTeamSlugSchema.safeParse(input);
    if (!parsed.success) {
      return {
        available: false,
        reason: reservedHostedTeamSlugs.has(input) ? "reserved" : "invalid",
      };
    }
    const taken = await this.#database
      .selectFrom("hostedTeams")
      .select("id")
      .where("slug", "=", parsed.data)
      .executeTakeFirst();
    return taken ? { available: false, reason: "taken" } : { available: true };
  }

  async create(
    accountId: ControlPlaneAccountId,
    input: CreateHostedTeamRequest,
  ): Promise<HostedTeamView> {
    const id = randomUUID();
    const setupToken = randomBytes(32).toString("base64url");
    const row = await this.#database.transaction().execute(async (transaction) => {
      // The creator's row serializes their creates, so the cap and request replay both hold.
      const account = await transaction
        .selectFrom("users")
        .select(["id", "deletionFencedUntil"])
        .where("id", "=", accountId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!account) throw new ControlPlaneError("unauthorized", "Account sign-in required");
      if (deletionFenced(account.deletionFencedUntil)) throw deletionInProgress();
      const replayed = await transaction
        .selectFrom("hostedTeams")
        .selectAll()
        .where("creatorAccountId", "=", accountId)
        .where("createRequestId", "=", input.requestId)
        .executeTakeFirst();
      if (replayed) return replayed;
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
          { reason: "hosted-team-limit-reached" },
        );
      }
      const inserted = await transaction
        .insertInto("hostedTeams")
        .values({
          id,
          slug: input.slug,
          name: input.name,
          createRequestId: input.requestId,
          creatorAccountId: accountId,
          state: "active",
          setupTokenDigest: digestSecret(setupToken),
          sealedSetupToken: this.#cipher.seal(id, 1, setupToken),
          setupGeneration: 1,
          stage: "reserving",
          phase: "provisioning",
          hostImage: null,
          statusMessage: null,
          statusReportedAt: null,
          suspendedReason: null,
          deletedAt: null,
        })
        .onConflict((conflict) => conflict.column("slug").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!inserted) {
        throw new ControlPlaneError("conflict", "That address is taken. Try another.", {
          reason: "hosted-team-address-taken",
        });
      }
      return inserted;
    });
    return toView(row, accountId);
  }

  /** Teams the Account created, and teams whose directory lists it as a member. */
  async listForAccount(accountId: ControlPlaneAccountId): Promise<readonly HostedTeamView[]> {
    const rows = await this.#visible(accountId).orderBy("createdAt", "asc").limit(100).execute();
    return rows.map((row) => toView(row, accountId));
  }

  /** Teams the Account holds (created, or was handed) and hasn't seen deleted. */
  async listCreatedBy(accountId: ControlPlaneAccountId): Promise<readonly HostedTeamView[]> {
    const rows = await this.#visible(accountId)
      .where("creatorAccountId", "=", accountId)
      .orderBy("createdAt", "asc")
      .execute();
    return rows.map((row) => toView(row, accountId));
  }

  async forAccount(
    accountId: ControlPlaneAccountId,
    id: HostedTeamId,
  ): Promise<HostedTeamView | null> {
    const row = await this.#visible(accountId).where("id", "=", id).executeTakeFirst();
    return row ? toView(row, accountId) : null;
  }

  /**
   * Starts a failed team's setup again. Before its Host has an owner, a new setup token restarts
   * the Host with a fresh setup window; after, Account only waits for its directory again.
   */
  async retry(accountId: ControlPlaneAccountId, id: HostedTeamId): Promise<HostedTeamView> {
    const setupToken = randomBytes(32).toString("base64url");
    const row = await this.#database.transaction().execute(async (transaction) => {
      // FOR SHARE: waits for, or holds off, this Account's deletion fence.
      const account = await transaction
        .selectFrom("users")
        .select("deletionFencedUntil")
        .where("id", "=", accountId)
        .forShare()
        .executeTakeFirst();
      if (!account) throw new ControlPlaneError("unauthorized", "Account sign-in required");
      if (deletionFenced(account.deletionFencedUntil)) throw deletionInProgress();
      const current = await transaction
        .selectFrom("hostedTeams")
        .selectAll()
        .where("id", "=", id)
        .where("creatorAccountId", "=", accountId)
        .where("state", "!=", "deleted")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current) throw new ControlPlaneError("not_found", "Hosted team was not found");
      if (current.state === "suspended") {
        throw new ControlPlaneError("conflict", "Opensteer suspended this team.");
      }
      if (current.stage !== "failed") return current;
      const now = new Date();
      const restart = current.bootstrapReceipt === null;
      const generation = current.setupGeneration + 1;
      return transaction
        .updateTable("hostedTeams")
        .set({
          ...(restart
            ? {
                setupTokenDigest: digestSecret(setupToken),
                sealedSetupToken: this.#cipher.seal(id, generation, setupToken),
                setupGeneration: generation,
                stage: "starting",
                configuringSince: null,
              }
            : { stage: "configuring", configuringSince: now }),
          stageMessage: null,
          bootstrapNextAt: null,
          bootstrapLeaseUntil: null,
          updatedAt: now,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return toView(row, accountId);
  }

  /**
   * Cancels a team whose Host can't have an owner yet (its creator may) or deletes one whose Host
   * may, which only an owner that Host confirms may do. Answers the team at `deleting`.
   */
  async remove(accountId: ControlPlaneAccountId, id: HostedTeamId): Promise<HostedTeamView> {
    const current = await this.#visible(accountId).where("id", "=", id).executeTakeFirst();
    if (!current) throw new ControlPlaneError("not_found", "Hosted team was not found");
    const origin = hostedTeamOrigin(current.slug as HostedTeamSlug);
    let confirmedOwner = false;
    for (;;) {
      const outcome = await this.#database.transaction().execute(async (transaction) => {
        // The adoption that lets a Host commit its owner holds this lock too, so a cancel either
        // lands before it (and the adoption fails) or sees its Deployment.
        await lockDeploymentOrigin(transaction, origin);
        const adopted = await transaction
          .selectFrom("deployments")
          .select("id")
          .where("canonicalOrigin", "=", origin)
          // FOR UPDATE: a delete removes this Deployment; it ranks before the team row.
          .forUpdate()
          .executeTakeFirst();
        const row = await transaction
          .selectFrom("hostedTeams")
          .selectAll()
          .where("id", "=", id)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        if (row.state === "deleted") return row;
        if (!confirmedOwner) {
          if (row.bootstrapReceipt !== null || adopted) return "owner-check" as const;
          if (row.creatorAccountId !== accountId) throw ownerRequired();
        }
        await deleteHostedTeams(transaction, { id });
        return transaction
          .selectFrom("hostedTeams")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
      });
      if (outcome !== "owner-check") return toView(outcome, accountId);
      await this.#requireOwner(accountId, current);
      confirmedOwner = true;
    }
  }

  /** Ownership can change on the team; only its Host knows, so no answer deletes nothing. */
  async #requireOwner(accountId: ControlPlaneAccountId, team: HostedTeamRow): Promise<void> {
    const authority = await this.#authority(team);
    const answer = authority ? await this.#ownerCheck({ accountId, authority }) : undefined;
    if (answer === undefined) throw hostUnavailable();
    if (answer.owner) return;
    const settled = await this.#database
      .selectFrom("hostedTeams")
      .select(["bootstrapReceipt", "creatorAccountId", "stage"])
      .where("id", "=", team.id)
      .executeTakeFirstOrThrow();
    if (settled.bootstrapReceipt !== null || settled.creatorAccountId !== accountId)
      throw ownerRequired();
    // Its creator, before Account knows who owns it: setup has to finish (or be retried) first.
    throw new ControlPlaneError(
      "conflict",
      settled.stage === "failed"
        ? "Try setting this team up again, then delete it."
        : "This team is finishing setup. Try again in a minute.",
    );
  }

  /** The team's other owners, as its own Host confirms them now. Only its holder may ask. */
  async owners(accountId: ControlPlaneAccountId, id: HostedTeamId): Promise<HostedTeamOwner[]> {
    const team = await this.#held(accountId, id);
    const authority = await this.#authority(team);
    const answer = authority ? await this.#ownerCheck({ accountId, authority }) : undefined;
    if (answer === undefined) throw hostUnavailable();
    const others = answer.owners.filter((owner) => owner !== accountId);
    if (others.length === 0) return [];
    const people = await this.#database
      .selectFrom("users")
      .select(["id", "displayName", "email"])
      .where("id", "in", others)
      .execute();
    return others.flatMap((owner) => {
      const person = people.find((candidate) => candidate.id === owner);
      return person
        ? [{ accountId: person.id, displayName: person.displayName, email: person.email }]
        : [];
    });
  }

  /**
   * Hands a set-up team from its holder to `to`, whom its Host must confirm as an owner just
   * before: the team, its Account Deployment and that Deployment's Account sign-in.
   */
  async transfer(
    accountId: ControlPlaneAccountId,
    id: HostedTeamId,
    to: ControlPlaneAccountId,
  ): Promise<HostedTeamView> {
    if (to === accountId) throw new ControlPlaneError("bad_request", "You already hold this team.");
    const team = await this.#held(accountId, id);
    const authority = await this.#authority(team);
    if (!authority) throw new ControlPlaneError("conflict", "This team isn’t set up yet.");
    const answer = await this.#ownerCheck({ accountId: to, authority });
    if (answer === undefined) throw hostUnavailable();
    if (!answer.owner)
      throw new ControlPlaneError(
        "forbidden",
        "They aren’t an owner of this team. Make them one in the team first.",
        { reason: "hosted-team-owner-required" },
      );
    const row = await this.#database
      .transaction()
      .execute((transaction) =>
        transferHostedTeam(transaction, { id, from: accountId, to, authority }),
      );
    return toView(row, accountId);
  }

  async #held(accountId: ControlPlaneAccountId, id: HostedTeamId): Promise<HostedTeamRow> {
    const team = await this.#visible(accountId)
      .where("id", "=", id)
      .where("state", "!=", "deleted")
      .executeTakeFirst();
    if (!team) throw new ControlPlaneError("not_found", "Hosted team was not found");
    if (team.creatorAccountId !== accountId)
      throw new ControlPlaneError(
        "forbidden",
        "Only the person who holds this team in Opensteer can transfer it.",
      );
    return team;
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

  /**
   * Records what the provisioner saw. Only a report judged against the current setup generation
   * moves a waiting team: to `configuring` once the Host runs it, back to `starting`, or to
   * `failed`. A report for an older generation changes nothing. The answer says whether there is
   * setup to do.
   */
  async reportStatus(
    id: HostedTeamId,
    report: HostedTeamStatusReport,
  ): Promise<{ readonly configuring: boolean }> {
    // A running Host names its generation; otherwise only the provisioner can say which it judged.
    const judged =
      report.setupGeneration ??
      (report.phase === "ready" ? report.observedSetupGeneration : undefined);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("hostedTeams")
        .selectAll()
        .where("id", "=", id)
        .where("setupGeneration", ">=", Math.max(report.observedSetupGeneration, judged ?? 0))
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row) {
        throw new ControlPlaneError("not_found", "Hosted team was not found at that generation");
      }
      if (judged !== undefined && judged < row.setupGeneration) return { configuring: false };
      const now = new Date();
      const waiting =
        row.state === "active" &&
        row.bootstrapReceipt === null &&
        judged === row.setupGeneration &&
        (row.stage === "reserving" || row.stage === "starting" || row.stage === "configuring");
      let stage: HostedTeamStoredStage = row.stage;
      if (waiting) {
        if (report.phase === "ready") {
          if (report.observedSetupGeneration === row.setupGeneration) stage = "configuring";
        } else if (report.phase === "failed") stage = "failed";
        else if (report.phase === "provisioning") stage = "starting";
      }
      await transaction
        .updateTable("hostedTeams")
        .set({
          phase: report.phase,
          hostImage: report.hostImage,
          observedSetupGeneration: report.observedSetupGeneration,
          statusMessage: report.message ?? null,
          statusReportedAt: now,
          ...(stage === row.stage
            ? {}
            : {
                stage,
                stageMessage:
                  stage === "failed" ? "The team server didn’t start. Try again." : null,
                configuringSince: stage === "configuring" ? now : null,
                bootstrapNextAt: null,
                bootstrapLeaseUntil: null,
              }),
        })
        .where("id", "=", id)
        .execute();
      return { configuring: stage === "configuring" };
    });
  }

  /**
   * Fails every team still reserving or starting whose setup began before `startedBefore`, so its
   * creator can retry or cancel. A pre-bootstrap stage records when it began in `updatedAt`
   * (create and retry). Covers provisioners whose failure reports name no setup generation.
   */
  async failStalledSetups(startedBefore: Date): Promise<number> {
    const failed = await this.#database
      .updateTable("hostedTeams")
      .set({
        stage: "failed",
        stageMessage: "The team server didn’t start. Try again.",
        bootstrapLeaseUntil: null,
        bootstrapNextAt: null,
        updatedAt: new Date(),
      })
      .where("state", "=", "active")
      .where("stage", "in", ["reserving", "starting"])
      .where("bootstrapReceipt", "is", null)
      .where("updatedAt", "<", startedBefore)
      .executeTakeFirst();
    return Number(failed.numUpdatedRows);
  }

  /* ---- Bootstrap ---- */

  /** Claims the next team whose setup is due, or undefined when none is. */
  async claimBootstrap(now = new Date()): Promise<HostedTeamBootstrapClaim | undefined> {
    return this.#database.transaction().execute(async (transaction) => {
      const due = await transaction
        .selectFrom("hostedTeams")
        .selectAll()
        .where("stage", "=", "configuring")
        .where("state", "=", "active")
        .where((expression) =>
          expression.or([
            expression("bootstrapNextAt", "is", null),
            expression("bootstrapNextAt", "<=", now),
          ]),
        )
        .where((expression) =>
          expression.or([
            expression("bootstrapLeaseUntil", "is", null),
            expression("bootstrapLeaseUntil", "<=", now),
          ]),
        )
        .orderBy("bootstrapNextAt", sql`asc nulls first`)
        .limit(1)
        .forNoKeyUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!due?.creatorAccountId) return undefined;
      const claimed = await transaction
        .updateTable("hostedTeams")
        .set((expression) => ({
          bootstrapAttempt: expression("bootstrapAttempt", "+", 1),
          bootstrapLeaseUntil: new Date(now.getTime() + bootstrapLeaseMilliseconds),
          configuringSince: due.configuringSince ?? now,
        }))
        .where("id", "=", due.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const creator = await transaction
        .selectFrom("users")
        .select(["id", "displayName", "email", "emailVerified"])
        .where("id", "=", due.creatorAccountId)
        .executeTakeFirst();
      const owner =
        creator?.emailVerified === true
          ? VerifiedDeploymentOwnerProfileSchema.safeParse({
              subject: creator.id,
              email: creator.email,
              displayName: creator.displayName,
            })
          : undefined;
      return {
        id: claimed.id,
        slug: claimed.slug as HostedTeamSlug,
        origin: hostedTeamOrigin(claimed.slug as HostedTeamSlug),
        name: claimed.name ?? claimed.slug,
        creator: due.creatorAccountId,
        owner: owner?.success ? owner.data : null,
        generation: claimed.setupGeneration,
        attempt: claimed.bootstrapAttempt,
        sealedSetupToken: claimed.sealedSetupToken,
        configuringSince: claimed.configuringSince ?? now,
        bootstrapped: claimed.bootstrapReceipt !== null,
      };
    });
  }

  /** The plaintext setup token of a claim, which never leaves Account except to its own Host. */
  openSetupToken(claim: HostedTeamBootstrapClaim): string | null {
    return claim.sealedSetupToken
      ? this.#cipher.open(claim.id, claim.generation, claim.sealedSetupToken)
      : null;
  }

  /**
   * Fences an adoption to this claim: run inside the adoption transaction, it refuses a team
   * cancelled, retried or claimed again since, so no Deployment outlives its team.
   */
  adoptionGuard(claim: HostedTeamBootstrapClaim) {
    return async (transaction: DatabaseTransaction): Promise<void> => {
      if (!(await lockClaim(transaction, claim))) throw superseded();
    };
  }

  /**
   * Records the Host's receipt: its owner is committed. Clears the sealed setup token and the
   * sealed adoption result, and marks the team ready if its directory already reached Account.
   */
  async recordBootstrap(
    claim: HostedTeamBootstrapClaim,
    result: { readonly receipt: HostedTeamBootstrapReceipt },
  ): Promise<void> {
    const receipt = HostedTeamBootstrapReceiptSchema.parse(result.receipt);
    await this.#database.transaction().execute(async (transaction) => {
      const now = new Date();
      // Serializes with deleting, which removes the Deployment this receipt names.
      await lockDeploymentOrigin(transaction, claim.origin);
      // The Host installed one adoption result; none of the others for it may stay sealed.
      const outstanding = await transaction
        .selectFrom("deploymentAdoptionOperations")
        .select("proofId")
        .where("ownerAccountId", "=", claim.creator)
        .where("state", "=", "completed")
        .where(
          sql<boolean>`receipt->'authority'->>'deploymentId' = ${receipt.authority.deploymentId}`,
        )
        .orderBy("proofId")
        .forNoKeyUpdate()
        .execute();
      if (outstanding.length > 0)
        await transaction
          .updateTable("deploymentAdoptionOperations")
          .set({ acknowledgedAt: now, sealedProvisioningBundle: null, state: "acknowledged" })
          .where(
            "proofId",
            "in",
            outstanding.map((operation) => operation.proofId),
          )
          .execute();
      if (!(await lockClaim(transaction, claim))) throw superseded();
      await transaction
        .updateTable("hostedTeams")
        .set({
          bootstrapReceipt: JSON.stringify(receipt),
          deploymentId: receipt.authority.deploymentId,
          sealedSetupToken: null,
          bootstrapLeaseUntil: null,
          bootstrapNextAt: null,
          updatedAt: now,
        })
        .where("id", "=", claim.id)
        .execute();
      await promoteReadyHostedTeams(transaction, receipt.authority.deploymentId, claim.creator);
    });
  }

  /** Waits for a team whose Host has its owner until its directory entry reaches Account. */
  async settleBootstrapped(claim: HostedTeamBootstrapClaim, retryAt: Date): Promise<boolean> {
    return this.#database.transaction().execute(async (transaction) => {
      if (!(await lockClaim(transaction, claim))) return false;
      const team = await transaction
        .selectFrom("hostedTeams")
        .select("deploymentId")
        .where("id", "=", claim.id)
        .executeTakeFirstOrThrow();
      if (
        team.deploymentId &&
        (await promoteReadyHostedTeams(transaction, team.deploymentId, claim.creator)) > 0
      )
        return true;
      await transaction
        .updateTable("hostedTeams")
        .set({ bootstrapLeaseUntil: null, bootstrapNextAt: retryAt })
        .where("id", "=", claim.id)
        .execute();
      return false;
    });
  }

  async deferBootstrap(claim: HostedTeamBootstrapClaim, retryAt: Date): Promise<void> {
    await this.#database
      .updateTable("hostedTeams")
      .set({ bootstrapLeaseUntil: null, bootstrapNextAt: retryAt })
      .where("id", "=", claim.id)
      .where((expression) => claimed(expression, claim))
      .execute();
  }

  async failBootstrap(claim: HostedTeamBootstrapClaim, message: string): Promise<void> {
    await this.#database
      .updateTable("hostedTeams")
      .set({
        stage: "failed",
        stageMessage: message.slice(0, 1_000),
        bootstrapLeaseUntil: null,
        bootstrapNextAt: null,
        updatedAt: new Date(),
      })
      .where("id", "=", claim.id)
      .where((expression) => claimed(expression, claim))
      .execute();
  }

  #visible(accountId: ControlPlaneAccountId) {
    return this.#database
      .selectFrom("hostedTeams")
      .selectAll()
      .where((expression) =>
        expression.or([expression("state", "!=", "deleted"), expression("phase", "!=", "deleted")]),
      )
      .where((expression) =>
        expression.or([
          expression("creatorAccountId", "=", accountId),
          expression.exists(
            expression
              .selectFrom("deploymentDirectoryEntries as member")
              .select("member.accountId")
              .whereRef("member.deploymentId", "=", "hostedTeams.deploymentId")
              .where("member.accountId", "=", accountId)
              .where("member.present", "=", true),
          ),
        ]),
      );
  }

  async #authority(row: HostedTeamRow): Promise<HostAccountAdoptionAuthority | undefined> {
    const deployment = await this.#database
      .selectFrom("deployments")
      .select(["id", "activeHostInstanceId", "canonicalOrigin", "hostKeyFingerprint"])
      .where("canonicalOrigin", "=", hostedTeamOrigin(row.slug as HostedTeamSlug))
      .executeTakeFirst();
    if (!deployment?.canonicalOrigin || !deployment.hostKeyFingerprint) return undefined;
    return {
      canonicalOrigin: deployment.canonicalOrigin,
      deploymentId: deployment.id,
      hostInstanceId: deployment.activeHostInstanceId,
      hostKeyFingerprint: deployment.hostKeyFingerprint,
    };
  }
}

/** Opensteer's abuse controls for hosted teams, run by an operator inside an Account pod. */
export class HostedTeamOperator {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

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
    const deleted = await this.#database.transaction().execute(async (transaction) => {
      await lockDeploymentOrigin(transaction, hostedTeamOrigin(slug));
      return deleteHostedTeams(transaction, { slug });
    });
    if (deleted === 0) throw new Error(`No live hosted team ${slug}`);
  }
}

/**
 * A team is ready once its Host has committed the creator as owner (the receipt) and that
 * membership has reached Account's directory, whatever happened to it there since. The creator's
 * phones hear about it.
 */
export async function promoteReadyHostedTeams(
  transaction: DatabaseTransaction,
  deploymentId: DeploymentId,
  accountId: ControlPlaneAccountId,
): Promise<number> {
  const promoted = await transaction
    .updateTable("hostedTeams")
    .set({
      stage: "ready",
      stageMessage: null,
      configuringSince: null,
      bootstrapLeaseUntil: null,
      bootstrapNextAt: null,
      updatedAt: new Date(),
    })
    .where("deploymentId", "=", deploymentId)
    .where("creatorAccountId", "=", accountId)
    .where("state", "=", "active")
    .where("stage", "=", "configuring")
    .where("bootstrapReceipt", "is not", null)
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("deploymentDirectoryEntries")
          .select("accountId")
          .where("deploymentId", "=", deploymentId)
          .where("accountId", "=", accountId),
      ),
    )
    .returning(["slug", "bootstrapReceipt"])
    .execute();
  for (const team of promoted)
    await notifyTeamReady(transaction, {
      accountId,
      deploymentId,
      origin: hostedTeamOrigin(team.slug as HostedTeamSlug),
      channelId: HostedTeamBootstrapReceiptSchema.parse(team.bootstrapReceipt).generalChannelId,
    });
  return promoted.length;
}

/** How long a "your team is ready" push stays worth showing. */
const teamReadyNotificationMilliseconds = 60 * 60_000;

/** Queues a push to each of the creator's phones that wants outcomes, opening the team's #general. */
async function notifyTeamReady(
  transaction: DatabaseTransaction,
  input: {
    readonly accountId: ControlPlaneAccountId;
    readonly deploymentId: DeploymentId;
    readonly origin: string;
    readonly channelId: TeamChannelId;
  },
) {
  const devices = await transaction
    .selectFrom("notificationDevices")
    .select("id")
    .where("accountId", "=", input.accountId)
    .where("disabledAt", "is", null)
    .where("runOutcomesEnabled", "=", true)
    .execute();
  if (devices.length === 0) return;
  const now = new Date();
  const notificationId = createId("notification");
  await transaction
    .insertInto("notificationDeliveries")
    .values(
      devices.map((device) => ({
        notificationId,
        deviceId: device.id,
        deploymentId: input.deploymentId,
        kind: "team-ready" as const,
        threadId: null,
        requestId: null,
        messageId: null,
        preview: null,
        teamTarget: {
          kind: "team-ready" as const,
          origin: input.origin,
          teamId: input.deploymentId,
          channelId: input.channelId,
        },
        status: "pending" as const,
        attempts: 0,
        createdAt: now,
        nextAttemptAt: now,
        expiresAt: new Date(now.getTime() + teamReadyNotificationMilliseconds),
      })),
    )
    .execute();
}

/**
 * Moves a team, under its origin lock, from `from` to `to` with the Account Deployment adopted at
 * its address (still the one `authority` names) and that Deployment's Account sign-in client.
 */
async function transferHostedTeam(
  transaction: DatabaseTransaction,
  input: {
    readonly id: HostedTeamId;
    readonly from: ControlPlaneAccountId;
    readonly to: ControlPlaneAccountId;
    readonly authority: HostAccountAdoptionAuthority;
  },
): Promise<HostedTeamRow> {
  const origin = input.authority.canonicalOrigin;
  // Every writer of a team's holder, state or Deployment takes its origin first, so the reads
  // below are stable without row locks, which are then taken in rank order.
  await lockDeploymentOrigin(transaction, origin);
  const team = await transaction
    .selectFrom("hostedTeams")
    .select(["creatorAccountId", "slug"])
    .where("id", "=", input.id)
    .where("state", "!=", "deleted")
    .executeTakeFirst();
  if (!team || hostedTeamOrigin(team.slug as HostedTeamSlug) !== origin)
    throw new ControlPlaneError("not_found", "Hosted team was not found");
  if (team.creatorAccountId !== input.from)
    throw new ControlPlaneError("conflict", "Someone else holds this team now.");
  const deployment = await transaction
    .selectFrom("deployments")
    .select(["id", "oidcClientId"])
    .where("id", "=", input.authority.deploymentId)
    .where("canonicalOrigin", "=", origin)
    .where("ownerAccountId", "=", input.from)
    .executeTakeFirst();
  if (!deployment) throw new ControlPlaneError("conflict", "This team changed. Try again.");
  // An owner keeps no hide marker; the directory shows them their team.
  await transaction
    .deleteFrom("deploymentDirectoryVisibility")
    .where("deploymentId", "=", deployment.id)
    .where("accountId", "=", input.to)
    .execute();
  // FOR SHARE: holds off the recipient's deletion fence, and its row, until this commits.
  const recipient = await transaction
    .selectFrom("users")
    .select("deletionFencedUntil")
    .where("id", "=", input.to)
    .forShare()
    .executeTakeFirst();
  if (!recipient) throw new ControlPlaneError("not_found", "That person’s Account is gone.");
  if (deletionFenced(recipient.deletionFencedUntil)) throw deletionInProgress();
  await transaction
    .updateTable("deployments")
    .set({ ownerAccountId: input.to })
    .where("id", "=", deployment.id)
    .execute();
  if (deployment.oidcClientId)
    await transaction
      .updateTable("oauthClients")
      .set({ userId: input.to, updatedAt: new Date() })
      .where("clientId", "=", deployment.oidcClientId)
      .where("userId", "=", input.from)
      .execute();
  return transaction
    .updateTable("hostedTeams")
    .set({ creatorAccountId: input.to, updatedAt: new Date() })
    .where("id", "=", input.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Starts deleting an Account, before anything else is undone: refuses while another attempt is
 * deleting it or while it holds a team whose Host may have an owner (deleting or transferring
 * that is the person's call), cancels its teams still being set up, and fences it so nothing
 * gives it a team until the deletion ends. Returns the attempt that holds the fence.
 */
export async function beginAccountDeletion(
  database: Database,
  accountId: ControlPlaneAccountId,
): Promise<string> {
  const attemptId = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const listed = await database
      .selectFrom("hostedTeams")
      .select("slug")
      .where("creatorAccountId", "=", accountId)
      .where("state", "!=", "deleted")
      .orderBy("slug", "asc")
      .execute();
    const fenced = await database.transaction().execute(async (transaction) => {
      // Adoption and transfer take a team's origin first, so neither lands on one checked here.
      for (const { slug } of listed)
        await lockDeploymentOrigin(transaction, hostedTeamOrigin(slug as HostedTeamSlug));
      const account = await transaction
        .selectFrom("users")
        .select(["deletionAttemptId", "deletionFencedUntil"])
        .where("id", "=", accountId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!account) throw new ControlPlaneError("not_found", "Account was not found");
      if (account.deletionAttemptId !== attemptId && deletionFenced(account.deletionFencedUntil))
        throw new ControlPlaneError("conflict", "Account deletion already in progress.", {
          reason: "account-deletion-in-progress",
        });
      await transaction
        .updateTable("users")
        .set({ deletionAttemptId: attemptId, deletionFencedUntil: fenceUntil() })
        .where("id", "=", accountId)
        .execute();
      const teams = await transaction
        .selectFrom("hostedTeams")
        .select(["id", "slug", "bootstrapReceipt"])
        .where("creatorAccountId", "=", accountId)
        .where("state", "!=", "deleted")
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      // Handed one between the listing and the fence: lock its origin too.
      if (teams.some((team) => !listed.some(({ slug }) => slug === team.slug))) return false;
      const adopted = await heldHostedTeams(transaction, accountId);
      if (adopted.length > 0) throw hostedTeamsRemain(adopted);
      if (teams.length > 0) await deleteHostedTeams(transaction, { creatorAccountId: accountId });
      return true;
    });
    if (fenced) return attemptId;
  }
  await abandonAccountDeletion(database, accountId, attemptId);
  throw new ControlPlaneError("unavailable", "Your teams changed. Try again.");
}

/** Keeps `attemptId`'s fence up for its next step; refuses once it lapsed or another took it. */
export async function renewAccountDeletion(
  database: Database,
  accountId: ControlPlaneAccountId,
  attemptId: string,
): Promise<void> {
  const renewed = await database
    .updateTable("users")
    .set({ deletionFencedUntil: fenceUntil() })
    .where("id", "=", accountId)
    .where("deletionAttemptId", "=", attemptId)
    .where("deletionFencedUntil", ">", new Date())
    .returning("id")
    .executeTakeFirst();
  if (!renewed)
    throw new ControlPlaneError("unavailable", "Deleting your Account stopped. Try again.");
}

/** Ends `attemptId`'s deletion that won't finish, so the Account may have teams again. */
export async function abandonAccountDeletion(
  database: Database,
  accountId: ControlPlaneAccountId,
  attemptId: string,
): Promise<void> {
  await database
    .updateTable("users")
    .set({ deletionAttemptId: null, deletionFencedUntil: null })
    .where("id", "=", accountId)
    .where("deletionAttemptId", "=", attemptId)
    .execute();
}

/** Live teams `accountId` holds whose Host was adopted, receipt or not: they may have an owner. */
export async function heldHostedTeams(
  database: Database | DatabaseTransaction,
  accountId: ControlPlaneAccountId,
): Promise<
  readonly { readonly id: HostedTeamId; readonly name: string; readonly origin: string }[]
> {
  const teams = await database
    .selectFrom("hostedTeams")
    .select(["id", "slug", "name", "bootstrapReceipt"])
    .where("creatorAccountId", "=", accountId)
    .where("state", "!=", "deleted")
    .orderBy("createdAt", "asc")
    .execute();
  if (teams.length === 0) return [];
  const origins = teams.map((team) => hostedTeamOrigin(team.slug as HostedTeamSlug));
  const adopted = new Set(
    (
      await database
        .selectFrom("deployments")
        .select("canonicalOrigin")
        .where("canonicalOrigin", "in", origins)
        .execute()
    ).map((deployment) => deployment.canonicalOrigin),
  );
  return teams.flatMap((team) => {
    const origin = hostedTeamOrigin(team.slug as HostedTeamSlug);
    return team.bootstrapReceipt !== null || adopted.has(origin)
      ? [{ id: team.id, name: team.name ?? team.slug, origin }]
      : [];
  });
}

/**
 * Marks matching live teams deleted and removes the Account Deployment adopted at each one's
 * address, since no Host will ever answer there again.
 */
export async function deleteHostedTeams(
  transaction: DatabaseTransaction,
  match:
    | { readonly creatorAccountId: ControlPlaneAccountId }
    | { readonly id: HostedTeamId }
    | { readonly slug: HostedTeamSlug },
): Promise<number> {
  let query = transaction.selectFrom("hostedTeams").select("slug").where("state", "!=", "deleted");
  if ("slug" in match) query = query.where("slug", "=", match.slug);
  else if ("id" in match) query = query.where("id", "=", match.id);
  else query = query.where("creatorAccountId", "=", match.creatorAccountId);
  const teams = await query.orderBy("slug", "asc").execute();
  if (teams.length === 0) return 0;
  const origins = teams.map((team) => hostedTeamOrigin(team.slug as HostedTeamSlug));
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
    .set({
      state: "deleted",
      setupTokenDigest: null,
      sealedSetupToken: null,
      bootstrapLeaseUntil: null,
      bootstrapNextAt: null,
      deletedAt: now,
      updatedAt: now,
    })
    .where(
      "slug",
      "in",
      teams.map((team) => team.slug),
    )
    .where("state", "!=", "deleted")
    .executeTakeFirst();
  return Number(deleted.numUpdatedRows);
}

async function lockClaim(
  transaction: DatabaseTransaction,
  claim: HostedTeamBootstrapClaim,
): Promise<boolean> {
  return (
    (await transaction
      .selectFrom("hostedTeams")
      .select("id")
      .where("id", "=", claim.id)
      .where((expression) => claimed(expression, claim))
      .forNoKeyUpdate()
      .executeTakeFirst()) !== undefined
  );
}

function claimed(
  expression: ExpressionBuilder<ControlPlaneDatabaseSchema, "hostedTeams">,
  claim: HostedTeamBootstrapClaim,
) {
  return expression.and([
    expression("state", "=", "active"),
    expression("stage", "=", "configuring"),
    expression("setupGeneration", "=", claim.generation),
    expression("bootstrapAttempt", "=", claim.attempt),
  ]);
}

function hostedTeamsRemain(teams: readonly { readonly origin: string }[]) {
  const hosts = teams.map((team) => new URL(team.origin).host).join(", ");
  return new ControlPlaneError(
    "conflict",
    `Delete or transfer these teams first: ${hosts}`.slice(0, 500),
    { reason: "hosted-teams-remain" },
  );
}

function deletionFenced(until: Date | null): boolean {
  return until !== null && until.getTime() > Date.now();
}

function fenceUntil(): Date {
  return new Date(Date.now() + accountDeletionFenceMilliseconds);
}

function deletionInProgress() {
  return new ControlPlaneError("conflict", "This Account is being deleted.", {
    reason: "account-deletion-in-progress",
  });
}

function hostUnavailable() {
  return new ControlPlaneError(
    "unavailable",
    "Your team’s server didn’t answer. Try again in a minute.",
  );
}

function ownerRequired() {
  return new ControlPlaneError("forbidden", "Only this team’s owners can delete it.", {
    reason: "hosted-team-owner-required",
  });
}

/** A bootstrap attempt lost its team: cancelled, retried or claimed again since. */
export class HostedTeamSupersededError extends ControlPlaneError {
  constructor() {
    super("conflict", "This team’s setup changed.");
  }
}

function superseded() {
  return new HostedTeamSupersededError();
}

function toView(row: HostedTeamRow, accountId: ControlPlaneAccountId): HostedTeamView {
  const stage =
    row.state === "deleted" ? "deleting" : row.state === "suspended" ? "failed" : row.stage;
  const message =
    row.state === "suspended" ? "Opensteer suspended this team." : (row.stageMessage ?? null);
  return {
    id: row.id,
    name: row.name ?? row.slug,
    slug: row.slug,
    origin: hostedTeamOrigin(row.slug as HostedTeamSlug),
    ...(row.deploymentId ? { deploymentId: row.deploymentId } : {}),
    stage,
    ...(stage === "failed" ? { error: { message: message ?? unfinishedMessage } } : {}),
    creator: row.creatorAccountId === accountId,
  };
}
