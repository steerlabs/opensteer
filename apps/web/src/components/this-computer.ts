/**
 * The Runner of the computer this window runs on, for the selected Home: the
 * desktop's own Runner for a Home elsewhere, or the Home's own Runner when
 * this Mac hosts the Home, which has no Runner of the desktop's beside it.
 * Null in a browser that is not the desktop app, which proves no computer.
 */
export function thisComputerRunnerId(input: {
  readonly hostingRunnerId: string | null;
  readonly localRunnerId: string | null;
}): string | null {
  return input.localRunnerId ?? input.hostingRunnerId;
}
