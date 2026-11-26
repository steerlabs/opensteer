import { z } from "zod";
import { AgentOperationEndingSchema } from "./agent-operation-endings.js";
import { AgentOperationIdSchema, ThreadIdSchema } from "./ids.js";
export const ToolErrorSchema = z.strictObject({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  next: z.string().max(2000).nullable(),
  /**
   * The Device an asleep or stopped refusal is about, for a caller allowed to
   * know it. Structured only: the sentence an agent reads does not change.
   */
  device: z
    .strictObject({ id: z.string().min(1).max(100), name: z.string().min(1).max(200) })
    .optional(),
});
export const ToolErrorViewSchema = z.object({
  ...ToolErrorSchema.shape,
  device: z.object(ToolErrorSchema.shape.device.unwrap().shape).optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;
export const ToolFailureSchema = z.strictObject({
  error: ToolErrorSchema,
  taskId: ThreadIdSchema.optional(),
  operationId: AgentOperationIdSchema.optional(),
  status: z.enum(["refused", "failed", "unknown"]).optional(),
  ending: AgentOperationEndingSchema.optional(),
});
export type ToolFailure = z.infer<typeof ToolFailureSchema>;
export type ToolFailureReceipt = Required<Pick<ToolFailure, "taskId" | "operationId">> &
  Pick<ToolFailure, "status" | "ending">;
/** Why a visible target can't be used now, in a tool failure's shape; `next` is never empty. */
export const BlockedSchema = z.strictObject({
  code: ToolErrorSchema.shape.code,
  message: ToolErrorSchema.shape.message,
  next: z.string().min(1).max(2000),
});
export type Blocked = z.infer<typeof BlockedSchema>;

export class ToolBlockedError extends Error {
  readonly blocked: Blocked;
  readonly receipt: ToolFailureReceipt | undefined;

  constructor(blocked: Blocked, receipt?: ToolFailureReceipt) {
    super(blocked.message);
    this.blocked = blocked;
    this.receipt = receipt;
  }
}
