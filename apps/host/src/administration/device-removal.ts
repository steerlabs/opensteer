import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import type { AuthenticatedSession, RunnerId, UserId } from "@opensteer/core";
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

async function finishRemoval(
  dependencies: Dependencies,
  runnerId: RunnerId,
  removed: Awaited<ReturnType<OpensteerStore["revokeRunner"]>>,
  afterResponse?: (effect: () => void) => void,
) {
  await dependencies.shellControl.endMachineSessions(runnerId, "machine-revoked");
  await dependencies.runners.revoke(runnerId);
  dependencies.channels.relay.forget(runnerId);
  dependencies.computerApps.detachRunner(runnerId, "revoked");
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
  runnerId: RunnerId,
  action: () => Promise<T>,
) {
  return dependencies.shellControl.withMachineAdmission(runnerId, () =>
    dependencies.computerApps.withRunnerAdmission(runnerId, () =>
      dependencies.browser.withRunnerAdmission(runnerId, action),
    ),
  );
}
export async function removeDevice(
  dependencies: Dependencies,
  runnerId: RunnerId,
  userId: UserId,
  options: Parameters<OpensteerStore["revokeRunner"]>[2] = {},
  afterResponse?: (effect: () => void) => void,
) {
  return deviceMembershipTurn(dependencies.store, async () => {
    const removed = await withRemovalAdmission(dependencies, runnerId, () =>
      dependencies.store.revokeRunner(runnerId, userId, options),
    );
    await finishRemoval(dependencies, runnerId, removed, afterResponse);
  });
}
export async function removeSignedDevice(
  dependencies: Dependencies,
  proof: Parameters<OpensteerStore["leaveDevice"]>[0],
  afterResponse?: (effect: () => void) => void,
) {
  return deviceMembershipTurn(dependencies.store, async () => {
    const result = await withRemovalAdmission(dependencies, proof.runnerId as RunnerId, () =>
      dependencies.store.leaveDevice(proof),
    );
    if (result.removed)
      await finishRemoval(dependencies, result.runnerId, result.removed, afterResponse);
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
    const result = binding?.deviceId
      ? await withRemovalAdmission(dependencies, binding.deviceId, remove)
      : await remove();
    if (result.removed && result.runnerId)
      await finishRemoval(dependencies, result.runnerId, result.removed, afterResponse);
    else
      dependencies.authenticator.identity.announceSessionsEnded(
        result.endedSessionIds,
        afterResponse,
      );
  });
}
