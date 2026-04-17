import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConfigureObservationSessionInput,
  ObservationSink,
  SessionObservationSink,
} from "@opensteer/protocol";
import { OpensteerSessionRuntime } from "./runtime.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

function createObservationRuntime() {
  const openedSessionIds: string[] = [];
  const closedSessionIds: string[] = [];
  const configuredSessions: Array<{ sessionId: string; profile: string | undefined }> = [];
  const observationSink = {
    async openSession(input: { sessionId: string }) {
      openedSessionIds.push(input.sessionId);
      return {
        sessionId: input.sessionId,
        async configure(nextInput: ConfigureObservationSessionInput) {
          configuredSessions.push({
            sessionId: input.sessionId,
            profile: nextInput.config?.profile,
          });
        },
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
    configuredSessions,
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

test("OpensteerSessionRuntime reconfigures an open observation session without reopening it", async () => {
  const { runtime, openedSessionIds, configuredSessions, closedSessionIds } =
    createObservationRuntime();

  await runtime.setObservabilityConfig({
    profile: "baseline",
  });
  await runtime.setObservabilityConfig({
    profile: "diagnostic",
  });
  await runtime.close();

  assert.deepEqual(openedSessionIds, ["root-session"]);
  assert.deepEqual(configuredSessions, [
    {
      sessionId: "root-session",
      profile: "diagnostic",
    },
  ]);
  assert.deepEqual(closedSessionIds, ["root-session"]);
});

test("OpensteerSessionRuntime does not open an observation session when observability is off", async () => {
  const { runtime, openedSessionIds } = createObservationRuntime();

  await runtime.setObservabilityConfig({
    profile: "off",
  });

  assert.deepEqual(openedSessionIds, []);
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

test("OpensteerSessionRuntime deduplicates concurrent observation session opens", async () => {
  const openStarted = createDeferred<void>();
  const releaseOpen = createDeferred<void>();
  const openedSessionIds: string[] = [];
  const observationSink = {
    async openSession(input: { sessionId: string }) {
      openedSessionIds.push(input.sessionId);
      openStarted.resolve();
      await releaseOpen.promise;
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
        async close() {},
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

  const firstObservationSession = ensureObservationSession(runtime);
  await openStarted.promise;
  const secondObservationSession = ensureObservationSession(runtime);
  releaseOpen.resolve();

  const [first, second] = await Promise.all([firstObservationSession, secondObservationSession]);

  assert.equal(first?.sessionId, "root-session");
  assert.equal(second?.sessionId, "root-session");
  assert.deepEqual(openedSessionIds, ["root-session"]);
});
