import {
  computerConnectionCommands as buildCommands,
  runnerDistributionPrefix,
  runnerImageReference,
} from "@opensteer/client/computers";
export { runnerDistributionPrefix, runnerImageReference } from "@opensteer/client/computers";
const revision =
  import.meta.env.OPENSTEER_RUNNER_SOURCE_REVISION || import.meta.env.OPENSTEER_SOURCE_REVISION;
export const runnerImage = runnerImageReference(
  revision,
  import.meta.env.OPENSTEER_IMAGE_REGISTRY || "opensteer",
);
export const runnerDistribution = runnerDistributionPrefix(
  import.meta.env.OPENSTEER_RUNNER_ARTIFACT_BASE_URL,
  revision,
);
export function computerConnectionCommands(input: Parameters<typeof buildCommands>[0]) {
  return buildCommands({ ...input, runnerImage });
}
