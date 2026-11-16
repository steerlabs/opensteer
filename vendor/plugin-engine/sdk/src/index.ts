/**
 * PluginEngine SDK scaffold. Each contract area keeps its model, errors and
 * operations together. Both local and remote clients share this API.
 */
import { Effect } from "effect";
import { promisePluginEngine } from "./implementation/promise.ts";
import { Digest, SecureRandom } from "effect/crypto";
import type {
  PromisePluginEngine as PluginEngine,
  PluginEngineOptions,
  RemotePluginEngineOptions,
} from "./contracts/pluginEngine.ts";
import {
  createPluginEngine as createPluginEngineEffect,
  createRemotePluginEngine as createRemotePluginEngineEffect,
} from "./implementation/create.ts";

export * from "./contracts/index.ts";
export type { PromisePluginEngine as PluginEngine } from "./contracts/pluginEngine.ts";
export {
  runtimeAdapter,
  createAppRuntime,
  type AppRuntime,
  type ResolvedAppRuntime,
} from "./implementation/runtime.ts";
export { pluginEngineDatabase } from "./implementation/storage-migrations.ts";
export { makePluginEngineStorage, type PluginEngineDatabase } from "./implementation/storage.ts";
/** Create an in-process PluginEngine using caller-owned storage, runtime and credential encryption. */
export const createPluginEngine = (options: PluginEngineOptions): Promise<PluginEngine> =>
  Effect.runPromise(
    createPluginEngineEffect(options).pipe(
      Effect.provide([SecureRandom.layerWebCrypto, Digest.layerWebCrypto]),
      Effect.map(promisePluginEngine),
    ),
  );

/** Create a remote PluginEngine client. Currently rejects with NotImplemented until the transport is implemented. */
export const createRemotePluginEngine = (options: RemotePluginEngineOptions): Promise<PluginEngine> =>
  Effect.runPromise(createRemotePluginEngineEffect(options).pipe(Effect.map(promisePluginEngine)));

export * from "./contracts/workflows.ts";
