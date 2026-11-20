import { requestFromRow } from "@opensteer/database";
import {
  authorizedDetail,
  authorizedSyncState,
  withPersonalSyncRead,
} from "@opensteer/database/personal-sync-store";
import { OpensteerError, type ReferenceId, type UserId } from "@opensteer/core";
import type { DatabaseSchema, OpensteerStore } from "@opensteer/database";
import {
  hostApi,
  ReferenceResolveInputSchema,
  ReferenceResolveResultSchema,
  rpcSuccess,
  threadPageMaxItems,
  type HostApiServerContext,
  type ReferenceResolveInput,
  type ReferenceResolution,
} from "@opensteer/protocol";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { requireSession } from "../server/rpc-context.js";

type PersonalReferenceResolver = (
  database: Kysely<DatabaseSchema>,
  input: { ownerId: UserId; ids: readonly ReferenceId[] },
) => Promise<readonly ReferenceResolution[]>;

export function createReferenceHandlers(
  store: Pick<OpensteerStore, "database">,
  resolve: PersonalReferenceResolver,
) {
  return {
    "references.resolve": async (input: ReferenceResolveInput, context: HostApiServerContext) => {
      const ownerId = requireSession(context).user.id;
      const parsed = ReferenceResolveInputSchema.safeParse(input);
      if (!parsed.success)
        throw new OpensteerError({ code: "bad_request", message: "Invalid reference batch" });
      const results = await resolve(store.database, { ownerId, ids: parsed.data.ids });
      return rpcSuccess(ReferenceResolveResultSchema.parse({ results }));
    },
  };
}

export function createThreadRequestHandler(
  store: Pick<OpensteerStore, "database" | "getThreadForOwner" | "requests">,
) {
  return async (
    input: z.output<(typeof hostApi)["thread.requests.list"]["payload"]>,
    context: HostApiServerContext,
  ) => {
    const ownerId = requireSession(context).user.id;
    if (input.review) {
      const review = new Map(input.review.map(({ id, revision }) => [id, revision]));
      return withPersonalSyncRead(store.database, async (tx) => {
        await authorizedSyncState(tx, ownerId);
        if (!(await authorizedDetail(tx, ownerId, { kind: "thread", threadId: input.threadId })))
          throw new OpensteerError({ code: "not_found", message: "Thread not found" });
        const rows = await tx
          .selectFrom("requests")
          .selectAll()
          .where("originatingThreadId", "=", input.threadId)
          .where("id", "in", [...review.keys()])
          .where("status", "=", "pending")
          .limit(20)
          .execute();
        if (
          rows.length !== review.size ||
          rows.some(({ id, revision }) => review.get(id) !== revision)
        )
          throw new OpensteerError({
            code: "conflict",
            reason: "request-changed",
            message: "The reviewed Request changed.",
          });
        const requests = rows.map(requestFromRow);
        const byteCount = Buffer.byteLength(JSON.stringify(requests));
        return rpcSuccess(
          hostApi["thread.requests.list"].success.parse({
            threadId: input.threadId,
            requests,
            reviewedRevisions: Object.fromEntries(review),
            window: {
              byteCount,
              itemCount: requests.length,
              totalItems: requests.length,
              hasMore: false,
              nextBefore: null,
            },
          }),
        );
      });
    }
    if (input.requestId && (input.before !== undefined || input.limit !== undefined))
      throw new OpensteerError({
        code: "bad_request",
        message: "A targeted Request read cannot page",
      });
    const thread = await store.getThreadForOwner(input.threadId, ownerId);
    if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
    const reference = input.requestId
      ? await store.requests.referenceForOwner({
          ownerId,
          threadId: input.threadId,
          requestId: input.requestId,
        })
      : null;
    const requests = reference ? [reference.request] : [];
    const page = input.requestId
      ? {
          requests,
          reviewedRevisions:
            reference?.request.status === "pending"
              ? { [reference.request.id]: reference.revision }
              : {},
          window: {
            byteCount: Buffer.byteLength(JSON.stringify(requests)),
            hasMore: false,
            nextBefore: null,
            itemCount: requests.length,
            totalItems: requests.length,
          },
        }
      : await store.requests.originatingPendingPage({
          ...(input.before ? { before: input.before } : {}),
          limit: Math.min(input.limit ?? threadPageMaxItems, threadPageMaxItems),
          threadId: input.threadId,
        });
    return rpcSuccess(
      hostApi["thread.requests.list"].success.parse({ ...page, threadId: input.threadId }),
    );
  };
}
