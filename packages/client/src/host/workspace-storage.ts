import type { EnvironmentSummary } from "./client.js";

/**
 * Where a new Workspace's files can go, in the words every client asks it.
 *
 * The web dialog and the phone's sheet offer the same choice against the same
 * Host, so which computers qualify and how two same-named computers are told
 * apart live here rather than in either application.
 */

/** The computers that can hold a Workspace's folder on their own disk. */
export function workspaceStorageMachines(
  environments: readonly EnvironmentSummary[],
): EnvironmentSummary[] {
  return environments.filter((environment) =>
    environment.workspaceBackings.includes("local-directory"),
  );
}

/** A disabled form explains nothing; this says which of the two states it is. */
export function noWorkspaceStorageExplanation(machineCount: number): string {
  return machineCount === 0
    ? "No computer can hold a specialist's files yet. Add a computer that can run agents, then come back here."
    : "The computers that can hold a specialist's files are offline. Turn one on, then come back here.";
}

/**
 * Two computers a person named the same way are otherwise indistinguishable
 * here, and picking the wrong one puts the files on the wrong disk. The
 * disambiguator is the tail of the id — stable, so the same computer reads the
 * same way every time — and appears only where the names actually collide.
 */
export function machineChoiceLabel(
  machine: EnvironmentSummary,
  machines: readonly EnvironmentSummary[],
): string {
  const duplicated =
    machines.filter((candidate) => candidate.name === machine.name).length > 1
      ? ` · ${machine.id.slice(-6)}`
      : "";
  return `${machine.name}${duplicated}${machine.connected ? "" : " (offline)"}`;
}
