import { lockRequestWorkspaces } from "./request-workspace-locks.js";
import { randomUUID } from "node:crypto";
import type { RequestPresentation, RunnerId, UserId, ThreadId, WorkspaceId } from "@opensteer/core";
import {
  ComputerAppSetupRequestSchema,
  computerAppIdentityKey,
  computerAppIdentitiesEqual,
  type ComputerAppIdentity,
  type ComputerAppSetupRequest,
  type IntegrationAccess,
  type LocalMcpServerSetup,
} from "@opensteer/integration-core";
import { sql, type Selectable, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import { requestFromRow } from "./request-persistence.js";

export type ComputerAppSetupRequestRow = Selectable<DatabaseSchema["computerAppSetupRequests"]>;

/** An approval outlives a browser tab but not a person's memory of asking for it. */
export const computerAppSetupRequestLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

/**
 * The scope every setup-request write is keyed by.
 *
 * Before computer use it was `(runnerId, definitionId)`, because a computer
 * connection was the definition on the Runner and nothing finer. `macos-app`
 * scopes app approvals by bundle id, and policy approvals by kind: consuming
 * Notes must leave Calendar and the automatic policy approval pending.
 */
export interface ComputerAppScope {
  readonly appKey: string | null;
  readonly kind: "app" | "policy";
  readonly definitionId: string;
  readonly runnerId: RunnerId;
}

/**
 * The uniqueness key of one approved app, or null for a definition whose
 * connections name no app. Postgres never derives it: see the
 * `0049_computer_app_identity` migration for why the store owns the
 * lowercasing.
 */
export function computerAppKeyOf(app: ComputerAppIdentity | null): string | null {
  return app === null ? null : computerAppIdentityKey(app);
}

export function computerAppScopeOf(input: {
  readonly kind?: "app" | "policy";
  readonly app: ComputerAppIdentity | null;
  readonly definitionId: string;
  readonly runnerId: RunnerId;
}): ComputerAppScope {
  return {
    kind: input.kind ?? "app",
    appKey: computerAppKeyOf(input.app),
    definitionId: input.definitionId,
    runnerId: input.runnerId,
  };
}

export function computerAppSetupRequestFromRow(
  row: ComputerAppSetupRequestRow,
): ComputerAppSetupRequest {
  // `appKey` is the index's copy of the identity, not part of the approval a
  // desktop signs, so it never reaches the signed transcript.
  const { appKey: _appKey, ...rest } = row;
  return ComputerAppSetupRequestSchema.parse({
    ...rest,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
}

/** Locks the one row that may exist for this scope, so approval cannot race replacement. */
export async function lockComputerAppSetupRequestInTransaction(
  transaction: Transaction<DatabaseSchema>,
  scope: ComputerAppScope,
): Promise<ComputerAppSetupRequestRow | undefined> {
  return (
    transaction
      .selectFrom("computerAppSetupRequests")
      .selectAll()
      .where("kind", "=", scope.kind)
      .where("runnerId", "=", scope.runnerId)
      .where("definitionId", "=", scope.definitionId)
      .where("appKey", scope.appKey === null ? "is" : "=", scope.appKey)
      // FOR UPDATE: Callers delete or replace this computer app setup request.
      .forUpdate()
      .executeTakeFirst()
  );
}

/**
 * Removes the pending approvals this scope covers and answers with their ids,
 * so a caller can settle whatever `computer.app.access` Requests named them.
 *
 * An omitted `definitionId` or `appKey` widens the scope on purpose: removing
 * a computer takes back every approval on it, and uninstalling an app takes
 * back every approval of that definition.
 */
export async function deleteComputerAppSetupRequestsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  scope: {
    readonly kind?: "app" | "policy";
    readonly appKey?: string | null;
    readonly definitionId?: string;
    readonly runnerId?: RunnerId;
  },
): Promise<readonly string[]> {
  let query = transaction.deleteFrom("computerAppSetupRequests");
  if (scope.kind !== undefined) query = query.where("kind", "=", scope.kind);
  if (scope.runnerId !== undefined) query = query.where("runnerId", "=", scope.runnerId);
  if (scope.definitionId !== undefined) {
    query = query.where("definitionId", "=", scope.definitionId);
  }
  if (scope.appKey !== undefined) {
    query = query.where("appKey", scope.appKey === null ? "is" : "=", scope.appKey);
  }
  const removed = await query.returning("id").execute();
  return removed.map(({ id }) => id);
}

/**
 * Moves the pending `computer.app.access` Requests waiting on one approval to
 * the approval that replaced it, so consuming, declining or expiring the new
 * one settles them too.
 */
export async function relinkComputerAppAccessRequestsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly from: string; readonly to: string },
): Promise<void> {
  const pending = transaction
    .selectFrom("requests")
    .selectAll()
    .where("kind", "=", "computer.app.access")
    .where("status", "=", "pending")
    .where(sql<string>`payload->>'setupRequestId'`, "=", input.from)
    .orderBy("id", "asc");
  await lockRequestWorkspaces(
    transaction,
    (await pending.execute()).flatMap((row) => [row.originatingWorkspaceId, row.targetWorkspaceId]),
  );
  const waiting = await pending.forNoKeyUpdate().execute();
  if (waiting.length === 0) return;
  const replacement = await transaction
    .selectFrom("computerAppSetupRequests")
    .innerJoin("runners", "runners.id", "computerAppSetupRequests.runnerId")
    .select([
      "computerAppSetupRequests.app as app",
      "computerAppSetupRequests.kind as kind",
      "runners.name as runnerName",
    ])
    .where("computerAppSetupRequests.id", "=", input.to)
    .executeTakeFirstOrThrow();
  // A phone's approval names no app either, so only the kind tells an access
  // approval from the automatic policy's.
  if (replacement.kind !== "app") {
    throw new Error("A computer access Request can only wait on an access approval");
  }
  for (const row of waiting) {
    const request = requestFromRow(row);
    if (request.payload.kind !== "computer.app.access") continue;
    await transaction
      .updateTable("requests")
      .set({
        payload: jsonValue({ ...request.payload, app: replacement.app, setupRequestId: input.to }),
        presentation: jsonValue(
          computerAppAccessPresentation({
            access: request.payload.access,
            app: replacement.app,
            reason: request.payload.reason,
            runnerName: replacement.runnerName,
            setupRequestId: input.to,
          }),
        ),
      })
      .where("id", "=", row.id)
      .execute();
  }
}

