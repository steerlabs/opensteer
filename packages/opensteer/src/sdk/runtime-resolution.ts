import type { CloudBrowserProfilePreference } from "@opensteer/cloud-contracts";

import {
  DEFAULT_OPENSTEER_ENGINE,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import {
  assertExecutionModeSupportsEngine,
  resolveOpensteerExecutionMode,
  type OpensteerExecutionMode,
} from "../mode/config.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { resolveCloudConfig, type OpensteerCloudConfig } from "../cloud/config.js";
import { CloudSessionProxy } from "../cloud/session-proxy.js";
import { OpensteerRuntime, type OpensteerRuntimeOptions } from "./runtime.js";
import type { OpensteerDisconnectableRuntime } from "./semantic-runtime.js";

export interface OpensteerCloudOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly browserProfile?: CloudBrowserProfilePreference;
}

export interface OpensteerResolvedRuntimeConfig {
  readonly mode: OpensteerExecutionMode;
  readonly cloud?: OpensteerCloudConfig;
}

export function resolveOpensteerRuntimeConfig(
  input: {
    readonly cloud?: boolean | OpensteerCloudOptions;
    readonly environmentMode?: string;
    readonly mode?: OpensteerExecutionMode;
  } = {},
): OpensteerResolvedRuntimeConfig {
  const mode = resolveOpensteerExecutionMode({
    ...(input.mode === undefined ? {} : { explicit: input.mode }),
    cloud: input.cloud !== undefined && input.cloud !== false,
    ...(input.environmentMode === undefined ? {} : { environment: input.environmentMode }),
  });

  if (mode === "cloud") {
    return {
      mode,
      cloud: resolveCloudConfig({
        enabled: true,
        ...(typeof input.cloud === "object" ? input.cloud : {}),
        mode,
      })!,
    };
  }

  return { mode };
}

export function createOpensteerSemanticRuntime(
  input: {
    readonly runtimeOptions?: OpensteerRuntimeOptions;
    readonly engine?: OpensteerEngineName;
    readonly cloud?: boolean | OpensteerCloudOptions;
    readonly mode?: OpensteerExecutionMode;
  } = {},
): OpensteerDisconnectableRuntime {
  const runtimeOptions = input.runtimeOptions ?? {};
  const engine = input.engine ?? runtimeOptions.engineName ?? DEFAULT_OPENSTEER_ENGINE;
  const config = resolveOpensteerRuntimeConfig({
    ...(input.cloud === undefined ? {} : { cloud: input.cloud }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(process.env.OPENSTEER_MODE === undefined
      ? {}
      : { environmentMode: process.env.OPENSTEER_MODE }),
  });
  assertExecutionModeSupportsEngine(config.mode, engine);

  if (config.mode === "cloud") {
    return new CloudSessionProxy(new OpensteerCloudClient(config.cloud!), {
      ...(runtimeOptions.rootDir === undefined ? {} : { rootDir: runtimeOptions.rootDir }),
      ...(runtimeOptions.rootPath === undefined ? {} : { rootPath: runtimeOptions.rootPath }),
      ...(runtimeOptions.workspace === undefined ? {} : { workspace: runtimeOptions.workspace }),
      ...(runtimeOptions.cleanupRootOnClose === undefined
        ? {}
        : { cleanupRootOnClose: runtimeOptions.cleanupRootOnClose }),
    });
  }

  return new OpensteerRuntime({
    ...runtimeOptions,
    engineName: engine,
  });
}
