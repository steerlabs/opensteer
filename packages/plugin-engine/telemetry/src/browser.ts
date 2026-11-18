import { Effect, Layer, ManagedRuntime } from "effect";
import { Atom } from "effect/reactivity";
export const browserSettings = (_basePath: string, _service: string) => Effect.void;
export const makeBrowserTelemetry = (_settings: Effect.Effect<void>) => {
  const memoMap = Layer.makeMemoMapUnsafe();
  return {
    runtime: ManagedRuntime.make(Layer.empty, { memoMap }),
    atoms: Atom.context({ memoMap }),
  };
};
