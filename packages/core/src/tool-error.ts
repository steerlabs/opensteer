import { z } from "zod";
export const ToolErrorSchema = z.strictObject({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  next: z.string().max(2000).nullable(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;
export const ToolFailureSchema = z.strictObject({ error: ToolErrorSchema });
export type ToolFailure = z.infer<typeof ToolFailureSchema>;
/** Why a visible target can't be used now, in a tool failure's shape; `next` is never empty. */
export const BlockedSchema = z.strictObject({
  code: ToolErrorSchema.shape.code,
  message: ToolErrorSchema.shape.message,
  next: z.string().min(1).max(2000),
});
export type Blocked = z.infer<typeof BlockedSchema>;

export class ToolBlockedError extends Error {
  readonly blocked: Blocked;

  constructor(blocked: Blocked) {
    super(blocked.message);
    this.blocked = blocked;
  }
}
