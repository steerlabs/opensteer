import { spawnSupervised } from "@opensteer/harness/process-supervisor";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const root = z.string().parse(process.env.OPENSTEER_OWNER_E2E_ROOT);
const executable = z.string().parse(process.env.OPENSTEER_OWNER_E2E_EXECUTABLE);
for (const name of ["cache", "config", "data", "state"])
  mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
const child = spawnSupervised({
  executable,
  args: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
  cwd: root,
  environment: {
    HOME: root,
    PATH: "/usr/bin:/bin",
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_SERVER_PASSWORD: "offline-parent-death-e2e-only",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  },
});
void (async () => {
  for await (const chunk of child.stderr) process.stderr.write(chunk);
})();
let announced = false;
void (async () => {
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk.toString("utf8");
    if (!announced && /listening on/iu.test(output)) {
      announced = true;
      process.stdout.write(
        `${JSON.stringify({ event: "test.engine.ready", pid: child.child.pid })}\n`,
      );
    }
  }
})();
process.on("SIGTERM", () => {
  void child.terminate(0).finally(() => process.exit(0));
});
// The driver deliberately SIGKILLs this owner, so no JS cleanup can save it.
setTimeout(() => {
  void child.terminate(0).finally(() => process.exit(2));
}, 60_000);
