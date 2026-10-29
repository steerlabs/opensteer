/**
 * Keeps a signal from opening an inspector in this process.
 *
 * Node starts its inspector on SIGUSR1, and through an inspector any program
 * running as this user can read the process's memory. The local Runner holds
 * its bridge tokens there, and the computer use token drives a helper that
 * holds two macOS grants. A Node started from a command line this app writes
 * gets `--disable-sigusr1`; the local Runner is an Electron utility process,
 * whose Node is started by Electron, so it refuses the signal itself: any
 * listener replaces Node's default action, and this one does nothing.
 */
export function refuseInspectorSignal(target: Pick<NodeJS.Process, "on">): void {
  target.on("SIGUSR1", ignoreInspectorSignal);
}

function ignoreInspectorSignal(): void {
  // Deliberately empty: receiving the signal is the whole of what it may do.
}
