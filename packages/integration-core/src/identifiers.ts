import { z } from "zod";

export const IntegrationProviderSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u);
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;
