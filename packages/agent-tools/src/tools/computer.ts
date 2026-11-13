import { RunnerIdSchema } from "@opensteer/core";
import { defineAgentTool } from "../registry.js";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import { RequestCreationOutputSchema } from "./outputs.js";
export const machine_full_disk_access_request = defineAgentTool({
  name: "machine_full_disk_access_request",
  title: "Request Mac file access",
  description:
    "Ask the person at a Mac to enable Full Disk Access when authorized SSH work needs protected files and the computers note says it is off. Run-only. Returns a Request, resolved when macOS reports access or the person declines.",
  input: z
    .strictObject({
      computer: z
        .string()
        .trim()
        .min(1)
        .max(63)
        .describe("Exact Mac alias from the computers note."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Protected files this task needs and why."),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: RequestCreationOutputSchema,
  access: "write",
  callers: ["run"] as const,
});

export const device_access_request = defineAgentTool({
  name: "device_access_request",
  title: "Request device access",
  description:
    "After device-access-off, ask the person in Needs you to turn on that device's access. Use its machineId and capability as access. Disabled devices also appear in the owned-device inventory. Do not call for offline devices or re-ask after Not now in the same task. Fulfillment continues in a new Run with rebuilt routes; per-app, profile or OS authorization may still be needed.",
  input: z.strictObject({
    machineId: RunnerIdSchema.describe(
      "Stable device id from the refusal or owned-device inventory.",
    ),
    access: z.enum(["browser", "apps", "files"]),
    reason: z.string().trim().min(1).max(500).describe("Why this task needs that access."),
    operationKey: OperationKeySchema.optional(),
  }),
  output: RequestCreationOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
