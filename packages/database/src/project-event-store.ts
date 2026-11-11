import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Kysely, Transaction } from "kysely";
import {
  OpensteerError,
  type AgentEvent,
  type ProjectEngineRequestEvent,
  type ProjectPendingEngineRequest,
} from "@opensteer/core";
import {
  ProjectRunnerToHostMessageSchema,
  RunnerConnectionFenceSchema,
  sameRunnerConnectionFence,
  type ProjectRunControl,
  type RunnerConnectionFence,
} from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { z } from "zod";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { assertActiveProjectBinding, readProjectRunBinding } from "./execution-authority.js";
import { withDatabaseTransaction } from "./connection.js";
import { type ChannelLinks } from "./store-primitives.js";
import { reserveProjectWorkStop, finalizeProjectRunTransaction } from "./run-finalization.js";
import { attemptForBinding } from "./run-attempts.js";
import { projectAssignmentEventsInTransaction } from "./assignment-store.js";
import { markThreadStatePending } from "./thread-status.js";
import {
  storableJson,
  applyEventProjection,
  persistAuthenticatedRunnerEvent,
} from "./runner-event-store.js";
import { PendingAgentEventSchema, type PendingAgentEvent } from "@opensteer/protocol";
import type { DatabaseSchema } from "./schema.js";

export type ProjectProposalAcceptance =
  | {
      readonly state: "ready";
      readonly request: ProjectPendingEngineRequest;
      readonly replayed: boolean;
      readonly events: readonly AgentEvent[];
    }
  | {
      readonly state: "settled";
      readonly requestId: ProjectEngineRequestEvent["data"]["request"]["id"];
    }
  | {
      readonly state: "refused";
      readonly control: Extract<ProjectRunControl, { readonly kind: "request.refuse" }>;
    };

export interface ProjectRequestProposalPort {
  propose(
    transaction: Transaction<DatabaseSchema>,
    input: ProjectEngineRequestEvent,
  ): Promise<ProjectProposalAcceptance>;
}

function proposalReceiptId(ordinal: number): string {
  const value = BigInt(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(ordinal))
    .toString(16)
    .padStart(15, "0");
  // Version eight separates transport ordinals from generated version-four tool identities.
  return `00000000-0000-8000-8${value.slice(0, 3)}-${value.slice(3)}`;
}

export class ProjectProposalAcceptanceStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly dependencies: {
    readonly currentPeerIsProjectCapable: (peer: RunnerConnectionFence) => boolean;
    readonly requests: ProjectRequestProposalPort;
    readonly links?: ChannelLinks | undefined;
    readonly cancelRequest?:
      | ((
          transaction: Transaction<DatabaseSchema>,
          event: Extract<PendingAgentEvent, { readonly type: "request.cancelled" }>,
        ) => Promise<readonly AgentEvent[]>)
      | undefined;
  };

  constructor(
    database: Kysely<DatabaseSchema>,
    dependencies: ProjectProposalAcceptanceStore["dependencies"],
  ) {
    this.database = database;
    this.dependencies = dependencies;
  }

  accept(peerInput: RunnerConnectionFence, raw: unknown) {
    return this.acceptFrame(peerInput, raw, true);
  }

  protected async acceptFrame(
    peerInput: RunnerConnectionFence,
    raw: unknown,
    requireProposal: boolean,
  ) {
    const peer = RunnerConnectionFenceSchema.parse(peerInput);
    const assertPeer = () => {
      if (!this.dependencies.currentPeerIsProjectCapable(peer))
        throw new OpensteerError({
          code: "forbidden",
          message: "Project proposal peer is not authenticated and capable",
        });
    };
    assertPeer();
    const frame = ProjectRunnerToHostMessageSchema.parse(raw);
    if (
      frame.type !== "runner.project.event" ||
      (requireProposal && frame.event.type !== "request.proposed.project") ||
      !sameRunnerConnectionFence(peer, frame)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Project proposal does not match its authenticated connection",
      });
    const event = storableJson(frame.event);
    const requestId = proposalReceiptId(event.ordinal);
    const fingerprint = createHash("sha256").update(canonicalJson(event)).digest("hex");
    await assertProjectAuthority(this.database);
    return withDatabaseTransaction(this.database, async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .innerJoin("grants", "grants.runId", "runs.id")
        .selectAll("runs")
        .where("runs.id", "=", event.binding.runId)
        .where("grants.id", "=", event.binding.grantId)
        .where("grants.runnerId", "=", peer.runnerId)
        .where("grants.runnerBootId", "=", peer.bootId)
        .forNoKeyUpdate("runs")
        .executeTakeFirst();
      const original = run
        ? await readProjectRunBinding(transaction, {
            runId: run.id,
            grantId: event.binding.grantId,
          })
        : null;
      if (!run || !original || !isDeepStrictEqual(original.binding, event.binding))
        throw new OpensteerError({
          code: "forbidden",
          message: "Project proposal has no matching stored source",
        });
      const previous = await transaction
        .selectFrom("agentControlRequests")
        .selectAll()
        .where("runId", "=", run.id)
        .where("requestId", "=", requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (previous) {
        if (
          previous.action !== "project.event" ||
          previous.actionClass !== "project.event" ||
          previous.sourceThreadId !== event.binding.threadId ||
          previous.requestFingerprint !== fingerprint ||
          event.ordinal >= run.nextRunnerOrdinal
        )
          throw new OpensteerError({
            code: "conflict",
            message: "Project proposal ordinal was committed with different content",
          });
        assertPeer();
        return {
          binding: event.binding,
          ordinal: event.ordinal,
          events: [] as readonly AgentEvent[],
          wasDuplicate: true,
          proposalState: null,
        };
      }
      await assertActiveProjectBinding(transaction, event.binding, {
        runnerIsAttached: (runnerId, bootId) =>
          runnerId === peer.runnerId &&
          bootId === peer.bootId &&
          this.dependencies.currentPeerIsProjectCapable(peer),
      });
      if (run.nextRunnerOrdinal !== event.ordinal)
        throw new OpensteerError({
          code: "conflict",
          message: "Project proposal ordinal is out of sequence",
        });
      await transaction
        .insertInto("agentControlRequests")
        .values({
          runId: run.id,
          requestId,
          sourceThreadId: run.threadId,
          action: "project.event",
          actionClass: "project.event",
          requestFingerprint: fingerprint,
        })
        .execute();
      await reserveProjectWorkStop(transaction, { runIds: [run.id] });
      await markThreadStatePending(transaction, run.threadId);
      if (event.type !== "request.proposed.project") {
        const links = this.dependencies.links;
        if (!links)
          throw new OpensteerError({
            code: "conflict",
            reason: "project-event-projection-unavailable",
            message: "The Project event persistence boundary is not connected",
          });
        const pending = PendingAgentEventSchema.parse({
          type: event.type,
          data: event.data,
          emittedAt: event.emittedAt,
          ordinal: event.ordinal,
          bindingGeneration: event.binding.bindingGeneration,
          environmentId: event.binding.environmentId,
          workspaceId: event.binding.workspaceId,
          runId: event.binding.runId,
          threadId: event.binding.threadId,
        });
        const accepted = await persistAuthenticatedRunnerEvent(
          transaction,
          links,
          {
            event: pending,
            data: pending.data,
            run,
            attempt: await attemptForBinding(transaction, run.id, event.binding.bindingGeneration),
            environmentId: event.binding.environmentId,
            runnerId: peer.runnerId,
            runnerBootId: peer.bootId,
          },
          {
            project: (tx, item, channelLinks, attempt) =>
              applyEventProjection(tx, item, channelLinks, attempt, {
                finalize: (tx, finalization) => finalizeProjectRunTransaction(tx, finalization),
                // A post-freeze queue admission already has its own Project Run; only an explicit steer controls this one.
                deliverConversation: async () => ({ events: [], revokedGrants: [] }),
                cancelRequest: async (tx, cancelled) => {
                  if (!this.dependencies.cancelRequest)
                    throw new OpensteerError({
                      code: "conflict",
                      reason: "project-request-cancellation-unavailable",
                      message:
                        "The Project engine Request cancellation boundary is not connected yet",
                    });
                  return this.dependencies.cancelRequest(tx, cancelled);
                },
              }),
            assignmentActivity: async (tx, runId) => {
              const current = await tx
                .selectFrom("runs")
                .select("assignmentId")
                .where("id", "=", runId)
                .executeTakeFirst();
              if (!current?.assignmentId) return [];
              const assignment = await tx
                .updateTable("delegations")
                .set((eb) => ({ revision: eb("revision", "+", 1), updatedAt: new Date() }))
                .where("id", "=", current.assignmentId)
                .returningAll()
                .executeTakeFirstOrThrow();
              return projectAssignmentEventsInTransaction(
                tx,
                assignment,
                "assignment.updated",
                runId,
              );
            },
          },
        );
        assertPeer();
        return {
          binding: event.binding,
          ordinal: event.ordinal,
          events: [accepted.event, ...accepted.compensatingEvents],
          wasDuplicate: false,
          proposalState: null,
        };
      }
      if (run.status !== "running" && run.status !== "waiting")
        throw new OpensteerError({
          code: "conflict",
          message: "A Project Run can propose a Request only while running or waiting",
        });
      const proposal = await this.dependencies.requests.propose(transaction, {
        type: "request.proposed.project",
        binding: event.binding,
        data: event.data,
      });
      const advanced = await transaction
        .updateTable("runs")
        .set({ nextRunnerOrdinal: event.ordinal + 1 })
        .where("id", "=", run.id)
        .where("nextRunnerOrdinal", "=", event.ordinal)
        .executeTakeFirstOrThrow();
      if (advanced.numUpdatedRows !== 1n)
        throw new OpensteerError({
          code: "conflict",
          message: "Project proposal ordinal changed during acceptance",
        });
      assertPeer();
      return {
        binding: event.binding,
        ordinal: event.ordinal,
        events: proposal.state === "ready" ? proposal.events : ([] as readonly AgentEvent[]),
        wasDuplicate: false,
        proposalState: proposal.state,
      };
    });
  }
}

/** The whole Project event schema is authenticated once before using the shared durable projections. */
export class ProjectRunEventAcceptanceStore extends ProjectProposalAcceptanceStore {
  override accept(peer: RunnerConnectionFence, raw: unknown) {
    return this.acceptFrame(peer, raw, false);
  }
}
