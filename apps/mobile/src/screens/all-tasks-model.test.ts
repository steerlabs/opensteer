import { allTasksRows, taskList, type HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { createId } from "@opensteer/core";
import { afterEach, expect, it } from "vitest";
import { allTasksFilterRows, allTasksView, needsYouCards } from "./all-tasks-model.js";

const clients: MockHostClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function mockHost(): MockHostClient {
  const client = new MockHostClient({ latencyMs: 0, quietTasksAvailable: true });
  clients.push(client);
  return client;
}

it("lists a read Done task once its Done page loads, though no open page holds it", async () => {
  const client = mockHost();
  const read = Object.values(client.getSnapshot().threadReadStates).find(
    (state) => state.unreadSequence === null,
  )!;
  await client.setTaskDone(read.threadId, true);
  await client.loadDoneTasks();
  const held = client.getSnapshot();
  // As the Host answers: the open-task pages never carry a Done task.
  const snapshot: HostSnapshot = {
    ...held,
    tasks: {
      ...held.tasks!,
      entries: held.tasks!.entries.filter(({ thread }) => thread.doneAt === null),
    },
  };
  expect(allTasksRows(taskList(snapshot), "done").map((row) => row.threadId)).not.toContain(
    read.threadId,
  );
  expect(allTasksFilterRows(allTasksView(snapshot), "done").map((row) => row.threadId)).toContain(
    read.threadId,
  );
});

it("draws one Needs you card per Request, even two from one task", () => {
  const held = mockHost().getSnapshot();
  const first = held.needsYou!.entries[0]!;
  const second = { ...first, request: { ...first.request, id: createId("request") } };
  const cards = needsYouCards({
    ...held,
    needsYou: { ...held.needsYou!, entries: [first, second] },
  });
  expect(cards.map((card) => [card.taskId, card.surface.request.id])).toEqual([
    [first.navigationThreadId, first.request.id],
    [first.navigationThreadId, second.request.id],
  ]);
});
