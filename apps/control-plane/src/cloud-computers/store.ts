import { randomBytes, randomUUID } from "node:crypto";
import {
  CloudComputerBootReleaseSchema,
  CloudComputerDesiredSchema,
  CloudComputerEgressSchema,
  CloudComputerIdSchema,
  type CloudComputerBootRequest,
  type CloudComputerBootResponse,
  type CloudComputerDesired,
  type CloudComputerId,
  type CloudComputerReport,
  type CloudComputerView,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import type { Kysely, Selectable, Transaction, Updateable } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import type { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { ControlPlaneError } from "../server/errors.js";
import type { CloudComputerConfig } from "./config.js";
import { billingStatus, matchesPrice, type StripeBilling, type StripeEvent } from "./stripe.js";
import type { BillingStatus, CloudComputerTable } from "./tables.js";

type Database = Kysely<ControlPlaneDatabaseSchema>;
type TransactionDb = Transaction<ControlPlaneDatabaseSchema>;
type Computer = Selectable<CloudComputerTable>;
type Mutation =
  "suspend" | "resume" | "delete" | "operator-suspend" | "operator-unsuspend" | "reissue";
const bootstrapLifetimeMs = 20 * 60_000;
const checkoutLifetimeMs = 2 * 60 * 60_000;
const emptyDigest = "0".repeat(64);

interface StoreOptions {
  readonly config: CloudComputerConfig;
  readonly accountOrigin: URL;
  readonly cipher: HostedTeamSetupTokenCipher;
  readonly stripe: StripeBilling;
  readonly now?: () => Date;
}

export class CloudComputerStore {
  readonly #db: Database;
  readonly #options: StoreOptions;
  readonly #now: () => Date;

  constructor(database: Database, options: StoreOptions) {
    this.#db = database;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get plan() {
    return this.#options.config.plan;
  }

  async checkout(accountId: ControlPlaneAccountId, requestId: string) {
    const attempt = await this.#db.transaction().execute(async (tx) => {
      if (!(await lockOwner(tx, accountId, this.#now()))) throw missing();
      const attempts = tx
        .selectFrom("cloudComputerCheckouts")
        .selectAll()
        .where("accountId", "=", accountId);
      const replay = await attempts.where("requestId", "=", requestId).executeTakeFirst();
      if (replay) {
        if (replay.status === "expired" || (!replay.url && replay.expiresAt <= this.#now())) {
          throw new ControlPlaneError("conflict", "This checkout expired");
        }
        return replay;
      }
      const existing = await tx
        .selectFrom("cloudComputers")
        .select("id")
        .where("accountId", "=", accountId)
        .where((eb) =>
          eb.or([eb("tombstonedAt", "is", null), eb("billingStatus", "!=", "canceled")]),
        )
        .executeTakeFirst();
      if (existing)
        throw new ControlPlaneError(
          "conflict",
          "This Account already has a Cloud Computer or subscription",
        );
      const open = await attempts.where("status", "=", "open").executeTakeFirst();
      if (open)
        throw new ControlPlaneError("conflict", "This Account already has a checkout in progress");
      return tx
        .insertInto("cloudComputerCheckouts")
        .values({
          accountId,
          requestId,
          stripePriceId: this.#options.config.stripePriceId,
          currency: this.plan.currency,
          status: "open",
          url: null,
          stripeSessionId: null,
          expiresAt: new Date(this.#now().getTime() + checkoutLifetimeMs),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });

    if (attempt.url) return { url: attempt.url };
    const session = await this.#options.stripe.checkout({
      accountId,
      requestId,
      priceId: attempt.stripePriceId,
      expiresAt: attempt.expiresAt,
    });
    const result = await this.#db
      .updateTable("cloudComputerCheckouts")
      .where("accountId", "=", accountId)
      .where("requestId", "=", requestId)
      .where("status", "!=", "expired")
      .where((eb) =>
        eb.or([eb("stripeSessionId", "is", null), eb("stripeSessionId", "=", session.id)]),
      )
      .set({ stripeSessionId: session.id, url: session.url })
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n)
      throw new ControlPlaneError("conflict", "Checkout is no longer available");
    return { url: session.url };
  }

  async billingPortal(accountId: ControlPlaneAccountId) {
    const billing = await this.#db
      .selectFrom("cloudComputers")
      .select("stripeCustomerId")
      .where("accountId", "=", accountId)
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
    if (!billing) throw missing();
    return this.#options.stripe.portal(billing.stripeCustomerId);
  }

  async applyStripeEvent(event: StripeEvent): Promise<void> {
    await this.#db.transaction().execute(async (tx) => {
      const recorded = await tx
        .insertInto("cloudComputerStripeEvents")
        .values({ id: event.id, type: event.type, receivedAt: this.#now() })
        .onConflict((conflict) => conflict.column("id").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!recorded || event.operation === "ignore") return;
      if (event.operation === "billing") {
        const row = await tx
          .selectFrom("cloudComputers")
          .selectAll()
          .where("stripeSubscriptionId", "=", event.subscriptionId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!row) return;
        const subscription = await this.#options.stripe.subscription(row.stripeSubscriptionId);
        if (
          subscription.id !== row.stripeSubscriptionId ||
          subscription.customer !== row.stripeCustomerId
        ) {
          throw new ControlPlaneError("unavailable", "Stripe returned a different subscription");
        }
        const billing = billingStatus(subscription);
        const effectiveBilling =
          billing === "active" &&
          !matchesPrice(subscription, row.stripePriceId, row.billingCurrency)
            ? "inactive"
            : billing;
        const now = this.#now();
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", row.id)
          .set({
            billingStatus: effectiveBilling,
            ...transition(row, desiredState(row, effectiveBilling), now),
            updatedAt: now,
          })
          .executeTakeFirst();
        return;
      }

      const { checkout } = event;
      const { account_id: accountId, request_id: requestId } = checkout.metadata;
      if (
        accountId !== checkout.client_reference_id ||
        !(await lockOwner(tx, accountId, this.#now()))
      )
        return;
      const attempt = await tx
        .selectFrom("cloudComputerCheckouts")
        .selectAll()
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !attempt ||
        attempt.status !== "open" ||
        (attempt.stripeSessionId !== null && attempt.stripeSessionId !== checkout.id)
      )
        return;
      const writeAttempt = tx
        .updateTable("cloudComputerCheckouts")
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId);
      if (event.operation === "expired") {
        await writeAttempt
          .set({ status: "expired", stripeSessionId: checkout.id })
          .executeTakeFirst();
        return;
      }
      const payment = event.checkout;
      const subscription = await this.#options.stripe.subscription(payment.subscription);
      if (
        subscription.id !== payment.subscription ||
        subscription.customer !== payment.customer ||
        subscription.metadata["account_id"] !== accountId ||
        subscription.metadata["request_id"] !== requestId ||
        !matchesPrice(subscription, attempt.stripePriceId, attempt.currency) ||
        payment.currency !== attempt.currency
      ) {
        throw new ControlPlaneError(
          "unavailable",
          "Stripe checkout does not match the Cloud Computer price",
        );
      }

      const id = CloudComputerIdSchema.parse(`cc_${randomUUID()}`);
      const { config, cipher } = this.#options;
      const now = this.#now();
      const billing = billingStatus(subscription);
      const setupCode = newSecret();
      await tx
        .insertInto("cloudComputers")
        .values({
          id,
          accountId,
          generation: 1,
          state: billing === "active" ? "active" : "suspended",
          hostname: `${id.replace("_", "-")}.${config.domain}`,
          region: config.region,
          serverType: config.serverType,
          release: JSON.stringify(config.release),
          setupCodeDigest: digestSecret(setupCode),
          sealedSetupCode: cipher.seal(id, 1, setupCode),
          sealedBackupPassword: cipher.seal(`backup:${id}`, 1, newSecret()),
          bootstrapDigest: null,
          sealedBootstrapToken: null,
          bootstrapExpiresAt: null,
          bootstrapReceipt: null,
          bootstrapReceiptAt: null,
          readinessStartedAt: now,
          phase: "provisioning",
          providerServerId: null,
          ipv4: null,
          ipv6: null,
          deploymentId: null,
          hostKeyFingerprint: null,
          lastError: null,
          operatorSuspension: null,
          stripeCheckoutId: checkout.id,
          stripeCustomerId: payment.customer,
          stripeSubscriptionId: payment.subscription,
          stripePriceId: attempt.stripePriceId,
          billingCurrency: attempt.currency,
          billingStatus: billing,
          createdAt: now,
          updatedAt: now,
          reportedAt: null,
          deletedAt: null,
          tombstonedAt: null,
        })
        .executeTakeFirst();
      await writeAttempt
        .set({ status: "completed", stripeSessionId: checkout.id })
        .executeTakeFirst();
    });
  }

  async desired(): Promise<CloudComputerDesired[]> {
    const rows = await this.#db
      .selectFrom("cloudComputers")
      .selectAll()
      .where("tombstonedAt", "is", null)
      .orderBy("createdAt")
      .limit(10_000)
      .execute();
    return Promise.all(
      rows.map(async (snapshot) => {
        let row = snapshot;
        if (needsVm(row) && !row.bootstrapDigest) {
          row = await this.#db.transaction().execute(async (tx) => {
            const current = await lockedComputer(tx, snapshot.id);
            if (!needsVm(current) || current.bootstrapDigest) return current;
            const token = newSecret();
            return tx
              .updateTable("cloudComputers")
              .where("id", "=", current.id)
              .set({
                bootstrapDigest: bootDigest(current, token),
                sealedBootstrapToken: this.#options.cipher.seal(
                  `boot:${current.id}`,
                  current.generation,
                  token,
                ),
                bootstrapExpiresAt: new Date(this.#now().getTime() + bootstrapLifetimeMs),
              })
              .returningAll()
              .executeTakeFirstOrThrow();
          });
        }
        const token =
          needsVm(row) &&
          row.sealedBootstrapToken &&
          row.bootstrapExpiresAt &&
          row.bootstrapExpiresAt > this.#now()
            ? this.#options.cipher.open(`boot:${row.id}`, row.generation, row.sealedBootstrapToken)
            : undefined;
        return CloudComputerDesiredSchema.parse({
          id: row.id,
          generation: row.generation,
          state: row.state,
          hostname: row.hostname,
          region: row.region,
          serverType: row.serverType,
          release: row.release,
          readinessStartedAt: row.readinessStartedAt.toISOString(),
          ...(row.deploymentId
            ? {
                observedIdentity: {
                  deploymentId: row.deploymentId,
                  hostKeyFingerprint: row.hostKeyFingerprint,
                },
              }
            : {}),
          ...(token ? { bootstrapToken: token } : {}),
        });
      }),
    );
  }

  async report(report: CloudComputerReport): Promise<boolean> {
    return this.#db.transaction().execute(async (tx) => {
      const row = await lockedComputer(tx, report.id);
      if (row.generation !== report.generation || row.tombstonedAt !== null) return false;
      if (!phaseMatchesState(row.state, report.phase)) return false;
      const identity = report.observedIdentity;
      if (
        row.deploymentId &&
        identity &&
        (identity.deploymentId !== row.deploymentId ||
          identity.hostKeyFingerprint !== row.hostKeyFingerprint)
      ) {
        throw new ControlPlaneError("conflict", "Cloud Computer Home identity changed");
      }
      const now = this.#now();
      const ready = report.phase === "ready";
      const deleted = report.phase === "deleted";
      await tx
        .updateTable("cloudComputers")
        .where("id", "=", row.id)
        .set({
          phase: report.phase,
          ipv4: report.ipv4,
          ipv6: report.ipv6,
          // Retain the last server observation through transient provider failures.
          providerServerId: deleted
            ? null
            : (report.providerServerId?.toString() ?? row.providerServerId),
          lastError: report.lastError,
          reportedAt: now,
          updatedAt: now,
          ...(ready && !row.deploymentId && identity
            ? {
                deploymentId: identity.deploymentId,
                hostKeyFingerprint: identity.hostKeyFingerprint,
              }
            : {}),
          ...(ready || deleted ? clearBootToken : {}),
          ...(deleted ? { tombstonedAt: now, deploymentId: null, hostKeyFingerprint: null } : {}),
        })
        .executeTakeFirst();
      if (deleted) {
        await tx
          .updateTable("cloudComputerEgressEndpoints")
          .set({ computerId: null })
          .where("computerId", "=", row.id)
          .executeTakeFirst();
      }
      return ready && row.bootstrapReceiptAt === null;
    });
  }

  async boot(
    id: CloudComputerId,
    input: CloudComputerBootRequest,
  ): Promise<CloudComputerBootResponse> {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const valid = equalSecretDigests(
        bootDigest(row ?? { id, generation: 0 }, input.bootstrapToken),
        row?.bootstrapDigest ?? emptyDigest,
      );
      if (
        !row ||
        !valid ||
        row.hostname !== input.hostname ||
        row.state !== "active" ||
        !row.bootstrapExpiresAt ||
        row.bootstrapExpiresAt <= this.#now() ||
        row.deploymentId ||
        !row.setupCodeDigest ||
        !row.sealedBackupPassword
      ) {
        throw new ControlPlaneError(
          "unauthorized",
          "Invalid or expired Cloud Computer bootstrap token",
        );
      }

      const endpoints = tx.selectFrom("cloudComputerEgressEndpoints").selectAll();
      let endpoint = await endpoints.where("computerId", "=", id).executeTakeFirst();
      if (!endpoint) {
        endpoint = await endpoints
          .where("computerId", "is", null)
          .orderBy("id")
          .forUpdate()
          .skipLocked()
          .limit(1)
          .executeTakeFirst();
        if (endpoint) {
          await tx
            .updateTable("cloudComputerEgressEndpoints")
            .set({ computerId: id })
            .where("id", "=", endpoint.id)
            .executeTakeFirst();
        }
      }
      await tx
        .updateTable("cloudComputers")
        .set({ egressUnavailable: !endpoint })
        .where("id", "=", id)
        .executeTakeFirst();

      const { config, cipher } = this.#options;
      const prefix = `cloud-computers/${id}`;
      return {
        hostname: row.hostname,
        accountOrigin: this.#options.accountOrigin.origin,
        setupCodeDigest: row.setupCodeDigest,
        release: CloudComputerBootReleaseSchema.parse({
          version: row.release.version,
          images: row.release.images,
        }),
        ...(endpoint
          ? {
              egress: {
                url: endpoint.url,
                username: endpoint.username,
                password: cipher.open(`egress:${endpoint.id}`, 1, endpoint.sealedPassword),
              },
            }
          : {}),
        backup: {
          ...config.backup,
          prefix,
          repository: `s3:${config.backup.endpoint}/${config.backup.bucket}/${prefix}`,
          password: cipher.open(`backup:${id}`, 1, row.sealedBackupPassword),
        },
      };
    });
  }

  async setupCodeForReadyHome(
    id: CloudComputerId,
    generation: number,
  ): Promise<string | undefined> {
    const row = await this.#db
      .selectFrom("cloudComputers")
      .select(["sealedSetupCode", "generation"])
      .where("id", "=", id)
      .where("generation", "=", generation)
      .where("state", "=", "active")
      .where("phase", "=", "ready")
      .where("bootstrapReceiptAt", "is", null)
      .executeTakeFirst();
    return row?.sealedSetupCode
      ? this.#options.cipher.open(id, row.generation, row.sealedSetupCode)
      : undefined;
  }

  async list(accountId?: ControlPlaneAccountId): Promise<CloudComputerView[]> {
    let query = this.#db.selectFrom("cloudComputers").selectAll().orderBy("createdAt", "desc");
    if (accountId) query = query.where("accountId", "=", accountId);
    const rows = await query.execute();
    return this.#views(rows);
  }

  async show(id: CloudComputerId, accountId?: ControlPlaneAccountId): Promise<CloudComputerView> {
    let query = this.#db.selectFrom("cloudComputers").selectAll().where("id", "=", id);
    if (accountId) query = query.where("accountId", "=", accountId);
    const row = await query.executeTakeFirst();
    if (!row) throw missing();
    return (await this.#views([row]))[0]!;
  }

  async #views(rows: readonly Computer[]) {
    if (rows.length === 0) return [];
    const endpoints = await this.#db
      .selectFrom("cloudComputerEgressEndpoints")
      .select("computerId")
      .where(
        "computerId",
        "in",
        rows.map(({ id }) => id),
      )
      .execute();
    const assigned = new Set(endpoints.map(({ computerId }) => computerId));
    return rows.map((row) => view(row, assigned.has(row.id), this.#now()));
  }

  async mutate(
    id: CloudComputerId,
    action: Mutation,
    accountId?: ControlPlaneAccountId,
    reason?: string,
  ) {
    await this.#db.transaction().execute(async (tx) => {
      const row = await lockedComputer(tx, id);
      if (accountId && row.accountId !== accountId) throw missing();
      if (row.state === "deleted") {
        if (action === "delete") return;
        throw new ControlPlaneError("conflict", "This Cloud Computer is deleted");
      }

      const now = this.#now();
      let changes: Updateable<CloudComputerTable>;
      if (action === "delete") {
        changes = {
          ...transition(row, "deleted", now),
          ...clearBootToken,
          deletedAt: now,
          sealedSetupCode: null,
          setupCodeDigest: null,
          sealedBackupPassword: null,
        };
      } else if (action === "reissue") {
        if (row.state !== "active")
          throw new ControlPlaneError(
            "conflict",
            "Resume the Cloud Computer before reissuing bootstrap",
          );
        const generation = row.generation + 1;
        const setupCode = newSecret();
        changes = {
          ...clearBootToken,
          generation,
          phase: "provisioning",
          readinessStartedAt: now,
          reportedAt: null,
          setupCodeDigest: digestSecret(setupCode),
          sealedSetupCode: this.#options.cipher.seal(id, generation, setupCode),
          providerServerId: null,
          ipv4: null,
          ipv6: null,
          deploymentId: null,
          hostKeyFingerprint: null,
          lastError: null,
          bootstrapReceipt: null,
          bootstrapReceiptAt: null,
          egressUnavailable: false,
        };
      } else {
        const ownerSuspended = action === "suspend" || (action !== "resume" && row.ownerSuspended);
        const operatorSuspension =
          action === "operator-suspend"
            ? (reason ?? "Paused by Opensteer.")
            : action === "operator-unsuspend"
              ? null
              : row.operatorSuspension;
        changes = {
          ownerSuspended,
          operatorSuspension,
          ...transition(
            row,
            desiredState({ ...row, operatorSuspension, ownerSuspended }, row.billingStatus),
            now,
          ),
        };
      }
      await tx
        .updateTable("cloudComputers")
        .set({ ...changes, updatedAt: now })
        .where("id", "=", id)
        .executeTakeFirst();
    });
    return this.show(id, accountId);
  }

  async addEgressEndpoint(endpoint: {
    url: string;
    username: string;
    password: string;
  }): Promise<string> {
    const parsed = CloudComputerEgressSchema.safeParse(endpoint);
    if (!parsed.success)
      throw new ControlPlaneError("bad_request", "Invalid browser egress endpoint");
    const id = randomUUID();
    const row = await this.#db
      .insertInto("cloudComputerEgressEndpoints")
      .values({
        id,
        url: new URL(parsed.data.url).origin,
        username: parsed.data.username,
        computerId: null,
        sealedPassword: this.#options.cipher.seal(`egress:${id}`, 1, parsed.data.password),
      })
      .onConflict((conflict) => conflict.column("url").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!row) throw new ControlPlaneError("conflict", "Browser egress endpoint already exists");
    return row.id;
  }

  async removeEgressEndpoint(id: string): Promise<void> {
    const result = await this.#db
      .deleteFrom("cloudComputerEgressEndpoints")
      .where("id", "=", id)
      .where("computerId", "is", null)
      .executeTakeFirst();
    if (result.numDeletedRows !== 1n) {
      throw new ControlPlaneError(
        "conflict",
        "Browser egress endpoint is assigned or does not exist",
      );
    }
  }

  async listEgressEndpoints() {
    return this.#db
      .selectFrom("cloudComputerEgressEndpoints")
      .select(["id", "computerId"])
      .orderBy("id")
      .execute();
  }
}

