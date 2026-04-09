import {
  DEFAULT_OPENSTEER_ENGINE,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import type { OpensteerEnvironment } from "../env.js";
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
    readonly environment?: OpensteerEnvironment;
  } = {},
): OpensteerResolvedRuntimeConfig {
  const environment = input.environment ?? process.env;
  const provider = resolveOpensteerProvider({
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(environment.OPENSTEER_PROVIDER === undefined
      ? {}
      : { environmentProvider: environment.OPENSTEER_PROVIDER }),
  });

  if (provider.mode === "cloud") {
    return {
      provider,
      cloud: resolveCloudConfig({
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        environment,
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
    readonly environment?: OpensteerEnvironment;
  } = {},
): OpensteerDisconnectableRuntime {
  const runtimeOptions = input.runtimeOptions ?? {};
  const engine = input.engine ?? runtimeOptions.engineName ?? DEFAULT_OPENSTEER_ENGINE;
  const config = resolveOpensteerRuntimeConfig({
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
  assertProviderSupportsEngine(config.provider.mode, engine);

  if (config.provider.mode === "cloud") {
    return new CloudSessionProxy(new OpensteerCloudClient(config.cloud!), {
      ...(runtimeOptions.rootDir === undefined ? {} : { rootDir: runtimeOptions.rootDir }),
      ...(runtimeOptions.rootPath === undefined ? {} : { rootPath: runtimeOptions.rootPath }),
      ...(runtimeOptions.workspace === undefined ? {} : { workspace: runtimeOptions.workspace }),
      ...(runtimeOptions.policy === undefined ? {} : { policy: runtimeOptions.policy }),
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
