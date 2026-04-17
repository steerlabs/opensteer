import assert from "node:assert/strict";
import test from "node:test";
import { OpensteerSessionRuntime } from "./runtime.js";

test("OpensteerSessionRuntime uses the scoped observation session id when provided", async () => {
    const openedSessionIds: string[] = [];
    const runtime = new OpensteerSessionRuntime({
      name: "observation-test",
      engine: {} as never,
      observationSessionId: "root-session",
      observability: {
        profile: "baseline",
      },
      observationSink: {
        async openSession(input: { sessionId: string }) {
          openedSessionIds.push(input.sessionId);
          return {
            async appendEvents() {
              return [];
            },
            async appendArtifacts() {
              return [];
            },
            async close() {},
          } as never;
        },
      } as never,
    });

    await runtime.withObservationSessionId("controller-session", async () => {
      await runtime.setObservabilityConfig({
        profile: "diagnostic",
      });
    });

    assert.deepEqual(openedSessionIds, ["controller-session"]);
});

test("OpensteerSessionRuntime falls back to the fixed observation session id when no override is active", async () => {
    const openedSessionIds: string[] = [];
    const runtime = new OpensteerSessionRuntime({
      name: "observation-test",
      engine: {} as never,
      observationSessionId: "root-session",
      observability: {
        profile: "baseline",
      },
      observationSink: {
        async openSession(input: { sessionId: string }) {
          openedSessionIds.push(input.sessionId);
          return {
            async appendEvents() {
              return [];
            },
            async appendArtifacts() {
              return [];
            },
            async close() {},
          } as never;
        },
      } as never,
    });

    await runtime.setObservabilityConfig({
      profile: "diagnostic",
    });

    assert.deepEqual(openedSessionIds, ["root-session"]);
});
