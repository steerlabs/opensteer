import { createId, PendingRequestViewSchema } from "@opensteer/core";
import {
  DeviceIntegrationConnectionSummarySchema,
  DeviceComputerAppSetupRequestSchema,
} from "@opensteer/integration-core";
import { MachineSummarySchema } from "./machines.js";
import { ComputerViewSchema } from "./computer-view.js";
import { TabBootstrapSchema } from "./tabs.js";

export const now = "2026-08-22T12:00:00.000Z";
export const selfId = createId("runner");
export const screenId = createId("device");
export const threadId = createId("thread");
export const runId = createId("run");
export const ownerId = createId("user");
export const window = {
  byteCount: 0,
  hasMore: false,
  itemCount: 2,
  nextBefore: null,
  totalItems: 2,
};
export const content = [
  { type: "text", text: "Look at " },
  { type: "phone", machineId: screenId, display: "main", name: "My iPhone" },
];
export const view = ComputerViewSchema.parse({
  connectionId: `con_${crypto.randomUUID()}`,
  machineId: screenId,
  target: { kind: "phone", display: "main" },
  window: null,
  viewId: `cvw_${crypto.randomUUID()}`,
  generation: 1,
  driverGeneration: 3,
  state: "ready",
  openedAt: now,
  expiresAt: now,
  unavailableReason: null,
});
export const selfView = { ...view, machineId: selfId, driverGeneration: undefined };
export const machine = MachineSummarySchema.parse({
  access: null,
  allowedModules: ["integrations"],
  detail: null,
  device: { form: "laptop", platform: "macos" },
  enrollmentId: null,
  expiresAt: null,
  id: selfId,
  selfRunnerId: selfId,
  lastSeenAt: null,
  modules: {},
  name: "Mac",
  ownership: "mine",
  pinnedThreads: 0,
  revocable: true,
  status: "offline",
  unlinkedLocalFolders: 0,
});
export const screen = {
  ...machine,
  id: screenId,
  selfRunnerId: null,
  allowedModules: [],
  name: "My iPhone",
};
export const connection = DeviceIntegrationConnectionSummarySchema.parse({
  accountIdentifier: null,
  applicationSource: null,
  authMethodId: "computer",
  authorizationDigest: null,
  computer: { access: "read", app: null, blockedAt: null, policyRevision: 1, deviceId: selfId },
  connectionMethod: "computer",
  createdAt: now,
  definitionId: "android-phone",
  displayName: "Phone",
  externalIdentityId: null,
  externalTenantId: null,
  grantedScopes: [],
  id: `con_${crypto.randomUUID()}`,
  provider: "computer",
  providerApplicationId: null,
  status: "connected",
  statusDetail: null,
  statusReason: null,
  updatedAt: now,
});
export const screenConnection = {
  ...connection,
  definitionId: "iphone-screen",
  computer: { ...connection.computer!, deviceId: screenId },
};
export const setup = DeviceComputerAppSetupRequestSchema.parse({
  id: crypto.randomUUID(),
  deploymentId: createId("deployment"),
  ownerUserId: ownerId,
  deviceId: selfId,
  definitionId: "android-phone",
  definitionDigest: "a".repeat(43),
  access: "read",
  kind: "app",
  policyAppApproval: null,
  app: null,
  server: null,
  reason: null,
  threadId,
  threadTitle: "Task",
  createdAt: now,
  expiresAt: now,
});
export const screenSetup = { ...setup, deviceId: screenId, definitionId: "iphone-screen" };
export const request = PendingRequestViewSchema.parse({
  id: createId("request"),
  kind: "computer.app.access",
  status: "pending",
  callId: "access",
  mode: "durable",
  originatingRunId: runId,
  originatingOccurrenceId: null,
  originatingThreadId: threadId,
  requestedBy: ownerId,
  createdAt: now,
  requiredActor: "requester",
  cancellationReason: null,
  resolvedAt: null,
  resolvedBy: null,
  response: null,
  payload: {
    kind: "computer.app.access",
    deviceId: selfId,
    definitionId: "android-phone",
    app: null,
    access: "read",
    reason: "Look",
    setupRequestId: setup.id,
  },
  presentation: {
    kind: "choice",
    title: "Read phone",
    options: [
      { hint: "allow-once", id: "allow", label: "Allow" },
      { hint: "reject-once", id: "reject", label: "Reject" },
    ],
  },
});
export const screenRequest = {
  ...request,
  payload: { ...request.payload, deviceId: screenId, definitionId: "iphone-screen" },
};
const tab = {
  tabId: createId("tab"),
  kind: "phone",
  title: "Phone",
  computer: { computerId: selfId, name: "Phone" },
  groupId: null,
  state: "open",
  openedBy: "person",
  usedBy: [],
  createdAt: now,
  updatedAt: now,
};
export const tabs = TabBootstrapSchema.parse({
  tabs: [
    tab,
    { ...tab, tabId: createId("tab"), computer: { computerId: screenId, name: "My iPhone" } },
  ],
  layout: { revision: 1, items: [] },
  complete: true,
});
tabs.layout.items = [
  {
    kind: "group",
    group: {
      groupId: createId("tabGroup"),
      name: "Phones",
      color: "blue",
      collapsed: false,
      tabIds: tabs.tabs.map((tab) => tab.tabId),
    },
  },
];
