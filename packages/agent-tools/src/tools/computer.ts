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
    "Ask in Needs you to enable device access. Use machineId and capability from device-access-off or the owned-device inventory. Never ask for offline devices or re-ask after Not now in this task. Fulfillment starts a new Run; finer permissions still apply.",
  input: z.strictObject({
    machineId: RunnerIdSchema.describe("Device id from refusal or inventory."),
    access: z.enum(["browser", "apps", "files"]),
    reason: z.string().trim().min(1).max(500).describe("Why this task needs that access."),
    operationKey: OperationKeySchema.optional(),
  }),
  output: RequestCreationOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
