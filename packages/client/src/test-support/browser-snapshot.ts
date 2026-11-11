import type { HostedBrowserBootstrap } from "@opensteer/protocol";
import { BrowserTabStore } from "../host/browser-tab-store.js";
import { BrowserSnapshotDerivation } from "../host/browser-snapshot.js";

export function browserSnapshotFromRows(prefix: Pick<HostedBrowserBootstrap, "groups" | "tabs">) {
  const store = new BrowserTabStore(() => {});
  store.seed(prefix);
  return new BrowserSnapshotDerivation().derive({ browserSessions: [], workspaceTabs: [] }, store);
}
