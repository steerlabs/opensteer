import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { pluginGate } from "./plugin-gate.js";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
/** Let every forked fiber run until it waits. */
const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true });

describe("pluginGate", () => {
  it("runs executions together and a change alone, once they finish", () =>
    run(
      Effect.gen(function* () {
        const gate = pluginGate(5_000);
        const order: string[] = [];
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const running = yield* Effect.forkChild(
          gate.run(
            "p",
            Effect.gen(function* () {
              order.push("call:start");
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              order.push("call:end");
            }),
          ),
        );
        yield* Deferred.await(started);
        // A second execution starts while the first runs.
        yield* gate.run(
          "p",
          Effect.sync(() => order.push("second")),
        );
        const change = yield* Effect.forkChild(
          gate.change(
            "p",
            Effect.sync(() => order.push("change")),
          ),
        );
        yield* settle;
        // An execution that arrives while the change waits does not overtake it.
        const late = yield* Effect.forkChild(
          gate.run(
            "p",
            Effect.sync(() => order.push("late")),
          ),
        );
        yield* settle;
        expect(order).toEqual(["call:start", "second"]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        yield* Fiber.join(change);
        yield* Fiber.join(late);
        expect(order).toEqual(["call:start", "second", "call:end", "change", "late"]);
      }),
    ));

  it("gives up a change that waits too long for an execution, having run nothing of it", () =>
    run(
      Effect.gen(function* () {
        const gate = pluginGate(200);
        const release = yield* Deferred.make<void>();
        const waiting = yield* Effect.forkChild(gate.run("p", Deferred.await(release)));
        yield* settle;
        let changed = false;
        const exit = yield* Effect.exit(
          gate.change(
            "p",
            Effect.sync(() => {
              changed = true;
            }),
          ),
        );
        expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("PluginBusy");
        expect(changed).toBe(false);
        // Executions start again at once.
        expect(yield* gate.run("p", Effect.succeed("ran"))).toBe("ran");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(waiting);
      }),
    ));

  it("runs work an execution starts in its own plugin within it, while a change waits", () =>
    run(
      Effect.gen(function* () {
        const gate = pluginGate(5_000);
        const release = yield* Deferred.make<void>();
        const nested = yield* Deferred.make<string>();
        const outer = yield* Effect.forkChild(
          gate.run(
            "p",
            Effect.gen(function* () {
              yield* Deferred.await(release);
              yield* Deferred.succeed(nested, yield* gate.run("p", Effect.succeed("inner")));
            }),
          ),
        );
        yield* settle;
        const change = yield* Effect.forkChild(gate.change("p", Effect.void));
        yield* settle;
        yield* Deferred.succeed(release, undefined);
        expect(yield* Deferred.await(nested)).toBe("inner");
        yield* Fiber.join(outer);
        yield* Fiber.join(change);
      }),
    ));

  it("keeps one plugin's change from holding another plugin", () =>
    run(
      Effect.gen(function* () {
        const gate = pluginGate(5_000);
        const release = yield* Deferred.make<void>();
        const change = yield* Effect.forkChild(gate.change("p", Deferred.await(release)));
        yield* settle;
        expect(yield* gate.run("q", Effect.succeed("other"))).toBe("other");
        yield* gate.change("q", Effect.void);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(change);
      }),
    ));
});
