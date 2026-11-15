import type {
  BrowserTabOpenInput,
  HostClient,
  LegacyHostSnapshot,
  PersonalSurfaceDestination,
} from "@opensteer/client/host";
import {
  AppIdSchema,
  BrowserProfileIdSchema,
  PageOpenUrlSchema,
  RunnerIdSchema,
  TabIdSchema,
  type TabId,
  type TabTarget,
} from "@opensteer/core";
import { tabsClient } from "./tabs-host.js";

/**
 * The tab a task's place names, for the person's explicit Open. A page is its
 * tab already; an app or a phone opens its one tab, which the Host reuses.
 * A Mac app named only by a task's session has no tab to name here: null.
 * (Delete when the shared client's run places carry their tabId.)
 */
export async function placeTabId(
  hostClient: HostClient,
  destination: PersonalSurfaceDestination,
): Promise<TabId | null> {
  if (destination.kind === "browser") return TabIdSchema.parse(destination.tabId);
  const client = tabsClient(hostClient);
  if (destination.kind === "opensteer-app")
    return (await client.openTab({ appId: AppIdSchema.parse(destination.appId), kind: "app" }))
      .tabId;
  if (destination.kind === "phone")
    return (
      await client.openTab({
        computerId: RunnerIdSchema.parse(destination.machineId),
        kind: "phone",
      })
    ).tabId;
  return null;
}

/**
 * A page tab target for a URL, from the shared client's browser choice: a
 * profile opens on its home, Guest where the choice placed it. Null for a
 * browser this reader no longer has.
 * (Delete when the shared client's link places name TabTargets.)
 */
export function pageTabTarget(
  snapshot: Pick<LegacyHostSnapshot, "browserSessions">,
  input: BrowserTabOpenInput,
  url: string,
): TabTarget | null {
  const page = PageOpenUrlSchema.safeParse(url);
  if (!page.success) return null;
  const choice =
    "sessionId" in input
      ? snapshot.browserSessions.find(({ id }) => id === input.sessionId)
      : undefined;
  if ("sessionId" in input && choice === undefined) return null;
  const profileId =
    choice !== undefined
      ? choice.profileId
      : !("sessionId" in input) && input.identity.kind === "profile"
        ? input.identity.profileId
        : null;
  if (profileId !== null)
    return { kind: "page", profileId: BrowserProfileIdSchema.parse(profileId), url: page.data };
  const runnerId =
    choice !== undefined
      ? choice.placement.runnerId
      : !("sessionId" in input) && input.placement?.kind === "runner"
        ? input.placement.runnerId
        : null;
  return {
    guest: true,
    kind: "page",
    url: page.data,
    ...(runnerId === null ? {} : { computerId: RunnerIdSchema.parse(runnerId) }),
  };
}