const clearBootToken = {
  bootstrapDigest: null,
  sealedBootstrapToken: null,
  bootstrapExpiresAt: null,
};

function newSecret() {
  return randomBytes(32).toString("base64url");
}

function bootDigest(row: Pick<Computer, "id" | "generation">, token: string) {
  return digestSecret(`${row.id}\0${row.generation}\0${token}`);
}

function needsVm(row: Computer) {
  return row.state === "active" && !row.providerServerId && !row.deploymentId;
}

async function lockOwner(tx: TransactionDb, accountId: ControlPlaneAccountId, now: Date) {
  const owner = await tx
    .selectFrom("users")
    .select(["id", "deletionFencedUntil"])
    .where("id", "=", accountId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  return (
    owner !== undefined && (owner.deletionFencedUntil === null || owner.deletionFencedUntil <= now)
  );
}

async function lockedComputer(tx: TransactionDb, id: CloudComputerId) {
  const row = await tx
    .selectFrom("cloudComputers")
    .selectAll()
    .where("id", "=", id)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!row) throw missing();
  return row;
}

function phaseMatchesState(
  state: CloudComputerDesired["state"],
  phase: CloudComputerReport["phase"],
) {
  if (phase === "failed" || phase === "provisioning")
    return state !== "deleted" || phase === "failed";
  if (state === "deleted") return phase === "deleted" || phase === "deleting";
  if (state === "suspended") return phase === "suspended";
  return phase === "booting" || phase === "ready";
}

