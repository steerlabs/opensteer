#!/usr/bin/env node
// A diagnostic PATH shim, used only for electron-builder's bare codesign calls.
// Execute Apple's signer unchanged; never serialize arguments or stderr.
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { constants } = require("node:os");
const path = require("node:path");

async function traceCodesign(args, options) {
  const signing =
    args.includes("--sign") || args.includes("-s") || args.some((arg) => arg.startsWith("--sign="));
  if (!signing) {
    const result = await options.execute("/usr/bin/codesign", args);
    return result.code ?? 128 + (constants.signals[result.signal] ?? 1);
  }
  const relative = path.relative(options.root, path.resolve(args.at(-1) ?? "."));
  const file =
    relative.startsWith("..") || path.isAbsolute(relative) ? "outside-package" : relative || ".";
  const id = randomUUID();
  const start = performance.now();
  const emit = (fields) => {
    try {
      options.record({
        id,
        phase: "package.codesign",
        file,
        at: new Date().toISOString(),
        ...fields,
      });
    } catch {
      /* Measurement must not alter signing. */
    }
  };
  emit({ event: "start" });
  const result = await options.execute("/usr/bin/time", ["-p", "/usr/bin/codesign", ...args]);
  const seconds = (key) => {
    const matches = [...result.stderr.matchAll(new RegExp(`^${key}\\s+([0-9.]+)\\s*$`, "gm"))];
    const value = matches.at(-1)?.[1];
    return value === undefined ? undefined : Number(value) * 1000;
  };
  const code = result.code ?? 128 + (constants.signals[result.signal] ?? 1);
  emit({
    event: code === 0 ? "complete" : "failed",
    elapsedMs: seconds("real") ?? performance.now() - start,
    cpuUserMs: seconds("user"),
    cpuSystemMs: seconds("sys"),
    exitCode: code,
  });
  return code;
}

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["inherit", "inherit", "pipe"], shell: false });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

module.exports = { traceCodesign };
if (require.main === module) {
  traceCodesign(process.argv.slice(2), {
    root: process.env.OPENSTEER_CODESIGN_TIMING_ROOT ?? process.cwd(),
    execute,
    record: (event) => {
      const filename = process.env.OPENSTEER_RELEASE_TIMING_FILE;
      if (filename)
        appendFileSync(
          filename,
          JSON.stringify({ parentId: process.env.OPENSTEER_RELEASE_COMMAND_ID, ...event }) + "\n",
          { mode: 0o600 },
        );
    },
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(String(error) + "\n");
      process.exitCode = 1;
    },
  );
}
