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
import { lockWorkspaceRow } from "./store-primitives.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import { markThreadStatePending } from "./thread-status.js";
import { storableJson } from "./runner-event-store.js";
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
  };

  constructor(
    database: Kysely<DatabaseSchema>,
    dependencies: ProjectProposalAcceptanceStore["dependencies"],
  ) {
    this.database = database;
    this.dependencies = dependencies;
  }

  async accept(peerInput: RunnerConnectionFence, raw: unknown) {
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
      frame.event.type !== "request.proposed.project" ||
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
      await assertActiveProjectBinding(transaction, event.binding, {
        runnerIsAttached: (runnerId, bootId) =>
          runnerId === peer.runnerId &&
          bootId === peer.bootId &&
          this.dependencies.currentPeerIsProjectCapable(peer),
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
      await lockWorkspaceRow(transaction, event.binding.workspaceId);
      await transaction
        .selectFrom("threads")
        .select("id")
        .where("id", "=", event.binding.threadId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      await lockRunProjectionRows(transaction, {
        runIds: [run.id],
        threadIds: [run.threadId],
        requestIds: [event.data.request.id],
      });
      await markThreadStatePending(transaction, run.threadId);
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