function desiredState(
  row: Pick<Computer, "state" | "ownerSuspended" | "operatorSuspension">,
  billing: BillingStatus,
): Computer["state"] {
  if (row.state === "deleted") return "deleted";
  return row.ownerSuspended || row.operatorSuspension || billing !== "active"
    ? "suspended"
    : "active";
}

function transition(
  row: Computer,
  next: Computer["state"],
  now: Date,
): Updateable<CloudComputerTable> {
  if (row.state === next) return {};
  return {
    state: next,
    phase: next === "deleted" ? "deleting" : "provisioning",
    lastError: null,
    ...(next === "active"
      ? {
          readinessStartedAt: new Date(
            Math.max(now.getTime(), row.readinessStartedAt.getTime() + 1),
          ),
        }
      : {}),
  };
}

function view(row: Computer, assigned: boolean, now: Date): CloudComputerView {
  const egress = assigned ? "assigned" : row.egressUnavailable ? "unavailable" : "pending";
  const base = { id: row.id, egress } as const;
  if (row.state === "deleted") return { ...base, status: "deleted" };
  if (row.state === "suspended") {
    return {
      ...base,
      status: "suspended",
      reason:
        row.operatorSuspension ??
        (row.ownerSuspended
          ? "You paused this Cloud Computer."
          : row.billingStatus === "canceled"
            ? "Your subscription ended."
            : "Your subscription needs attention."),
    };
  }
  if (row.phase === "ready")
    return { ...base, status: "ready", address: `https://${row.hostname}` };
  if (row.bootstrapExpiresAt && row.bootstrapExpiresAt <= now) {
    return {
      ...base,
      status: "needs_attention",
      reason: "The Cloud Computer’s boot credential expired.",
    };
  }
  if (row.phase === "failed" && row.lastError)
    return { ...base, status: "needs_attention", reason: row.lastError };
  return { ...base, status: "preparing" };
}

function missing() {
  return new ControlPlaneError("not_found", "Cloud Computer was not found");
}
