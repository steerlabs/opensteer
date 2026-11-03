/** Programs receive ordinary process setup, never the Runner's service credentials. */
export function programEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
  ]) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}
