import { HarnessInstanceIdSchema } from "@opensteer/core";
import { z } from "zod";
import { AgentHomeSettingsFileViewSchema } from "./runner-agent-home-settings.js";

/** Clients gate the read on this Host capability. */
export const automaticModelsCapability = "automatic-models-v1" as const;
/** What runs a background job now: the first candidate. Null when nothing can. */
const InUseViewSchema = z
  .object({
    harnessInstanceId: HarnessInstanceIdSchema,
    accountDisplayName: z.string(),
    computerDisplayName: z.string(),
    modelDisplayName: z.string(),
    /** The effort it runs at, in the engine's words; absent from older Hosts and models without one. */
    effortDisplayName: z.string().nullable().optional(),
    usageLimited: z.boolean(),
  })
  .nullable();
export const AutomaticModelsViewSchema = z.object({
  file: AgentHomeSettingsFileViewSchema,
  excludedAccounts: z.array(HarnessInstanceIdSchema),
  naming: InUseViewSchema,
  light: InUseViewSchema,
  deep: InUseViewSchema,
});
export type AutomaticModelsView = z.infer<typeof AutomaticModelsViewSchema>;
