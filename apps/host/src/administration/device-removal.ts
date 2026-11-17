import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import {
  DeviceIdSchema,
  RunnerIdSchema,
  type DeviceId,
  type AuthenticatedSession,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { AdministrationDependencies } from "./administration-service.js";
import type { HostAuthenticator } from "../identity/auth.js";
import { notifyMachinesChanged } from "../shell/machine-access-events.js";

type Dependencies = AdministrationDependencies & { readonly authenticator: HostAuthenticator };
const membershipTurns = new WeakMap<OpensteerStore, KeyedMutationQueue>();
export function deviceMembershipTurn<T>(
  store: OpensteerStore,
  action: () => Promise<T>,
): Promise<T> {
  let turns = membershipTurns.get(store);
  if (!turns) {
    turns = new KeyedMutationQueue();
    membershipTurns.set(store, turns);
  }
  return turns.run("membership", action);
}

export async function finishDeviceRemoval(
  dependencies: Dependencies,
  runnerId: RunnerId | null,
  removed: Awaited<ReturnType<OpensteerStore["revokeRunner"]>>,
  afterResponse?: (effect: () => void) => void,
) {
  for (const deviceId of removed.removedDeviceIds)
    dependencies.computerApps.forgetDevice(deviceId, true);
  for (const binding of removed.detachedDeviceBindings)
    dependencies.computerApps.forgetDevice(binding.deviceId);
  if (runnerId) {
    await dependencies.shellControl.endMachineSessions(runnerId, "machine-revoked");
    await dependencies.runners.revoke(runnerId);
    dependencies.channels.relay.forget(runnerId);
    dependencies.computerApps.detachRunner(runnerId, "revoked");
  }
  await dependencies.computerApps.refreshDeviceDrivers();
  for (const sessionId of removed.closedBrowserSessions)
    dependencies.browser.abandonSession(sessionId);
  await dependencies.browser.profilesRemoved(removed.deletedBrowserProfiles);
  for (const event of [...removed.events, ...removed.requestEvents])
    dependencies.publishDeploymentEvent(event);
  if (removed.cancelledRequestIds.length) dependencies.integrations.continuations.notify();
  dependencies.authenticator.identity.announceSessionsEnded(removed.endedSessionIds, afterResponse);
  notifyMachinesChanged(dependencies.realtime, "machine.command");
}
function withRemovalAdmission<T>(
  dependencies: Dependencies,
  runnerId: RunnerId | null,
  deviceIds: readonly DeviceId[],
  action: () => Promise<T>,
) {
  return dependencies.computerApps.withDeviceAdmissions(deviceIds, () =>
    runnerId
      ? dependencies.shellControl.withMachineAdmission(runnerId, () =>
          dependencies.computerApps.withRunnerAdmission(runnerId, () =>
            dependencies.browser.withRunnerAdmission(runnerId, action),
          ),
        )
      : action(),
  );
}
async function removalDeviceIds(
  dependencies: Dependencies,
  runnerId: RunnerId,
): Promise<readonly DeviceId[]> {
  return (await dependencies.store.listDeviceDrivers({ runnerId })).map(
    (binding) => binding.deviceId,
  );
}
export async function removeDevice(
  dependencies: Dependencies,
  target: DeviceId | RunnerId,
  userId: UserId,
  options: Parameters<OpensteerStore["revokeRunner"]>[2] = {},
  afterResponse?: (effect: () => void) => void,
) {
  return deviceMembershipTurn(dependencies.store, async () => {
    const deviceId = DeviceIdSchema.parse(target);
    const runnerId =
      (await dependencies.store.listDeviceDrivers({ deviceId, includeDetached: true })).find(
        (binding) => binding.role === "self",
      )?.runnerId ?? null;
    const ids = runnerId
      ? [...new Set([deviceId, ...(await removalDeviceIds(dependencies, runnerId))])]
      : [deviceId];
    const removed = await withRemovalAdmission(dependencies, runnerId, ids, () =>
      dependencies.store.removeDevice(
        deviceId,
        userId,
        options.administration ? { administration: options.administration } : {},
      ),
    );
    await finishDeviceRemoval(dependencies, runnerId, removed, afterResponse);
  });
}
export async function removeSignedDevice(
  dependencies: Dependencies,
  proof: Parameters<OpensteerStore["leaveDevice"]>[0],
  afterResponse?: (effect: () => void) => void,
) {
  return deviceMembershipTurn(dependencies.store, async () => {
    const runnerId = RunnerIdSchema.parse(proof.runnerId);
    const result = await withRemovalAdmission(
      dependencies,
      runnerId,
      await removalDeviceIds(dependencies, runnerId),
      () => dependencies.store.leaveDevice(proof),
    );
    if (result.removed)
      await finishDeviceRemoval(dependencies, result.runnerId, result.removed, afterResponse);
    else notifyMachinesChanged(dependencies.realtime, "machine.command");
  });
}
export async function signOutDeviceSession(
  dependencies: Dependencies,
  session: AuthenticatedSession,
  sessionId: import("@opensteer/core").AuthSessionId,
  afterResponse?: (effect: () => void) => void,
) {
  return deviceMembershipTurn(dependencies.store, async () => {
    const binding = await dependencies.store.database
      .selectFrom("authSessions")
      .select("deviceId")
      .where("id", "=", sessionId)
      .where("userId", "=", session.user.id)
      .executeTakeFirst();
    const remove = () =>
      dependencies.store.revokeDeviceSession({ sessionId, userId: session.user.id });
    const runnerId = binding?.deviceId
      ? await dependencies.store.getDeviceSelfRunnerId(binding.deviceId)
      : null;
    const result = runnerId
      ? await withRemovalAdmission(
          dependencies,
          runnerId,
          await removalDeviceIds(dependencies, runnerId),
          remove,
        )
      : await remove();
    if (result.removed && result.runnerId)
      await finishDeviceRemoval(dependencies, result.runnerId, result.removed, afterResponse);
    else
      dependencies.authenticator.identity.announceSessionsEnded(
        result.endedSessionIds,
        afterResponse,
      );
  });
}

/** Membership → sorted Device turns → sorted Runner transport turns. */
export function changeDeviceDrivers<T>(
  dependencies: Pick<Dependencies, "store" | "computerApps">,
  input: { readonly deviceIds: readonly DeviceId[]; readonly runnerIds: readonly RunnerId[] },
  commit: () => Promise<T>,
): Promise<T> {
  return deviceMembershipTurn(dependencies.store, async () => {
    const bindings = await Promise.all(
      input.deviceIds.map((deviceId) => dependencies.store.listDeviceDrivers({ deviceId })),
    );
    return dependencies.computerApps.withDeviceAdmissions(input.deviceIds, async () => {
      const ids = [
        ...new Set([...input.runnerIds, ...bindings.flat().map(({ runnerId }) => runnerId)]),
      ].sort();
      const enter = (index: number): Promise<T> =>
        index < ids.length
          ? dependencies.computerApps.withRunnerAdmission(ids[index]!, () => enter(index + 1))
          : commit();
      const result = await enter(0);
      await dependencies.computerApps.refreshDeviceDrivers();
      return result;
    });
  });
}
