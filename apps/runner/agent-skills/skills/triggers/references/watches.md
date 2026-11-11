# Continuous watches

A watch works only when its activation is healthy and you observe its intended effect. Watches run continuously; they cannot be manually run.

Keep the process alive, use a stable observation ID, and let Opensteer stop it:

```ts
import { readFile, rename, watch, writeFile } from "node:fs/promises";

export default async function ({ event, opensteer }) {
  const cursorPath = ".opensteer-folder-watch-cursor";
  let cursor = Number(await readFile(cursorPath, "utf8").catch(() => "0"));
  const folder = watch("./incoming");
  for await (const change of folder) {
    if (!change.filename) continue;
    const nextCursor = cursor + 1;
    await opensteer.callTool("thread_send", {
      delivery: "queue",
      message: `Changed: ${change.filename}`,
      observationId: `folder:${nextCursor}`,
      threadId: event.trigger.anchorThreadId,
    });
    await writeFile(`${cursorPath}.next`, String(nextCursor));
    await rename(`${cursorPath}.next`, cursorPath);
    cursor = nextCursor;
  }
}
```

Use durable observation identities for logical changes, including across activations when duplicate effects matter. Filesystem events are hints, not a durable queue; reconcile content if missing a change matters.

Watches use the program tool list, including integration tools, within the anchor Thread's authority. Delegate when agent judgment or a Run-only tool is needed; see the [program contract](program-contract.md).
