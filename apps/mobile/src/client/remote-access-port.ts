import type { RemoteAccessPort } from "@opensteer/client/host";
import type { MobileClient } from "./mobile-client.js";

/** This phone's half of "Use from anywhere" for the computer it is attached to. */
export function mobileRemoteAccessPort(
  client: Pick<MobileClient, "linkSelectedPersonalAccount" | "signInAccount">,
): RemoteAccessPort {
  return {
    link: ({ activating }) => client.linkSelectedPersonalAccount({ activating }),
    signIn: () => client.signInAccount(),
  };
}
