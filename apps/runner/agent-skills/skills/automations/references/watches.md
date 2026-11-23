# Continuous watches

A watch works only when its activation is healthy and you observe its intended effect. Watches run continuously; they cannot be manually run.

Create an ongoing monitor with `ownTask: true`; record its criteria and asking task or email destination under `automations/<automation-id>/` before enabling it. Check in code first. Queue model checks with `freshContext: true`, carrying criteria, destination and state path in each wake; start child checks from the monitor's task. Send real finds to the asking task with `opensteer_task_send` queue or email through a connected integration; a `report` never notifies. Each background wake briefly says what happened.

Write a normal script that stays alive, uses a stable `observationId`, and lets Opensteer stop it; test it in your shell, then register it:

```js
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, watch, writeFile } from "node:fs/promises";

const automationId = process.env.OPENSTEER_AUTOMATION_ID;
const taskId = "<monitor-task-id>";
const stateDir = `automations/${automationId}`;
await mkdir(stateDir, { recursive: true });
const cursorPath = `${stateDir}/cursor`;
let cursor = Number(await readFile(cursorPath, "utf8").catch(() => "0"));

for await (const change of watch("./incoming")) {
  if (!change.filename) continue;
  const nextCursor = cursor + 1;
  execFileSync("opensteer", [
    "opensteer_task_send",
    JSON.stringify({
      delivery: "queue",
      freshContext: true,
      message: `Check ${change.filename} for the configured incoming-file criteria. State: ${stateDir}/. Send real finds to the asking task recorded in ${stateDir}/destination.json. Briefly record what happened.`,
      observationId: `folder:${nextCursor}`,
      taskId,
    }),
  ]);
  await writeFile(`${cursorPath}.next`, String(nextCursor));
  await rename(`${cursorPath}.next`, cursorPath);
  cursor = nextCursor;
}
```

Use durable observation identities for logical changes, including across activations when duplicate effects matter. Filesystem events are hints, not a durable queue; reconcile content if missing a change matters.

Watches call Opensteer through the `opensteer` CLI or MCP within their task's authority; see [running scripts](scripts.md).