/**
 * What the card for a `computer.app.access` Request says. A phone's ask names
 * no app, so its card names the phone and the owner's Opensteer controls.
 */
export function computerAppAccessPresentation(input: {
  readonly access: IntegrationAccess;
  readonly app: ComputerAppIdentity | null;
  readonly reason: string;
  readonly runnerName: string;
  readonly setupRequestId: string;
}): RequestPresentation {
  const allowed = input.access === "read-write" ? "can see and control" : "can see";
  const subject = { id: input.setupRequestId, kind: "computer-app-setup" as const };
  if (input.app === null) {
    return {
      detail: `${input.reason} ${input.runnerName} — ${allowed}. Allow or decline from any Opensteer app.`,
      kind: "external",
      subject,
      title: `Wants to ${input.access === "read-write" ? "see and control" : "see"} ${input.runnerName}`,
    };
  }
  return {
    detail: `${input.reason} ${input.app.displayName} on ${input.runnerName} — ${allowed}. Approve it on that Mac; decline from anywhere.`,
    kind: "external",
    subject,
    title: `Wants to use ${input.app.displayName} on ${input.runnerName}`,
  };
}

export async function insertComputerAppSetupRequestInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly kind?: "app" | "policy" | "server";
    readonly policyAppApproval?: "automatic" | null;
    readonly reason?: string | null;
    readonly server?: LocalMcpServerSetup | null;
    readonly threadId?: ThreadId | null;
    readonly workspaceId?: WorkspaceId | null;
    readonly workspaceName?: string | null;
    readonly threadTitle?: string | null;
    readonly access: IntegrationAccess;
    readonly app: ComputerAppIdentity | null;
    readonly definitionDigest: string;
    readonly definitionId: string;
    readonly now: Date;
    readonly ownerUserId: UserId;
    readonly runnerId: RunnerId;
  },
): Promise<ComputerAppSetupRequestRow> {
  const deployment = await transaction
    .selectFrom("deployments")
    .select("id")
    .where("singletonKey", "=", "primary")
    .executeTakeFirstOrThrow();
  const workspaceName =
    input.workspaceName !== undefined
      ? input.workspaceName
      : input.workspaceId
        ? ((
            await transaction
              .selectFrom("workspaces")
              .select("name")
              .where("id", "=", input.workspaceId)
              .executeTakeFirst()
          )?.name.slice(0, 160) ?? null)
        : null;
  return transaction
    .insertInto("computerAppSetupRequests")
    .values({
      kind: input.kind ?? "app",
      policyAppApproval: input.policyAppApproval ?? null,
      reason: input.reason ?? null,
      server: input.server ? jsonValue(input.server) : null,
      threadId: input.threadId ?? null,
      workspaceId: input.workspaceId ?? null,
      workspaceName,
      threadTitle: input.threadTitle ?? null,
      access: input.access,
      app: input.app === null ? null : jsonValue(input.app),
      appKey: computerAppKeyOf(input.app),
      createdAt: input.now,
      definitionDigest: input.definitionDigest,
      definitionId: input.definitionId,
      deploymentId: deployment.id,
      expiresAt: new Date(input.now.getTime() + computerAppSetupRequestLifetimeMs),
      id: randomUUID(),
      ownerUserId: input.ownerUserId,
      runnerId: input.runnerId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Whether an existing pending approval is the same ask, and therefore replayable. */
export function computerAppSetupRequestMatches(
  row: ComputerAppSetupRequestRow,
  input: {
    readonly access: IntegrationAccess;
    readonly app: ComputerAppIdentity | null;
    readonly definitionDigest: string;
    readonly now: Date;
    readonly ownerUserId: UserId;
  },
): boolean {
  return (
    row.ownerUserId === input.ownerUserId &&
    row.access === input.access &&
    row.definitionDigest === input.definitionDigest &&
    computerAppIdentitiesEqual(row.app, input.app) &&
    row.expiresAt > input.now
  );
}
