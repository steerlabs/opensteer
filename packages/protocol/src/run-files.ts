import { RunIdSchema } from "@opensteer/core";
import { z } from "zod";
import { RunnerConnectionFenceSchema } from "./runner-identity.js";

/**
 * Files an agent's Run exchanges with an app on another Runner.
 *
 * Bytes never ride these frames: each side streams them through the Host's
 * one-use transfer route, and these frames only say which transfer and whose
 * Run. Everything here dies with the tool call that asked for it, so nothing
 * is replayed into a later execution.
 */
export const runFileMaxBytes = 2 * 1_024 * 1_024 * 1_024;
export const runFileMaxPerCall = 20;
export const runFileTransferContentType = "application/x-opensteer-run-file";
/** The file's name, percent-encoded, on an upload and on the download that relays it. */
export const runFileNameHeader = "x-opensteer-file-name";
export const runFileTransferPath = (id: string): string =>
  `/v1/runner/file-transfers/${encodeURIComponent(id)}`;

export const RunFileTransferSchema = z.strictObject({
  id: z.uuid(),
  token: z.string().min(32).max(128),
});
export type RunFileTransfer = z.infer<typeof RunFileTransferSchema>;

/** One live execution of one Run: a resumed Run is a different one. */
export const RunFileExecutionSchema = z.strictObject({
  bindingGeneration: z.number().int().positive(),
  runId: RunIdSchema,
});
export type RunFileExecution = z.infer<typeof RunFileExecutionSchema>;

const base = { ...RunnerConnectionFenceSchema.shape, requestId: z.uuid() };

export const HostRunFileRequestSchema = z.discriminatedUnion("type", [
  /** Fetch each transfer into this Run's file area and answer with the local paths. */
  z.strictObject({
    ...base,
    execution: RunFileExecutionSchema,
    transfers: z.array(RunFileTransferSchema).min(1).max(runFileMaxPerCall),
    type: z.literal("host.run-file.receive"),
  }),
  /** Check each path against this Run's own roots, then upload it to its transfer. */
  z.strictObject({
    ...base,
    execution: RunFileExecutionSchema,
    files: z
      .array(z.strictObject({ path: z.string().min(1).max(4_096), transfer: RunFileTransferSchema }))
      .min(1)
      .max(runFileMaxPerCall),
    type: z.literal("host.run-file.send"),
  }),
  z.strictObject({ ...base, type: z.literal("host.run-file.cancel") }),
]);
export type HostRunFileRequest = z.infer<typeof HostRunFileRequestSchema>;

export const RunnerRunFileResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ...base,
    ok: z.literal(true),
    /** Local to the Run's engine, in transfer order. Empty for `host.run-file.send`. */
    paths: z.array(z.string().min(1).max(4_096)).max(runFileMaxPerCall),
    type: z.literal("runner.run-file.result"),
  }),
  z.strictObject({
    ...base,
    message: z.string().min(1).max(500),
    ok: z.literal(false),
    type: z.literal("runner.run-file.result"),
  }),
]);
export type RunnerRunFileResult = z.infer<typeof RunnerRunFileResultSchema>;
