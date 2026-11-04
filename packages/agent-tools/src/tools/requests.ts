import { defineAgentTool } from "../registry.js";
import { RequestIdSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema, CursorSchema } from "./inputs.js";
import { RequestListOutputSchema, RequestWithdrawOutputSchema } from "./outputs.js";
export const request_list = defineAgentTool({
  name: "request_list",
  title: "Inspect Requests",
  description:
    "Inspect outgoing Thread/incoming Workspace Requests, including pending/terminal status, newest first with a paging window. Never poll for approval; pending is not permission.",
  input: z.strictObject({
    before: CursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: RequestListOutputSchema,
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
