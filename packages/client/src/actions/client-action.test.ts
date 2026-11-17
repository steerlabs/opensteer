import { expect, it } from "vitest";
import { createClientAction, createClientActionFamily } from "./client-action.js";
import { controlledClientSession } from "../test-support/client-connection.js";
import { HostTransportError } from "../connections/host-transport-error.js";

it("decides not-sent synchronously and keeps lost acknowledgement uncertain after recovery", async () => {
  const session = controlledClientSession();
  let calls = 0;
  const action = createClientAction(session, {
    key: "tab:close:1",
    label: "close this tab",
    done: "closed",
    happened: "this tab closed",
    execute: async () => {
      calls++;
      throw new HostTransportError("timed-out");
    },
  });
  session.change({ phase: "recovering", network: "offline" });
  expect(action.preflight()?.kind).toBe("not-sent");
  expect((await action.run(undefined)).kind).toBe("not-sent");
  expect(calls).toBe(0);
  session.change({ phase: "ready", network: "online", readyRevision: 2 });
  expect((await action.run(undefined)).kind).toBe("unconfirmed");
  session.change({ phase: "recovering", epoch: 2 });
  session.change({ phase: "ready", readyRevision: 3 });
  expect(action.getSnapshot().outcome?.kind).toBe("unconfirmed");
  expect(calls).toBe(1);
  action.dispose();
});
it("keeps an entity's outcome in its family until authoritative reconciliation", async () => {
  const session = controlledClientSession();
  let accepted = false;
  const family = createClientActionFamily(session, {
    label: "close",
    execute: async () => {
      throw new HostTransportError("timed-out");
    },
    reconcile: async () => (accepted ? { kind: "confirmed", value: undefined } : null),
  });
  await family.for("one").run(undefined);
  expect(family.for("one").getSnapshot().outcome?.kind).toBe("unconfirmed");
  expect(family.for("two").getSnapshot().outcome).toBeNull();
  accepted = true;
  await family.for("one").reconcile();
  expect(family.for("one").getSnapshot().outcome?.kind).toBe("confirmed");
  family.dispose();
});
