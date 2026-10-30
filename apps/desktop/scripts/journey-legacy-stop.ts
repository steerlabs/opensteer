import {
  realProcessIO,
  stopRegisteredGroups,
  verifiedGroup,
  type ProcessIdentity,
  type ProcessIO,
} from "./journey-processes.js";

// The legacy trap waits up to one second per cleanup pass, with additional process teardown.
export const LEGACY_CLEANUP_GRACE_MS = 5000;
export async function stopLegacyGroup(
  group: ProcessIdentity,
  io: ProcessIO = realProcessIO,
  graceMs = LEGACY_CLEANUP_GRACE_MS,
  now = Date.now,
): Promise<void> {
  if (verifiedGroup(group, io.processes())) io.signal(-group.pgid, "SIGTERM");
  const deadline = now() + graceMs;
  while (now() < deadline && verifiedGroup(group, io.processes())) {
    await io.pause(Math.min(50, Math.max(0, deadline - now())));
  }
  await stopRegisteredGroups({ groups: [group] }, io);
}
