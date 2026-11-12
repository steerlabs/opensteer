import { withPersonalReadTransaction } from "./personal-transaction.js";
import "./connection.js";
import { publishedMessagePredicate } from "./message-visibility.js";
import {
  MessageIdSchema,
  OpensteerError,
  SequenceSchema,
  compareSequence,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { ThreadMessagePage } from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { DatabaseSchema } from "./schema.js";
import { messageFromRow } from "./thread-row-mappers.js";
import { boundedSerializedPrefix, serializedArrayBytes } from "./message-window.js";
const historyCursorSchema = z.strictObject({
  threadId: z.string(),
  sequence: SequenceSchema,
  query: z.string().nullable(),
});
export function encodeThreadHistoryCursor(
  threadId: ThreadId,
  sequence: import("@opensteer/core").Sequence,
  query?: string,
) {
  return Buffer.from(
    JSON.stringify({
      threadId,
      sequence,
      query: query?.trim() || null,
    }),
  ).toString("base64url");
}
export interface ThreadHistoryQuery {
  readonly threadId: ThreadId;
  readonly ownerId: UserId;
  readonly before?: string;
  readonly query?: string;
  readonly aroundMessageId?: z.infer<typeof MessageIdSchema>;
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

/** Published reports are visible before consumption; waiting work is not conversation history. */
export async function readThreadHistory(
  database: Kysely<DatabaseSchema>,
  input: ThreadHistoryQuery,
): Promise<ThreadMessagePage | null> {
  const limit = Math.min(100, Math.max(1, input.maxItems ?? 100));
  const maxBytes = Math.min(640 * 1024, Math.max(1, input.maxBytes ?? 640 * 1024));
  const search = input.query?.trim() || null;
  if (search && search.length > 256)
    throw new OpensteerError({
      code: "bad_request",
      message: "Search is limited to 256 characters",
    });
  if (input.aroundMessageId && (input.before || search))
    throw new OpensteerError({
      code: "bad_request",
      message: "An anchored read cannot also search or page",
    });
  const anchor = (() => {
    if (!input.before) return null;
    try {
      const parsed = historyCursorSchema.parse(
        JSON.parse(Buffer.from(input.before, "base64url").toString("utf8")),
      );
      if (parsed.threadId !== input.threadId || parsed.query !== search)
        throw new Error("different history");
      return parsed;
    } catch {
      throw new OpensteerError({
        code: "bad_request",
        message: "History cursor does not match this conversation and search",
      });
    }
  })();
  return withPersonalReadTransaction(
    database,
    async (transaction) => {
      const thread = await transaction
        .selectFrom("threads")
        .select("threads.id")
        .where("threads.id", "=", input.threadId)
        .executeTakeFirst();
      if (!thread) return null;
      let visible = transaction
        .selectFrom("messages")
        .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
        .where("messages.threadId", "=", input.threadId)
        .where(publishedMessagePredicate("threadInputs"));
      if (search)
        visible = visible.where(
          sql<boolean>`jsonb_to_tsvector('simple', jsonb_path_query_array(messages.content, '$[*] ? (@.type == "text").text'), '["string"]') @@ plainto_tsquery('simple', ${search})`,
        );
      const total = await visible
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow();
      const listed = visible.selectAll("messages").select("threadInputs.policy");
      let rows;
      if (input.aroundMessageId) {
        const target = await listed
          .where("messages.id", "=", input.aroundMessageId)
          .executeTakeFirst();
        if (!target)
          throw new OpensteerError({
            code: "not_found",
            message: "Message is unavailable in this conversation",
          });
        const [earlier, later] = await Promise.all([
          listed
            .where("messages.sequence", "<", target.sequence)
            .orderBy("messages.sequence", "desc")
            .limit(Math.floor((limit - 1) / 2))
            .execute(),
          listed
            .where("messages.sequence", ">", target.sequence)
            .orderBy("messages.sequence", "asc")
            .limit(Math.ceil((limit - 1) / 2))
            .execute(),
        ]);
        rows = [target, ...earlier, ...later];
      } else {
        const page = anchor ? listed.where("messages.sequence", "<", anchor.sequence) : listed;
        rows = await page.orderBy("messages.sequence", "desc").limit(limit).execute();
      }
      const window = boundedSerializedPrefix(
        rows.map(({ policy, ...row }) => ({
          ...messageFromRow(row),
          ...(row.addressedToUserId
            ? {
                addressedToUserId: row.addressedToUserId,
              }
            : {}),
          ...(policy
            ? {
                policy,
              }
            : {}),
        })),
        limit,
        maxBytes,
      );
      if (rows.length && !window.items.length)
        throw new OpensteerError({
          code: "bad_request",
          message: "History byte limit is too small for this message",
        });
      const messages = [...window.items].sort((a, b) => compareSequence(a.sequence, b.sequence));
      const oldest = messages[0];
      const earlier = oldest
        ? await visible
            .select("messages.id")
            .where("messages.sequence", "<", oldest.sequence)
            .limit(1)
            .executeTakeFirst()
        : undefined;
      return {
        messages,
        threadId: input.threadId,
        window: {
          threadId: input.threadId,
          byteCount: serializedArrayBytes(messages),
          itemCount: messages.length,
          totalItems: Number(total.count),
          hasMore: Boolean(earlier),
          nextBefore:
            oldest && earlier
              ? encodeThreadHistoryCursor(input.threadId, oldest.sequence, search ?? undefined)
              : null,
        },
      };
    },
    "repeatable read",
  );
}
