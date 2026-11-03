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
  access: "self",
  callers: ["run"] as const,
});
