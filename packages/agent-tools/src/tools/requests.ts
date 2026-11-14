import { defineAgentTool } from "../registry.js";
import { RequestIdSchema, RequestResponseSchema } from "@opensteer/core";
import { z } from "zod";
import { CursorSchema } from "./inputs.js";
import { RequestListOutputSchema, RequestWithdrawOutputSchema } from "./outputs.js";
export const opensteer_request_list = defineAgentTool({
  name: "opensteer_request_list",
  title: "List Requests",
  description: "List visible Requests. A pending Request is not permission.",
  input: z.strictObject({
    cursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: RequestListOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_request_read = defineAgentTool({
  name: "opensteer_request_read",
  title: "Read a Request",
  description: "Read a Request and its revision before answering an ordinary question.",
  input: z.strictObject({ requestId: RequestIdSchema }),
  output: RequestWithdrawOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_request_answer = defineAgentTool({
  name: "opensteer_request_answer",
  title: "Answer a Request",
  description:
    "Answer an ordinary question using the revision you read. Permission approvals require the person.",
  input: z.strictObject({
    requestId: RequestIdSchema,
    response: RequestResponseSchema,
    expectedRevision: z.string().min(1).max(128),
  }),
  output: RequestWithdrawOutputSchema,
  access: "write",
  callers: ["run"] as const,
});
export const opensteer_request_withdraw = defineAgentTool({
  name: "opensteer_request_withdraw",
  title: "Withdraw a Request",
  description: "Withdraw a pending Request this task originated.",
  input: z.strictObject({ requestId: RequestIdSchema }),
  output: RequestWithdrawOutputSchema,
  access: "write",
  callers: ["run"] as const,
  destructive: true,
});
