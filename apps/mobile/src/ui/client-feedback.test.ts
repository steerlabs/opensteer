import { controlledClientSession } from "@opensteer/client/test-support";
import { expect, it } from "vitest";
import { screenAction } from "./client-feedback.js";

it("says the verb of the latest spec under a key two verbs share", async () => {
  const session = controlledClientSession();
  session.change({ network: "offline", phase: "recovering" });
  const spec = (done: string) => ({ label: "restart the worker", done, execute: async () => {} });
  screenAction(session, "worker:1", spec("reopened"));
  const outcome = await screenAction(session, "worker:1", spec("resumed")).run(undefined);
  expect(outcome).toMatchObject({ kind: "not-sent", issue: { done: "resumed" } });
});
