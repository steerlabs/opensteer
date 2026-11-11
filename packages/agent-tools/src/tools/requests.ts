import { defineAgentTool } from "../registry.js";
import { RequestIdSchema, RequestResponseSchema } from "@opensteer/core";

import { z } from "zod";

import { OperationKeySchema, CursorSchema } from "./inputs.js";
import { RequestListOutputSchema, RequestWithdrawOutputSchema } from "./outputs.js";
export const pending_request = defineAgentTool({
  name: "pending_request",
  title: "Read or answer Requests",
  description:
    "Inspect personal Requests. list: Requests from tasks and background jobs, newest first. read: one requestId, with status and ordinary question details. respond: answer an ordinary question using its response shape and expectedRevision from read; Run-only, with write access to its conversation. This cannot approve a permission request. Pending is not permission.",
  input: z
    .strictObject({
      action: z.enum(["list", "read", "respond"]).default("list"),
      requestId: RequestIdSchema.optional(),
      response: RequestResponseSchema.optional(),
      expectedRevision: z.string().min(1).max(128).optional(),
      operationKey: OperationKeySchema.optional(),
      before: CursorSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .superRefine((input, context) => {
      if ((input.action !== "list") !== !!input.requestId)
        context.addIssue({
          code: "custom",
          message: "read and respond require requestId; list omits it",
        });
      if (input.action !== "list" && input.before)
        context.addIssue({ code: "custom", message: "before is for list" });
      if (
        input.action === "respond"
          ? !input.response || !input.expectedRevision
          : input.response !== undefined || input.expectedRevision !== undefined
      )
        context.addIssue({
          code: "custom",
          message: "respond requires response and expectedRevision; other actions omit them",
        });
    }),
  output: z.union([RequestListOutputSchema, RequestWithdrawOutputSchema]),
  access: "write",
  readsOnly: (input) => input.action !== "respond",
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
