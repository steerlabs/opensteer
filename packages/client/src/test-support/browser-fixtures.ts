import {
  HostedBrowserBootstrapSchema,
  HostedBrowserSessionSchema,
  type HostedBrowserBootstrap,
} from "@opensteer/protocol";
import type { HostSnapshot, PersonalTabLineage } from "../host/client.js";
import { seedBrowserSession, seedBrowserSnapshot } from "./browser-snapshot.js";

export type BrowserBootstrapFixture = Omit<
  HostedBrowserBootstrap,
  "groups" | "tabs" | "profiles" | "placements" | "profileGrants"
> & {
  groups?: HostedBrowserBootstrap["groups"];
  tabs?: HostedBrowserBootstrap["tabs"];
  profiles: HostSnapshot["browserProfiles"];
  placements: HostSnapshot["browserPlacements"];
  sessions?: (
    | import("@opensteer/protocol").HostedBrowserSession
    | import("../host/client.js").BrowserSessionSummary
  )[];
  lineages?: PersonalTabLineage[];
};
export function browserSessionFixture<T extends object>(input: T) {
  return {
    ...HostedBrowserSessionSchema.strip().parse(input),
    ...("browserTabs" in input
      ? { browserTabs: input.browserTabs as HostSnapshot["browserTabs"] }
      : {}),
  };
}
export function browserBootstrapWithRows(
  browser: BrowserBootstrapFixture | HostedBrowserBootstrap,
): HostedBrowserBootstrap {
  const { sessions = [], lineages, ...wire } = browser as BrowserBootstrapFixture;
  if (browser.groups && browser.tabs) return HostedBrowserBootstrapSchema.parse(wire);
  const source = seedBrowserSnapshot(
    { browserSessions: sessions.map((session) => seedBrowserSession(session)) } as HostSnapshot,
    lineages,
  );
  const store = source.browserTabs!;
  return HostedBrowserBootstrapSchema.parse({
    ...wire,
    groups: { rows: store.groups().ids.map(store.group), complete: true },
    tabs: store.groups().ids.map((groupId) => ({
      groupId,
      rows: store.sessionTabs(store.group(groupId)!.sessionId),
      complete: store.tabs(groupId).whole,
    })),
  });
}
