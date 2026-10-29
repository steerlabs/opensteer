import { spawn } from "node:child_process";
import { appendFileSync, existsSync, watch } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const fixture = argument("fixture");
const scratch = argument("scratch");
const capture = argument("capture");
if (!fixture || !scratch || !capture) throw new Error("Missing scripted-engine paths");
const preparationRelease = argument("preparation-release");
const releaseFile = join(scratch, `turn-${process.pid}`);
const child = spawn(
  process.execPath,
  [
    fixture,
    ...process.argv
      .slice(2)
      .filter(
        (value) =>
          ![
            "--fixture=",
            "--scratch=",
            "--preparation-release=",
            "--release-file=",
            "--readiness-runner-pid=",
          ].some((prefix) => value.startsWith(prefix)),
      ),
    `--release-file=${releaseFile}`,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const messageSchema = z
  .object({
    method: z.string().optional(),
    params: z
      .object({ input: z.array(z.unknown()).optional(), threadId: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const lines = createInterface({ input: process.stdin });
let forwarding = Promise.resolve();
let watcher: ReturnType<typeof watch> | undefined;
let ephemeral = false;

lines.on("line", (line) => {
  forwarding = forwarding
    .then(async () => {
      const message = messageSchema.parse(JSON.parse(line));
      if (message.method === "thread/start") ephemeral = message.params?.ephemeral === true;
      if (
        message.method === "initialize" &&
        preparationRelease &&
        !existsSync(preparationRelease)
      ) {
        appendFileSync(
          capture,
          `${JSON.stringify({ preparationHeld: { pid: process.pid, runnerPid: Number(argument("readiness-runner-pid") ?? process.ppid), enginePid: child.pid } })}\n`,
        );
        // Hold the real app-server handshake; catalog inspection itself remains responsive.
        await new Promise<void>((resolve) => {
          const ready = () => {
            if (!existsSync(preparationRelease)) return;
            watcher?.close();
            watcher = undefined;
            resolve();
          };
          watcher = watch(scratch, ready);
          ready();
        });
      }
      if (message.method === "turn/start" && !ephemeral) {
        appendFileSync(
          capture,
          `${JSON.stringify({
            dispatchReadinessTurn: {
              input: message.params?.input,
              releaseFile,
              threadId: message.params?.threadId,
            },
          })}\n`,
        );
      }
      child.stdin.write(`${line}\n`);
    })
    .catch((error: unknown) => {
      console.error(error);
      child.kill("SIGTERM");
    });
});
lines.on("close", () => {
  void forwarding.then(() => child.stdin.end());
});
process.on("SIGTERM", () => {
  watcher?.close();
  child.kill("SIGTERM");
});
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
