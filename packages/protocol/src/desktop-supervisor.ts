import { z } from "zod";
import {
  PersonalRemoteAdministrationOperationSchema,
  PersonalRemoteExecutorProgressSchema,
} from "./personal-remote-access.js";
import {
  DesktopUpdateStateSchema,
  DesktopUpdateOperationSchema,
  DesktopUpdatePhaseSchema,
} from "./maintenance.js";

const messageId = z.string().uuid();
export const DesktopSupervisorInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    messageId,
    incarnationId: z.string().uuid(),
    state: DesktopUpdateStateSchema,
  }),
  z.object({ type: z.literal("desktop-update.state"), state: DesktopUpdateStateSchema }),
  z.object({
    type: z.literal("remote-access.progress"),
    messageId,
    progress: PersonalRemoteExecutorProgressSchema,
  }),
  z.object({
    type: z.literal("desktop-update.progress"),
    messageId,
    operationId: z.string().uuid(),
    state: DesktopUpdatePhaseSchema.exclude(["pending"]),
    fromVersion: z.string().min(1).max(64).nullable(),
    targetVersion: z.string().min(1).max(64).nullable(),
    detail: DesktopUpdateOperationSchema.shape.detail,
  }),
]);
export type DesktopSupervisorInput = z.infer<typeof DesktopSupervisorInputSchema>;
export type DesktopUpdateProgress = Extract<
  DesktopSupervisorInput,
  { type: "desktop-update.progress" }
>;
export const DesktopSupervisorOutputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ack"), messageId, accepted: z.boolean() }),
  z.object({
    type: z.literal("remote-access.operation"),
    operation: PersonalRemoteAdministrationOperationSchema,
  }),
  z.object({
    type: z.literal("desktop-update.operation"),
    operation: DesktopUpdateOperationSchema,
  }),
]);
export type DesktopSupervisorOutput = z.infer<typeof DesktopSupervisorOutputSchema>;
