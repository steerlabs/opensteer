// @vitest-environment happy-dom
import { countRenders } from "./render-count.test-support.js";
import { act } from "react";
import { expect, it } from "vitest";
import { placeList } from "@opensteer/client/host";
import { client, mount, settle } from "./workspace/workspace.interaction.test-support.js";

function drawn(
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  component: string,
  keys: readonly string[],
): readonly string[] {
  const byKey = counts.get(component);
  return keys.filter((key) => (byKey?.get(key) ?? 0) > 0);
}

it("a streamed reply redraws only its own task's row and the tabs it is in", async () => {
  await mount("/");
  // The seeded world stops moving on its own, so the reply is the only thing that changes.
  act(() => void client.scriptPlaces());
  await settle(100);
  const tasks = [...document.querySelectorAll<HTMLElement>(".side-task[data-thread-id]")].map(
    (row) => row.dataset.threadId!,
  );
  const tabs = [...document.querySelectorAll<HTMLElement>(".side-tab[data-place-key]")].map(
    (row) => row.dataset.placeKey!,
  );
  const busy = new Set(client.getSnapshot().runQueue.map((run) => run.threadId));
  const threadId = tasks.find((id) => !busy.has(id));
  expect(threadId, "an idle task to reply in").toBeDefined();
  expect(tasks.length).toBeGreaterThan(3);
  expect(tabs.length).toBeGreaterThan(3);
  const counts = await countRenders(async () => {
    // The mock answers once the whole scripted reply has streamed into the task.
    await act(async () => {
      await client.dispatch({
        content: [{ type: "text", text: "Tidy the notes" }],
        delivery: "queue",
        idempotencyKey: "sidebar-redraws-1",
        threadId: threadId!,
        type: "thread.sendMessage",
      });
    });
  });
  const holding = new Set<string>(
    placeList(client.getSnapshot())
      .filter((place) => place.occupants.some((occupant) => occupant.threadId === threadId))
      .map((place) => place.key),
  );
  expect(drawn(counts, "TaskRowItem", [threadId!]), "the replying task's row").toEqual([threadId]);
  expect(
    drawn(
      counts,
      "TaskRowItem",
      tasks.filter((id) => id !== threadId),
    ),
    "other tasks' rows",
  ).toEqual([]);
  expect(
    drawn(
      counts,
      "TabRow",
      tabs.filter((key) => !holding.has(key)),
    ),
    "tab rows the task is not in",
  ).toEqual([]);
});
