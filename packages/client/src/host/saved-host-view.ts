import type { HostSnapshot } from "./client.js";
import { compareTaskOrder } from "./task-entries.js";
import { taskList } from "./task-list.js";
import {
  CanonicalOriginSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  IsoDateTimeSchema,
  MarkColorSchema,
  ThreadIdSchema,
  UserIdSchema,
  IconNameSchema,
} from "@opensteer/core";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { z } from "zod";

export const maximumSavedViewBytes = 1_048_576;
const utf8 = new TextEncoder();
const text = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine((value) => utf8.encode(value).byteLength <= bytes);
export const SavedViewScopeSchema = z.strictObject({
  schema: z.literal(1),
  epoch: z.number().int().positive(),
  hostIdentity: z.strictObject({
    deploymentId: DeploymentIdSchema,
    hostInstanceId: HostInstanceIdSchema,
    hostKeyFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u),
  }),
  loginId: z.uuid(),
  accountSource: z
    .strictObject({
      issuer: CanonicalOriginSchema,
      subject: ControlPlaneAccountIdSchema,
      loginId: z.uuid(),
    })
    .optional(),
});
export type SavedViewScope = z.infer<typeof SavedViewScopeSchema>;
export const SavedTaskSchema = z.strictObject({
  id: ThreadIdSchema,
  title: text(512),
  glyph: z.strictObject({
    icon: IconNameSchema.nullable(),
    color: MarkColorSchema.nullable(),
  }),
  group: z.enum(["working", "ready", "done"]),
});
export type SavedTask = z.infer<typeof SavedTaskSchema>;
export const SavedHostViewSchema = SavedViewScopeSchema.extend({
  userId: UserIdSchema,
  capturedAt: IsoDateTimeSchema,
  tasks: z
    .array(SavedTaskSchema)
    .max(50)
    .refine((tasks) => new Set(tasks.map(({ id }) => id)).size === tasks.length)
    .optional(),
}).refine((view) => utf8.encode(JSON.stringify(view)).byteLength <= maximumSavedViewBytes - 37);
export type SavedHostView = z.infer<typeof SavedHostViewSchema>;

/** Fixed field order: expected local authority constructs AAD, never file headers. */
export function savedViewScopeKey(scope: SavedViewScope): string {
  return JSON.stringify(
    SavedViewScopeSchema.parse({
      schema: scope.schema,
      epoch: scope.epoch,
      hostIdentity: scope.hostIdentity,
      loginId: scope.loginId,
      ...(scope.accountSource ? { accountSource: scope.accountSource } : {}),
    }),
  );
}
export interface SavedViewStore {
  load(scope: SavedViewScope, isCurrent: () => boolean): Promise<SavedHostView | null>;
  write(view: SavedHostView, isCurrent: () => boolean): Promise<void>;
  invalidate(deploymentId: string): Promise<void>;
}

/** Volatile accepted answers for this viewer; never persisted or used as read authority. */
export interface SavedViewReadiness {
  readonly tasksReady: boolean;
}
export function emptySavedViewReadiness(): SavedViewReadiness {
  return { tasksReady: false };
}

/** Reuse the shared list's membership/order, but retain no state, attention or action. */
export function projectSavedTasks(snapshot: HostSnapshot): SavedTask[] {
  const list = taskList({
    ...snapshot,
    waitingRequests: [],
    requests: {},
    runQueue: [],
    browserSessions: [],
    machines: [],
  });
  const groups = ["working", "ready", "done"] as const;
  const recent = new Set(
    groups
      .flatMap((group) => list[group])
      .sort((a, b) =>
        compareTaskOrder(
          { askedAt: a.askedAt, id: a.threadId },
          { askedAt: b.askedAt, id: b.threadId },
        ),
      )
      .slice(0, 50)
      .map(({ threadId }) => threadId),
  );
  return groups.flatMap((group) =>
    list[group]
      .filter(({ threadId }) => recent.has(threadId))
      .map((row) =>
        SavedTaskSchema.parse({
          id: row.threadId,
          title: boundedSavedText(row.title, 512),
          glyph: { icon: row.icon, color: row.color ?? null },
          group,
        }),
      ),
  );
}

function boundedSavedText(value: string, bytes: number, tail = false): string {
  if (utf8.encode(value).byteLength <= bytes) return value;
  const characters = Array.from(value);
  const note = tail ? "Earlier text omitted\n" : "";
  let low = 0,
    high = Math.min(characters.length, bytes);
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const candidate =
      note + (tail ? characters.slice(-count) : characters.slice(0, count)).join("");
    if (utf8.encode(candidate).byteLength <= bytes) low = count;
    else high = count - 1;
  }
  return note + (tail ? characters.slice(-low) : characters.slice(0, low)).join("");
}

/** Mock mode exercises the same controller and format without a production key or file namespace. */
export function createMemorySavedViews(): SavedViewStore {
  const views = new Map<string, SavedHostView>();
  return {
    async load(scope, isCurrent) {
      const view = views.get(scope.hostIdentity.deploymentId);
      return isCurrent() && view && savedViewScopeKey(view) === savedViewScopeKey(scope)
        ? structuredClone(view)
        : null;
    },
    async write(view, isCurrent) {
      const parsed = SavedHostViewSchema.parse(view);
      if (isCurrent()) views.set(view.hostIdentity.deploymentId, structuredClone(parsed));
    },
    async invalidate(id) {
      views.delete(id);
    },
  };
}
