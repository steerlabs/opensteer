import { defineAgentTool } from "../registry.js";
import { RequestIdSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema, CursorSchema } from "./inputs.js";
import { RequestListOutputSchema, RequestWithdrawOutputSchema } from "./outputs.js";
export const pending_request = defineAgentTool({
  name: "pending_request",
  title: "Inspect Requests",
  description:
    "Inspect reachable Requests. list: outgoing Thread/incoming Workspace Requests, newest first. read: one requestId, with status and safe details. Pending is not permission; this tool cannot answer or approve.",
  input: z
    .strictObject({
      action: z.enum(["list", "read"]).default("list"),
      requestId: RequestIdSchema.optional(),
      before: CursorSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .superRefine((input, context) => {
      if ((input.action === "read") !== !!input.requestId)
        context.addIssue({ code: "custom", message: "read requires requestId; list omits it" });
      if (input.action === "read" && input.before)
        context.addIssue({ code: "custom", message: "before is for list" });
    }),
  output: z.union([RequestListOutputSchema, RequestWithdrawOutputSchema]),
  access: "read",
  callers: ["run", "program", "connection"] as const,
});

export const request_withdraw = defineAgentTool({
  name: "request_withdraw",
  title: "Withdraw a Request",
  description:
    "Withdraw a pending Request this Thread originated and no longer needs. Run-only; terminal/foreign Requests refused. Returns the withdrawn Request.",
  input: z
    .strictObject({ requestId: RequestIdSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: RequestWithdrawOutputSchema,
  access: "write",
  callers: ["run"] as const,
  destructive: true,
});
