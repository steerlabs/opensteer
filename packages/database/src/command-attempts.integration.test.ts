import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import {
  beginCommandAttempt,
  recoverCommandAttempts,
  settleCommandAttempt,
} from "./command-attempts.js";
import { connectionAttempts, outstandingAttempts } from "./connection-disconnect.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("a connection's command acting outside the database (G4)", (test) => {
  test("is in its Disconnect set while it acts, which ends only with its evidence", async ({
    storeFixture: f,
  }) => {
    const owner = (await f.createRunFixture("command-attempts")).userId;
    const connections = new AgentConnectionStore(f.database);
    const record = await connections.create({
      userId: owner,
      label: "Commands agent",
      clientName: "Commands agent",
      accessMode: "full-access",
      resource: "https://home.test/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(record.id, `hash-${randomBytes(8).toString("hex")}`);
    const attempt = async (key: string) => {
      const begun = await beginCommandAttempt(f.database, {
        requestedBy: owner,
        callerKey: `connection:${record.id}`,
        connectionId: record.id,
        type: "machine.revoke",
        idempotencyKey: key,
      });
      if (begun.kind !== "begun") throw new Error("expected a new attempt");
      return begun.id;
    };
    const acting = await attempt("revoke-1");
    const cut = await attempt("revoke-2");
    await connections.revoke(owner, record.id);
    const outstanding = async () =>
      outstandingAttempts(await connectionAttempts(f.database, record.id))
        .filter((entry) => entry.kind === "command")
        .map((entry) => entry.id)
        .sort();
    // Disconnect shows both while they act, and does not end before their evidence.
    expect(await outstanding()).toEqual([acting, cut].sort());
    await settleCommandAttempt(f.database, acting, "done");
    expect(await outstanding()).toEqual([cut]);
    // One a restart cut off may have happened: unknown, its contact lost, and so it ends.
    expect(await recoverCommandAttempts(f.database)).toEqual({ recovered: 1 });
    expect(await outstanding()).toEqual([]);
    const ended = (await connectionAttempts(f.database, record.id)).find(
      (entry) => entry.id === cut,
    );
    expect(ended).toMatchObject({ kind: "command", handedOff: false });
    expect(ended?.contactLostAt).not.toBeNull();
  });
});

describeStore("a narrowed grant and a connection's command acting outside (K4)", (test) => {
  test("waits on its running command, as on its sessions, until the command's evidence", async ({
    storeFixture: f,
  }) => {
    const owner = (await f.createRunFixture("command-attempts-narrowed")).userId;
    const connections = new AgentConnectionStore(f.database);
    const record = await connections.create({
      userId: owner,
      label: "Narrowed agent",
      clientName: "Narrowed agent",
      accessMode: "full-access",
      resource: "https://home.test/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(record.id, `hash-${randomBytes(8).toString("hex")}`);
    const begun = await beginCommandAttempt(f.database, {
      requestedBy: owner,
      callerKey: `connection:${record.id}`,
      connectionId: record.id,
      type: "machine.revoke",
      idempotencyKey: "narrowed-1",
    });
    if (begun.kind !== "begun") throw new Error("expected a new attempt");
    // The person narrows the grant while it acts.
    await connections.update(owner, {
      connectionId: record.id,
      expectedRevision: 1,
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const outstanding = async () =>
      outstandingAttempts(await connectionAttempts(f.database, record.id))
        .filter((entry) => entry.kind === "command")
        .map((entry) => entry.id);
    expect(await outstanding()).toEqual([begun.id]);
    await settleCommandAttempt(f.database, begun.id, "done");
    expect(await outstanding()).toEqual([]);
  });
});

describeStore("one key, one attempt (K1)", (test) => {
  test("an earlier attempt of the key that is running or unknown is answered, never begun again", async ({
    storeFixture: f,
  }) => {
    const owner = (await f.createRunFixture("command-attempts-key")).userId;
    const input = (key: string) => ({
      requestedBy: owner,
      callerKey: "run:run_one-key",
      connectionId: null,
      type: "machine.revoke",
      idempotencyKey: key,
    });
    const first = await beginCommandAttempt(f.database, input("k-running"));
    expect(first).toMatchObject({ kind: "begun" });
    // While it is running, the same key sent again does not act.
    expect(await beginCommandAttempt(f.database, input("k-running"))).toEqual({
      kind: "prior",
      state: "running",
    });
    // Once it may have happened, never again.
    await settleCommandAttempt(f.database, (first as { id: string }).id, "unknown");
    expect(await beginCommandAttempt(f.database, input("k-running"))).toEqual({
      kind: "prior",
      state: "unknown",
    });
    // Done: the handler's own lookup replays it; no second attempt is recorded.
    const done = await beginCommandAttempt(f.database, input("k-done"));
    await settleCommandAttempt(f.database, (done as { id: string }).id, "done");
    expect(await beginCommandAttempt(f.database, input("k-done"))).toEqual({
      kind: "prior",
      state: "done",
    });
    // Failed: nothing happened, so it may be sent again.
    const failed = await beginCommandAttempt(f.database, input("k-failed"));
    await settleCommandAttempt(f.database, (failed as { id: string }).id, "failed");
    expect(await beginCommandAttempt(f.database, input("k-failed"))).toMatchObject({
      kind: "begun",
    });
    // Two at once: one begins, the other finds it.
    const both = await Promise.all([
      beginCommandAttempt(f.database, input("k-both")),
      beginCommandAttempt(f.database, input("k-both")),
    ]);
    expect(both.map((entry) => entry.kind).sort()).toEqual(["begun", "prior"]);
    expect(
      await f.database
        .selectFrom("commandAttempts")
        .select("state")
        .where("idempotencyKey", "=", "k-both")
        .execute(),
    ).toEqual([{ state: "running" }]);
  });
});
