import type { CallableIntegrationTool, IntegrationRequester } from "@opensteer/database";
import type { RunnerId } from "@opensteer/core";
import { computerAppIdentityKey } from "@opensteer/integration-core";
import { androidPhoneDefinitionId } from "@opensteer/protocol";
import type { RunCapabilityClaims } from "../agents/run-capability.js";
import type { IntegrationPlatformService } from "./integration-platform-service.js";
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
    IntegrationPlatformService,
    | "store"
    | "computerAppApprovals"
    | "listCallableTools"
    | "computerToolEnabled"
    | "computerUseVersion"
  >,
  input: IntegrationRequester,
  run?: RunCapabilityClaims<string>,
  callableTools?: readonly CallableIntegrationTool[],
) {
  const [inventory, tools, setupRequests, accessRequests, enabled] = await Promise.all([
    platform.computerAppApprovals.computerUseInventory(input.ownerUserId),
    callableTools ?? platform.listCallableTools(input),
    platform.store.listComputerAppSetupRequests(input.ownerUserId),
    platform.store.requests.listPendingIntegrationAccessRequests(input.ownerUserId),
    run ? platform.computerToolEnabled(run) : true,
  ]);
  const grants = new Set(accessRequests.map((request) => request.requestedConnectionId));
  const onMacRequests = setupRequests.flatMap(({ kind, definitionId, runnerId, app, access }) =>
    kind === "app" && definitionId === computerUseDefinitionId && app
      ? [{ runnerId, app, access }]
      : [],
  );
  const holders = new Map(
    [...inventory.machines, ...inventory.phones].map(
      (machine) =>
        [
          machine.runnerId,
          platform.computerAppApprovals.computerAppHolders(machine.runnerId),
        ] as const,
    ),
  );
  const held = (runnerId: RunnerId, key: string) => {
    const holder = holders.get(runnerId)?.get(key);
    return holder && holder.runId !== run?.runId ? holder : null;
  };
  const versions = new Map(
    inventory.machines.map(
      (machine) => [machine.runnerId, platform.computerUseVersion(machine.runnerId)] as const,
    ),
  );
  const machineFacts = (machine: (typeof inventory.machines)[number]) => ({
    ...machine,
    computerToolEnabled: enabled,
    computerUseVersion: versions.get(machine.runnerId) ?? null,
  });
  const app = (
    machine: (typeof inventory.machines)[number],
    identity: { displayName: string; bundleId: string },
  ) => {
    const key = identity.bundleId.toLowerCase();
    const approved = machine.apps.find((entry) => entry.bundleId.toLowerCase() === key);
    const refs = approved ? computerToolRefs(tools, approved.connectionId) : {};
    return computerAppDiscovery({
      app: identity.displayName,
      computerId: machine.runnerId,
      machine: machineFacts(machine),
      approval: approved ?? null,
      callable: !!refs.observe,
      canAct: !!refs.act,
      pendingOnMac: onMacRequests.some(
        (request) =>
          request.runnerId === machine.runnerId && computerAppIdentityKey(request.app) === key,
      ),
      pendingPersonalGrant: !!approved && grants.has(approved.connectionId),
      heldByAnotherRun: held(machine.runnerId, key),
    });
  };
  const phone = (entry: (typeof inventory.phones)[number]) => {
    const refs = entry.connection ? computerToolRefs(tools, entry.connection.connectionId) : {};
    return phoneDiscovery({
      phone: {
        ...entry,
        computerId: entry.runnerId,
        computerToolEnabled: enabled,
      },
      connection: entry.connection,
      blockedByOwner: entry.blockedByOwner,
      callable: !!refs.observe,
      canAct: !!refs.act,
      pendingPhoneAccess: setupRequests.some(
        (request) =>
          request.kind === "app" &&
          request.definitionId === androidPhoneDefinitionId &&
          request.runnerId === entry.runnerId,
      ),
      pendingPersonalGrant: !!entry.connection && grants.has(entry.connection.connectionId),
      heldByAnotherRun: held(
        entry.runnerId,
        computerUseHolderKey({ kind: "display", definitionId: androidPhoneDefinitionId }),
      ),
    });
  };
  return {
    ...inventory,
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
            request.runnerId === machine.runnerId &&
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
    onMacRequests,
    app,
    phone,
    machine: (machine: (typeof inventory.machines)[number]) =>
      computerMachineProblem(machineFacts(machine)),
  };
}
