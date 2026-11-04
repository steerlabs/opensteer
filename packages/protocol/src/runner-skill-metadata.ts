import { z } from "zod";
import { IsoDateTimeSchema } from "@opensteer/core";
import { LocalWorkspaceBindingRefSchema, WorkspaceStorageFenceSchema } from "./workspace-local.js";
const name = z.string().min(1).max(120);
// Complete metadata replacement from the current authenticated storage owner. No paths or bodies.
export const RunnerSkillMetadataReportSchema = z.strictObject({
  ...WorkspaceStorageFenceSchema.shape,
  type: z.literal("runner.skills.report"),
  binding: LocalWorkspaceBindingRefSchema,
  scanSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scannedAt: IsoDateTimeSchema,
  result: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("complete"),
      skills: z
        .array(
          z.strictObject({
            fullName: name,
            description: z.string().max(320),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        )
        .max(64),
      warnings: z.array(z.enum(["invalid-metadata", "symlink", "limit-exceeded"])).max(3),
    }),
    z.strictObject({ status: z.literal("failed"), reason: z.enum(["unavailable", "unreadable"]) }),
  ]),
});
export type RunnerSkillMetadataReport = z.infer<typeof RunnerSkillMetadataReportSchema>;
