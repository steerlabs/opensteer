import type { NativeOAuthManager } from "@opensteer/client/auth";
import type { DeploymentConnection } from "@opensteer/client/connections";
import type { PersonalSessionStore } from "./personal-session-store.js";

/**
 * What this phone can present to one Deployment.
 *
 * Two questions, deliberately separate. `authorization` is asked when a request
 * is about to go out and may refresh an access token on the way; `held` is
 * asked to draw a row and must never reach the network, because a list of
 * twenty places would otherwise become twenty token refreshes every time the
 * catalog changed.
 */
export interface DeploymentCredentials {
  authorization(connection: DeploymentConnection): Promise<string | null>;
  held(connection: DeploymentConnection): Promise<boolean>;
  viewLoginId?(connection: DeploymentConnection): Promise<string | undefined>;
}

/**
 * The real answer: a self-hosted Host issues its own OAuth bearer, and a
 * Personal computer reached remotely presents the session its pairing code
 * established. A Deployment never carries both — the two credential families
 * are read by different parsers on the Host, and mixing them would let one
 * stand in for the other.
 */
export function createDeploymentCredentials(options: {
  readonly now: () => Date;
  readonly oauth: Pick<NativeOAuthManager, "authorizationHeader" | "hostCredentialState"> &
    Partial<Pick<NativeOAuthManager, "hostViewLoginId">>;
  readonly sessions: PersonalSessionStore;
}): DeploymentCredentials {
  return {
    async viewLoginId(connection) {
      if (connection.kind === "self-hosted") return options.oauth.hostViewLoginId?.(connection);
      return (await options.sessions.load(connection.authority.document.deploymentId))?.viewLoginId;
    },
    async authorization(connection): Promise<string | null> {
      if (connection.kind === "self-hosted") return options.oauth.authorizationHeader(connection);
      return options.sessions.authorization(
        connection.authority.document.deploymentId,
        options.now(),
      );
    },

    async held(connection): Promise<boolean> {
      if (connection.kind === "self-hosted") {
        return options.oauth.hostCredentialState(connection).status === "signed-in";
      }
      return (
        (await options.sessions.authorization(
          connection.authority.document.deploymentId,
          options.now(),
        )) !== null
      );
    },
  };
}
