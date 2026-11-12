export const devicesRoute = "/settings/devices";

export function computerAppAnchorId(definitionId: string): string {
  return `computer-app-${definitionId}`;
}

export function deviceRoute(machineId: string): string {
  return `${devicesRoute}/${encodeURIComponent(machineId)}`;
}

/**
 * The one route to one app on one device. The Apps settings link here by
 * device and definition rather than carrying a second copy of its editor.
 */
export function deviceAppRoute(input: {
  readonly definitionId: string;
  readonly runnerId: string;
}): string {
  return `${deviceRoute(input.runnerId)}#${computerAppAnchorId(input.definitionId)}`;
}

/** The definition a `#computer-app-…` fragment names, if it names one. */
export function computerAppIdFromHash(hash: string): string | null {
  const bare = hash.startsWith("#") ? hash.slice(1) : hash;
  const prefix = computerAppAnchorId("");
  return bare.startsWith(prefix) && bare.length > prefix.length ? bare.slice(prefix.length) : null;
}
