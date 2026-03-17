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
import { resolveConnectConfig, type OpensteerConnectConfig } from "../connect/config.js";
import { createConnectedOpensteerEngineFactory } from "../connect/engine.js";
import { resolveCloudConfig, type OpensteerCloudConfig } from "../cloud/config.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { CloudSessionProxy } from "../cloud/session-proxy.js";
import type { OpensteerSemanticRuntime } from "../cli/dispatch.js";

export interface OpensteerCloudOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface OpensteerResolvedRuntimeConfig {
  readonly mode: OpensteerExecutionMode;
  readonly connect?: OpensteerConnectConfig;
  readonly cloud?: OpensteerCloudConfig;
}

export function resolveOpensteerRuntimeConfig(input: {
  readonly connect?: boolean | OpensteerConnectConfig;
  readonly cloud?: boolean | OpensteerCloudOptions;
  readonly environmentMode?: string;
} = {}): OpensteerResolvedRuntimeConfig {
  const environmentMode = input.environmentMode ?? process.env.OPENSTEER_MODE;
  const mode = resolveOpensteerExecutionMode({
    connect: input.connect !== undefined && input.connect !== false,
    cloud: input.cloud !== undefined && input.cloud !== false,
    ...(environmentMode === undefined ? {} : { environment: environmentMode }),
  });

  if (mode === "connect") {
    return {
      mode,
      connect: resolveConnectConfig({
        enabled: true,
        ...(typeof input.connect === "object" ? input.connect : {}),
        mode,
      })!,
    };
  }

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
  readonly connect?: boolean | OpensteerConnectConfig;
  readonly cloud?: boolean | OpensteerCloudOptions;
} = {}): OpensteerSemanticRuntime {
  const runtimeOptions = input.runtimeOptions ?? {};
  const engine = input.engine ?? DEFAULT_OPENSTEER_ENGINE;
  const config = resolveOpensteerRuntimeConfig({
    ...(input.connect === undefined ? {} : { connect: input.connect }),
    ...(input.cloud === undefined ? {} : { cloud: input.cloud }),
  });
  assertExecutionModeSupportsEngine(config.mode, engine);

  if (config.mode === "cloud") {
    return new CloudSessionProxy(new OpensteerCloudClient(config.cloud!), runtimeOptions.name);
  }

  if (config.mode === "connect") {
    return new OpensteerSessionRuntime({
      ...runtimeOptions,
      engineFactory: createConnectedOpensteerEngineFactory(config.connect!),
    });
  }

  return new OpensteerSessionRuntime({
    ...runtimeOptions,
    engineFactory:
      runtimeOptions.engineFactory
        ?? createOpensteerEngineFactory(engine),
  });
}
