import type { HostSnapshot, MessageEntry } from "./client.js";
import { taskList } from "./task-list.js";
import { visibleTranscript } from "./transcript.js";
import {
  groupTranscriptEntries,
  conversationRows,
  conversationTurn,
} from "./agent-activity-model.js";
import {
  CanonicalOriginSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  IsoDateTimeSchema,
  MessageIdSchema,
  MarkColorSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkspaceIconNameSchema,
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
export const SavedChatSchema = z
  .strictObject({
    workspaceId: WorkspaceIdSchema,
    // A known Main with no Home is an answer too; an omitted home is unknown.
    threadId: ThreadIdSchema.nullable(),
    messages: z
      .array(z.strictObject({ voice: z.enum(["mine", "input", "agent"]), text: text(65_536) }))
      .max(200),
  })
  .refine((home) => home.threadId !== null || home.messages.length === 0)
  .refine((home) => utf8.encode(JSON.stringify(home)).byteLength <= 262_144);
export type SavedChat = z.infer<typeof SavedChatSchema>;
export const SavedTaskSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  id: ThreadIdSchema,
  title: text(512),
  glyph: z.strictObject({
    icon: WorkspaceIconNameSchema.nullable(),
    color: MarkColorSchema.nullable(),
  }),
  group: z.enum(["working", "ready", "done"]),
});
export type SavedTask = z.infer<typeof SavedTaskSchema>;
export const SavedHostViewSchema = SavedViewScopeSchema.extend({
  userId: UserIdSchema,
  capturedAt: IsoDateTimeSchema,
  home: SavedChatSchema.optional(),
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
  readonly home:
    | { readonly status: "unknown" }
    | { readonly status: "absent"; readonly workspaceId: string }
    | {
        readonly status: "window";
        readonly workspaceId: string;
        readonly threadId: string;
        readonly latest: boolean;
      };
  readonly workspaceRefusal: number;
}
export function emptySavedViewReadiness(): SavedViewReadiness {
  return { tasksReady: false, home: { status: "unknown" }, workspaceRefusal: 0 };
}

/** Text-only projection of the accepted latest window. Synthetic stream IDs never qualify. */
export function projectSavedHome(snapshot: HostSnapshot): SavedChat | undefined {
  const answer = snapshot.savedViewReadiness?.home;
  if (!answer || answer.status === "unknown") return undefined;
  if (answer.status === "absent")
    return SavedChatSchema.parse({ workspaceId: answer.workspaceId, threadId: null, messages: [] });
  if (
    !answer.latest ||
    answer.threadId !== snapshot.homeThreadId ||
    answer.workspaceId !== snapshot.homeWorkspaceId
  )
    return undefined;
  const entries = (snapshot.transcripts[answer.threadId] ?? []).filter(
    (entry) =>
      entry.kind !== "message" ||
      (entry.published !== false &&
        entry.streaming !== true &&
        entry.messageKind !== "continuation" &&
        MessageIdSchema.safeParse(entry.id).success),
  );
  const rows = conversationRows(
    groupTranscriptEntries(visibleTranscript(entries, null, { conversation: true })),
    { live: false, atComputer: () => false },
  );
  const messages: SavedChat["messages"] = [];
  for (const { group } of rows) {
    const message: MessageEntry | null =
      group.kind === "message"
        ? group.entry
        : group.kind === "turn"
          ? conversationTurn(group.turn).reply
          : null;
    if (!message || message.body.trim() === "") continue;
    messages.push({
      voice:
        message.messageKind === "assistant"
          ? "agent"
          : message.author.kind === "human" && message.author.userId === snapshot.user?.id
            ? "mine"
            : "input",
      text: boundedSavedText(message.body, 65_536, true),
    });
  }
  const home = {
    workspaceId: answer.workspaceId,
    threadId: answer.threadId,
    messages: messages.slice(-200),
  };
  while (home.messages.length && utf8.encode(JSON.stringify(home)).byteLength > 262_144)
    home.messages.shift();
  return SavedChatSchema.parse(home);
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
      .sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.threadId.localeCompare(b.threadId),
      )
      .slice(0, 50)
      .map(({ threadId }) => threadId),
  );
  return groups.flatMap((group) =>
    list[group]
      .filter(({ threadId }) => recent.has(threadId))
      .map((row) =>
        SavedTaskSchema.parse({
          workspaceId: row.workspaceId,
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
