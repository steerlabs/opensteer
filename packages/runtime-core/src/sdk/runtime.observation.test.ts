import assert from "node:assert/strict";
import test from "node:test";
import type { ObservationSink, SessionObservationSink } from "@opensteer/protocol";
import { OpensteerSessionRuntime } from "./runtime.js";

function createObservationRuntime() {
  const openedSessionIds: string[] = [];
  const closedSessionIds: string[] = [];
  const observationSink = {
    async openSession(input: { sessionId: string }) {
      openedSessionIds.push(input.sessionId);
      return {
        sessionId: input.sessionId,
        async append(): Promise<never> {
          throw new Error("append should not be called in observation session tests");
        },
        async appendBatch() {
          return [];
        },
        async writeArtifact(): Promise<never> {
          throw new Error("writeArtifact should not be called in observation session tests");
        },
        async flush() {},
        async close() {
          closedSessionIds.push(input.sessionId);
        },
      } satisfies SessionObservationSink;
    },
  } satisfies ObservationSink;
  const runtime = new OpensteerSessionRuntime({
    name: "observation-test",
    engine: {} as never,
    observationSessionId: "root-session",
    observability: {
      profile: "baseline",
    },
    observationSink,
  });

  return {
    runtime,
    openedSessionIds,
    closedSessionIds,
  };
}

async function ensureObservationSession(
  runtime: OpensteerSessionRuntime,
): Promise<{ readonly sessionId: string } | undefined> {
  // @ts-expect-error exercising a private helper for regression coverage
  return await runtime.ensureObservationSession();
}

test("OpensteerSessionRuntime uses the scoped observation session id when provided", async () => {
  const { runtime, openedSessionIds } = createObservationRuntime();

  await runtime.withObservationSessionId("controller-session", async () => {
    await runtime.setObservabilityConfig({
      profile: "diagnostic",
    });
  });

  assert.deepEqual(openedSessionIds, ["controller-session"]);
});

test("OpensteerSessionRuntime falls back to the fixed observation session id when no override is active", async () => {
  const { runtime, openedSessionIds } = createObservationRuntime();

  await runtime.setObservabilityConfig({
    profile: "diagnostic",
  });

  assert.deepEqual(openedSessionIds, ["root-session"]);
});

test("OpensteerSessionRuntime resolves scoped observation sessions even after the root session was opened", async () => {
  const { runtime, openedSessionIds } = createObservationRuntime();

  await runtime.setObservabilityConfig({
    profile: "diagnostic",
  });

  const scopedObservationSession = await runtime.withObservationSessionId(
    "controller-session",
    () => ensureObservationSession(runtime),
  );

  assert.equal(scopedObservationSession?.sessionId, "controller-session");
  assert.deepEqual(openedSessionIds, ["root-session", "controller-session"]);
});

test("OpensteerSessionRuntime restores the root observation session after a scoped override ends", async () => {
  const { runtime, openedSessionIds } = createObservationRuntime();

  const scopedObservationSession = await runtime.withObservationSessionId(
    "controller-session",
    () => ensureObservationSession(runtime),
  );
  const rootObservationSession = await ensureObservationSession(runtime);

  assert.equal(scopedObservationSession?.sessionId, "controller-session");
  assert.equal(rootObservationSession?.sessionId, "root-session");
  assert.deepEqual(openedSessionIds, ["controller-session", "root-session"]);
});

test("OpensteerSessionRuntime can explicitly suppress observation inside a scoped block", async () => {
  const { runtime, openedSessionIds } = createObservationRuntime();

  await runtime.setObservabilityConfig({
    profile: "diagnostic",
  });

  const scopedObservationSession = await runtime.withoutObservationSession(() =>
    ensureObservationSession(runtime),
  );

  assert.equal(scopedObservationSession, undefined);
  assert.deepEqual(openedSessionIds, ["root-session"]);
});

test("OpensteerSessionRuntime rejects undefined observation session ids from untyped callers", async () => {
  const { runtime, openedSessionIds } = createObservationRuntime();

  await assert.rejects(() => {
    // @ts-expect-error exercising an untyped caller passing undefined
    return runtime.withObservationSessionId(undefined, async () => {});
  }, TypeError);

  assert.deepEqual(openedSessionIds, []);
});

test("OpensteerSessionRuntime closes every observation session opened during its lifetime", async () => {
  const { runtime, closedSessionIds } = createObservationRuntime();

  await ensureObservationSession(runtime);
  await runtime.withObservationSessionId("controller-session", async () => {
    await ensureObservationSession(runtime);
  });

  await runtime.close();

  assert.deepEqual(closedSessionIds.sort(), ["controller-session", "root-session"]);
});
