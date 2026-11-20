import type { CallableIntegrationTool, IntegrationRequester } from "@opensteer/database";
import type { Blocked, RunId, DeviceId } from "@opensteer/core";
import { computerAppIdentityKey } from "@opensteer/integration-core";
import { isPhoneDisplayDefinitionId } from "@opensteer/core";
import type { RunCapabilityClaims } from "../agents/run-capability.js";
import type { DeviceService } from "./device-service.js";
import {
  computerAppDiscovery,
  phoneDiscovery,
  computerToolRefs,
  computerMachineProblem,
} from "./computer-use-discovery.js";
import {
  computerUseDefinitionId,
  computerUseHolderKey,
} from "../computer-use/computer-use-service.js";
export async function gatherComputerAccess(
  platform: Pick<
    DeviceService,
    | "store"
    | "computerAppApprovals"
    | "listCallableTools"
    | "computerToolEnabled"
    | "computerUseVersion"
  > & {
    readonly store: Pick<DeviceService["store"], "requesterGrant">;
  },
  input: IntegrationRequester & { readonly runId?: RunId },
  run?: RunCapabilityClaims<string>,
  callableTools?: readonly CallableIntegrationTool[],
) {
  const hasRun = !!(run || input.runId);
  const [ownerInventory, tools, ownerSetupRequests, ownerAccessRequests, enabled, grant] =
    await Promise.all([
      platform.computerAppApprovals.computerUseInventory(input.ownerUserId),
      callableTools ?? platform.listCallableTools(input),
      platform.store.listDeviceComputerAppSetupRequests(input.ownerUserId),
      platform.store.integrationRequests.listPendingIntegrationAccessRequests(input.ownerUserId),
      run ? platform.computerToolEnabled(run) : hasRun,
      platform.store.requesterGrant(input),
    ]);
  // A selected grant learns only the Devices, apps and phone screens it names: the inventory is
  // scoped before anything is projected, and the person's pending setup is none of its business.
  const selected = grant?.scope === "selected" ? grant : null;
  const grantedApps = selected?.resources.flatMap((resource) =>
    resource.kind === "computer-app" ? [resource] : [],
  );
  const inventory = grantedApps
    ? {
        ...ownerInventory,
        machines: ownerInventory.machines.flatMap((machine) => {
          const apps = machine.apps.filter((entry) =>
            grantedApps.some(
              (resource) =>
                resource.approvalId === entry.connectionId.toLowerCase() &&
                resource.deviceId === machine.deviceId,
            ),
          );
          return apps.length ? [{ ...machine, apps }] : [];
        }),
        phones: ownerInventory.phones.filter((phone) =>
          grantedApps.some(
            (resource) =>
              resource.deviceId === phone.deviceId &&
              resource.app.kind === "phone-screen" &&
              resource.app.definitionId === phone.definitionId,
          ),
        ),
      }
    : ownerInventory;
  const setupRequests = selected ? [] : ownerSetupRequests;
  const accessRequests = selected ? [] : ownerAccessRequests;
  const runRequired: { blocked: Blocked; access?: never } = {
    blocked: {
      code: "unavailable",
      message: "Only a task's Run can operate phones and Mac apps.",
      next: 'Use opensteer_task_send with delivery "queue" to ask a task to do this work.',
    },
  };
  const grants = new Set(accessRequests.map((request) => request.requestedConnectionId));
  const onMacRequests = setupRequests.flatMap(({ kind, definitionId, deviceId, app, access }) =>
    kind === "app" && definitionId === computerUseDefinitionId && app
      ? [{ deviceId, app, access }]
      : [],
  );
  const [holderEntries, versionEntries] = await Promise.all([
    Promise.all(
      [...inventory.machines, ...inventory.phones].map(
        async (machine) =>
          [
            machine.deviceId,
            await platform.computerAppApprovals.computerAppHolders(machine.deviceId),
          ] as const,
      ),
    ),
    Promise.all(
      inventory.machines.map(
        async (machine) =>
          [machine.deviceId, await platform.computerUseVersion(machine.deviceId)] as const,
      ),
    ),
  ]);
  const holders = new Map(holderEntries);
  const held = (deviceId: DeviceId, key: string) => {
    const holder = holders.get(deviceId)?.get(key);
    return !!holder && holder.runId !== (run?.runId ?? input.runId);
  };
  const versions = new Map(versionEntries);
  const machineFacts = (machine: (typeof inventory.machines)[number]) => ({
    ...machine,
    computerToolEnabled: enabled,
    computerUseVersion: versions.get(machine.deviceId) ?? null,
  });
  const app = (
    machine: (typeof inventory.machines)[number],
    identity: { displayName: string; bundleId: string },
  ) => {
    const key = identity.bundleId.toLowerCase();
    const approved = machine.apps.find((entry) => entry.bundleId.toLowerCase() === key);
    const refs = approved ? computerToolRefs(tools, approved.connectionId) : {};
    if (!hasRun) return runRequired;
    return computerAppDiscovery({
      app: identity.displayName,
      computerId: machine.deviceId,
      machine: machineFacts(machine),
      approval: approved ?? null,
      callable: !!refs.observe,
      canAct: !!refs.act,
      pendingOnMac: onMacRequests.some(
        (request) =>
          request.deviceId === machine.deviceId && computerAppIdentityKey(request.app) === key,
      ),
      pendingPersonalGrant: !!approved && grants.has(approved.connectionId),
      heldByAnotherRun: held(machine.deviceId, key),
    });
  };
  const phone = (entry: (typeof inventory.phones)[number]) => {
    const refs = entry.connection ? computerToolRefs(tools, entry.connection.connectionId) : {};
    if (!hasRun) return runRequired;
    return phoneDiscovery({
      phone: {
        ...entry,
        definitionId: entry.definitionId === "iphone-screen" ? "iphone-screen" : "android-phone",
        computerId: entry.deviceId,
        computerToolEnabled: enabled,
      },
      connection: entry.connection,
      blockedByOwner: entry.blockedByOwner,
      callable: !!refs.observe,
      canAct: !!refs.act,
      pendingPhoneAccess: setupRequests.some(
        (request) =>
          request.kind === "app" &&
          isPhoneDisplayDefinitionId(request.definitionId) &&
          request.deviceId === entry.deviceId,
      ),
      pendingPersonalGrant: !!entry.connection && grants.has(entry.connection.connectionId),
      heldByAnotherRun: held(
        entry.deviceId,
        computerUseHolderKey({ kind: "display", definitionId: entry.definitionId }),
      ),
    });
  };
  return {
    ...inventory,
    /** Whether a selected grant scoped this inventory: it names apps, never a whole Mac. */
    grantScoped: selected !== null,
    tools,
    appEntries: (machine: (typeof inventory.machines)[number]) => [
      ...machine.apps.map((entry) => ({
        id: entry.connectionId,
        name: entry.name,
        bundleId: entry.bundleId,
        ...app(machine, { displayName: entry.name, bundleId: entry.bundleId }),
      })),
      ...onMacRequests
        .filter(
          (request) =>
            request.deviceId === machine.deviceId &&
            !machine.apps.some(
              (entry) => entry.bundleId.toLowerCase() === computerAppIdentityKey(request.app),
            ),
        )
        .map((request) => ({
          id: null,
          name: request.app.displayName,
          bundleId: request.app.bundleId,
          ...app(machine, request.app),
        })),
    ],
    app,
    phone,
    machine: (machine: (typeof inventory.machines)[number]) =>
      hasRun ? computerMachineProblem(machineFacts(machine)) : runRequired,
  };
}
