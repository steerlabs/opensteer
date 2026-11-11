import { createDatabase } from "./connection.js";
import { OpensteerStore } from "./store.js";
import {
  describeStore,
  pendingEvent,
  testContinuationIdentity,
} from "./store.integration.test-support.js";
import { ownTestDatabaseProducer } from "./test-database.test-support.js";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { expect, vi, onTestFinished } from "vitest";

type Statement = { sql: string; parameters: unknown[] };

describeStore("Personal authority SQL parity", (it) => {
  it("preserves ordered admission and answer statements, transactions and locks", async ({
    storeFixture,
  }) => {
    let nextId = 0;
    const ids = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockImplementation(() => `99999999-9999-4999-8999-${String(++nextId).padStart(12, "0")}`);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
    onTestFinished(() => {
      ids.mockRestore();
      vi.useRealTimers();
    });
    const seed = await storeFixture.createRunFixture(
      "parity",
      {
        deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
        workspaceBacking: "local-directory",
      },
      "main",
    );
    const traces: Record<"admission" | "answer", Statement[]> = { admission: [], answer: [] };
    let capturing: "admission" | "answer" | null = null;
    const pool = new Pool({ connectionString: storeFixture.databaseUrl, max: 1 });
    pool.on("connect", (client) => {
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          if (capturing) {
            const query = args[0];
            if (typeof query !== "string")
              throw new Error("Unexpected database query representation");
            traces[capturing].push({
              sql: query,
              parameters: Array.isArray(args[1]) ? args[1] : [],
            });
          }
          return Reflect.apply(target, receiver, args);
        },
      });
    });
    const { database } = await ownTestDatabaseProducer(storeFixture.databaseUrl, async () => {
      const database = createDatabase({ connectionString: storeFixture.databaseUrl }, pool);
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    await pool.query("set track_functions = 'all'");
    const helperCalls = async () => {
      await pool.query("select pg_stat_force_next_flush()");
      const result = await pool.query<{ calls: string }>(
        "select coalesce(sum(calls), 0)::text as calls from pg_stat_user_functions where funcid = 'public.opensteer_stored_execution_authority()'::regprocedure",
      );
      const row = result.rows[0];
      if (!row) throw new Error("Authority helper statistics were not returned");
      return Number(row.calls);
    };
    const beforeAdmission = await helperCalls();
    let admissionHelperCalls = 0;
    let answerHelperCalls = 0;
    try {
      capturing = "admission";
      const turn = await store.enqueueThreadInput({
        content: [{ type: "text", text: "Run parity" }],
        idempotencyKey: "parity-turn",
        requestedBy: seed.userId,
        threadId: seed.thread.id,
        policy: "queue",
        source: { kind: "human" },
      });
      capturing = null;
      admissionHelperCalls = (await helperCalls()) - beforeAdmission;
      if (!turn.run || !turn.command) throw new Error("Run was not admitted");
      await store.claimCommand(turn.command.id, "parity-dispatcher");
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: seed.harnessInstance.id,
        leaseTokenHash: "parity-lease",
        membershipGeneration: 1,
        runnerBootId: "parity-boot",
        runnerId: seed.runnerId,
        runId: turn.run.id,
        threadId: seed.thread.id,
      });
      await store.commitRunnerEvent({
        environmentId: seed.environmentId,
        runnerBootId: "parity-boot",
        runnerId: seed.runnerId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          data: { status: "running" },
          environmentId: seed.environmentId,
          ordinal: 0,
          runId: turn.run.id,
          threadId: seed.thread.id,
          type: "run.started",
          workspaceId: seed.workspace.id,
        }),
      });
      const opened = await store.requests.create({
        callId: "parity-request",
        kind: "browser.access",
        mode: "durable",
        originatingRunId: turn.run.id,
        originatingThreadId: seed.thread.id,
        originatingWorkspaceId: seed.workspace.id,
        targetWorkspaceId: seed.workspace.id,
        requestedBy: seed.userId,
        requiredActor: "requester",
        payload: {
          kind: "browser.access",
          reason: "Choose access",
          suggestion: { kind: "user_choice" },
        },
        presentation: {
          kind: "external",
          title: "Choose access",
          subject: { id: seed.workspace.id, kind: "workspace" },
        },
      });
      const beforeAnswer = await helperCalls();
      capturing = "answer";
      const answer = await store.requests.resolveBrowserRequest({
        requestId: opened.request.id,
        resolvedBy: seed.userId,
        response: { kind: "external", value: { decision: "declined" } },
      });
      capturing = null;
      answerHelperCalls = (await helperCalls()) - beforeAnswer;
      expect(answer.request.status).toBe("declined");
    } finally {
      capturing = null;
    }
    console.info("Personal execution authority helper calls", {
      admission: admissionHelperCalls,
      answer: answerHelperCalls,
    });
    expect(admissionHelperCalls).toBeLessThanOrEqual(5);
    expect(answerHelperCalls).toBeLessThanOrEqual(5);
    const identifiers = new Map<string, string>();
    const normalized = JSON.stringify(traces)
      .replace(
        /(?:[a-z]+_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu,
        (id) => {
          if (!identifiers.has(id)) identifiers.set(id, `id-${identifiers.size + 1}`);
          return identifiers.get(id)!;
        },
      )
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/gu, "<time>");
    const expected = await readFile(
      new URL("./personal-authority-parity.expected.json", import.meta.url),
      "utf8",
    );
    expect(JSON.parse(normalized)).toEqual(JSON.parse(expected));
  });
});
