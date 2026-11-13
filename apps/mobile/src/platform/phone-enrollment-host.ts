import type { HostClient } from "@opensteer/client/host";
import type { HostAuthorization } from "./host-network.js";

const hosts = new WeakMap<
  HostClient,
  {
    readonly deploymentId: string;
    readonly origin: string;
    readonly hostInstanceId: string;
    readonly authorization: HostAuthorization;
  }
>();

export function registerPhoneEnrollmentHost(
  client: HostClient,
  host: {
    readonly deploymentId: string;
    readonly origin: string;
    readonly hostInstanceId: string;
    readonly authorization: HostAuthorization;
  },
): void {
  hosts.set(client, host);
}

export async function phoneEnrollmentHost(client: HostClient, deploymentId: string) {
  const host = hosts.get(client);
  if (host === undefined || host.deploymentId !== deploymentId)
    throw new Error("Open the Opensteer this phone is being added to.");
  const authorization = await host.authorization.current();
  if (authorization === null) throw new Error("Sign in to add this phone.");
  return { origin: host.origin, hostInstanceId: host.hostInstanceId, authorization };
}
