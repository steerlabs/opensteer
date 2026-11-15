import { OpensteerError, type ReferenceId, type UserId } from "@opensteer/core";
import type { LegacyDatabaseSchema as DatabaseSchema, OpensteerStore } from "@opensteer/database";
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
import { requireSession } from "../integrations/integration-rpc-context.js";

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
  store: Pick<OpensteerStore, "getThreadForOwner" | "requests">,
) {
  return async (
    input: z.output<(typeof hostApi)["thread.requests.list"]["payload"]>,
    context: HostApiServerContext,
  ) => {
    const ownerId = requireSession(context).user.id;
    if (input.requestId && (input.before !== undefined || input.limit !== undefined))
      throw new OpensteerError({
        code: "bad_request",
        message: "A targeted Request read cannot page",
      });
    const thread = await store.getThreadForOwner(input.threadId, ownerId);
    if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
    const request = input.requestId
      ? await store.requests.referenceForOwner({
          ownerId,
          threadId: input.threadId,
          requestId: input.requestId,
        })
      : null;
    const requests =
      request && (request.kind !== "device.access" || input.deviceAccessRequests === "include")
        ? [request]
        : [];
    const page = input.requestId
      ? {
          requests,
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
          ...(input.deviceAccessRequests
            ? { deviceAccessRequests: input.deviceAccessRequests }
            : {}),
          threadId: input.threadId,
        });
    return rpcSuccess(
      hostApi["thread.requests.list"].success.parse({ ...page, threadId: input.threadId }),
    );
  };
}
