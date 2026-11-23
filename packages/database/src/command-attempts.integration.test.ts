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
    const attempt = (key: string) =>
      beginCommandAttempt(f.database, {
        requestedBy: owner,
        callerKey: `connection:${record.id}`,
        connectionId: record.id,
        type: "machine.revoke",
        idempotencyKey: key,
      });
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
