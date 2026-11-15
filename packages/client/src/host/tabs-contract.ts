import type {
  App,
  AppId,
  Tab,
  TabGroup,
  TabGroupId,
  TabId,
  TabLayout,
  TabTarget,
} from "@opensteer/core";
import type {
  TabCloseResult,
  TabGroupUpdateInput,
  TabOrganizeInput,
  TabOrganizeResult,
  TabViewer,
} from "@opensteer/protocol";
export interface TabsClient {
  openTab(target: TabTarget): Promise<Tab>;
  closeTabs(tabIds: TabId[]): Promise<TabCloseResult>;
  reopenTab(tabId?: TabId): Promise<Tab>;
  /**
   * Opens or wakes this device's viewer. `wake` is the person's explicit Open:
   * only it arms a phone's one-shot screen wake; selection restore, renewal
   * and reconnect never do.
   */
  activateTab(tabId: TabId, options?: { readonly wake?: boolean }): Promise<TabViewer>;
  organizeTabs(input: TabOrganizeInput): Promise<TabOrganizeResult>;
  updateTabGroup(input: TabGroupUpdateInput): Promise<TabGroup>;
  deleteTabGroup(groupId: TabGroupId): Promise<void>;
  listApps(query?: string): Promise<App[]>;
  /** One app, as an app tab reads its origin chat. */
  getApp(appId: AppId): Promise<App>;
  renameApp(appId: AppId, name: string): Promise<App>;
  startApp(appId: AppId): Promise<App>;
  stopApp(appId: AppId): Promise<App>;
  deleteApp(appId: AppId): Promise<void>;
}
export interface TabsReadModel {
  readonly rows: ReadonlyMap<TabId, Tab>;
  readonly layout: TabLayout;
  readonly complete: boolean;
  readonly syncing: boolean;
  get(tabId: TabId): Tab | undefined;
  subscribe(listener: () => void): () => void;
  subscribeTab(tabId: TabId, listener: () => void): () => void;
}
export interface TabsHostSnapshot {
  readonly tabs: TabsReadModel;
  readonly appsRevision: number;
}
