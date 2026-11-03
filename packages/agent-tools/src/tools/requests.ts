import { defineAgentTool } from "../registry.js";
import { RequestIdSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema, CursorSchema } from "./inputs.js";
import { RequestListOutputSchema, RequestWithdrawOutputSchema } from "./outputs.js";
export const request_list = defineAgentTool({
  name: "request_list",
  title: "List Requests",
  description:
    "To inspect this Thread's outgoing or this Workspace's incoming Requests, use request_list. Includes pending and terminal states, newest first; follow the cursor.",
  input: z.strictObject({
    before: CursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: RequestListOutputSchema,
  access: "read",
  callers: ["run", "program"] as const,
});

export const request_withdraw = defineAgentTool({
  name: "request_withdraw",
  title: "Withdraw Request",
  description:
    "When this Thread no longer needs a pending Request it originated, withdraw it with requestId. Terminal and foreign Requests are rejected.",
  input: z
    .strictObject({ requestId: RequestIdSchema })
    .safeExtend({ operationKey: OperationKeySchema.optional() }),
  output: RequestWithdrawOutputSchema,
  access: "self",
  callers: ["run"] as const,
  destructive: true,
});
