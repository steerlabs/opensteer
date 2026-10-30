import {
  CanonicalOriginSchema,
  DeploymentIdSchema,
  HostInstanceIdSchema,
  IsoDateTimeSchema,
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
