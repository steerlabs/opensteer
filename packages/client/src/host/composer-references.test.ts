import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import { composerReferenceCandidates } from "./composer-references.js";

const fixture = new MockHostClient({ latencyMs: 0 });
const base = fixture.getSnapshot();
fixture.dispose();
it("offers held personal tasks, automations and computers once each", () => {
  const task = {
    ...base.threads[0]!,
    id: createId("thread"),
    purpose: "task" as const,
    title: "Recent ferry",
  };
  const automation = {
    id: createId("trigger"),
    name: "Ferry schedule",
    kind: "schedule" as const,
    paused: false,
    ended: false,
    taskId: null,
    nextFireAt: null,
  };
  const machine = { ...base.machines[0]!, id: createId("runner"), name: "Ferry computer" };
  const snapshot = {
    ...base,
    threads: [task],
    tasks: null,
    activeTasks: [{ thread: task, failure: null, lastReply: null }],
    doneTasks: {},
    threadAutomations: { [task.id]: [automation] },
    machines: [machine],
  };
  expect(composerReferenceCandidates(snapshot, "ferry").map(({ markdown }) => markdown)).toEqual([
    `[Recent ferry](opensteer:${task.id})`,
    `[Ferry schedule](opensteer:${automation.id})`,
    `[Ferry computer](opensteer:${machine.id})`,
  ]);
});
