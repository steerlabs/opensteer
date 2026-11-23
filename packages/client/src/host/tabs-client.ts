import type { App, AppId, Tab, TabId } from "@opensteer/core";
import type {
  AppCommand,
  AppCommandResult,
  TabCommand,
  TabCommandResult,
  TabViewer,
} from "@opensteer/protocol";
import type { TabStore } from "./tab-store.js";
import type { TabsClient } from "./tabs-contract.js";

type WithoutKey<T> = T extends unknown ? Omit<T, "idempotencyKey"> : never;
export type TabsCommand = WithoutKey<TabCommand | AppCommand>;
type ResultOf<Type extends TabsCommand["type"]> = Extract<
  TabCommandResult | AppCommandResult,
  { type: Type }
>;

export interface TabsClientPort {
  /** Sends one command under the given key; a transport retry reuses that key. */
  dispatch(
    command: TabCommand | AppCommand,
    signal?: AbortSignal,
  ): Promise<TabCommandResult | AppCommandResult>;
  listApps(query?: string): Promise<App[]>;
  getApp(appId: AppId): Promise<App>;
  readonly store: TabStore;
  /** The page session the Host bound for this device's view of a tab. */
  activated?(tab: Tab, viewer: TabViewer, wake: boolean): void;
}

/**
 * Every tab and app mutation, through `commands.dispatch`. Each answer's
 * layout reaches the shared catalog only if it is newer than the stream, and
 * the public result drops the envelope fields.
 */
export function createTabsClient(port: TabsClientPort): TabsClient {
  // Each tab's newest activation: an older answer arriving after it binds nothing.
  const activations = new Map<TabId, number>();
  let activation = 0;
  async function send<Command extends TabsCommand>(
    command: Command,
    signal?: AbortSignal,
  ): Promise<ResultOf<Command["type"]>> {
    const key = `${command.type}:${globalThis.crypto.randomUUID()}`;
    signal?.throwIfAborted();
    const result = await port.dispatch(
      { ...command, idempotencyKey: key } as TabCommand | AppCommand,
      signal,
    );
    signal?.throwIfAborted();
    if (result.type !== command.type) throw new Error(`Unexpected ${command.type} result.`);
    return result as ResultOf<Command["type"]>;
  }
  return {
    async openTab(target, options) {
      const result = await send({
        type: "tab.open",
        target,
        ...(options?.typed && target.kind === "page" ? { typed: true as const } : {}),
      });
      port.store.applyCommand({ layout: result.layout, tabs: [result.tab as Tab] });
      return result.tab as Tab;
    },
    async closeTabs(tabIds) {
      const { type: _type, layout, ...result } = await send({ type: "tab.close", tabIds });
      port.store.applyCommand({ layout });
      return result;
    },
    async reopenTab(tabId?: TabId) {
      const result = await send({ type: "tab.reopen", ...(tabId ? { tabId } : {}) });
      port.store.applyCommand({ layout: result.layout, tabs: [result.tab as Tab] });
      return result.tab as Tab;
    },
    async activateTab(tabId, options) {
      const request = ++activation;
      activations.set(tabId, request);
      try {
        const result = await send({ type: "tab.activate", tabId }, options?.signal);
        if (activations.get(tabId) === request)
          port.activated?.(result.tab as Tab, result.viewer, options?.wake === true);
        return result.viewer;
      } finally {
        if (activations.get(tabId) === request) activations.delete(tabId);
      }
    },
    async organizeTabs(input) {
      const result = await send({ type: "tab.organize", ...input });
      port.store.applyCommand({ layout: result.layout, tabs: result.tabs as Tab[] });
      const groups = result.layout.items.flatMap((item) =>
        item.kind === "group" ? [item.group] : [],
      );
      return { tabs: result.tabs, groups };
    },
    async updateTabGroup(input) {
      const result = await send({ type: "tab.group.update", ...input });
      port.store.applyCommand({ layout: result.layout });
      return result.group;
    },
    async deleteTabGroup(groupId) {
      const result = await send({ type: "tab.group.delete", groupId });
      port.store.applyCommand({ layout: result.layout });
    },
    async closeTabGroup(groupId) {
      const { type: _type, layout, ...result } = await send({ type: "tab.group.close", groupId });
      port.store.applyCommand({ layout });
      return result;
    },
    listApps: (query?: string) => port.listApps(query),
    getApp: (appId: AppId) => port.getApp(appId),
    async renameApp(appId: AppId, name: string) {
      return (await send({ type: "app.rename", appId, name })).app as App;
    },
    async startApp(appId: AppId) {
      return (await send({ type: "app.start", appId })).app as App;
    },
    async stopApp(appId: AppId) {
      return (await send({ type: "app.stop", appId })).app as App;
    },
    async deleteApp(appId: AppId) {
      await send({ type: "app.delete", appId });
    },
  };
}
