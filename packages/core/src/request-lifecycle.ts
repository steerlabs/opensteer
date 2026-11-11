import { z } from "zod";

export const RequestCancellationReasonSchema = z.enum([
  "run-ended",
  "process-lost",
  "source-closed",
  // Shared Done puts a task away using the reason released readers know.
  "thread-archived",
  "workspace-deleted",
  "membership-revoked",
  "resource-deleted",
  "authority-revoked",
]);

export const ProjectRequestCancellationReasonSchema = RequestCancellationReasonSchema.or(
  z.literal("no-eligible-manager"),
);
