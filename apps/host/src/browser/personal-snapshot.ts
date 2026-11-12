import { OpensteerError } from "@opensteer/core";
import {
  OpensteerStore,
  PersonalTabStore,
  BrowserTabGroupStore,
  AppStore,
} from "@opensteer/database";
import type { PersonalSnapshotResourcesReader } from "@opensteer/database";
import { BrowserRowSource } from "./browser-client-streams.js";
import { publicProfile, publicPlacement, type BrowserRuntimePlacement } from "./browser-service.js";

export async function readPersonalResources(
  input: Parameters<PersonalSnapshotResourcesReader>[0],
  placements: () => readonly BrowserRuntimePlacement[],
): ReturnType<PersonalSnapshotResourcesReader> {
  const { database, ownerId, maxBytes } = input;
  const store = new OpensteerStore(database),
    tabs = new PersonalTabStore(database);
  const [profiles, homes, tabGroups, appTabs, profileDeletions] = await Promise.all([
    store.listBrowserProfiles(ownerId),
    store.listEligibleBrowserRunners(ownerId),
    new BrowserTabGroupStore(database).layout(ownerId, database),
    new AppStore(database).listTabs(ownerId),
    store.listPendingBrowserProfileDeletions(ownerId),
  ]);
  const allowed = new Set(homes.map((home) => home.id));
  const eligible = placements().filter((placement) => allowed.has(placement.runnerId));
  const metadata = {
    appTabs,
    browser: {
      profileDeletions,
      profiles: profiles.map(publicProfile),
      profileHomes: homes.map((home) => home.id),
      placements: eligible.map(publicPlacement),
      available: eligible.some((placement) => placement.available),
      tabRestoreVersion: 1 as const,
      tabGroupsVersion: 1 as const,
      tabGroups,
    },
  };
  const budget = maxBytes - Buffer.byteLength(JSON.stringify(metadata)) - 2048;
  if (budget < 4096)
    throw new OpensteerError({
      code: "conflict",
      message: "Personal resource catalog exceeds snapshot budget",
    });
  const source = new BrowserRowSource(
    {
      authorityGeneration: () => 0,
      groupIds: (user) => tabs.groupIds(user),
      readGroups: (user, ids) => tabs.read(user, ids, database),
      readTabs: (ids) => tabs.openTabs(ids),
      groupId: (id) => tabs.lineageForSession(id),
      live: () => undefined,
      occupants: () => [],
      onError: (error) => {
        throw error;
      },
    },
    () => {},
  );
  try {
    const result = {
      appTabs,
      browser: { ...metadata.browser, ...(await source.bootstrap(ownerId, budget)) },
    };
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
      throw new OpensteerError({
        code: "conflict",
        message: "Personal resource snapshot exceeds byte budget",
      });
    return result;
  } finally {
    source.close();
  }
}
