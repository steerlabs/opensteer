import type {
  App,
  AppId,
  ComputerAppIdentity,
  ComputerViewTarget,
  RunnerId,
  DeviceId,
  Tab,
  TabGroup,
  TabGroupId,
  TabId,
  TabLayout,
  TabTarget,
  TabUnavailableCode,
  ThreadId,
  UserId,
  WindowId,
} from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import type {
  ComputerView,
  TabBootstrap,
  TabCloseResult,
  TabGroupUpdateInput,
  TabListInput,
  TabListResult,
  TabOrganizeInput,
  TabOrganizeResult,
  TabViewer,
} from "@opensteer/protocol";
import type { PageAgentBinding } from "@opensteer/protocol/browser-agent";
import type { Transaction } from "kysely";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import type { ConnectionCaller } from "../mcp/agent-caller.js";
export type { PageAgentBinding } from "@opensteer/protocol/browser-agent";
export type TabActor =
  | { kind: "person"; ownerId: UserId }
  | { kind: "run"; claims: RunToolScope }
  | { kind: "connection"; caller: ConnectionCaller };
export interface TabServicePort {
  list(actor: TabActor, input: TabListInput): Promise<TabListResult>;
  open(actor: TabActor, target: TabTarget, key: string): Promise<{ tab: Tab }>;
  close(actor: TabActor, tabIds: TabId[], key: string): Promise<TabCloseResult>;
  reopen(
    actor: TabActor,
    tabId: TabId | undefined,
    key: string,
  ): Promise<{ tab: Tab; layout: TabLayout }>;
  activate(ownerId: UserId, tabId: TabId, key: string): Promise<{ tab: Tab; viewer: TabViewer }>;
  organize(actor: TabActor, input: TabOrganizeInput, key: string): Promise<TabOrganizeResult>;
  updateGroup(
    actor: TabActor,
    input: TabGroupUpdateInput,
    key: string,
  ): Promise<{ group: TabGroup }>;
  deleteGroup(ownerId: UserId, groupId: TabGroupId, key: string): Promise<{ layout: TabLayout }>;
  get(ownerId: UserId, tabId: TabId): Promise<Tab>;
  bootstrap(ownerId: UserId, maxBytes: number): Promise<TabBootstrap>;
  requireOpenPage(claims: RunToolScope, tabId: TabId): Promise<PageAgentBinding>;
  authorizeBind(claims: RunToolScope, tabId: TabId): Promise<void>;
  authorizeShow(claims: RunToolScope, tabId: TabId): Promise<void>;
  appsChanged(appIds: AppId[]): void;
}
export interface AppTabPort {
  get(ownerId: UserId, appId: AppId): Promise<App>;
  // Uses the existing personal transaction; no native or process I/O.
  removeTabs(tx: Transaction<DatabaseSchema>, appId: AppId): Promise<TabId[]>;
}
export type NativeTabTargetState = (
  | { state: "open" | "asleep" }
  | { state: "unavailable"; unavailableCode: TabUnavailableCode; unavailableReason: string }
) & { usedBy: Array<{ taskId: ThreadId }> };
export interface ResolvedTabWindow {
  windowId: WindowId;
  app: ComputerAppIdentity;
  appName: string;
  bundleId: string;
  title: string;
}
export type NativeTargetAcquired = {
  ownerId: UserId;
  runClaims: RunToolScope;
  computerId: RunnerId;
  key: string;
  membershipRevision: number;
} & ({ kind: "window"; windowId: WindowId } | { kind: "phone" });
export type NativeTargetAcquiredHandler = (target: NativeTargetAcquired) => Promise<TabId>;
export type DeviceNativeTargetAcquired = {
  ownerId: UserId;
  runClaims: RunToolScope;
  computerId: DeviceId;
  key: string;
  membershipRevision: number;
} & ({ kind: "window"; windowId: WindowId } | { kind: "phone" });
export interface DeviceNativeTabTargetsPort {
  phoneState(ownerId: UserId, deviceId: DeviceId): Promise<NativeTabTargetState>;
  openOwnerView(
    ownerId: UserId,
    input: {
      tabId: TabId;
      tabGeneration: number;
      computerId: DeviceId;
      target: ComputerViewTarget;
    },
    key: string,
  ): Promise<ComputerView>;
}
export interface NativeTabTargetsPort {
  resolveWindow(
    ownerId: UserId,
    computerId: RunnerId,
    target: { windowId: WindowId } | { bundleId: string },
  ): Promise<ResolvedTabWindow>;
  windowState(
    ownerId: UserId,
    computerId: RunnerId,
    windowId: WindowId,
    app?: ComputerAppIdentity | null,
  ): Promise<NativeTabTargetState>;
  phoneState(ownerId: UserId, computerId: RunnerId): Promise<NativeTabTargetState>;
  openOwnerView(
    ownerId: UserId,
    input: {
      tabId: TabId;
      tabGeneration: number;
      computerId: RunnerId;
      target: ComputerViewTarget;
    },
    key: string,
  ): Promise<ComputerView>;
  closeOwnerViews(ownerId: UserId, tabId: TabId, tabGeneration: number): Promise<void>;
  onTargetAcquired(
    handler: NativeTargetAcquiredHandler,
    capture?: (ownerId: UserId) => Promise<number>,
  ): () => void;
}
