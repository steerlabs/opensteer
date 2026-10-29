export const defaultWebPort = 43_100;

export function resolveWebPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return defaultWebPort;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("OPENSTEER_WEB_PORT must be an integer from 1024 through 65535");
  }
  return port;
}
