import { z } from "zod";

/**
 * The local Runner's credentials, posted to its utility process rather than
 * placed in its environment.
 *
 * A child's startup environment stays readable to every process of the same
 * user for as long as the child runs, so the enrollment token and the bridge
 * tokens travel over the utility process's own message port, the one channel
 * only this app holds. They keep their variable names, so the Runner parses
 * them with the rules it applies to any other source.
 */
export const RunnerWorkerSecretsMessageSchema = z.strictObject({
  secrets: z.record(z.string(), z.string()),
  type: z.literal("runner.worker.secrets"),
});
export type RunnerWorkerSecretsMessage = z.infer<typeof RunnerWorkerSecretsMessageSchema>;

export function runnerWorkerSecretsMessage(
  secrets: Readonly<Record<string, string>>,
): RunnerWorkerSecretsMessage {
  return { secrets: { ...secrets }, type: "runner.worker.secrets" };
}

/** Asks the worker's Runner to look for engines now rather than at its next heartbeat. */
export const RunnerWorkerEnginesRecheckMessageSchema = z.strictObject({
  type: z.literal("runner.worker.engines.recheck"),
});
export const runnerWorkerEnginesRecheckMessage: z.infer<
  typeof RunnerWorkerEnginesRecheckMessageSchema
> = { type: "runner.worker.engines.recheck" };

export const RunnerWorkerPowerMessageSchema = z.strictObject({
  type: z.enum(["runner.worker.power.sleeping", "runner.worker.power.awake"]),
});
export type RunnerWorkerPowerMessage = z.infer<typeof RunnerWorkerPowerMessageSchema>;

/** The person stopped one Run from this Mac's menu bar; the worker's Runner interrupts it. */
export const RunnerWorkerStopRunMessageSchema = z.strictObject({
  runId: z.string().min(1).max(200),
  type: z.literal("runner.worker.stop-run"),
});

/** One Run the worker's Runner is doing work for, as this Mac may show it. */
export const RunnerWorkerRunSchema = z.strictObject({
  runId: z.string().min(1).max(200),
  startedAt: z.iso.datetime(),
  purpose: z.enum(["task", "voice", "background-job"]),
  engine: z.string().min(1).max(200),
});
export type RunnerWorkerRun = z.infer<typeof RunnerWorkerRunSchema>;

/** Every Run the worker's Runner is doing work for, sent each time that changes. */
export const RunnerWorkerActivityMessageSchema = z.strictObject({
  runs: z.array(RunnerWorkerRunSchema).max(256),
  type: z.literal("runner.worker.activity"),
});
