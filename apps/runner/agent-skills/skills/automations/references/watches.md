# Continuous watches

A watch works only when its activation is healthy and you observe its intended effect. Watches run continuously; they cannot be manually run.

Create an ongoing monitor with `ownTask: true`; record its criteria and asking task or email destination under `automations/<trigger-id>/` before enabling it. Check in code first. Queue model checks with `freshContext: true`, carrying criteria, destination and state path in each wake; start child checks from the monitor's task. Send real finds to the asking task with `thread_send` queue or email through a connected integration; a `report` never notifies. Each background wake briefly says what happened.

Keep the process alive, use a stable observation ID, and let Opensteer stop it:

```ts
import { mkdir, readFile, rename, watch, writeFile } from "node:fs/promises";

export default async function ({ event, opensteer }) {
  const stateDir = `automations/${event.trigger.id}`;
  await mkdir(stateDir, { recursive: true });
  const cursorPath = `${stateDir}/cursor`;
  let cursor = Number(await readFile(cursorPath, "utf8").catch(() => "0"));
  const folder = watch("./incoming");
  for await (const change of folder) {
    if (!change.filename) continue;
    const nextCursor = cursor + 1;
    await opensteer.callTool("thread_send", {
      delivery: "queue",
      freshContext: true,
      message: `Check ${change.filename} for the configured incoming-file criteria. State: ${stateDir}/. Send real finds to the asking task recorded in ${stateDir}/destination.json. Briefly record what happened.`,
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
