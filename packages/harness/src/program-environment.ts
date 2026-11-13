import { selectEnvironment } from "@opensteer/shared/userEnvironment";

/** Programs receive ordinary process setup, never the Runner's service credentials. */
export function programEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return selectEnvironment(
    source,
    ["HOME", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "PATH", "SHELL", "TERM", "TMPDIR", "USER"],
    platform,
  );
}
