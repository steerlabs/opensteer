import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import type {
  DesktopSelectDeploymentInput,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";

// Desktop authorizes in the system browser: its renderer cannot navigate to a Host origin.
export async function startHostOidcSignIn(input: {
  readonly deploymentId: DesktopSelectDeploymentInput["deploymentId"] | null;
  readonly desktopBridge: Pick<OpensteerDesktopBridge, "select"> | null;
  readonly hostClient: Pick<HostClient, "rpc">;
  readonly navigate: (url: string) => void;
  readonly oauthQuery: string | null;
  readonly providerId: string;
}): Promise<boolean> {
  if (input.desktopBridge) {
    if (input.deploymentId === null) {
      throw new Error("This app has no selected deployment to authorize.");
    }
    await input.desktopBridge.select({ deploymentId: input.deploymentId });
    return false;
  }
  input.navigate(
    unwrapRpcResult(
      await input.hostClient.rpc["auth.oidc.begin"]({
        ...(input.oauthQuery ? { oauthQuery: input.oauthQuery } : {}),
        providerId: input.providerId,
        returnPath: "/",
      }),
    ).redirectUrl,
  );
  return true;
}
