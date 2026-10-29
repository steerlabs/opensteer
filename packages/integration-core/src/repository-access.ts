import { z } from "zod";

export const IntegrationRepositoryAccessViewSchema = z.object({
  installationUrl: z.url().nullable(),
  installations: z
    .array(
      z.object({
        id: z.string().min(1),
        accountLogin: z.string().min(1),
        repositorySelection: z.enum(["all", "selected"]),
        repositoryCount: z.number().int().nonnegative(),
        configureUrl: z.url(),
        suspended: z.boolean(),
      }),
    )
    .max(1_000),
  ready: z.boolean(),
});

export type IntegrationRepositoryAccess = z.infer<typeof IntegrationRepositoryAccessViewSchema>;
