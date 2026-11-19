import type { ThreadId, UserId } from "@opensteer/core";
import type { Kysely } from "kysely";
import {
  buildPersonalDetailSnapshot,
  buildPersonalShellSnapshot,
} from "./personal-snapshot-store.js";
import {
  readPersonalScopeCut,
  type PersonalReadScope,
  type PersonalResumeCursor,
} from "./personal-sync-store.js";
import type { DatabaseSchema } from "./schema.js";

export function readPersonalShellSnapshot(
  database: Kysely<DatabaseSchema>,
  input: {
    viewerId: UserId;
    selectedThreadId?: ThreadId;
    cursor?: PersonalResumeCursor;
  },
) {
  return readPersonalScopeCut(database, {
    viewerId: input.viewerId,
    scope: { kind: "shell" },
    ...(input.cursor ? { cursor: input.cursor } : {}),
    snapshot: (tx, state) =>
      buildPersonalShellSnapshot(tx, state, input.viewerId, input.selectedThreadId),
  });
}

export function readPersonalDetailSnapshot(
  database: Kysely<DatabaseSchema>,
  input: {
    viewerId: UserId;
    scope: Exclude<PersonalReadScope, { kind: "shell" }>;
    anchorItemId?: string;
    cursor?: PersonalResumeCursor;
  },
) {
  return readPersonalScopeCut(database, {
    viewerId: input.viewerId,
    scope: input.scope,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    snapshot: (tx, state) =>
      buildPersonalDetailSnapshot(tx, state, input.viewerId, input.scope, input.anchorItemId),
  });
}
