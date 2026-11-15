import { z } from "zod";
export const ToolErrorSchema = z.strictObject({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  next: z.string().max(2000).nullable(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;
export const ToolFailureSchema = z.strictObject({ error: ToolErrorSchema });
export type ToolFailure = z.infer<typeof ToolFailureSchema>;
