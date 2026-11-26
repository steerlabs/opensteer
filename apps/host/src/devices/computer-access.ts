import type { CallableIntegrationTool, IntegrationRequester } from "@opensteer/database";
import {
  OpensteerError,
  type Blocked,
  type RunId,
  type DeviceId,
} from "@opensteer/core";
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
    readonly store: Pick<DeviceService["store"], "requesterShown">;
  },
  input: IntegrationRequester & {
    readonly runId?: RunId;
    /** A connected agent, which drives what it was granted through `computer_use` itself. */
    readonly direct?: true;
  },
  run?: RunCapabilityClaims<string>,
  callableTools?: readonly CallableIntegrationTool[],
) {
  const hasRun = !!(run || input.runId || input.direct);
  // A connected agent: its own discovery, its session's scripts, or its direct call.
  const connectedAgent =
    !!input.direct ||
    input.connectionId !== undefined ||
    input.agentBindingId?.startsWith("session:") === true;
  const [ownerInventory, tools, ownerSetupRequests, ownerAccessRequests, enabled] =
    await Promise.all([
      platform.computerAppApprovals.computerUseInventory(input.ownerUserId),
      callableTools ?? platform.listCallableTools(input),
      platform.store.listDeviceComputerAppSetupRequests(input.ownerUserId),
      platform.store.integrationRequests.listPendingIntegrationAccessRequests(input.ownerUserId),
      run ? platform.computerToolEnabled(run) : hasRun,
    ]);
  // Under a connection's grant, an approval on the person's devices is shown only as the one rule
  // lends it now (`grantedDeviceApprovals`): one blocked, on a removed device, made again as a new
  // row, or outside the grant is not there at all. A selected grant learns only the Devices it
  // names apps of, and the person's pending setup is none of its business.
  const shown = await platform.store.requesterShown(input);
  const grant = shown?.grant ?? null;
  const selected = grant?.scope === "selected" ? grant : null;
  const lent = shown && new Set(shown.approvals.map(({ id }) => id.toLowerCase()));
  const lends = (approvalId: string | null | undefined) =>
    !lent || (approvalId !== null && approvalId !== undefined && lent.has(approvalId.toLowerCase()));
  const machines = lent
    ? ownerInventory.machines.flatMap((machine) => {
        const apps = machine.apps.filter((app) => lends(app.connectionId));
        return apps.length || !selected ? [{ ...machine, apps }] : [];
      })
    : ownerInventory.machines;
  const grantedMacs = new Set(
    machines
      .filter((machine) => machine.apps.some((app) => app.status === "approved"))
      .map((machine) => machine.deviceId),
  );
  const inventory = lent
    ? {
        ...ownerInventory,
        machines,
        phones: await Promise.all(
          ownerInventory.phones
            .filter((phone) => {
              const approvalId = phone.connectionId ?? phone.connection?.connectionId;
              // A phone no approval is made for yet stays for a grant of everything, as its Mac.
              return approvalId
                ? isPhoneDisplayDefinitionId(phone.definitionId) && lends(approvalId)
                : !selected;
            })
            .map(async ({ setup, ...phone }) => {
              if (!selected || setup?.location !== "driver-mac")
                return { ...phone, ...(setup ? { setup } : {}) };
              const deviceId = grantedMacs.size
                ? await platform.store
                    .requireSelfDeviceId(setup.driverRunnerId)
                    .catch((error: unknown) => {
                      if (error instanceof OpensteerError && error.code === "not_found")
                        return null;
                      throw error;
                    })
                : null;
              return { ...phone, ...(deviceId && grantedMacs.has(deviceId) ? { setup } : {}) };
            }),
        ),
      }
    : ownerInventory;
  const setupRequests = selected ? [] : ownerSetupRequests;
  const accessRequests = selected ? [] : ownerAccessRequests;
  const runRequired: { blocked: Blocked; access?: never } = {
    blocked: {
      code: "unavailable",
      message: "Only a running task can operate phones and Mac apps.",
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
      canAct: input.direct ? approved?.access === "read-write" : !!refs.act,
      pendingOnMac: onMacRequests.some(
        (request) =>
          request.deviceId === machine.deviceId && computerAppIdentityKey(request.app) === key,
      ),
      pendingPersonalGrant: !!approved && grants.has(approved.connectionId),
      heldByAnotherRun: held(machine.deviceId, key),
      connectedAgent,
    });
  };
  const phone = (entry: (typeof inventory.phones)[number]) => {
    const refs = entry.connection ? computerToolRefs(tools, entry.connection.connectionId) : {};
    if (!hasRun) return runRequired;
    const access = phoneDiscovery({
      phone: {
        ...entry,
        definitionId: entry.definitionId === "iphone-screen" ? "iphone-screen" : "android-phone",
        computerId: entry.deviceId,
        computerToolEnabled: enabled,
      },
      connection: entry.connection,
      blockedByOwner: entry.blockedByOwner,
      callable: !!refs.observe,
      canAct: input.direct ? entry.connection?.access === "read-write" : !!refs.act,
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
      connectedAgent,
    });
    const reason = entry.availability?.reason?.kind;
    return entry.definitionId === "iphone-screen" && reason && access.access
      ? { ...access, lastKnown: reason }
      : access;
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
