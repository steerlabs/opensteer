import type { DeploymentShape } from "@opensteer/core";
import { computerConnectionCommands } from "../computers/connection-commands.js";

/**
 * The command that joins a computer as the team's, built only from the image
 * the Host names for its own release. A Host with no published build names
 * none, and then there is no honest command to give.
 */
export function teamComputerCommand(input: {
  readonly deploymentShape: DeploymentShape;
  readonly hostOrigin: string;
  readonly team: string;
  readonly replaced: {
    readonly enrollmentId: string;
    readonly token: string;
    readonly runnerImage?: string | null | undefined;
  };
}):
  | { readonly kind: "command"; readonly text: string }
  | { readonly kind: "unavailable"; readonly text: string } {
  const image = input.replaced.runnerImage;
  if (!image)
    return {
      kind: "unavailable",
      text: `${input.team}’s server has no published Opensteer build to run on a computer, so there is no command to give yet. Whoever runs it needs a release build of the server.`,
    };
  return {
    kind: "command",
    text: computerConnectionCommands({
      deploymentShape: input.deploymentShape,
      enrollmentId: input.replaced.enrollmentId,
      hostOrigin: input.hostOrigin,
      name: `${input.team} computer`,
      runnerDistribution: null,
      runnerImage: image,
      token: input.replaced.token,
    }).container,
  };
}
