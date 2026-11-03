import { defineAgentTool } from "../registry.js";

import { z } from "zod";

import { OperationKeySchema } from "./inputs.js";
import { RequestCreationOutputSchema } from "./outputs.js";
export const machine_full_disk_access_request = defineAgentTool({
  name: "machine_full_disk_access_request",
  title: "Request Full Access on a Mac",
  description:
    "Request macOS Full Disk Access when SSH work needs protected files and the current computers note says access is off. Copy that Mac's alias into computer and explain which files the work needs. The person approves at that Mac; the Request resolves when macOS reports the grant or the person declines.",
  input: z
    .strictObject({
      computer: z
        .string()
        .trim()
        .min(1)
        .max(63)
        .describe("Copy the alias from the other-computers note."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Tell the person what the task needs to open."),
    })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: RequestCreationOutputSchema,
  access: "self",
  callers: ["run"] as const,
});
