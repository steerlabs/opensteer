import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runBounded } from "./command-runner.js";
import { runMacPreparations } from "./mac-preparation.js";

const directory = await mkdtemp(
  path.join(
    process.env.OPENSTEER_PHASE_F_EVIDENCE_DIRECTORY ?? tmpdir(),
    "opensteer-phone-processes-",
  ),
);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
await mkdir(path.join(directory, "scripts"));
await mkdir(path.join(directory, "apps/agent-phone"), { recursive: true });
await copyFile(
  path.join(root, "apps/agent-phone/gradle.properties"),
  path.join(directory, "apps/agent-phone/gradle.properties"),
);
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
for (const source of ["build-agent-phone.ts", "release-agent-phone.cjs"])
  await copyFile(
    source === "build-agent-phone.ts" && process.env.OPENSTEER_PHONE_SCRIPT
      ? process.env.OPENSTEER_PHONE_SCRIPT
      : path.join(root, "scripts", source),
    path.join(directory, "scripts", source),
  );
for (const source of ["packages", "node_modules"])
  await symlink(path.join(root, source), path.join(directory, source));
const worker = path.join(directory, "worker.json");
const calls = path.join(directory, "gradle-args.json");
const gradle = path.join(directory, "apps/agent-phone/gradlew");
await writeFile(
  gradle,
  `#!${process.execPath}
import {spawn} from 'node:child_process';import fs from 'node:fs';const args=process.argv.slice(2);
const launcherMatches = (process.env.GRADLE_OPTS ?? '').includes('-Xmx3g') && (process.env.GRADLE_OPTS ?? '').includes('-Dfile.encoding=UTF-8');
const agentMatches = args.includes('-Dorg.gradle.internal.instrumentation.agent=false');
const daemon = !launcherMatches || !agentMatches || !args.includes('--no-daemon') || !args.includes('-Pkotlin.compiler.execution.strategy=in-process');
fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify({args,gradleOpts:process.env.GRADLE_OPTS,javaOpts:process.env.JAVA_OPTS,launcherMatches,daemon}));
const child=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(worker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`)}],{detached:daemon,stdio:'ignore'});if(daemon)child.unref();setInterval(()=>{},1000);
`,
  { mode: 0o755 },
);
let cleanupFailure: unknown;
try {
  await assert.rejects(
    runMacPreparations([
      async (signal) => {
        await runBounded(
          process.execPath,
          [
            "--import",
            "tsx",
            path.join(directory, "scripts/build-agent-phone.ts"),
            "--release",
            "--output",
            path.join(directory, "artifact"),
          ],
          { signal, cwd: root },
        );
      },
      async (signal) => {
        for (let i = 0; i < 100; i++) {
          try {
            await readFile(worker);
            throw new Error("Injected sibling failure");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
          await delay(50, undefined, { signal });
        }
        throw Error("Fake Gradle did not start");
      },
    ]),
    /Injected sibling failure/u,
  );
  const { pid } = JSON.parse(await readFile(worker, "utf8")) as { pid: number };
  await writeFile(
    path.join(directory, "worker-after-return.txt"),
    await runBounded("/bin/ps", ["-o", "pid,ppid,pgid,sess,stat,command", "-p", String(pid)]).catch(
      (error: unknown) => String(error),
    ),
  );
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  const { args, gradleOpts, javaOpts, daemon } = JSON.parse(await readFile(calls, "utf8")) as {
    args: unknown;
    gradleOpts: string;
    javaOpts: string;
    daemon: boolean;
  };
  assert.ok(
    Array.isArray(args) &&
      args.includes("--no-daemon") &&
      args.includes("-Pkotlin.compiler.execution.strategy=in-process"),
  );
  assert.ok(
    Array.isArray(args) && args.includes("-Dorg.gradle.internal.instrumentation.agent=false"),
  );
  assert.equal(javaOpts, "");
  assert.equal(daemon, false);
  assert.ok(Array.isArray(args) && args.includes(`-Dorg.gradle.jvmargs=${gradleOpts}`));
  assert.ok(gradleOpts.includes("-Xmx3g") && gradleOpts.includes("-Dfile.encoding=UTF-8"));
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(
      { passed: true, detachedWorkerPrevented: true, workerPid: pid, args, gradleOpts },
      null,
      2,
    ),
  );
} finally {
  try {
    const { pid } = JSON.parse(await readFile(worker, "utf8")) as { pid: number };
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      ["ESRCH", "ENOENT"].includes(String(error.code))
    ))
      cleanupFailure = error;
  }
}
if (cleanupFailure) throw cleanupFailure;
process.stdout.write(`${directory}\n`);
