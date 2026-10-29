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
