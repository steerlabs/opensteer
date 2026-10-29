import { z } from "zod";
import { ThreadIdSchema } from "./ids.js";
import { ThreadTitleSchema } from "./thread-title.js";
import { WorkspaceIconNameSchema } from "./workspace-icons.js";

/**
 * What an agent may change about a task: the person's own controls, with the
 * same effect. One flat object rather than a union, because engines require an
 * object at the top of a tool's input schema.
 */
export const ThreadWriteInputSchema = z
  .strictObject({
    action: z.enum(["rename", "set_icon", "done", "reopen"]),
    threadId: ThreadIdSchema.optional(),
    title: ThreadTitleSchema.optional(),
    icon: WorkspaceIconNameSchema.nullable().optional(),
  })
  .superRefine((input, context) => {
    if ((input.action === "rename") !== (input.title !== undefined)) {
      context.addIssue({ code: "custom", message: "rename takes title; no other action does" });
    }
    if ((input.action === "set_icon") !== (input.icon !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "set_icon takes icon (null for the default); no other action does",
      });
    }
  });
export type ThreadWriteInput = z.infer<typeof ThreadWriteInputSchema>;
