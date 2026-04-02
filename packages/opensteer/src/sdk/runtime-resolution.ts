import {
  DEFAULT_OPENSTEER_ENGINE,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import {
  assertProviderSupportsEngine,
  resolveOpensteerProvider,
  type OpensteerProviderOptions,
  type OpensteerResolvedProvider,
} from "../provider/config.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { resolveCloudConfig, type OpensteerCloudConfig } from "../cloud/config.js";
import { CloudSessionProxy } from "../cloud/session-proxy.js";
import { OpensteerRuntime, type OpensteerRuntimeOptions } from "./runtime.js";
import type { OpensteerDisconnectableRuntime } from "./semantic-runtime.js";

export interface OpensteerResolvedRuntimeConfig {
  readonly provider: OpensteerResolvedProvider;
  readonly cloud?: OpensteerCloudConfig;
}

export function resolveOpensteerRuntimeConfig(
  input: {
    readonly provider?: OpensteerProviderOptions;
    readonly environmentProvider?: string;
  } = {},
): OpensteerResolvedRuntimeConfig {
  const provider = resolveOpensteerProvider({
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.environmentProvider === undefined
      ? {}
      : { environmentProvider: input.environmentProvider }),
  });

  if (provider.mode === "cloud") {
    return {
      provider,
      cloud: resolveCloudConfig({
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.environmentProvider === undefined
          ? {}
          : { environmentProvider: input.environmentProvider }),
      })!,
    };
  }

  return { provider };
}

export function createOpensteerSemanticRuntime(
  input: {
    readonly runtimeOptions?: OpensteerRuntimeOptions;
    readonly engine?: OpensteerEngineName;
    readonly provider?: OpensteerProviderOptions;
  } = {},
): OpensteerDisconnectableRuntime {
  const runtimeOptions = input.runtimeOptions ?? {};
  const engine = input.engine ?? runtimeOptions.engineName ?? DEFAULT_OPENSTEER_ENGINE;
  const config = resolveOpensteerRuntimeConfig({
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(process.env.OPENSTEER_PROVIDER === undefined
      ? {}
      : { environmentProvider: process.env.OPENSTEER_PROVIDER }),
  });
  assertProviderSupportsEngine(config.provider.mode, engine);

  if (config.provider.mode === "cloud") {
    return new CloudSessionProxy(new OpensteerCloudClient(config.cloud!), {
      ...(runtimeOptions.rootDir === undefined ? {} : { rootDir: runtimeOptions.rootDir }),
      ...(runtimeOptions.rootPath === undefined ? {} : { rootPath: runtimeOptions.rootPath }),
      ...(runtimeOptions.workspace === undefined ? {} : { workspace: runtimeOptions.workspace }),
      ...(runtimeOptions.cleanupRootOnClose === undefined
        ? {}
        : { cleanupRootOnClose: runtimeOptions.cleanupRootOnClose }),
      ...(runtimeOptions.observability === undefined
        ? {}
        : { observability: runtimeOptions.observability }),
    });
  }

  return new OpensteerRuntime({
    ...runtimeOptions,
    engineName: engine,
  });
}
