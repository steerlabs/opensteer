import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  harnessExecutableEnvironmentVariable,
  harnessKindRecord,
  shippedHarnessCatalogEntry,
  type HarnessKind,
} from "@opensteer/core";
import { z } from "zod";
import { defaultHarnessExecutable } from "./harness/harness-drivers.js";

const defaultNativeFsHelperBinary = fileURLToPath(
  new URL(
    `../native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);
const defaultAgentSkillsDirectory = fileURLToPath(new URL("../agent-skills", import.meta.url));
const defaultBrowserHarnessExecutable = fileURLToPath(
  new URL("../browser-harness/browser-harness.mjs", import.meta.url),
);

/**
 * What every Runner shape needs. The assets only an agents Runner starts are
 * parsed separately by {@link parseAgentExecutionConfig}, so a reach-only
 * Runner is never asked to resolve a harness it will not run.
 */
const RunnerApplicationEnvironmentSchema = z.object({
  OPENSTEER_NATIVE_FS_HELPER: z
    .string()
    .trim()
    .min(1)
    .refine(isAbsolute, "OPENSTEER_NATIVE_FS_HELPER must be an absolute path")
    .default(defaultNativeFsHelperBinary),
  OPENSTEER_LOCAL_WORKSPACE_LEGACY_REGISTRY_PATH: z
    .string()
    .trim()
    .min(1)
    .refine(isAbsolute, "OPENSTEER_LOCAL_WORKSPACE_LEGACY_REGISTRY_PATH must be an absolute path")
    .optional(),
  OPENSTEER_OPENSSL_BINARY: z.string().trim().min(1).default("openssl"),
  OPENSTEER_RUNNER_READINESS_PATH: z
    .string()
    .trim()
    .min(1)
    .refine(isAbsolute, "OPENSTEER_RUNNER_READINESS_PATH must be an absolute path")
    .optional(),
});

export interface RunnerApplicationConfig {
  readonly nativeFsHelperBinary: string;
  readonly localWorkspaceLegacyRegistryPath?: string;
  readonly opensslBinary: string;
  readonly readinessPath?: string;
}

export function parseRunnerApplicationConfig(
  environment: NodeJS.ProcessEnv,
): RunnerApplicationConfig {
  const parsed = RunnerApplicationEnvironmentSchema.parse(environment);
  return {
    nativeFsHelperBinary: parsed.OPENSTEER_NATIVE_FS_HELPER,
    ...(parsed.OPENSTEER_LOCAL_WORKSPACE_LEGACY_REGISTRY_PATH
      ? { localWorkspaceLegacyRegistryPath: parsed.OPENSTEER_LOCAL_WORKSPACE_LEGACY_REGISTRY_PATH }
      : {}),
    opensslBinary: parsed.OPENSTEER_OPENSSL_BINARY,
    ...(parsed.OPENSTEER_RUNNER_READINESS_PATH
      ? { readinessPath: parsed.OPENSTEER_RUNNER_READINESS_PATH }
      : {}),
  };
}

/**
 * Provider-engine login state belongs to the selected Runner's local CLI and
 * is inherited only through the harness runtime boundary. Scrub obsolete
 * Opensteer-native model secrets so they cannot become a second auth path.
 */
export function consumeRunnerApplicationConfig(
  environment: NodeJS.ProcessEnv,
): RunnerApplicationConfig {
  try {
    return parseRunnerApplicationConfig(environment);
  } finally {
    delete environment.OPENSTEER_NATIVE_MODEL;
    delete environment.OPENSTEER_NATIVE_MODEL_BASE_URL;
    delete environment.OPENSTEER_NATIVE_MODEL_API_KEY;
    delete environment.OPENSTEER_NATIVE_MODEL_API_KEY_FILE;
  }
}

/**
 * The execution assets an agents Runner starts. Every distribution names its
 * harness executables (the Personal runtime, a lent computer's install script,
 * the desktop worker); the defaults resolve the packages the Runner itself
 * declares, which is what a source tree or the container runs, and they are
 * evaluated only when nothing named an executable.
 */
const AgentExecutionEnvironmentSchema = z.object({
  OPENSTEER_AGENT_SKILLS_DIRECTORY: z
    .string()
    .trim()
    .min(1)
    .refine(isAbsolute, "OPENSTEER_AGENT_SKILLS_DIRECTORY must be an absolute path")
    .default(defaultAgentSkillsDirectory),
  OPENSTEER_BROWSER_HARNESS: z
    .string()
    .trim()
    .min(1)
    .refine(isAbsolute, "OPENSTEER_BROWSER_HARNESS must be an absolute path")
    .default(defaultBrowserHarnessExecutable),
});

/**
 * One `OPENSTEER_<KIND>_EXECUTABLE` per catalog entry, folded rather than
 * listed, so an engine added to the catalog is configurable without a second
 * edit here.
 *
 * Every distribution that ships an engine's bytes names them, and the default
 * is the driver package's own resolution of the dependency those bytes arrive
 * in. An `installed` engine ships no bytes, so no distribution names one and
 * the variable is never set: its default is the installed command or documented install location,
 * which is a place to look rather than a file that must exist — the driver
 * reports it unavailable when the person has not installed the engine.
 */
const harnessExecutableSchemas = harnessKindRecord((kind) => {
  const variable = harnessExecutableEnvironmentVariable(kind);
  if (shippedHarnessCatalogEntry(kind).runtime.shape === "downloaded") {
    return z.literal("").default("");
  }
  return z
    .string()
    .trim()
    .min(1)
    .refine(isAbsolute, `${variable} must be an absolute path`)
    .default(() => defaultHarnessExecutable(kind));
});

export interface AgentExecutionConfig {
  readonly agentSkillsDirectory: string;
  readonly browserHarnessExecutable: string;
  readonly harnessExecutables: Record<HarnessKind, string>;
}

export function parseAgentExecutionConfig(environment: NodeJS.ProcessEnv): AgentExecutionConfig {
  const parsed = AgentExecutionEnvironmentSchema.parse(environment);
  return {
    agentSkillsDirectory: parsed.OPENSTEER_AGENT_SKILLS_DIRECTORY,
    browserHarnessExecutable: parsed.OPENSTEER_BROWSER_HARNESS,
    harnessExecutables: harnessKindRecord((kind) => {
      const value =
        shippedHarnessCatalogEntry(kind).runtime.shape === "downloaded"
          ? undefined
          : environment[harnessExecutableEnvironmentVariable(kind)];
      return harnessExecutableSchemas[kind].parse(value);
    }),
  };
}
