import { z } from "zod";

export const AuthMethodSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/),
  kind: z.literal("computer"),
  label: z.string().min(1).max(80),
});
export const AuthMethodViewSchema = z.object(AuthMethodSchema.shape);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;
