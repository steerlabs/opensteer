import { defineAgentTool } from "../registry.js";
import { RequestIdSchema, RequestResponseSchema } from "@opensteer/core";
import { z } from "zod";
import { CursorSchema } from "./inputs.js";
import { RequestListOutputSchema, RequestWithdrawOutputSchema } from "./outputs.js";
export const opensteer_request_list = defineAgentTool({
  name: "opensteer_request_list",
  title: "List Requests",
  description:
    "List Requests from tasks and background jobs, newest first. A pending Request is not permission. Mention returned items by their `link`, verbatim.",
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
  description:
    "Read one Request's status, its ordinary question details and its revision before answering it. Mention returned items by their `link`, verbatim.",
  input: z.strictObject({ requestId: RequestIdSchema }),
  output: RequestWithdrawOutputSchema,
  access: "read",
  callers: ["run", "program", "connection"] as const,
});
export const opensteer_request_answer = defineAgentTool({
  name: "opensteer_request_answer",
  title: "Answer a Request",
  description:
    "Answer an ordinary question with its response shape and the expectedRevision you read; this needs write access to the task that asked. It never approves a permission Request; approvals are the person's.",
  input: z.strictObject({
    requestId: RequestIdSchema,
    response: RequestResponseSchema,
    expectedRevision: z.string().min(1).max(128),
  }),
  output: RequestWithdrawOutputSchema,
  access: "write",
  callers: ["run", "program"] as const,
});
export const opensteer_request_withdraw = defineAgentTool({
  name: "opensteer_request_withdraw",
  title: "Withdraw a Request",
  description:
    "Withdraw a pending Request this task originated and no longer needs. Finished Requests and Requests from other tasks are refused.",
  input: z.strictObject({ requestId: RequestIdSchema }),
  output: RequestWithdrawOutputSchema,
  access: "write",
  callers: ["run", "program"] as const,
  destructive: true,
});
