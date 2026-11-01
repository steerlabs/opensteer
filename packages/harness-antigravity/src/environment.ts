import { ensurePrivateDirectory, setFileMode } from "@opensteer/shared/privateFiles";
import { access, copyFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessProviderState } from "@opensteer/harness";
import type { AntigravityHarnessConfig, AntigravityAuthMethod } from "./config.js";
import type { PreparedAntigravityRuntime } from "./runtime.js";

export const antigravityBrowserMarker = "__OPENSTEER_ANTIGRAVITY_AUTH_URL__";
export const antigravityAuthStdoutPrefix =
  "Open the following link to authenticate the ACP server: ";

const removedEnvironmentKeys = new Set([
  "BROWSER",
  "CLOUDSDK_CORE_PROJECT",
  "ELECTRON_RUN_AS_NODE",
  "GCLOUD_PROJECT",
  "GEMINI_API_KEY",
  "GEMINI_HOME",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "ANTIGRAVITY_HARNESS_PATH",
  "PYTHONUNBUFFERED",
]);

const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${antigravityBrowserMarker}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`;

function quoteBrowserArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface AntigravityProfile {
  readonly acpDirectory: string;
  readonly browserCommand: string;
  readonly geminiHome: string;
  readonly tokenPath: string;
}

export interface AntigravityLaunch {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly profile: AntigravityProfile;
}

async function systemCaBundle(
  environment: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  for (const candidate of [
    environment.NIX_SSL_CERT_FILE,
    "/etc/ssl/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
  ]) {
    if (!candidate || !candidate.startsWith("/")) continue;
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next system location.
    }
  }
  return undefined;
}

export async function prepareAntigravityLaunch(input: {
  readonly apiKey?: string;
  readonly authMethod: AntigravityAuthMethod;
  readonly baseEnvironment: Readonly<Record<string, string>>;
  readonly config: AntigravityHarnessConfig;
  readonly nodeExecutable: string;
  readonly providerState: HarnessProviderState;
  readonly runtime: Pick<PreparedAntigravityRuntime, "executable" | "harness">;
}): Promise<AntigravityLaunch> {
  if (input.providerState.kind !== "isolated" || !input.providerState.providerHomeDirectory) {
    throw new Error("Antigravity requires an isolated account profile");
  }
  const geminiHome = resolve(input.providerState.providerHomeDirectory);
  const acpDirectory = join(geminiHome, "antigravity-acp");
  await ensurePrivateDirectory(geminiHome, "Antigravity profile must be a real directory");
  await ensurePrivateDirectory(acpDirectory, "Antigravity state must be a real directory");
  const gcp = {
    ...(input.config.gcpProject ? { project: input.config.gcpProject } : {}),
    ...(input.config.gcpLocation ? { location: input.config.gcpLocation } : {}),
  };
  await writeFile(
    join(acpDirectory, "settings.json"),
    `${JSON.stringify({
      auth: { type: input.authMethod },
      ...(Object.keys(gcp).length > 0 ? { gcp } : {}),
    })}\n`,
    { mode: 0o600 },
  );

  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.baseEnvironment)) {
    const upper = key.toUpperCase();
    if (!removedEnvironmentKeys.has(upper) && !upper.startsWith("AGY_ACP_")) {
      environment[key] = value;
    }
  }
  if (input.authMethod === "gemini-api-key" && input.apiKey) {
    environment.GEMINI_API_KEY = input.apiKey;
  } else if (input.authMethod === "agent-platform" && input.apiKey) {
    environment.GOOGLE_API_KEY = input.apiKey;
  }
  const browserCommand = [input.nodeExecutable, "-e", browserHelperSource, "--", "%s"]
    .map(quoteBrowserArgument)
    .join(" ");
  environment.AGY_ACP_FORCE_FILE_STORAGE = "1";
  environment.ANTIGRAVITY_HARNESS_PATH = input.runtime.harness;
  environment.BROWSER = browserCommand;
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.GEMINI_HOME = geminiHome;
  environment.PYTHONUNBUFFERED = "1";
  if (process.platform === "linux" && !environment.SSL_CERT_FILE && !environment.SSL_CERT_DIR) {
    const caBundle = await systemCaBundle(input.baseEnvironment);
    if (caBundle) environment.SSL_CERT_FILE = caBundle;
  }
  return {
    args: process.platform === "linux" ? ["--uid="] : [],
    environment,
    executable: input.runtime.executable,
    profile: {
      acpDirectory,
      browserCommand,
      geminiHome,
      tokenPath: join(acpDirectory, "acp_token.json"),
    },
  };
}

export async function prepareAntigravityTitleLaunch(
  input: Parameters<typeof prepareAntigravityLaunch>[0] & { readonly directory: string },
): Promise<AntigravityLaunch> {
  const profileDirectory = join(input.directory, "home");
  const launch = await prepareAntigravityLaunch({
    ...input,
    baseEnvironment: {
      ...input.baseEnvironment,
      CLOUDSDK_CONFIG: join(input.directory, "gcloud"),
      HOME: input.directory,
      XDG_CONFIG_HOME: join(input.directory, "config"),
      XDG_DATA_HOME: join(input.directory, "data"),
    },
    providerState: {
      ...input.providerState,
      privateStateRoot: input.directory,
      providerHomeDirectory: profileDirectory,
      store: { directory: profileDirectory, id: input.providerState.store.id },
    },
  });
  const authenticationFile =
    input.authMethod === "oauth-personal"
      ? "acp_token.json"
      : input.authMethod === "oauth-business"
        ? "acp_business_token.json"
        : undefined;
  if (authenticationFile && input.providerState.providerHomeDirectory) {
    try {
      await copyFile(
        join(input.providerState.providerHomeDirectory, "antigravity-acp", authenticationFile),
        join(launch.profile.acpDirectory, authenticationFile),
      );
      await setFileMode(join(launch.profile.acpDirectory, authenticationFile), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return launch;
}
