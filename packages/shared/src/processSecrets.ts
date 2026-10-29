import { readFileSync } from "node:fs";

/**
 * Secrets a supervisor hands a child process without putting them in its
 * environment.
 *
 * A process's startup environment stays readable for its whole life by any
 * other process of the same user (`ps -E` on macOS reads it from the kernel),
 * whatever the process later deletes from `process.env`. So a supervisor that
 * starts a service with a credential writes the credentials as one JSON object
 * — `{ VARIABLE: value }`, in the variable names the service's configuration
 * already reads — to a descriptor the child inherits, names that descriptor
 * here, and the service reads it once before it parses its configuration.
 */
export const processSecretsDescriptorVariable = "OPENSTEER_SECRETS_FD";

/** Far more than a handful of tokens; a bound on what one read may allocate. */
const maximumSecretsBytes = 64 * 1_024;

export type ProcessSecrets = Readonly<Record<string, string>>;

export function encodeProcessSecrets(secrets: ProcessSecrets): string {
  return JSON.stringify(secrets);
}

/**
 * Reads the secrets the supervisor wrote to the descriptor `environment` names,
 * or nothing when it names none. It reads to end of file, so it is read once:
 * the variable is removed as it is read, and a second call finds nothing to
 * read rather than an empty descriptor it would mistake for no secrets.
 */
export function readProcessSecrets(environment: NodeJS.ProcessEnv): ProcessSecrets {
  const named = environment[processSecretsDescriptorVariable];
  delete environment[processSecretsDescriptorVariable];
  if (named === undefined || named === "") return {};
  if (!/^(0|[1-9][0-9]{0,3})$/u.test(named)) {
    throw new Error(`${processSecretsDescriptorVariable} must name an inherited file descriptor`);
  }
  let raw: string;
  try {
    raw = readFileSync(Number(named), "utf8");
  } catch (error) {
    throw new Error(`${processSecretsDescriptorVariable}=${named} could not be read`, {
      cause: error,
    });
  }
  return decodeProcessSecrets(raw);
}

export function decodeProcessSecrets(raw: string): ProcessSecrets {
  if (Buffer.byteLength(raw, "utf8") > maximumSecretsBytes) {
    throw new Error("The process secrets are larger than any set of credentials");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("The process secrets are not a JSON object");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("The process secrets are not a JSON object");
  }
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(decoded)) {
    if (typeof value !== "string") {
      throw new Error(`The process secret ${name} is not a string`);
    }
    secrets[name] = value;
  }
  return secrets;
}
