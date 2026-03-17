import type { CloudBrowserProfilePreference } from "@opensteer/cloud-contracts";
import {
  createOpensteerEngineFactory,
  DEFAULT_OPENSTEER_ENGINE,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import { OpensteerSessionRuntime, type OpensteerRuntimeOptions } from "./runtime.js";
import {
  assertExecutionModeSupportsEngine,
  resolveOpensteerExecutionMode,
  type OpensteerExecutionMode,
} from "../mode/config.js";
import { resolveCloudConfig, type OpensteerCloudConfig } from "../cloud/config.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { CloudSessionProxy } from "../cloud/session-proxy.js";
import type { OpensteerSemanticRuntime } from "../cli/dispatch.js";

export interface OpensteerCloudOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly browserProfile?: CloudBrowserProfilePreference;
}

export interface OpensteerResolvedRuntimeConfig {
  readonly mode: OpensteerExecutionMode;
  readonly cloud?: OpensteerCloudConfig;
}

export function resolveOpensteerRuntimeConfig(input: {
  readonly cloud?: boolean | OpensteerCloudOptions;
  readonly environmentMode?: string;
} = {}): OpensteerResolvedRuntimeConfig {
  const environmentMode = input.environmentMode ?? process.env.OPENSTEER_MODE;
  const mode = resolveOpensteerExecutionMode({
    cloud: input.cloud !== undefined && input.cloud !== false,
    ...(environmentMode === undefined ? {} : { environment: environmentMode }),
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

  return {
    mode,
  };
}

export function createOpensteerSemanticRuntime(input: {
  readonly runtimeOptions?: OpensteerRuntimeOptions;
  readonly engine?: OpensteerEngineName;
  readonly cloud?: boolean | OpensteerCloudOptions;
} = {}): OpensteerSemanticRuntime {
  const runtimeOptions = input.runtimeOptions ?? {};
  const engine = input.engine ?? DEFAULT_OPENSTEER_ENGINE;
  const config = resolveOpensteerRuntimeConfig({
    ...(input.cloud === undefined ? {} : { cloud: input.cloud }),
  });
  assertExecutionModeSupportsEngine(config.mode, engine);

  if (config.mode === "cloud") {
    return new CloudSessionProxy(new OpensteerCloudClient(config.cloud!), runtimeOptions.name);
  }

  return new OpensteerSessionRuntime({
    ...runtimeOptions,
    engineFactory:
      runtimeOptions.engineFactory
        ?? createOpensteerEngineFactory(engine),
  });
}
