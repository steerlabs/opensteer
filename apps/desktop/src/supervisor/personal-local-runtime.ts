import type { PersonalDeploymentPreparedPaths } from "../secrets/personal-deployment-store.js";

/**
 * The Chromium this computer lends its Deployment.
 *
 * It is not an identity of its own: the Runner beside it is the machine, and
 * it reaches this browser over the loopback bridge described here. Keeping the
 * bridge token out of the Host's reach is the point — the Runner key never
 * leaves the Runner process, and the browser never holds a Host credential.
 */
export interface PersonalLocalBrowserHandle {
  readonly bridgeToken: string;
  readonly runtimeId: string;
  /** Whether it signs in with Opensteer Passwords, which its Runner then advertises. */
  readonly signIn: boolean;
  readonly url: URL;
  stop(signal?: AbortSignal): Promise<void>;
}

export interface PersonalLocalRuntimePort {
  startBrowser(input: {
    readonly paths: PersonalDeploymentPreparedPaths;
    readonly runtimeId: string;
  }): Promise<PersonalLocalBrowserHandle>;
}
