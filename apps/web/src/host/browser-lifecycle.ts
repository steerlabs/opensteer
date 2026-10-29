import { observePageVisibility, pageVisible } from "../page-visibility.js";
import type { ClientLifecycle, ClientNetworkState } from "@opensteer/client/host";

/**
 * The browser's account of the two facts the Host client cannot see: whether
 * anybody is looking at this document, and whether this device believes it has
 * a network. The Desktop renderer is a browser too, so it uses this as well,
 * adding how long its hidden sockets last.
 *
 * `navigator.onLine` is the only signal a page gets, and it reports the local
 * interface rather than reachability — "online" is therefore a prompt to retry
 * now, never a promise that the Host answers.
 */
export function browserClientLifecycle(
  options: Pick<ClientLifecycle, "socketTrustWindowMs"> = {},
): ClientLifecycle {
  return {
    ...options,
    getSnapshot: () => ({
      network: networkState(),
      visibility: pageVisible() ? "foreground" : "background",
    }),
    onBackground: (listener) => visibilityListener(false, listener),
    onForeground: (listener) => visibilityListener(true, listener),
    onNetworkChange: (listener) => {
      const online = () => listener("online");
      const offline = () => listener("offline");
      window.addEventListener("online", online);
      window.addEventListener("offline", offline);
      return () => {
        window.removeEventListener("online", online);
        window.removeEventListener("offline", offline);
      };
    },
  };
}

function networkState(): ClientNetworkState {
  return navigator.onLine ? "online" : "offline";
}

function visibilityListener(visible: boolean, listener: () => void): () => void {
  return observePageVisibility(() => {
    if (pageVisible() === visible) listener();
  });
}
